import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openReadOnly } from "../../adapters/db/database";
import { runMigrations } from "../../adapters/db/migrate";
import { migrations } from "../../adapters/db/migrations";
import { createEventBus } from "../../kernel/bus";
import { loadConfig } from "../../kernel/config";
import { createContext } from "../../kernel/context";
import { ValidationError } from "../../kernel/errors";
import { nullLogger } from "../../kernel/testutil";
import type { DatasetConnector, DatasetQuery, GitHubClient } from "./ports";
import { deriveColumns, type QueryDatasetRow, queryDatasetConnector } from "./query-dataset";
import { createDataService } from "./service";

// Query datasets need a real file so the read-only handle shares the write handle's data
// (`:memory:` opens a *separate* db per handle). One temp file per test, both handles closed
// in afterEach so no handle leaks (TESTS.md §2.5).
let rw: Database;
let ro: Database;

const q = (over: Partial<DatasetQuery> = {}): DatasetQuery => ({
  org: "acme",
  range: { from: "2026-01-01", to: "2026-12-31" },
  limit: 1000,
  ...over,
});

const row = (over: Partial<QueryDatasetRow> = {}): QueryDatasetRow => ({
  id: "ds",
  title: "Dataset",
  description: null,
  sql: "SELECT n FROM nums ORDER BY n",
  columns: JSON.stringify([{ name: "n", type: "number", description: "" }]),
  created_at: "2026-07-10T00:00:00.000Z",
  updated_at: "2026-07-10T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  const path = join(mkdtempSync(join(tmpdir(), "ghr-qd-")), "ghreporting.db");
  rw = openDatabase(path);
  runMigrations(rw, migrations);
  rw.exec("CREATE TABLE nums(n INTEGER); INSERT INTO nums VALUES (1),(2),(3),(4),(5);");
  ro = openReadOnly(path);
});
afterEach(() => {
  ro.close();
  rw.close();
});

describe("deriveColumns", () => {
  it("derives names and infers types from a SELECT", () => {
    const cols = deriveColumns(
      ro,
      "SELECT :org AS org, 3 AS requests, '2026-01-01' AS day, 'x' AS label",
    );
    expect(cols).toEqual([
      { name: "org", type: "string", description: "" },
      { name: "requests", type: "number", description: "" },
      { name: "day", type: "date", description: "" },
      { name: "label", type: "string", description: "" },
    ]);
  });

  it("rejects a DELETE with ValidationError (never runs it)", () => {
    expect(() => deriveColumns(ro, "DELETE FROM nums")).toThrow(ValidationError);
    expect(rw.query("SELECT count(*) AS c FROM nums").get()).toEqual({ c: 5 });
  });

  it("rejects DROP TABLE and malformed SQL with ValidationError", () => {
    expect(() => deriveColumns(ro, "DROP TABLE nums")).toThrow(ValidationError);
    expect(() => deriveColumns(ro, "SELECT FROM WHERE")).toThrow(ValidationError);
  });

  it("infers real types from a matching sample when org/range are supplied", () => {
    // A parameterized SELECT: with the empty probe it matches nothing → all "string"; with the
    // sample that matches the seeded row it infers number/date correctly.
    const sql = "SELECT n AS cnt, '2026-01-01' AS day FROM nums WHERE :org = 'acme' ORDER BY n";
    const probed = deriveColumns(ro, sql);
    expect(probed.map((c) => c.type)).toEqual(["string", "string"]); // probe org="" → no rows
    const sampled = deriveColumns(ro, sql, { org: "acme", from: "2026-01-01", to: "2026-12-31" });
    expect(sampled.map((c) => c.type)).toEqual(["number", "date"]);
  });
});

describe("queryDatasetConnector", () => {
  it("never syncs — coverage() is empty", () => {
    expect(queryDatasetConnector(row(), ro).coverage(rw, q())).toEqual([]);
  });

  it("select() runs on the read-only handle and clamps the limit", () => {
    const rs = queryDatasetConnector(row(), ro).select(rw, q({ limit: 2 }));
    expect(rs.columns).toEqual([{ name: "n", type: "number", description: "" }]);
    expect(rs.rows).toEqual([[1], [2]]);
  });

  it("caps returned rows at the limit even when the SQL closes the wrapper paren", () => {
    // Adversarial: `SELECT n FROM nums) --` escapes the `SELECT * FROM ( … ) LIMIT n` wrapper
    // and drops the SQL LIMIT. The JS slice must still cap returned rows (no write is possible).
    const c = queryDatasetConnector(row({ sql: "SELECT n FROM nums) --" }), ro);
    expect(c.select(rw, q({ limit: 2 })).rows).toHaveLength(2);
    expect(rw.query("SELECT count(*) AS c FROM nums").get()).toEqual({ c: 5 }); // untouched
  });

  it("select() translates a runtime SQLite error to a 400 AppError (not an uncaught 500)", () => {
    // Passes derive-time validation (probe org="" takes the safe CASE branch), throws at real
    // query time (json_extract on a non-JSON org). Must surface as a 400, never a raw 500.
    const sql = "SELECT CASE WHEN :org = '' THEN 1 ELSE json_extract(:org, '$.a') END AS x";
    const c = queryDatasetConnector(row({ sql }), ro);
    expect(() => c.select(rw, q({ org: "not-json" }))).toThrow(
      expect.objectContaining({ code: "dataset.query_failed", status: 400 }),
    );
  });

  it("select() clamps a negative/zero limit to at least 1 row (no unlimited SQL LIMIT)", () => {
    const c = queryDatasetConnector(row(), ro); // sql selects 5 rows
    expect(c.select(rw, q({ limit: -5 })).rows).toHaveLength(1);
    expect(c.select(rw, q({ limit: 0 })).rows).toHaveLength(1);
  });

  it("select() binds org/from/to", () => {
    const c = queryDatasetConnector(row({ sql: "SELECT :org AS org, :from AS f, :to AS t" }), ro);
    expect(c.select(rw, q({ org: "globex" })).rows).toEqual([
      ["globex", "2026-01-01", "2026-12-31"],
    ]);
  });

  it("fetch() and upsert() throw dataset.readonly", async () => {
    const c = queryDatasetConnector(row(), ro);
    expect(() => c.upsert(rw, [])).toThrow(/read-only/);
    const gen = c.fetch({ scope: "acme", from: "x", to: "y" }, {} as never, {} as never);
    await expect(gen[Symbol.asyncIterator]().next()).rejects.toThrow(/read-only/);
  });
});

// The `data` service treats a stored query dataset as first-class: resolvable and listed with
// no re-init. Build the real service over the shared file handles from beforeEach.
describe("data service query-dataset integration", () => {
  const fake: DatasetConnector = {
    meta: {
      id: "premium-requests-fake",
      title: "Fake built-in",
      description: "",
      columns: [{ name: "n", type: "number", description: "" }],
      scope: "org",
      freshnessTtlHours: 24,
    },
    coverage: () => [],
    fetch: async function* () {},
    upsert: () => {},
    select: () => ({ columns: [], rows: [] }),
  };

  function buildService() {
    const { ctx } = createContext({
      db: rw,
      bus: createEventBus(nullLogger()),
      config: {
        ...loadConfig({ GHR_DB_PATH: ":memory:" }),
        now: () => new Date("2026-07-10T00:00:00Z"),
      },
      log: nullLogger(),
    });
    const svc = createDataService({ gh: {} as GitHubClient, roDb: ro, connectors: [fake] });
    svc.init(ctx);
    return svc;
  }

  function insertRow(r: QueryDatasetRow = row()) {
    rw.query(
      "INSERT INTO query_datasets(id,title,description,sql,columns,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(r.id, r.title, r.description, r.sql, r.columns, r.created_at, r.updated_at);
  }

  it("resolves a query dataset right after its row is inserted (no re-init)", async () => {
    const svc = buildService();
    insertRow();
    const rs = await svc.queryDataset("ds", q({ limit: 3 }), { sync: false });
    expect(rs.rows).toEqual([[1], [2], [3]]);
  });

  it("GET /datasets lists built-ins and query datasets, query dataset coverage is []", async () => {
    const svc = buildService();
    insertRow();
    const app = new (await import("hono")).Hono();
    svc.routes?.(app, {} as never);
    const res = await app.request("/datasets");
    const list = (await res.json()) as { id: string; coverage: unknown[] }[];
    const ids = list.map((d) => d.id);
    expect(ids).toContain("premium-requests-fake");
    expect(ids).toContain("ds");
    expect(list.find((d) => d.id === "ds")?.coverage).toEqual([]);
  });
});
