// T9.1 + T9.2 — the Copilot Spend report is a single self-contained Report Definition whose
// spend aggregations are embedded query-dataset SQL (ADR 0017). This validates the seed, provisions
// its datasets over seeded facts, and asserts the aggregates — no views, no connector code.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExport, toExport, validateDefinition } from "@ghreporting/domain";
import { openDatabase, openReadOnly } from "../../../adapters/db/database";
import { runMigrations } from "../../../adapters/db/migrate";
import { migrations } from "../../../adapters/db/migrations";
import type { DatasetQuery } from "../../data/ports";
import { type QueryDatasetRow, queryDatasetConnector } from "../../data/query-dataset";
import { createQueryDatasetRegistry } from "../../data/query-dataset-registry";
import seed from "./copilot-spend.json";

let rw: Database;
let ro: Database;

const q = (over: Partial<DatasetQuery> = {}): DatasetQuery => ({
  org: "acme",
  range: { from: "2026-01-01", to: "2026-06-30" },
  limit: 1000,
  ...over,
});

/** Run one provisioned dataset by id and return its rows. */
function run(id: string, query = q()): unknown[][] {
  const row = rw.query("SELECT * FROM query_datasets WHERE id=?").get(id) as QueryDatasetRow;
  return queryDatasetConnector(row, ro).select(rw, query).rows;
}

beforeEach(() => {
  const path = join(mkdtempSync(join(tmpdir(), "ghr-spend-")), "ghreporting.db");
  rw = openDatabase(path);
  runMigrations(rw, migrations);
  const skuId = (
    rw.query("SELECT id FROM skus WHERE name='copilot_premium_request'").get() as {
      id: number;
    }
  ).id;
  rw.exec(`
    INSERT INTO orgs(id, login) VALUES (1, 'acme'), (2, 'other');
    INSERT INTO users(id, login) VALUES (10, 'alice'), (11, 'bob');
    INSERT INTO teams(id, org_id, slug) VALUES (100, 1, 'core'), (101, 1, 'platform');
    INSERT INTO team_members(team_id, user_id) VALUES (100, 10), (101, 10), (100, 11);
  `);
  const fact = (
    day: string,
    userId: number | null,
    model: string,
    qty: number,
    gross: number,
    net: number,
  ) =>
    rw
      .query(
        `INSERT INTO usage_facts(day, org_id, user_id, sku_id, model, metric, quantity, unit, gross_amount_usd, net_amount_usd, source)
         VALUES (?1, 1, ?2, ${skuId}, ?3, 'premium_requests', ?4, 'request', ?5, ?6, 'test')`,
      )
      .run(day, userId, model, qty, gross, net);
  fact("2026-03-10", 10, "Claude Sonnet 4.5", 5, 2.0, 0); // alice, quota-covered (net 0)
  fact("2026-03-20", 10, "Claude Sonnet 4.5", 3, 1.2, 1.2); // alice, overage
  fact("2026-03-15", 11, "GPT-5", 10, 4.0, 4.0); // bob
  fact("2026-03-01", null, "GPT-5", 2, 0.8, 0.5); // org-level (user NULL)
  ro = openReadOnly(path);
  // Provision the seed's embedded datasets, exactly as the reports service does on init.
  const reg = createQueryDatasetRegistry({
    db: () => rw,
    roDb: ro,
    isBuiltin: () => false,
    now: () => new Date("2026-07-10T00:00:00Z"),
  });
  reg.provision(validateDefinition(seed.definition).datasets ?? []);
});
afterEach(() => {
  ro.close();
  rw.close();
});

describe("Copilot Spend seed", () => {
  it("is a valid definition embedding both spend datasets", () => {
    const def = validateDefinition(seed.definition);
    expect(def.datasets?.map((d) => d.id)).toEqual([
      "spend-by-user-model-month",
      "spend-by-team-month",
    ]);
    expect(def.panels.map((p) => p.dataset)).toEqual([
      "spend-by-user-model-month",
      "spend-by-user-model-month",
      "spend-by-team-month",
    ]);
  });

  it("exports and re-imports preserving the embedded datasets (portable)", () => {
    const def = validateDefinition(seed.definition);
    expect(parseExport(toExport("Copilot Spend", null, def)).definition).toEqual(def);
  });

  it("spend-by-user-model-month sums quantity and net per user/model/month", () => {
    // columns: month, user, model, requests, gross_usd, net_usd
    const rows = run("spend-by-user-model-month");
    expect(rows).toEqual([
      ["2026-03", null, "GPT-5", 2, 0.8, 0.5], // org-level rolls up under user NULL
      ["2026-03", "alice", "Claude Sonnet 4.5", 8, 3.2, 1.2], // 5+3 reqs, net 0+1.2
      ["2026-03", "bob", "GPT-5", 10, 4, 4],
    ]);
  });

  it("spend-by-team-month counts a two-team user in both teams, excludes org-level facts", () => {
    // columns: month, team, model, requests, net_usd
    const rows = run("spend-by-team-month");
    expect(rows).toEqual([
      ["2026-03", "core", "Claude Sonnet 4.5", 8, 1.2], // alice via core
      ["2026-03", "core", "GPT-5", 10, 4], // bob via core
      ["2026-03", "platform", "Claude Sonnet 4.5", 8, 1.2], // alice via platform (counted again)
    ]);
    // org-level (user NULL) never joins team_members → excluded from the team dataset.
    expect(rows.some((r) => r[3] === 2)).toBe(false);
  });

  it("filters by the :org parameter (a different org returns nothing)", () => {
    expect(run("spend-by-user-model-month", q({ org: "other" }))).toEqual([]);
  });

  it("clamps to the :from/:to window", () => {
    expect(
      run("spend-by-user-model-month", q({ range: { from: "2026-04-01", to: "2026-06-30" } })),
    ).toEqual([]);
  });
});
