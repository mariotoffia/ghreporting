// Dataset connector: org-people — who is in the org and which team they sit in.
// Endpoints: GET /orgs/{org}, /orgs/{org}/members, /orgs/{org}/teams,
// /orgs/{org}/teams/{team_slug}/members (all paginated).
// Auth: classic PAT scope `read:org` (fine-grained: organization Members read).
// Snapshot dataset: membership is a set, not an event log — team_members and
// org_members are replaced wholesale per sync.
import type { Database } from "bun:sqlite";
import { upsertOrg, upsertTeam, upsertUser } from "../../../adapters/db/dims";
import type { DatasetConnector, DatasetQuery, ResultSet } from "../ports";
import { filterSql, snapshotCoverage } from "./util";

const TTL_HOURS = 24;

interface GhUser {
  id: number;
  login: string;
  name?: string | null;
}
interface GhTeam {
  id: number;
  slug: string;
  name?: string | null;
  parent?: { id: number; slug: string } | null;
}

type Row =
  | { kind: "org"; id: number; login: string; name: string | null }
  | { kind: "user"; id: number; login: string; name: string | null; member: boolean }
  | { kind: "team"; id: number; slug: string; name: string | null; parent_id: number | null }
  | { kind: "membership"; team_id: number; user_id: number };

const COLUMNS = [
  { name: "user_login", type: "string", description: "GitHub login" },
  { name: "user_name", type: "string", description: "Display name, when public" },
  { name: "team_slug", type: "string", description: "Team the user belongs to (NULL if none)" },
  { name: "team_name", type: "string", description: "Team display name" },
  { name: "parent_team_slug", type: "string", description: "Parent team in the hierarchy" },
] as const;

export function orgPeopleConnector(now: () => Date): DatasetConnector {
  return {
    meta: {
      id: "org-people",
      title: "Organization people",
      description:
        "Members of the organization with their team memberships and team hierarchy. Members outside any team appear with empty team columns.",
      columns: [...COLUMNS],
      scope: "org-user",
      freshnessTtlHours: TTL_HOURS,
    },

    coverage(db, q) {
      return snapshotCoverage(db, "org-people", q, TTL_HOURS, now());
    },

    async *fetch(gap, gh) {
      const org = await gh.get<{ id: number; login: string; name?: string | null }>("/orgs/{org}", {
        org: gap.scope,
      });
      if (org.status !== 200) return;
      const rows: Row[] = [
        { kind: "org", id: org.data.id, login: org.data.login, name: org.data.name ?? null },
      ];
      for await (const page of gh.paginate<GhUser>("/orgs/{org}/members", { org: gap.scope })) {
        for (const m of page) {
          rows.push({ kind: "user", id: m.id, login: m.login, name: m.name ?? null, member: true });
        }
      }
      const teams: GhTeam[] = [];
      for await (const page of gh.paginate<GhTeam>("/orgs/{org}/teams", { org: gap.scope })) {
        teams.push(...page);
      }
      for (const t of teams) {
        rows.push({
          kind: "team",
          id: t.id,
          slug: t.slug,
          name: t.name ?? null,
          parent_id: t.parent?.id ?? null,
        });
      }
      for (const t of teams) {
        for await (const page of gh.paginate<GhUser>("/orgs/{org}/teams/{team_slug}/members", {
          org: gap.scope,
          team_slug: t.slug,
        })) {
          for (const m of page) {
            // team members can lag the members list; make sure the user row exists
            rows.push({
              kind: "user",
              id: m.id,
              login: m.login,
              name: m.name ?? null,
              member: false,
            });
            rows.push({ kind: "membership", team_id: t.id, user_id: m.id });
          }
        }
      }
      yield rows as unknown as Record<string, unknown>[];
    },

    upsert(db, batch) {
      const rows = batch as unknown as Row[];
      const org = rows.find((r): r is Extract<Row, { kind: "org" }> => r.kind === "org");
      if (!org) return;
      const orgId = upsertOrg(db, org);
      for (const r of rows) {
        if (r.kind === "user") upsertUser(db, r);
      }
      const teams = rows.filter((r): r is Extract<Row, { kind: "team" }> => r.kind === "team");
      // clear stale hierarchy links so a deleted-and-recreated team (same slug,
      // new id) can be dropped without tripping parent FK checks; pass 2 relinks
      db.query("UPDATE teams SET parent_team_id=NULL WHERE org_id=?1").run(orgId);
      const dropStale = db.query("DELETE FROM teams WHERE org_id=?1 AND slug=?2 AND id<>?3");
      for (const t of teams) {
        dropStale.run(orgId, t.slug, t.id);
        upsertTeam(db, { id: t.id, orgId, slug: t.slug, name: t.name, parentTeamId: null });
      }
      const setParent = db.query("UPDATE teams SET parent_team_id=?1 WHERE id=?2");
      for (const t of teams) {
        if (t.parent_id !== null) setParent.run(t.parent_id, t.id);
      }
      // membership is a set: replace the org's rows wholesale
      db.query(
        "DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE org_id=?1)",
      ).run(orgId);
      db.query("DELETE FROM org_members WHERE org_id=?1").run(orgId);
      const addTeamMember = db.query(
        "INSERT OR IGNORE INTO team_members(team_id, user_id) VALUES (?1, ?2)",
      );
      const addOrgMember = db.query(
        "INSERT OR IGNORE INTO org_members(org_id, user_id) VALUES (?1, ?2)",
      );
      for (const r of rows) {
        if (r.kind === "membership") addTeamMember.run(r.team_id, r.user_id);
        if (r.kind === "user" && r.member) addOrgMember.run(orgId, r.id);
      }
    },

    select(db: Database, q: DatasetQuery): ResultSet {
      const f = filterSql(
        {
          user_login: "u.login",
          user_name: "u.name",
          team_slug: "t.slug",
          team_name: "t.name",
          parent_team_slug: "p.slug",
        },
        q.filter,
      );
      const rows = db
        .query(
          `SELECT u.login AS user_login, u.name AS user_name, t.slug AS team_slug,
                  t.name AS team_name, p.slug AS parent_team_slug
           FROM org_members m
           JOIN orgs o ON o.id = m.org_id
           JOIN users u ON u.id = m.user_id
           LEFT JOIN team_members tm ON tm.user_id = u.id
             AND tm.team_id IN (SELECT id FROM teams WHERE org_id = m.org_id)
           LEFT JOIN teams t ON t.id = tm.team_id
           LEFT JOIN teams p ON p.id = t.parent_team_id
           WHERE o.login = ?${f.sql}
           ORDER BY u.login, t.slug
           LIMIT ?`,
        )
        .values(q.org, ...f.params, q.limit ?? -1);
      return { columns: [...COLUMNS], rows };
    },
  };
}
