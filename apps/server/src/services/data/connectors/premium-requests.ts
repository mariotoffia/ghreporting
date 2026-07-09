// Dataset connector: premium-requests — per-user, per-model premium request
// usage. The dataset the first report (E9) runs on.
// Endpoint (verified 2026-07 on docs.github.com):
//   GET /organizations/{org}/settings/billing/premium_request/usage
// One call per day gives org × model day grain; the API only breaks down by
// user when asked per user (?user=), so user × model rows are fetched once
// per (local org member, month) and land on the month's last day with
// metric 'premium_requests_month'. Day rows carry metric 'premium_requests'.
// Auth: fine-grained PAT, organization "Administration" (read) — classic PAT
// scopes are not documented for the billing platform endpoints.

import type { Database } from "bun:sqlite";
import { premiumRequestCost, roundUsd } from "@ghreporting/domain";
import { ensureSku, insertFactSql, modelPriceOn, upsertOrg } from "../../../adapters/db/dims";
import type { DatasetConnector, Gap } from "../ports";
import { eachDay, filterSql, rangeCoverage } from "./util";

const TTL_HOURS = 6;
const USAGE_ROUTE = "/organizations/{org}/settings/billing/premium_request/usage";

interface UsageItem {
  model?: string | null;
  unitType?: string;
  pricePerUnit?: number;
  grossQuantity?: number;
  grossAmount?: number;
  discountQuantity?: number;
  discountAmount?: number;
  netQuantity?: number;
  netAmount?: number;
}
interface UsageResponse {
  usageItems?: UsageItem[];
}

const COLUMNS = [
  { name: "day", type: "date", description: "Usage day; month rows land on the month's last day" },
  {
    name: "user_login",
    type: "string",
    description: "GitHub login (empty for org-level day rows)",
  },
  { name: "model", type: "string", description: "AI model the requests were billed against" },
  { name: "requests", type: "number", description: "Premium requests used" },
  { name: "multiplier", type: "number", description: "Model multiplier applied by GitHub" },
  { name: "gross_usd", type: "number", description: "Cost before included allowance" },
  { name: "net_usd", type: "number", description: "Billed cost after included allowance" },
] as const;

/** Inclusive months overlapping [from, to]: [{year, month, lastDay}]. */
export function monthsOf(
  from: string,
  to: string,
): { year: number; month: number; lastDay: string }[] {
  const months: { year: number; month: number; lastDay: string }[] = [];
  let d = new Date(`${from.slice(0, 7)}-01T00:00:00.000Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00.000Z`);
  while (d <= end) {
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    months.push({ year, month, lastDay });
    d = new Date(Date.UTC(year, month, 1));
  }
  return months;
}

function orgMembers(db: Database, orgLogin: string): string[] {
  return db
    .query(
      `SELECT u.login FROM org_members m
       JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
       WHERE o.login = ?1 ORDER BY u.login`,
    )
    .values(orgLogin)
    .map((r) => r[0] as string);
}

/** Group usage items by model, summing quantities and amounts. */
function byModel(items: UsageItem[]): Map<string, UsageItem> {
  const grouped = new Map<string, UsageItem>();
  for (const item of items) {
    const model = item.model ?? "unknown";
    const acc = grouped.get(model) ?? {};
    const add = (k: keyof UsageItem & string) => {
      const v = item[k];
      if (typeof v === "number") (acc[k] as number | undefined) = ((acc[k] as number) ?? 0) + v;
    };
    for (const k of ["grossQuantity", "grossAmount", "discountQuantity", "netAmount"] as const)
      add(k);
    grouped.set(model, acc);
  }
  return grouped;
}

export function premiumRequestsConnector(now: () => Date): DatasetConnector {
  function factRow(
    ctxLike: {
      orgId: number;
      orgLogin: string;
      db: Database;
      notifyUnknown: (model: string) => void;
    },
    day: string,
    metric: string,
    userLogin: string | null,
    model: string,
    item: UsageItem,
  ): Record<string, unknown> {
    const requests = item.grossQuantity ?? item.netQuantity ?? 0;
    const price = modelPriceOn(ctxLike.db, model, day);
    if (!price) ctxLike.notifyUnknown(model);
    const multiplier = price?.multiplier ?? 1;
    const gross =
      item.grossAmount ??
      premiumRequestCost({ requests, multiplier, pricePerRequestUsd: item.pricePerUnit });
    const net =
      item.netAmount ??
      premiumRequestCost({
        requests,
        multiplier,
        included: item.discountQuantity ?? 0,
        pricePerRequestUsd: item.pricePerUnit,
      });
    return {
      org_id: ctxLike.orgId,
      org_login: ctxLike.orgLogin,
      day,
      metric,
      user_login: userLogin,
      model,
      requests,
      multiplier,
      gross_usd: roundUsd(gross),
      net_usd: roundUsd(net),
      raw: JSON.stringify(item),
    };
  }

  return {
    meta: {
      id: "premium-requests",
      title: "Premium requests",
      description:
        "Copilot premium request usage and cost: per model and day for the whole organization, and per user and model at month grain. The dataset the Copilot spend report is built on.",
      columns: [...COLUMNS],
      scope: "org-user",
      freshnessTtlHours: TTL_HOURS,
    },

    coverage(db, q) {
      return rangeCoverage(db, "premium-requests", q, TTL_HOURS, now());
    },

    async *fetch(gap: Gap, gh, ctx) {
      const org = await gh.get<{ id: number; login: string }>("/orgs/{org}", { org: gap.scope });
      if (org.status !== 200) return;
      const like = {
        orgId: org.data.id,
        orgLogin: org.data.login,
        db: ctx.db,
        notifyUnknown: (model: string) =>
          ctx.notify({
            key: `data.premium-requests.unknown-model.${model}`,
            level: "warning",
            title: `Unknown model in premium request usage: ${model}`,
            body: `No model_prices row covers "${model}" — its facts were stored with multiplier 1. Add a price row to correct cost math.`,
            source: "data",
          }),
      };

      // org × model, day grain
      for (const day of eachDay(gap.from, gap.to)) {
        const [year, month, dayNum] = day.split("-").map(Number);
        let res: { status: number; data?: UsageResponse };
        try {
          res = await gh.get<UsageResponse>(USAGE_ROUTE, {
            org: gap.scope,
            year,
            month,
            day: dayNum,
          });
        } catch (e) {
          if ((e as { status?: number }).status === 404) continue; // no usage recorded that day
          throw e;
        }
        if (res.status !== 200 || !res.data?.usageItems) continue;
        const rows: Record<string, unknown>[] = [];
        for (const [model, item] of byModel(res.data.usageItems)) {
          rows.push(factRow(like, day, "premium_requests", null, model, item));
        }
        if (rows.length > 0) yield rows;
      }

      // user × model, month grain — one call per (member, month); members come
      // from the local org-people snapshot (sync org-people first for user rows)
      const members = orgMembers(ctx.db, gap.scope);
      for (const { year, month, lastDay } of monthsOf(gap.from, gap.to)) {
        for (const user of members) {
          let res: { status: number; data?: UsageResponse };
          try {
            res = await gh.get<UsageResponse>(USAGE_ROUTE, { org: gap.scope, year, month, user });
          } catch (e) {
            if ((e as { status?: number }).status === 404) continue;
            throw e;
          }
          if (res.status !== 200 || !res.data?.usageItems) continue;
          const rows: Record<string, unknown>[] = [];
          for (const [model, item] of byModel(res.data.usageItems)) {
            rows.push(factRow(like, lastDay, "premium_requests_month", user, model, item));
          }
          if (rows.length > 0) yield rows;
        }
      }
    },

    upsert(db, rows) {
      const first = rows[0];
      if (!first) return;
      const orgId = upsertOrg(db, { id: first.org_id as number, login: first.org_login as string });
      const skuId = ensureSku(db, "copilot", "copilot_premium_request");
      const insert = db.query(insertFactSql);
      const userId = db.query("SELECT id FROM users WHERE login=?1");
      for (const r of rows) {
        const user = r.user_login
          ? ((userId.get(r.user_login as string) as { id: number } | null)?.id ?? null)
          : null;
        insert.run(
          r.day as string,
          orgId,
          user,
          skuId,
          r.model as string,
          r.metric as string,
          r.requests as number,
          "requests",
          r.multiplier as number,
          r.gross_usd as number,
          r.net_usd as number,
          "premium-requests",
          (r.raw as string) ?? null,
        );
      }
    },

    select(db, q) {
      const f = filterSql({ user_login: "u.login", model: "f.model" }, q.filter);
      const rows = db
        .query(
          `SELECT f.day, u.login AS user_login, f.model, f.quantity AS requests,
                  f.multiplier, f.gross_amount_usd AS gross_usd, f.net_amount_usd AS net_usd
           FROM usage_facts f
           JOIN orgs o ON o.id = f.org_id
           LEFT JOIN users u ON u.id = f.user_id
           WHERE o.login = ? AND f.source = 'premium-requests'
             AND f.day BETWEEN ? AND ?${f.sql}
           ORDER BY f.day, u.login, f.model
           LIMIT ?`,
        )
        .values(q.org, q.range.from, q.range.to, ...f.params, q.limit ?? -1);
      return { columns: [...COLUMNS], rows };
    },
  };
}
