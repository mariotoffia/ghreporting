import type { Migration } from "../migrate";

/**
 * A single-row settings table (T12-followup): persists the last org the user worked with,
 * so the Explorer prefills it after a restart and the background scheduler has a scope to
 * sync without GHR_ORG being set. `CHECK (id = 1)` keeps it a singleton; org NULL = unset.
 */
export default {
  id: "0007_app_config",
  sql: `
CREATE TABLE app_config(
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  org TEXT
);
INSERT INTO app_config(id, org) VALUES (1, NULL);
`,
} satisfies Migration;
