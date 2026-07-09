import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";
import { ensureSku, insertFactSql, modelPriceOn, upsertOrg, upsertTeam, upsertUser } from "./dims";
import { runMigrations } from "./migrate";
import { migrations } from "./migrations";

let db: Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db, migrations);
});
afterEach(() => db.close());

function insertFact(
  quantity: number,
  opts: { userId?: number | null; model?: string | null } = {},
) {
  const orgId = upsertOrg(db, { id: 1, login: "acme" });
  const skuId = ensureSku(db, "copilot", "copilot_metrics");
  db.query(insertFactSql).run(
    "2026-07-01",
    orgId,
    opts.userId ?? null,
    skuId,
    opts.model ?? null,
    "code_suggestions",
    quantity,
    "count",
    1,
    null,
    null,
    "copilot-metrics",
    null,
  );
}

describe("schema v1", () => {
  it("re-upserting an org-level fact (NULL user, NULL model) keeps one row, updates quantity", () => {
    insertFact(10);
    insertFact(25);
    const rows = db.query("SELECT quantity FROM usage_facts").all() as { quantity: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity).toBe(25);
  });

  it("facts differing only in user or model are distinct rows", () => {
    insertFact(1);
    insertFact(2, { userId: upsertUser(db, { id: 7, login: "mario" }) });
    insertFact(3, { model: "gpt-4.1" });
    expect((db.query("SELECT COUNT(*) n FROM usage_facts").get() as { n: number }).n).toBe(3);
  });

  it("deleting a workbook cascades to its bindings", () => {
    db.query(
      "INSERT INTO workbooks(id, name, snapshot, updated_at) VALUES ('w1','r','{}','2026-01-01')",
    ).run();
    db.query(
      "INSERT INTO bindings(id, workbook_id, sheet, range, dataset, query, updated_at) VALUES ('b1','w1','Sheet1','A1:B2','premium-requests','{}','2026-01-01')",
    ).run();
    db.query("DELETE FROM workbooks WHERE id='w1'").run();
    expect((db.query("SELECT COUNT(*) n FROM bindings").get() as { n: number }).n).toBe(0);
  });

  it("seeds the copilot product and its skus", () => {
    expect(ensureSku(db, "copilot", "copilot_premium_request")).toBeGreaterThan(0);
    expect((db.query("SELECT COUNT(*) n FROM products").get() as { n: number }).n).toBe(1);
  });
});

describe("dims helpers", () => {
  it("upsertOrg/upsertUser return the stable id and keep name when update passes null", () => {
    const a = upsertOrg(db, { id: 42, login: "acme", name: "Acme Inc" });
    expect(upsertOrg(db, { id: 42, login: "acme" })).toBe(a);
    expect((db.query("SELECT name FROM orgs WHERE id=42").get() as { name: string }).name).toBe(
      "Acme Inc",
    );
    const u = upsertUser(db, { id: 9, login: "mario", name: "Mario" });
    expect(upsertUser(db, { id: 9, login: "mario", name: null })).toBe(u);
  });

  it("upsertTeam conflicts on (org_id, slug) and tracks the parent team", () => {
    const orgId = upsertOrg(db, { id: 1, login: "acme" });
    const parent = upsertTeam(db, { id: 100, orgId, slug: "eng", name: "Engineering" });
    const child = upsertTeam(db, {
      id: 101,
      orgId,
      slug: "web",
      name: "Web",
      parentTeamId: parent,
    });
    expect(
      upsertTeam(db, { id: 101, orgId, slug: "web", name: "Web v2", parentTeamId: parent }),
    ).toBe(child);
    const row = db.query("SELECT name, parent_team_id FROM teams WHERE id=101").get() as {
      name: string;
      parent_team_id: number;
    };
    expect(row.name).toBe("Web v2");
    expect(row.parent_team_id).toBe(100);
  });

  it("ensureSku is idempotent per (product, sku)", () => {
    const id = ensureSku(db, "actions", "actions_linux");
    expect(ensureSku(db, "actions", "actions_linux")).toBe(id);
    expect(ensureSku(db, "actions", "actions_windows")).not.toBe(id);
  });

  it("modelPriceOn picks the price valid on the fact's day", () => {
    db.query(
      "INSERT INTO model_prices(model, valid_from, multiplier, price_per_unit_usd) VALUES ('test-model','2025-06-01',1,0.04),('test-model','2026-07-01',2,0.05)",
    ).run();
    expect(modelPriceOn(db, "test-model", "2026-06-30")).toEqual({ multiplier: 1, priceUsd: 0.04 });
    expect(modelPriceOn(db, "test-model", "2026-07-01")).toEqual({ multiplier: 2, priceUsd: 0.05 });
    expect(modelPriceOn(db, "test-model", "2025-05-31")).toBeNull();
    expect(modelPriceOn(db, "unknown", "2026-01-01")).toBeNull();
  });

  it("seeded model_prices exist from GitHub's published multiplier table", () => {
    const n = (db.query("SELECT COUNT(*) n FROM model_prices").get() as { n: number }).n;
    expect(n).toBeGreaterThan(5);
    const base = modelPriceOn(db, "gpt-4.1", "2026-07-01");
    expect(base?.priceUsd).toBe(0.04);
  });

  it("all of it works on a file-backed database too", () => {
    const dir = join(tmpdir(), `ghr-dims-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const fdb = openDatabase(join(dir, "t.db"));
    try {
      runMigrations(fdb, migrations);
      const orgId = upsertOrg(fdb, { id: 1, login: "acme" });
      expect(orgId).toBe(1);
    } finally {
      fdb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
