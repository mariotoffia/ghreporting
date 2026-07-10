import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, openReadOnly } from "../../adapters/db/database";
import { runMigrations } from "../../adapters/db/migrate";
import { migrations } from "../../adapters/db/migrations";
import { wireErrorEnvelope } from "../../app";
import { createEventBus } from "../../kernel/bus";
import { loadConfig } from "../../kernel/config";
import { createContext } from "../../kernel/context";
import { nullLogger } from "../../kernel/testutil";
import type { GitHubClient } from "./ports";
import { createDataService, type DataService } from "./service";

let rw: Database;
let ro: Database;
let app: Hono;
let svc: DataService;

const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  const path = join(mkdtempSync(join(tmpdir(), "ghr-qdr-")), "ghreporting.db");
  rw = openDatabase(path);
  runMigrations(rw, migrations);
  // A tiny fact table so a real GROUP BY SELECT has something to aggregate.
  rw.exec(
    "CREATE TABLE sales(org TEXT, model TEXT, amount REAL);" +
      "INSERT INTO sales VALUES ('acme','gpt',1.0),('acme','gpt',2.0),('acme','claude',4.0);",
  );
  ro = openReadOnly(path);
  const log = nullLogger();
  const { ctx } = createContext({
    db: rw,
    bus: createEventBus(log),
    config: {
      ...loadConfig({ GHR_DB_PATH: ":memory:" }),
      now: () => new Date("2026-07-10T00:00:00Z"),
    },
    log,
  });
  svc = createDataService({ gh: {} as GitHubClient, roDb: ro });
  svc.init(ctx);
  app = new Hono();
  wireErrorEnvelope(app, log);
  svc.routes?.(app, ctx);
});
afterEach(() => {
  ro.close();
  rw.close();
});

// Query datasets are provisioned (ADR 0017), not created over HTTP — seed the read/edit routes
// under test by provisioning through the registry the reports service uses.
const create = (over: { id?: string; title?: string; sql?: string } = {}) =>
  svc.datasets?.provision([
    {
      id: over.id ?? "spend-by-model",
      title: over.title ?? "Spend by model",
      sql:
        over.sql ?? "SELECT model, SUM(amount) AS total FROM sales GROUP BY model ORDER BY model",
    },
  ]);

describe("query-datasets routes", () => {
  it("the standalone create route is gone (404)", async () => {
    const res = await app.request(
      "/query-datasets",
      json({ id: "x", title: "x", sql: "SELECT 1" }),
    );
    expect(res.status).toBe(404);
  });

  it("GET/:id returns the full provisioned row with parsed columns", async () => {
    create();
    const got = await (await app.request("/query-datasets/spend-by-model")).json();
    expect(got.id).toBe("spend-by-model");
    expect(got.sql).toContain("GROUP BY model");
    expect(got.columns).toEqual([
      { name: "model", type: "string", description: "" },
      { name: "total", type: "number", description: "" },
    ]);
  });

  it("GET list omits sql and columns", async () => {
    create();
    const list = (await (await app.request("/query-datasets")).json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(["description", "id", "title", "updated_at"]);
  });

  it("PUT partial update leaves other fields intact and re-derives columns", async () => {
    create();
    const res = await app.request("/query-datasets/spend-by-model", {
      ...json({ title: "Renamed" }),
      method: "PUT",
    });
    expect(res.status).toBe(200);
    const got = await (await app.request("/query-datasets/spend-by-model")).json();
    expect(got.title).toBe("Renamed");
    expect(got.sql).toContain("GROUP BY model"); // sql untouched
  });

  it("DELETE removes the row", async () => {
    create();
    expect((await app.request("/query-datasets/spend-by-model", { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await app.request("/query-datasets/spend-by-model")).status).toBe(404);
  });

  it("preview returns derived columns and rows", async () => {
    const res = await app.request(
      "/query-datasets/preview",
      json({ sql: "SELECT model, SUM(amount) AS total FROM sales GROUP BY model ORDER BY model" }),
    );
    const body = await res.json();
    expect(body.columns.map((c: { name: string }) => c.name)).toEqual(["model", "total"]);
    expect(body.rows).toEqual([
      ["claude", 4],
      ["gpt", 3],
    ]);
  });

  it("preview honors org/range so a parameterized WHERE returns rows", async () => {
    const res = await app.request(
      "/query-datasets/preview",
      json({
        sql: "SELECT model, SUM(amount) AS total FROM sales WHERE org = :org GROUP BY model ORDER BY model",
        org: "acme",
        range: { from: "2026-01-01", to: "2026-12-31" },
      }),
    );
    const body = await res.json();
    expect(body.rows).toEqual([
      ["claude", 4],
      ["gpt", 3],
    ]);
    // With a matching sample, the aggregate column infers as a number (not the empty-probe string).
    expect(body.columns.find((c: { name: string }) => c.name === "total")?.type).toBe("number");
  });

  it("a dataset that throws only at real-query time answers 400, not 500", async () => {
    // Create passes (probe org="" takes the safe branch), then querying with a non-JSON org
    // hits json_extract → SQLite throws → must be a 400 via the connector's guard, not a 500.
    const sql = "SELECT CASE WHEN :org = '' THEN 1 ELSE json_extract(:org, '$.a') END AS x";
    create({ id: "risky", sql }); // provisions fine (probe takes the safe branch)
    const res = await app.request(
      "/query",
      json({
        dataset: "risky",
        q: { org: "not-json", range: { from: "2026-01-01", to: "2026-12-31" } },
        sync: false,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET /schema returns table→columns for autocomplete, hiding bookkeeping tables", async () => {
    const schema = (await (await app.request("/schema")).json()) as Record<string, string[]>;
    expect(schema.sales).toEqual(["org", "model", "amount"]);
    expect(schema.usage_facts).toBeDefined(); // a real migration table
    expect(schema.query_datasets).toBeUndefined(); // internal, hidden
    expect(schema.schema_migrations).toBeUndefined();
  });

  it("a created dataset is immediately queryable and listed in /datasets (no re-init)", async () => {
    create();
    const q = { org: "acme", range: { from: "2026-01-01", to: "2026-12-31" } };
    const rs = await (
      await app.request("/query", json({ dataset: "spend-by-model", q, sync: false }))
    ).json();
    expect(rs.rows).toEqual([
      ["claude", 4],
      ["gpt", 3],
    ]);
    const datasets = (await (await app.request("/datasets")).json()) as { id: string }[];
    expect(datasets.map((d) => d.id)).toContain("spend-by-model");
  });
});
