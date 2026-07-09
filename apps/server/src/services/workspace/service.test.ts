import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { openDatabase } from "../../adapters/db/database";
import { runMigrations } from "../../adapters/db/migrate";
import { migrations } from "../../adapters/db/migrations";
import { wireErrorEnvelope } from "../../app";
import { createEventBus } from "../../kernel/bus";
import { loadConfig } from "../../kernel/config";
import { createContext } from "../../kernel/context";
import { nullLogger } from "../../kernel/testutil";
import { createWorkspaceService } from "./service";

const T1 = new Date("2026-07-09T12:00:00.000Z");
const T2 = new Date("2026-07-09T12:05:00.000Z");

interface Wb {
  id: string;
  name: string;
  updated_at: string;
}
interface Binding {
  id: string;
  workbookId: string;
  sheet: string;
  range: string;
  dataset: string;
  query: unknown;
  chartSpec?: unknown;
}
interface WbFull extends Wb {
  snapshot: unknown;
  bindings: Binding[];
}

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const d of open.splice(0)) d.close();
});

async function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  runMigrations(db, migrations);
  let now = T1;
  const bus = createEventBus(nullLogger());
  const config = { ...loadConfig({}), now: () => now };
  const { ctx } = createContext({ db, bus, config, log: nullLogger() });
  const svc = createWorkspaceService();
  await svc.init(ctx);

  const app = new Hono();
  const sub = new Hono();
  svc.routes?.(sub, ctx);
  app.route("/", sub);
  wireErrorEnvelope(app, nullLogger());

  const json = { "content-type": "application/json" };
  async function req<T = unknown>(path: string, init?: RequestInit) {
    const res = await app.request(path, init);
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
  }
  return {
    ctx,
    req,
    get: <T = unknown>(path: string) => req<T>(path),
    post: <T = unknown>(path: string, body: unknown) =>
      req<T>(path, { method: "POST", headers: json, body: JSON.stringify(body) }),
    put: <T = unknown>(path: string, body: unknown) =>
      req<T>(path, { method: "PUT", headers: json, body: JSON.stringify(body) }),
    del: <T = unknown>(path: string) => req<T>(path, { method: "DELETE" }),
    setNow: (d: Date) => (now = d),
  };
}

describe("workspace service — workbook CRUD", () => {
  it("POST /workbooks creates a workbook and echoes id/name/updated_at", async () => {
    const h = await setup();
    const { status, body } = await h.post<Wb>("/workbooks", { name: "Spend" });
    expect(status).toBe(200);
    expect(typeof body.id).toBe("string");
    expect(body.name).toBe("Spend");
    expect(body.updated_at).toBe(T1.toISOString());
  });

  it("POST /workbooks rejects a missing/blank name with a ValidationError", async () => {
    const h = await setup();
    expect((await h.post("/workbooks", {})).status).toBe(400);
    expect((await h.post("/workbooks", { name: "   " })).status).toBe(400);
  });

  it("rejects a non-object JSON body (null / array) with 400, not a 500", async () => {
    const h = await setup();
    expect((await h.post("/workbooks", null)).status).toBe(400);
    expect((await h.post("/workbooks", [1, 2])).status).toBe(400);
  });

  it("GET /workbooks lists {id,name,updated_at} and omits the (big) snapshot", async () => {
    const h = await setup();
    await h.post("/workbooks", { name: "A", snapshot: { sheets: { s1: { cells: 1 } } } });
    const { status, body } = await h.get<Array<Wb & { snapshot?: unknown }>>("/workbooks");
    expect(status).toBe(200);
    expect(body.length).toBe(1);
    expect(body[0]?.name).toBe("A");
    expect(body[0] && "snapshot" in body[0]).toBe(false);
  });

  it("GET /workbooks/:id returns the workbook with its parsed snapshot and bindings", async () => {
    const h = await setup();
    const snap = { name: "wb", sheetOrder: ["s1"] };
    const { body: created } = await h.post<Wb>("/workbooks", { name: "A", snapshot: snap });
    const { status, body } = await h.get<WbFull>(`/workbooks/${created.id}`);
    expect(status).toBe(200);
    expect(body.snapshot).toEqual(snap); // parsed object, not a JSON string
    expect(body.bindings).toEqual([]);
  });

  it("GET /workbooks/:id 404s for an unknown id", async () => {
    const h = await setup();
    expect((await h.get("/workbooks/nope")).status).toBe(404);
  });

  it("POST defaults an omitted snapshot to an empty object", async () => {
    const h = await setup();
    const { body: created } = await h.post<Wb>("/workbooks", { name: "A" });
    const { body } = await h.get<WbFull>(`/workbooks/${created.id}`);
    expect(body.snapshot).toEqual({});
  });

  it("PUT /workbooks/:id updates name + snapshot and bumps updated_at", async () => {
    const h = await setup();
    const { body: created } = await h.post<Wb>("/workbooks", { name: "A" });
    h.setNow(T2);
    const { status, body } = await h.put<Wb>(`/workbooks/${created.id}`, {
      name: "B",
      snapshot: { v: 2 },
    });
    expect(status).toBe(200);
    expect(body.name).toBe("B");
    expect(body.updated_at).toBe(T2.toISOString());
    const full = await h.get<WbFull>(`/workbooks/${created.id}`);
    expect(full.body.snapshot).toEqual({ v: 2 });
  });

  it("PUT /workbooks/:id leaves the snapshot untouched when only the name changes", async () => {
    const h = await setup();
    const { body: created } = await h.post<Wb>("/workbooks", {
      name: "A",
      snapshot: { keep: true },
    });
    await h.put(`/workbooks/${created.id}`, { name: "B" });
    const full = await h.get<WbFull>(`/workbooks/${created.id}`);
    expect(full.body.snapshot).toEqual({ keep: true });
  });

  it("PUT /workbooks/:id 404s for an unknown id", async () => {
    const h = await setup();
    expect((await h.put("/workbooks/nope", { name: "x" })).status).toBe(404);
  });

  it("DELETE /workbooks/:id removes it (404 afterwards)", async () => {
    const h = await setup();
    const { body: created } = await h.post<Wb>("/workbooks", { name: "A" });
    expect((await h.del(`/workbooks/${created.id}`)).status).toBe(200);
    expect((await h.get(`/workbooks/${created.id}`)).status).toBe(404);
  });

  it("DELETE /workbooks/:id 404s for an unknown id", async () => {
    const h = await setup();
    expect((await h.del("/workbooks/nope")).status).toBe(404);
  });
});

describe("workspace service — snapshot size guard (20 MB)", () => {
  // A string just over 20 MiB, cheap to build; the guard measures byte length.
  const huge = "x".repeat(20 * 1024 * 1024 + 1);

  it("POST rejects a snapshot over 20 MB with a ValidationError", async () => {
    const h = await setup();
    expect((await h.post("/workbooks", { name: "A", snapshot: { blob: huge } })).status).toBe(400);
  });

  it("PUT rejects a snapshot over 20 MB with a ValidationError", async () => {
    const h = await setup();
    const { body: created } = await h.post<Wb>("/workbooks", { name: "A" });
    expect((await h.put(`/workbooks/${created.id}`, { snapshot: { blob: huge } })).status).toBe(
      400,
    );
  });

  it("PUT rejects an explicit null snapshot instead of silently wiping the workbook", async () => {
    const h = await setup();
    const { body: created } = await h.post<Wb>("/workbooks", { name: "A", snapshot: { keep: 1 } });
    expect((await h.put(`/workbooks/${created.id}`, { snapshot: null })).status).toBe(400);
    // the stored snapshot must survive the rejected write
    const full = await h.get<WbFull>(`/workbooks/${created.id}`);
    expect(full.body.snapshot).toEqual({ keep: 1 });
  });

  it("POST rejects a non-object snapshot", async () => {
    const h = await setup();
    expect((await h.post("/workbooks", { name: "A", snapshot: "not-an-object" })).status).toBe(400);
  });
});

describe("workspace service — bindings", () => {
  async function withWorkbook(h: Awaited<ReturnType<typeof setup>>) {
    const { body } = await h.post<Wb>("/workbooks", { name: "A" });
    return body.id;
  }
  const bindingBody = {
    sheet: "Sheet1",
    range: "A1:C4",
    dataset: "premium-requests",
    query: { org: "acme", range: { from: "2026-01-01", to: "2026-06-30" }, limit: 100 },
  };

  it("POST /workbooks/:id/bindings creates a binding and returns it camelCased", async () => {
    const h = await setup();
    const wb = await withWorkbook(h);
    const { status, body } = await h.post<Binding>(`/workbooks/${wb}/bindings`, bindingBody);
    expect(status).toBe(200);
    expect(typeof body.id).toBe("string");
    expect(body.workbookId).toBe(wb);
    expect(body.sheet).toBe("Sheet1");
    expect(body.query).toEqual(bindingBody.query); // round-tripped through TEXT
    expect("chartSpec" in body).toBe(false); // omitted when null
  });

  it("round-trips an optional chartSpec through the TEXT column", async () => {
    const h = await setup();
    const wb = await withWorkbook(h);
    const chartSpec = { series: [{ type: "bar" }] };
    const { body } = await h.post<Binding>(`/workbooks/${wb}/bindings`, {
      ...bindingBody,
      chartSpec,
    });
    expect(body.chartSpec).toEqual(chartSpec);
  });

  it("lists a workbook's bindings under GET /workbooks/:id", async () => {
    const h = await setup();
    const wb = await withWorkbook(h);
    await h.post(`/workbooks/${wb}/bindings`, bindingBody);
    const { body } = await h.get<WbFull>(`/workbooks/${wb}`);
    expect(body.bindings.length).toBe(1);
    expect(body.bindings[0]?.workbookId).toBe(wb);
    expect(body.bindings[0]?.query).toEqual(bindingBody.query);
  });

  it("POST /workbooks/:id/bindings 404s when the workbook is missing", async () => {
    const h = await setup();
    expect((await h.post("/workbooks/ghost/bindings", bindingBody)).status).toBe(404);
  });

  it("POST /workbooks/:id/bindings rejects blank sheet/range/dataset or a missing query", async () => {
    const h = await setup();
    const wb = await withWorkbook(h);
    expect((await h.post(`/workbooks/${wb}/bindings`, { ...bindingBody, sheet: "" })).status).toBe(
      400,
    );
    expect((await h.post(`/workbooks/${wb}/bindings`, { ...bindingBody, range: "" })).status).toBe(
      400,
    );
    expect(
      (await h.post(`/workbooks/${wb}/bindings`, { ...bindingBody, dataset: "" })).status,
    ).toBe(400);
    const { query, ...noQuery } = bindingBody;
    expect((await h.post(`/workbooks/${wb}/bindings`, noQuery)).status).toBe(400);
  });

  it("PUT /bindings/:id updates fields and 404s for an unknown id", async () => {
    const h = await setup();
    const wb = await withWorkbook(h);
    const { body: b } = await h.post<Binding>(`/workbooks/${wb}/bindings`, bindingBody);
    const { status, body } = await h.put<Binding>(`/bindings/${b.id}`, { range: "A1:D9" });
    expect(status).toBe(200);
    expect(body.range).toBe("A1:D9");
    expect(body.sheet).toBe("Sheet1"); // untouched
    expect((await h.put("/bindings/ghost", { range: "A1" })).status).toBe(404);
  });

  it("PUT /bindings/:id merges query and sets/clears chartSpec independently", async () => {
    const h = await setup();
    const wb = await withWorkbook(h);
    const { body: b } = await h.post<Binding>(`/workbooks/${wb}/bindings`, bindingBody);

    // replace the query
    const nextQuery = { org: "beta", range: { from: "2026-02-01", to: "2026-02-28" } };
    const q = await h.put<Binding>(`/bindings/${b.id}`, { query: nextQuery });
    expect(q.body.query).toEqual(nextQuery);

    // set a chartSpec on a binding that had none
    const spec = { series: [{ type: "line" }] };
    const withSpec = await h.put<Binding>(`/bindings/${b.id}`, { chartSpec: spec });
    expect(withSpec.body.chartSpec).toEqual(spec);

    // clear it back to null → chartSpec omitted again
    const cleared = await h.put<Binding>(`/bindings/${b.id}`, { chartSpec: null });
    expect("chartSpec" in cleared.body).toBe(false);
  });

  it("DELETE /bindings/:id removes it and 404s for an unknown id", async () => {
    const h = await setup();
    const wb = await withWorkbook(h);
    const { body: b } = await h.post<Binding>(`/workbooks/${wb}/bindings`, bindingBody);
    expect((await h.del(`/bindings/${b.id}`)).status).toBe(200);
    const { body } = await h.get<WbFull>(`/workbooks/${wb}`);
    expect(body.bindings.length).toBe(0);
    expect((await h.del("/bindings/ghost")).status).toBe(404);
  });

  it("deleting a workbook cascades to its bindings (FK)", async () => {
    const h = await setup();
    const wb = await withWorkbook(h);
    await h.post(`/workbooks/${wb}/bindings`, bindingBody);
    await h.del(`/workbooks/${wb}`);
    const count = h.ctx.db.query("SELECT COUNT(*) n FROM bindings").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
