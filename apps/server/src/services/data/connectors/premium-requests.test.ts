import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { upsertOrg, upsertUser } from "../../../adapters/db/dims";
import type { Gap } from "../ports";
import { markSynced } from "../sync";
import { monthsOf, premiumRequestsConnector } from "./premium-requests";
import { connectorContext, fakeGitHub, ghError, TEST_NOW } from "./testutil";

const USAGE = "/organizations/acme/settings/billing/premium_request/usage";

const fixtures = {
  gets: {
    "/orgs/acme": { id: 1, login: "acme" },
    // day grain, org-level: two items for the same model are summed
    [`${USAGE}?day=1&month=7&year=2026`]: {
      usageItems: [
        {
          model: "GPT-5.4",
          unitType: "requests",
          pricePerUnit: 0.04,
          grossQuantity: 60,
          grossAmount: 14.4,
          discountQuantity: 0,
          discountAmount: 0,
          netQuantity: 60,
          netAmount: 14.4,
        },
        {
          model: "GPT-5.4",
          unitType: "requests",
          pricePerUnit: 0.04,
          grossQuantity: 40,
          grossAmount: 9.6,
          discountQuantity: 0,
          discountAmount: 0,
          netQuantity: 40,
          netAmount: 9.6,
        },
      ],
    },
    [`${USAGE}?day=2&month=7&year=2026`]: ghError(404), // no usage that day
    // user × model, month grain
    [`${USAGE}?month=7&user=anna&year=2026`]: {
      usageItems: [
        {
          model: "Mystery-1", // not in model_prices → multiplier 1 + notification
          unitType: "requests",
          netQuantity: 10, // no grossQuantity: netQuantity must carry through grouping
          discountQuantity: 10,
          pricePerUnit: 0.05, // payload price wins over the $0.04 default
        },
      ],
    },
    [`${USAGE}?month=7&user=mario&year=2026`]: {
      usageItems: [
        {
          model: "GPT-5.4",
          unitType: "requests",
          pricePerUnit: 0.04,
          grossQuantity: 100,
          grossAmount: 24,
          discountQuantity: 0,
          discountAmount: 0,
          netQuantity: 100,
          netAmount: 20,
        },
      ],
    },
  },
};

const gap: Gap = { scope: "acme", from: "2026-07-01", to: "2026-07-02" };
const q = { org: "acme", range: { from: "2026-07-01", to: "2026-07-31" } };

let ctx: ReturnType<typeof connectorContext>;
beforeEach(() => {
  ctx = connectorContext();
  // local org-people snapshot: the user grain enumerates these members
  const orgId = upsertOrg(ctx.db, { id: 1, login: "acme" });
  for (const [id, login] of [
    [7, "mario"],
    [8, "anna"],
  ] as const) {
    const userId = upsertUser(ctx.db, { id, login });
    ctx.db.query("INSERT INTO org_members(org_id, user_id) VALUES (?1, ?2)").run(orgId, userId);
  }
});
afterEach(() => ctx.db.close());

const connector = () => premiumRequestsConnector(() => TEST_NOW);

async function syncOnce() {
  const c = connector();
  for await (const b of c.fetch(gap, fakeGitHub(fixtures), ctx)) c.upsert(ctx.db, b);
}

describe("monthsOf", () => {
  it("lists inclusive months with their last day", () => {
    expect(monthsOf("2026-06-15", "2026-08-01")).toEqual([
      { year: 2026, month: 6, lastDay: "2026-06-30" },
      { year: 2026, month: 7, lastDay: "2026-07-31" },
      { year: 2026, month: 8, lastDay: "2026-08-31" },
    ]);
  });
});

describe("premium-requests connector", () => {
  it("produces org day rows and user month rows; same-model items are summed", async () => {
    await syncOnce();
    const rs = connector().select(ctx.db, q);
    expect(rs.columns.map((c) => c.name)).toEqual([
      "day",
      "user_login",
      "model",
      "requests",
      "multiplier",
      "gross_usd",
      "net_usd",
    ]);
    expect(rs.rows).toEqual([
      // org × model, day grain (60+40 summed), GPT-5.4 multiplier 6 from seed
      ["2026-07-01", null, "GPT-5.4", 100, 6, 24, 24],
      // user × model on the month's last day
      ["2026-07-31", "anna", "Mystery-1", 10, 1, 0.5, 0],
      ["2026-07-31", "mario", "GPT-5.4", 100, 6, 24, 20],
    ]);
  });

  it("unknown model stores multiplier 1 and notifies with a model-keyed dedupe key", async () => {
    await syncOnce();
    const unknown = ctx.notes.filter(
      (n) => n.key === "data.premium-requests.unknown-model.Mystery-1",
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.level).toBe("warning");
  });

  it("enumerates members from the API when org-people has not synced yet", async () => {
    const fresh = connectorContext(); // no org_members seeded
    try {
      const withMembers = structuredClone(fixtures) as typeof fixtures & {
        pages: Record<string, unknown[][]>;
      };
      withMembers.pages = {
        "/orgs/acme/members": [
          [
            { id: 7, login: "mario" },
            { id: 8, login: "anna" },
          ],
        ],
      };
      const c = connector();
      for await (const b of c.fetch(gap, fakeGitHub(withMembers), fresh)) c.upsert(fresh.db, b);
      const rs = c.select(fresh.db, q);
      expect(rs.rows.filter((r) => r[1] !== null).map((r) => r[1])).toEqual(["anna", "mario"]);
    } finally {
      fresh.db.close();
    }
  });

  it("coverage: whole range when never synced, empty when fresh", () => {
    const c = connector();
    expect(c.coverage(ctx.db, q)).toEqual([{ scope: "acme", from: q.range.from, to: q.range.to }]);
    markSynced(
      ctx.db,
      "premium-requests",
      { scope: "acme", from: q.range.from, to: q.range.to },
      TEST_NOW,
    );
    expect(c.coverage(ctx.db, q)).toEqual([]);
  });

  it("computes amounts from domain math when the payload omits them", async () => {
    await syncOnce();
    // anna's Mystery-1: no amounts in payload; 10 requests (netQuantity), the
    // payload's 0.05 price, multiplier 1, all quota-covered (discountQuantity
    // 10) → gross 10×1×0.05=0.5, net 0
    const rs = connector().select(ctx.db, { ...q, filter: { user_login: "anna" } });
    expect(rs.rows).toEqual([["2026-07-31", "anna", "Mystery-1", 10, 1, 0.5, 0]]);
  });

  it("double upsert is idempotent", async () => {
    await syncOnce();
    const count = () =>
      (ctx.db.query("SELECT COUNT(*) n FROM usage_facts").get() as { n: number }).n;
    const before = count();
    await syncOnce();
    expect(count()).toBe(before);
  });

  it("a 404 day is skipped; both days were asked", async () => {
    const gh = fakeGitHub(fixtures);
    const c = connector();
    for await (const b of c.fetch(gap, gh, ctx)) c.upsert(ctx.db, b);
    expect(gh.calls).toContain(`GET ${USAGE}?day=2&month=7&year=2026`);
  });

  it("select honors filters and limit", async () => {
    await syncOnce();
    const c = connector();
    expect(c.select(ctx.db, { ...q, filter: { model: "GPT-5.4" } }).rows).toHaveLength(2);
    expect(c.select(ctx.db, { ...q, limit: 1 }).rows).toHaveLength(1);
  });
});
