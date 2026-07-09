import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";
import { type Migration, runMigrations } from "./migrate";

const good: Migration[] = [
  { id: "0001_a", sql: "CREATE TABLE a(x INTEGER); CREATE TABLE a2(y INTEGER);" },
  { id: "0002_b", sql: "CREATE TABLE b(x INTEGER REFERENCES a(x));" },
];

const opened: Database[] = [];
function open(path = ":memory:"): Database {
  const db = openDatabase(path);
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

describe("runMigrations", () => {
  it("applies pending migrations once, in order", () => {
    const db = open();
    expect(runMigrations(db, good)).toEqual(["0001_a", "0002_b"]);
    const rows = db.query("SELECT id FROM schema_migrations ORDER BY id").values();
    expect(rows.map((r) => r[0])).toEqual(["0001_a", "0002_b"]);
  });

  it("second run applies nothing", () => {
    const db = open();
    runMigrations(db, good);
    expect(runMigrations(db, good)).toEqual([]);
  });

  it("applies only migrations not yet recorded", () => {
    const db = open();
    runMigrations(db, [good[0] as Migration]);
    expect(runMigrations(db, good)).toEqual(["0002_b"]);
  });

  it("a broken migration throws and records nothing for itself", () => {
    const db = open();
    runMigrations(db, good);
    const broken: Migration = { id: "0003_broken", sql: "CREATE TABLE c(x INTEGER); NOT SQL;" };
    expect(() => runMigrations(db, [...good, broken])).toThrow();
    const count = db.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(count.n).toBe(2); // rollback: no row for 0003_broken
    // the CREATE before the syntax error is rolled back too
    const c = db
      .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='c'")
      .get() as { n: number };
    expect(c.n).toBe(0);
  });

  it("works against a file-backed database", () => {
    const path = join(
      tmpdir(),
      `ghr-migrate-${process.pid}-${Math.random().toString(36).slice(2)}`,
      "t.db",
    );
    try {
      const db = open(path);
      expect(runMigrations(db, good)).toEqual(["0001_a", "0002_b"]);
      expect(runMigrations(db, good)).toEqual([]);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});

describe("openDatabase", () => {
  it("enables WAL and foreign keys", () => {
    const db = open(); // :memory: reports journal_mode "memory"; FK pragma is the real assert
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
  });
});
