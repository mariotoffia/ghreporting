import type { Migration } from "../migrate";

/**
 * Report Definitions (ADR 0014, DDD.md §3.7): one self-contained JSON document per
 * report. No child tables — a definition is a document, never queried server-side; the
 * frontend GETs it, compiles, and executes. `description` is nullable; the rest is
 * mandatory. Copilot Spend seeds here on init under the stable id `copilot-spend`.
 */
export default {
  id: "0004_reports",
  sql: `
CREATE TABLE reports(
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  definition  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`,
} satisfies Migration;
