import type { Migration } from "../migrate";

/** A Copilot seat is current state per (org, user), not a day fact. */
export default {
  id: "0003_copilot_seats",
  sql: `
CREATE TABLE copilot_seats(
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT, last_activity_at TEXT, last_activity_editor TEXT,
  plan_type TEXT, pending_cancellation_date TEXT,
  PRIMARY KEY(org_id, user_id));
`,
} satisfies Migration;
