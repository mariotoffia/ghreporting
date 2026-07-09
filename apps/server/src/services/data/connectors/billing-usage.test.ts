import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Gap } from "../ports";
import { billingUsageConnector } from "./billing-usage";
import { connectorContext, fakeGitHub, ghError, TEST_NOW } from "./testutil";

const USAGE = "/organizations/acme/settings/billing/usage";

const fixtures = {
  gets: {
    "/orgs/acme": { id: 1, login: "acme" },
    [`${USAGE}?month=6&year=2026`]: ghError(404), // month without usage
    [`${USAGE}?month=7&year=2026`]: {
      usageItems: [
        {
          date: "2026-07-01",
          product: "actions",
          sku: "actions_linux",
          quantity: 100,
          unitType: "minutes",
          pricePerUnit: 0.008,
          grossAmount: 0.8,
          discountAmount: 0.8,
          netAmount: 0,
          organizationName: "acme",
          repositoryName: "repo-a",
        },
        {
          date: "2026-07-01",
          product: "actions",
          sku: "actions_linux",
          quantity: 50,
          unitType: "minutes",
          pricePerUnit: 0.008,
          grossAmount: 0.4,
          discountAmount: 0,
          netAmount: 0.4,
          organizationName: "acme",
          repositoryName: "repo-b",
        },
        {
          date: "2026-07-02",
          product: "copilot",
          sku: "copilot_premium_request",
          quantity: 100,
          unitType: "requests",
          pricePerUnit: 0.04,
          grossAmount: 24,
          discountAmount: 4,
          netAmount: 20,
          organizationName: "acme",
        },
      ],
    },
  },
};

const gap: Gap = { scope: "acme", from: "2026-06-25", to: "2026-07-05" };
const q = { org: "acme", range: { from: "2026-06-01", to: "2026-07-31" } };

let ctx: ReturnType<typeof connectorContext>;
beforeEach(() => {
  ctx = connectorContext();
});
afterEach(() => ctx.db.close());

const connector = () => billingUsageConnector(() => TEST_NOW);

async function syncOnce() {
  const c = connector();
  for await (const b of c.fetch(gap, fakeGitHub(fixtures), ctx)) c.upsert(ctx.db, b);
}

describe("billing-usage connector", () => {
  it("aggregates per-repository items into day × product × sku facts", async () => {
    await syncOnce();
    const rs = connector().select(ctx.db, q);
    expect(rs.columns.map((c) => c.name)).toEqual([
      "day",
      "product",
      "sku",
      "quantity",
      "unit",
      "gross_usd",
      "net_usd",
    ]);
    expect(rs.rows).toEqual([
      ["2026-07-01", "actions", "actions_linux", 150, "minutes", 1.2000000000000002, 0.4],
      ["2026-07-02", "copilot", "copilot_premium_request", 100, "requests", 24, 20],
    ]);
  });

  it("keeps the dropped repository breakdown in raw", async () => {
    await syncOnce();
    const raw = ctx.db
      .query("SELECT raw FROM usage_facts WHERE day='2026-07-01' AND source='billing-usage'")
      .get() as { raw: string };
    const items = JSON.parse(raw.raw) as { repositoryName?: string }[];
    expect(items.map((i) => i.repositoryName)).toEqual(["repo-a", "repo-b"]);
  });

  it("asks each month once and skips 404 months", async () => {
    const gh = fakeGitHub(fixtures);
    const c = connector();
    for await (const b of c.fetch(gap, gh, ctx)) c.upsert(ctx.db, b);
    expect(gh.calls).toEqual([
      "GET /orgs/acme",
      `GET ${USAGE}?month=6&year=2026`,
      `GET ${USAGE}?month=7&year=2026`,
    ]);
  });

  it("double upsert is idempotent", async () => {
    await syncOnce();
    const count = () =>
      (ctx.db.query("SELECT COUNT(*) n FROM usage_facts").get() as { n: number }).n;
    const before = count();
    await syncOnce();
    expect(count()).toBe(before);
  });

  it("select honors filter and limit", async () => {
    await syncOnce();
    const c = connector();
    expect(c.select(ctx.db, { ...q, filter: { product: "copilot" } }).rows).toHaveLength(1);
    expect(c.select(ctx.db, { ...q, limit: 1 }).rows).toHaveLength(1);
  });
});
