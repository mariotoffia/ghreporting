import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Gap } from "../ports";
import { markSynced } from "../sync";
import { copilotSeatsConnector } from "./copilot-seats";
import { connectorContext, fakeGitHub, TEST_NOW } from "./testutil";

const marioSeat = {
  assignee: { id: 7, login: "mario" },
  created_at: "2025-01-01T00:00:00Z",
  last_activity_at: "2026-07-08T10:00:00Z",
  last_activity_editor: "vscode/1.102.0/copilot/1.90.0",
  plan_type: "business",
  pending_cancellation_date: null,
};

const fixtures = {
  gets: { "/orgs/acme": { id: 1, login: "acme", name: "Acme Inc" } },
  pages: {
    "/orgs/acme/copilot/billing/seats": [
      [
        marioSeat,
        { assignee: null, created_at: "2025-01-01T00:00:00Z" }, // unassigned seat: skipped
      ],
      [
        {
          assignee: { id: 8, login: "anna" },
          created_at: "2025-02-01T00:00:00Z",
          last_activity_at: null,
          last_activity_editor: null,
          plan_type: "business",
          pending_cancellation_date: "2026-08-01",
        },
      ],
    ],
  },
};

const gap: Gap = { scope: "acme", from: "2026-07-01", to: "2026-07-09" };
const q = { org: "acme", range: { from: "2026-07-01", to: "2026-07-09" } };

let ctx: ReturnType<typeof connectorContext>;
beforeEach(() => {
  ctx = connectorContext();
});
afterEach(() => ctx.db.close());

const connector = () => copilotSeatsConnector(() => TEST_NOW);

async function syncOnce(fx = fixtures) {
  const c = connector();
  for await (const b of c.fetch(gap, fakeGitHub(fx), ctx)) c.upsert(ctx.db, b);
}

describe("copilot-seats connector", () => {
  it("parses paginated seats, skipping unassigned ones", async () => {
    await syncOnce();
    const rs = connector().select(ctx.db, q);
    expect(rs.columns.map((c) => c.name)).toEqual([
      "user_login",
      "created_at",
      "last_activity_at",
      "last_activity_editor",
      "plan_type",
      "pending_cancellation_date",
    ]);
    expect(rs.rows).toEqual([
      ["anna", "2025-02-01T00:00:00Z", null, null, "business", "2026-08-01"],
      [
        "mario",
        "2025-01-01T00:00:00Z",
        "2026-07-08T10:00:00Z",
        "vscode/1.102.0/copilot/1.90.0",
        "business",
        null,
      ],
    ]);
  });

  it("double upsert keeps one row per seat; a dropped seat disappears", async () => {
    await syncOnce();
    await syncOnce();
    expect((ctx.db.query("SELECT COUNT(*) n FROM copilot_seats").get() as { n: number }).n).toBe(2);
    const smaller = structuredClone(fixtures);
    smaller.pages["/orgs/acme/copilot/billing/seats"] = [[marioSeat]];
    await syncOnce(smaller);
    const rs = connector().select(ctx.db, q);
    expect(rs.rows.map((r) => r[0])).toEqual(["mario"]);
  });

  it("select honors filter and limit", async () => {
    await syncOnce();
    const c = connector();
    expect(c.select(ctx.db, { ...q, filter: { user_login: "anna" } }).rows).toHaveLength(1);
    expect(c.select(ctx.db, { ...q, limit: 1 }).rows).toHaveLength(1);
  });

  it("coverage: whole-scope gap when never synced, empty when fresh", async () => {
    const c = connector();
    expect(c.coverage(ctx.db, q)).toHaveLength(1);
    markSynced(ctx.db, "copilot-seats", gap, TEST_NOW);
    expect(c.coverage(ctx.db, q)).toEqual([]);
  });
});
