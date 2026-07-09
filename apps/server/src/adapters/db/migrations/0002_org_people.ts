import type { Migration } from "../migrate";

/**
 * Org membership as a set. Schema v1 links users to orgs only through teams
 * (team_members) or facts — but the org-people dataset must list members who
 * belong to no team, so membership needs its own table. Replaced wholesale
 * per sync, like team_members.
 */
export default {
  id: "0002_org_people",
  sql: `
CREATE TABLE org_members(
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(org_id, user_id));
`,
} satisfies Migration;
