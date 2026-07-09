// Dataset connector: copilot-metrics — day × model Copilot engagement.
// Endpoint: GET /orgs/{org}/copilot/metrics/reports/organization-1-day?day=…
// → signed download links → NDJSON records (the legacy /orgs/{org}/copilot/metrics
// API was sunset 2026-04; see ADR 0012 for the mapping decisions).
// Auth: classic PAT `read:org` (fine-grained: "Organization Copilot metrics" read).
// History is short upstream — the nightly scheduler (T2.6) exists so the local
// DB accumulates what GitHub discards.
import { ensureSku, insertFactSql, upsertOrg } from "../../../adapters/db/dims";
import type { DatasetConnector } from "../ports";
import { eachDay, filterSql, rangeCoverage } from "./util";

const TTL_HOURS = 24;
const REPORT_ROUTE = "/orgs/{org}/copilot/metrics/reports/organization-1-day";

interface BreakdownEntry {
  model?: string;
  user_initiated_interaction_count?: number;
  code_generation_activity_count?: number;
  code_acceptance_activity_count?: number;
  loc_suggested_to_add_sum?: number;
  loc_added_sum?: number;
}

interface OrgDayRecord {
  day?: string;
  daily_active_users?: number;
  code_generation_activity_count?: number;
  code_acceptance_activity_count?: number;
  loc_suggested_to_add_sum?: number;
  loc_added_sum?: number;
  totals_by_model_feature?: BreakdownEntry[];
}

/** New-API field → our metric vocabulary (UBIQUITOUS.md Metric). */
const RECORD_METRICS: ReadonlyArray<[keyof OrgDayRecord & keyof BreakdownEntry, string]> = [
  ["code_generation_activity_count", "code_suggestions"],
  ["code_acceptance_activity_count", "code_acceptances"],
  ["loc_suggested_to_add_sum", "code_lines_suggested"],
  ["loc_added_sum", "code_lines_accepted"],
];

const COLUMNS = [
  { name: "day", type: "date", description: "Activity day (YYYY-MM-DD)" },
  { name: "model", type: "string", description: "AI model (empty for org-wide totals)" },
  {
    name: "metric",
    type: "string",
    description:
      "code_suggestions, code_acceptances, code_lines_suggested, code_lines_accepted, chats, engaged_users",
  },
  { name: "quantity", type: "number", description: "Metric value for the day" },
] as const;

/** Flatten one org-1-day record into fact rows (org totals + per-model chat activity). */
function factRows(
  record: OrgDayRecord,
  day: string,
  org: { id: number; login: string },
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  // org id comes from /orgs/{org}, not record.organization_id: a record that
  // omits the field would otherwise mint an org row with a bogus rowid
  const base = { org_id: org.id, org_login: org.login, day: record.day ?? day };
  for (const [field, metric] of RECORD_METRICS) {
    const quantity = record[field];
    if (typeof quantity === "number") rows.push({ ...base, model: null, metric, quantity });
  }
  if (typeof record.daily_active_users === "number") {
    rows.push({
      ...base,
      model: null,
      metric: "engaged_users",
      quantity: record.daily_active_users,
    });
  }
  // per-model: sum the model×feature chat-activity breakdown by model
  const byModel = new Map<string, Record<string, number>>();
  for (const entry of record.totals_by_model_feature ?? []) {
    if (!entry.model) continue;
    const acc = byModel.get(entry.model) ?? {};
    for (const [field, metric] of RECORD_METRICS) {
      const v = entry[field];
      if (typeof v === "number") acc[metric] = (acc[metric] ?? 0) + v;
    }
    if (typeof entry.user_initiated_interaction_count === "number") {
      acc.chats = (acc.chats ?? 0) + entry.user_initiated_interaction_count;
    }
    byModel.set(entry.model, acc);
  }
  for (const [model, metrics] of byModel) {
    for (const [metric, quantity] of Object.entries(metrics)) {
      rows.push({ ...base, model, metric, quantity });
    }
  }
  if (rows.length > 0) rows[0] = { ...rows[0], raw: JSON.stringify(record) }; // once per day
  return rows;
}

export function copilotMetricsConnector(now: () => Date): DatasetConnector {
  return {
    meta: {
      id: "copilot-metrics",
      title: "Copilot metrics",
      description:
        "Daily Copilot engagement for the organization: code suggestions and acceptances, lines suggested and accepted, chat interactions per AI model, and engaged users.",
      columns: [...COLUMNS],
      scope: "org",
      freshnessTtlHours: TTL_HOURS,
    },

    coverage(db, q) {
      return rangeCoverage(db, "copilot-metrics", q, TTL_HOURS, now());
    },

    async *fetch(gap, gh) {
      const org = await gh.get<{ id: number; login: string }>("/orgs/{org}", { org: gap.scope });
      if (org.status !== 200) return;
      for (const day of eachDay(gap.from, gap.to)) {
        let res: Awaited<ReturnType<typeof gh.get<{ download_links?: string[] }>>>;
        try {
          res = await gh.get<{ download_links?: string[] }>(REPORT_ROUTE, { org: gap.scope, day });
        } catch (e) {
          // missing days inside the range are legitimate (~1y retention window,
          // reports exist only since 2025-10); watermark the requested range anyway
          if ((e as { status?: number }).status === 404) continue;
          throw e;
        }
        if (res.status !== 200 || !res.data?.download_links) continue; // 204: no report
        const rows: Record<string, unknown>[] = [];
        for (const link of res.data.download_links) {
          const text = await gh.download(link);
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            rows.push(...factRows(JSON.parse(line) as OrgDayRecord, day, org.data));
          }
        }
        if (rows.length > 0) yield rows;
      }
    },

    upsert(db, rows) {
      const first = rows[0];
      if (!first) return;
      const orgId = upsertOrg(db, { id: first.org_id as number, login: first.org_login as string });
      const skuId = ensureSku(db, "copilot", "copilot_metrics");
      const insert = db.query(insertFactSql);
      for (const r of rows) {
        insert.run(
          r.day as string,
          orgId,
          null,
          skuId,
          (r.model as string) ?? null,
          r.metric as string,
          r.quantity as number,
          "count",
          1,
          null,
          null,
          "copilot-metrics",
          (r.raw as string) ?? null,
        );
      }
    },

    select(db, q) {
      const f = filterSql({ model: "f.model", metric: "f.metric" }, q.filter);
      const rows = db
        .query(
          `SELECT f.day, f.model, f.metric, f.quantity
           FROM usage_facts f
           JOIN orgs o ON o.id = f.org_id
           WHERE o.login = ? AND f.source = 'copilot-metrics'
             AND f.day BETWEEN ? AND ?${f.sql}
           ORDER BY f.day, f.model, f.metric
           LIMIT ?`,
        )
        .values(q.org, q.range.from, q.range.to, ...f.params, q.limit ?? -1);
      return { columns: [...COLUMNS], rows };
    },
  };
}
