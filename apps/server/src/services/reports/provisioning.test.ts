// T8.7.3 — reports provision + GC their embedded query datasets (ADR 0017). Wires the real data
// and reports services over one file-backed DB (so the read-only handle works) and drives the
// HTTP routes end to end.

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
import type { GitHubClient } from "../data/ports";
import { createDataService } from "../data/service";
import { createReportsService } from "./service";

let rw: Database;
let ro: Database;
let app: Hono;

const json = { "content-type": "application/json" };
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: json, body: JSON.stringify(body) });

/** A definition embedding `datasets`, with one panel pointing at the first. */
function defWith(datasets: { id: string; title: string; sql: string }[]) {
  return {
    version: 1 as const,
    parameters: [
      { name: "org", kind: "org", default: "acme" },
      { name: "range", kind: "dateRange", default: { from: "2026-01-01", to: "2026-12-31" } },
    ],
    panels: [
      {
        id: "p",
        title: "P",
        dataset: datasets[0]?.id ?? "premium-requests",
        query: { org: "{{org}}", range: "{{range}}" },
      },
    ],
    datasets,
  };
}

const DS = (id: string, sql = "SELECT n FROM nums ORDER BY n") => ({ id, title: id, sql });

const datasetIds = async (): Promise<string[]> =>
  ((await (await app.request("/api/data/datasets")).json()) as { id: string }[]).map((d) => d.id);

beforeEach(() => {
  const path = join(mkdtempSync(join(tmpdir(), "ghr-prov-")), "ghreporting.db");
  rw = openDatabase(path);
  runMigrations(rw, migrations);
  rw.exec("CREATE TABLE nums(n INTEGER); INSERT INTO nums VALUES (1),(2),(3);");
  ro = openReadOnly(path);
  const { ctx } = createContext({
    db: rw,
    bus: createEventBus(nullLogger()),
    config: {
      ...loadConfig({ GHR_DB_PATH: ":memory:" }),
      now: () => new Date("2026-07-10T00:00:00Z"),
    },
    log: nullLogger(),
  });
  const data = createDataService({ gh: {} as GitHubClient, roDb: ro });
  data.init(ctx);
  const reports = createReportsService({ datasets: data.datasets });
  reports.init(ctx);
  app = new Hono();
  wireErrorEnvelope(app, nullLogger());
  const rsub = new Hono();
  reports.routes?.(rsub, ctx);
  app.route("/api/reports", rsub);
  const dsub = new Hono();
  data.routes?.(dsub, ctx);
  app.route("/api/data", dsub);
});
afterEach(() => {
  ro.close();
  rw.close();
});

describe("reports provisioning (ADR 0017)", () => {
  it("creating a report provisions its datasets — queryable immediately, listed in the catalog", async () => {
    const res = await post("/api/reports", { name: "R", definition: defWith([DS("ds-a")]) });
    expect(res.status).toBe(200);
    expect(await datasetIds()).toContain("ds-a");
    const rs = await (
      await post("/api/data/query", {
        dataset: "ds-a",
        q: { org: "acme", range: { from: "2026-01-01", to: "2026-12-31" } },
        sync: false,
      })
    ).json();
    expect(rs.rows).toEqual([[1], [2], [3]]);
  });

  it("importing a report provisions its embedded datasets", async () => {
    const envelope = {
      kind: "ghreporting.report",
      version: 1,
      name: "Imported",
      description: null,
      definition: defWith([DS("ds-imp")]),
    };
    expect((await post("/api/reports/import", { envelope })).status).toBe(200);
    expect(await datasetIds()).toContain("ds-imp");
  });

  it("rejects a report whose embedded SQL is invalid (400) and writes no report row", async () => {
    const res = await post("/api/reports", {
      name: "Bad",
      definition: defWith([DS("ds-bad", "DELETE FROM nums")]),
    });
    expect(res.status).toBe(400);
    const list = (await (await app.request("/api/reports")).json()) as { name: string }[];
    expect(list.some((r) => r.name === "Bad")).toBe(false); // no report row written
    expect(await datasetIds()).not.toContain("ds-bad");
  });

  it("GCs a dataset when the last report referencing it is deleted", async () => {
    const created = await (
      await post("/api/reports", { name: "R", definition: defWith([DS("ds-gc")]) })
    ).json();
    expect(await datasetIds()).toContain("ds-gc");
    expect((await app.request(`/api/reports/${created.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(await datasetIds()).not.toContain("ds-gc");
  });

  it("keeps a shared dataset while any report still embeds it", async () => {
    const a = await (
      await post("/api/reports", { name: "A", definition: defWith([DS("ds-shared")]) })
    ).json();
    await post("/api/reports", { name: "B", definition: defWith([DS("ds-shared")]) });
    await app.request(`/api/reports/${a.id}`, { method: "DELETE" });
    expect(await datasetIds()).toContain("ds-shared"); // B still embeds it
  });

  it("a report row with an unparseable definition does not brick init (tolerant reconcile)", async () => {
    // Simulate a corrupt/hand-edited row, plus a valid report, then boot a fresh reports service
    // over the same DB. Init must not throw (it would abort the kernel), and the valid report's
    // datasets must still provision.
    rw.query(
      "INSERT INTO reports(id,name,description,definition,created_at,updated_at) VALUES ('corrupt','C',NULL,'{not json','t','t')",
    ).run();
    const goodDef = JSON.stringify(defWith([DS("ds-survives")]));
    rw.query(
      "INSERT INTO reports(id,name,description,definition,created_at,updated_at) VALUES ('good','G',NULL,?1,'t','t')",
    ).run(goodDef);

    const { ctx } = createContext({
      db: rw,
      bus: createEventBus(nullLogger()),
      config: {
        ...loadConfig({ GHR_DB_PATH: ":memory:" }),
        now: () => new Date("2026-07-10T00:00:00Z"),
      },
      log: nullLogger(),
    });
    const data = createDataService({ gh: {} as GitHubClient, roDb: ro });
    data.init(ctx);
    const reports = createReportsService({ datasets: data.datasets });
    expect(() => reports.init(ctx)).not.toThrow();
    expect(await datasetIds()).toContain("ds-survives"); // valid report still provisioned
  });

  it("updating a report to drop a dataset GCs the orphan", async () => {
    const r = await (
      await post("/api/reports", { name: "R", definition: defWith([DS("ds-keep"), DS("ds-drop")]) })
    ).json();
    expect(await datasetIds()).toEqual(expect.arrayContaining(["ds-keep", "ds-drop"]));
    await app.request(`/api/reports/${r.id}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ definition: defWith([DS("ds-keep")]) }),
    });
    const ids = await datasetIds();
    expect(ids).toContain("ds-keep");
    expect(ids).not.toContain("ds-drop");
  });
});
