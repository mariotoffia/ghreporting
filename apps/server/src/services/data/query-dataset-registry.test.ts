import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openReadOnly } from "../../adapters/db/database";
import { runMigrations } from "../../adapters/db/migrate";
import { migrations } from "../../adapters/db/migrations";
import { ValidationError } from "../../kernel/errors";
import { createQueryDatasetRegistry, type QueryDatasetRegistry } from "./query-dataset-registry";

let rw: Database;
let ro: Database;
let reg: QueryDatasetRegistry;
let clock = "2026-07-10T00:00:00.000Z";

const rows = () =>
  rw.query("SELECT id, sql, created_at, updated_at FROM query_datasets ORDER BY id").all() as {
    id: string;
    sql: string;
    created_at: string;
    updated_at: string;
  }[];

beforeEach(() => {
  const path = join(mkdtempSync(join(tmpdir(), "ghr-reg-")), "ghreporting.db");
  rw = openDatabase(path);
  runMigrations(rw, migrations);
  rw.exec("CREATE TABLE nums(n); INSERT INTO nums VALUES (1),(2),(3);");
  ro = openReadOnly(path);
  clock = "2026-07-10T00:00:00.000Z";
  reg = createQueryDatasetRegistry({
    db: () => rw,
    roDb: ro,
    isBuiltin: (id) => id === "premium-requests",
    now: () => new Date(clock),
  });
});
afterEach(() => {
  ro.close();
  rw.close();
});

describe("QueryDatasetRegistry.provision", () => {
  it("derives columns and inserts a new dataset", () => {
    reg.provision([{ id: "a", title: "A", sql: "SELECT n FROM nums" }]);
    const r = rows();
    expect(r.map((x) => x.id)).toEqual(["a"]);
    const stored = rw.query("SELECT columns FROM query_datasets WHERE id='a'").get() as {
      columns: string;
    } | null;
    const cols = JSON.parse(stored?.columns ?? "[]");
    expect(cols).toEqual([{ name: "n", type: "number", description: "" }]);
  });

  it("overwrites on re-provision but preserves created_at", () => {
    reg.provision([{ id: "a", title: "A", sql: "SELECT n FROM nums" }]);
    clock = "2026-08-01T00:00:00.000Z";
    reg.provision([{ id: "a", title: "A2", sql: "SELECT n AS m FROM nums" }]);
    const [r] = rows();
    expect(r?.sql).toBe("SELECT n AS m FROM nums");
    expect(r?.created_at).toBe("2026-07-10T00:00:00.000Z"); // unchanged
    expect(r?.updated_at).toBe("2026-08-01T00:00:00.000Z"); // bumped
  });

  it("rejects a built-in id with a 409 and writes nothing", () => {
    expect(() => reg.provision([{ id: "premium-requests", title: "x", sql: "SELECT 1" }])).toThrow(
      expect.objectContaining({ code: "dataset.reserved", status: 409 }),
    );
    expect(rows()).toHaveLength(0);
  });

  it("rejects bad/writing SQL (400) and applies NOTHING when any def in the batch is bad", () => {
    expect(() =>
      reg.provision([
        { id: "good", title: "g", sql: "SELECT n FROM nums" },
        { id: "bad", title: "b", sql: "DELETE FROM nums" },
      ]),
    ).toThrow(ValidationError);
    expect(rows()).toHaveLength(0); // validate-all-before-write: 'good' not inserted either
    expect(rw.query("SELECT count(*) AS c FROM nums").get()).toEqual({ c: 3 }); // untouched
  });
});

describe("QueryDatasetRegistry.sweep", () => {
  it("deletes rows not referenced, keeps referenced ones", () => {
    reg.provision([
      { id: "keep", title: "K", sql: "SELECT n FROM nums" },
      { id: "drop", title: "D", sql: "SELECT n FROM nums" },
    ]);
    reg.sweep(new Set(["keep"]));
    expect(rows().map((r) => r.id)).toEqual(["keep"]);
  });

  it("empty referenced set deletes everything", () => {
    reg.provision([{ id: "a", title: "A", sql: "SELECT n FROM nums" }]);
    reg.sweep(new Set());
    expect(rows()).toHaveLength(0);
  });
});
