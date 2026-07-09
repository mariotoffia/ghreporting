import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Gap } from "../ports";
import { copilotMetricsConnector } from "./copilot-metrics";
import { connectorContext, fakeGitHub, ghError, TEST_NOW } from "./testutil";

const record = {
  day: "2026-07-01",
  organization_id: "1",
  daily_active_users: 5,
  code_generation_activity_count: 100,
  code_acceptance_activity_count: 60,
  loc_suggested_to_add_sum: 500,
  loc_added_sum: 300,
  totals_by_model_feature: [
    {
      model: "gpt-5.4",
      feature: "chat_panel_agent_mode",
      user_initiated_interaction_count: 25,
      code_generation_activity_count: 10,
    },
    { model: "gpt-5.4", feature: "chat_inline", user_initiated_interaction_count: 5 },
    { model: "claude-sonnet-4.6", feature: "chat_inline", user_initiated_interaction_count: 15 },
  ],
};

const fixtures = {
  gets: {
    "/orgs/acme/copilot/metrics/reports/organization-1-day?day=2026-07-01": {
      download_links: ["https://signed.example.com/r1.ndjson"],
      report_day: "2026-07-01",
    },
    // 2026-07-02: report not generated — legitimate missing day
    "/orgs/acme/copilot/metrics/reports/organization-1-day?day=2026-07-02": ghError(404),
  },
  downloads: {
    "https://signed.example.com/r1.ndjson": `${JSON.stringify(record)}\n`,
  },
};

const gap: Gap = { scope: "acme", from: "2026-07-01", to: "2026-07-02" };
const q = { org: "acme", range: { from: "2026-07-01", to: "2026-07-02" } };

let ctx: ReturnType<typeof connectorContext>;
beforeEach(() => {
  ctx = connectorContext();
});
afterEach(() => ctx.db.close());

const connector = () => copilotMetricsConnector(() => TEST_NOW);

async function syncOnce() {
  const c = connector();
  for await (const b of c.fetch(gap, fakeGitHub(fixtures), ctx)) c.upsert(ctx.db, b);
}

describe("copilot-metrics connector", () => {
  it("downloads the day report and flattens org totals + per-model chat activity", async () => {
    await syncOnce();
    const rs = connector().select(ctx.db, q);
    expect(rs.columns.map((c) => c.name)).toEqual(["day", "model", "metric", "quantity"]);
    expect(rs.rows).toEqual([
      ["2026-07-01", null, "code_acceptances", 60],
      ["2026-07-01", null, "code_lines_accepted", 300],
      ["2026-07-01", null, "code_lines_suggested", 500],
      ["2026-07-01", null, "code_suggestions", 100],
      ["2026-07-01", null, "engaged_users", 5],
      ["2026-07-01", "claude-sonnet-4.6", "chats", 15],
      ["2026-07-01", "gpt-5.4", "chats", 30],
      ["2026-07-01", "gpt-5.4", "code_suggestions", 10],
    ]);
  });

  it("a 404 day is skipped, not fatal (missing days are legitimate)", async () => {
    const c = connector();
    const gh = fakeGitHub(fixtures);
    const batches: unknown[] = [];
    for await (const b of c.fetch(gap, gh, ctx)) batches.push(b);
    expect(batches).toHaveLength(1); // only 2026-07-01 produced rows
    expect(gh.calls.filter((l) => l.startsWith("GET"))).toHaveLength(2); // both days asked
  });

  it("double upsert stays idempotent and updates quantities", async () => {
    await syncOnce();
    const before = (ctx.db.query("SELECT COUNT(*) n FROM usage_facts").get() as { n: number }).n;
    await syncOnce();
    expect((ctx.db.query("SELECT COUNT(*) n FROM usage_facts").get() as { n: number }).n).toBe(
      before,
    );
  });

  it("stores the day's raw record once, not per fact row", async () => {
    await syncOnce();
    const n = (
      ctx.db.query("SELECT COUNT(*) n FROM usage_facts WHERE raw IS NOT NULL").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
  });

  it("select honors range, filter, and limit", async () => {
    await syncOnce();
    const c = connector();
    expect(c.select(ctx.db, { ...q, filter: { model: "gpt-5.4", metric: "chats" } }).rows).toEqual([
      ["2026-07-01", "gpt-5.4", "chats", 30],
    ]);
    expect(c.select(ctx.db, { ...q, limit: 2 }).rows).toHaveLength(2);
    expect(
      c.select(ctx.db, { org: "acme", range: { from: "2026-07-02", to: "2026-07-02" } }).rows,
    ).toEqual([]);
  });
});
