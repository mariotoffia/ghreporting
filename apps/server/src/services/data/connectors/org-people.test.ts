import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Gap } from "../ports";
import { orgPeopleConnector } from "./org-people";
import { connectorContext, fakeGitHub, TEST_NOW } from "./testutil";

// Checked-in fixture: 3 members, two teams (web under eng), bob teamless.
const fixtures = {
  gets: {
    "/orgs/acme": { id: 1, login: "acme", name: "Acme Inc" },
  },
  pages: {
    "/orgs/acme/members": [
      [
        { id: 7, login: "mario" },
        { id: 8, login: "anna" },
      ],
      [{ id: 9, login: "bob" }],
    ],
    "/orgs/acme/teams": [
      [
        { id: 100, slug: "eng", name: "Engineering", parent: null },
        { id: 101, slug: "web", name: "Web", parent: { id: 100, slug: "eng" } },
      ],
    ],
    "/orgs/acme/teams/eng/members": [[{ id: 7, login: "mario" }]],
    "/orgs/acme/teams/web/members": [[{ id: 8, login: "anna" }]],
  },
};

const gap: Gap = { scope: "acme", from: "2026-07-01", to: "2026-07-09" };
const q = { org: "acme", range: { from: "2026-07-01", to: "2026-07-09" } };

let ctx: ReturnType<typeof connectorContext>;
beforeEach(() => {
  ctx = connectorContext();
});
afterEach(() => ctx.db.close());

const connector = () => orgPeopleConnector(() => TEST_NOW);

async function syncOnce(c = connector()) {
  for await (const batch of c.fetch(gap, fakeGitHub(fixtures), ctx)) {
    c.upsert(ctx.db, batch);
  }
}

describe("org-people connector", () => {
  it("fetches members, teams, and per-team members into one snapshot batch", async () => {
    const gh = fakeGitHub(fixtures);
    const c = connector();
    const batches: Record<string, unknown>[][] = [];
    for await (const b of c.fetch(gap, gh, ctx)) batches.push(b);
    expect(batches).toHaveLength(1); // wholesale snapshot: one batch
    expect(gh.calls).toEqual([
      "GET /orgs/acme",
      "PAGINATE /orgs/acme/members",
      "PAGINATE /orgs/acme/teams",
      "PAGINATE /orgs/acme/teams/eng/members",
      "PAGINATE /orgs/acme/teams/web/members",
    ]);
  });

  it("upsert + select: teamless members get NULL team columns, hierarchy resolves", async () => {
    await syncOnce();
    const rs = connector().select(ctx.db, q);
    expect(rs.columns.map((c) => c.name)).toEqual([
      "user_login",
      "user_name",
      "team_slug",
      "team_name",
      "parent_team_slug",
    ]);
    expect(rs.rows).toEqual([
      ["anna", null, "web", "Web", "eng"],
      ["bob", null, null, null, null],
      ["mario", null, "eng", "Engineering", null],
    ]);
  });

  it("double upsert is idempotent (sets, not event logs)", async () => {
    await syncOnce();
    await syncOnce();
    const n = (t: string) => (ctx.db.query(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    expect(n("org_members")).toBe(3);
    expect(n("team_members")).toBe(2);
    expect(n("teams")).toBe(2);
    expect(n("users")).toBe(3);
  });

  it("a member who left disappears on the next sync (wholesale replace)", async () => {
    await syncOnce();
    const c = connector();
    const smaller = structuredClone(fixtures);
    smaller.pages["/orgs/acme/members"] = [[{ id: 7, login: "mario" }]];
    smaller.pages["/orgs/acme/teams/web/members"] = [[]];
    for await (const b of c.fetch(gap, fakeGitHub(smaller), ctx)) c.upsert(ctx.db, b);
    const rs = c.select(ctx.db, q);
    expect(rs.rows.map((r) => r[0])).toEqual(["mario"]);
  });

  it("select honors filter and limit", async () => {
    await syncOnce();
    const c = connector();
    expect(c.select(ctx.db, { ...q, filter: { team_slug: "web" } }).rows).toEqual([
      ["anna", null, "web", "Web", "eng"],
    ]);
    expect(c.select(ctx.db, { ...q, filter: { user_login: ["bob", "mario"] } }).rows).toHaveLength(
      2,
    );
    expect(c.select(ctx.db, { ...q, limit: 1 }).rows).toHaveLength(1);
  });

  it("coverage is one whole-scope gap until synced, then empty while fresh", async () => {
    const c = connector();
    expect(c.coverage(ctx.db, q)).toEqual([{ scope: "acme", from: q.range.from, to: q.range.to }]);
  });
});
