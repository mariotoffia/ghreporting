import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

describe("0006_query_datasets migration", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, migrations);
  });

  it("creates the query_datasets table with the declared columns", () => {
    const cols = (
      db.query("PRAGMA table_info(query_datasets)").all() as { name: string; notnull: number }[]
    ).map((c) => ({ name: c.name, notnull: c.notnull }));
    expect(cols).toEqual([
      { name: "id", notnull: 0 }, // PRIMARY KEY, but sqlite reports notnull=0 for INTEGER/TEXT PK
      { name: "title", notnull: 1 },
      { name: "description", notnull: 0 },
      { name: "sql", notnull: 1 },
      { name: "columns", notnull: 1 },
      { name: "created_at", notnull: 1 },
      { name: "updated_at", notnull: 1 },
    ]);
  });

  it("is idempotent — a second run applies nothing", () => {
    expect(runMigrations(db, migrations)).toEqual([]);
  });
});
