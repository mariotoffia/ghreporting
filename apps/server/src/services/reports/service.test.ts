import { afterEach, describe, expect, it } from "bun:test";
import { compile, validateDefinition } from "@ghreporting/domain";
import { Hono } from "hono";
import { openDatabase } from "../../adapters/db/database";
import { runMigrations } from "../../adapters/db/migrate";
import { migrations } from "../../adapters/db/migrations";
import { wireErrorEnvelope } from "../../app";
import { createEventBus } from "../../kernel/bus";
import { loadConfig } from "../../kernel/config";
import { createContext } from "../../kernel/context";
import type { ServiceContext } from "../../kernel/ports";
import { nullLogger } from "../../kernel/testutil";
import seed from "./seed/copilot-spend.json";
import { createReportsService } from "./service";

const T1 = new Date("2026-07-09T12:00:00.000Z");
const T2 = new Date("2026-07-09T12:05:00.000Z");

const DEF = {
  version: 1,
  parameters: [{ name: "org", kind: "org", default: "acme" }],
  panels: [{ id: "p", title: "Spend", dataset: "premium-requests", query: { org: "{{org}}" } }],
};

interface Report {
  id: string;
  name: string;
  description: string | null;
  updated_at: string;
}

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const d of open.splice(0)) d.close();
});

function harness(ctx: ServiceContext, svc: ReturnType<typeof createReportsService>) {
  const app = new Hono();
  const sub = new Hono();
  svc.routes?.(sub, ctx);
  app.route("/api/reports", sub);
  wireErrorEnvelope(app, nullLogger());
  const json = { "content-type": "application/json" };
  async function req<T = unknown>(path: string, init?: RequestInit) {
    const res = await app.request(path, init);
    return { status: res.status, body: (await res.json().catch(() => null)) as T, res };
  }
  return {
    raw: (path: string, init?: RequestInit) => app.request(path, init),
    get: <T = unknown>(path: string) => req<T>(path),
    post: <T = unknown>(path: string, body: unknown) =>
      req<T>(path, { method: "POST", headers: json, body: JSON.stringify(body) }),
    put: <T = unknown>(path: string, body: unknown) =>
      req<T>(path, { method: "PUT", headers: json, body: JSON.stringify(body) }),
    del: <T = unknown>(path: string) => req<T>(path, { method: "DELETE" }),
  };
}

/** Init the service (which seeds), then clear rows for a clean CRUD slate. */
async function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  runMigrations(db, migrations);
  let now = T1;
  const bus = createEventBus(nullLogger());
  const config = { ...loadConfig({}), now: () => now };
  const { ctx } = createContext({ db, bus, config, log: nullLogger() });
  const svc = createReportsService();
  await svc.init(ctx);
  db.query("DELETE FROM reports").run(); // drop the seed for CRUD isolation
  return { db, ctx, setNow: (d: Date) => (now = d), ...harness(ctx, svc) };
}

describe("reports service — CRUD", () => {
  it("creates a report and reads it back with the full definition", async () => {
    const h = await setup();
    const { status, body } = await h.post<Report>("/api/reports", {
      name: "Copilot Spend",
      description: "monthly",
      definition: DEF,
    });
    expect(status).toBe(200);
    const full = await h.get<{ id: string; name: string; definition: unknown }>(
      `/api/reports/${body.id}`,
    );
    expect(full.status).toBe(200);
    expect(full.body.name).toBe("Copilot Spend");
    expect(full.body.definition).toEqual(DEF);
  });

  it("lists reports without the definition body", async () => {
    const h = await setup();
    await h.post("/api/reports", { name: "A", definition: DEF });
    const { status, body } = await h.get<Array<Report & { definition?: unknown }>>("/api/reports");
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]?.name).toBe("A");
    expect(body[0]?.definition).toBeUndefined();
  });

  it("rejects a missing name and an invalid definition with 400", async () => {
    const h = await setup();
    expect((await h.post("/api/reports", { definition: DEF })).status).toBe(400);
    expect((await h.post("/api/reports", { name: "A", definition: { version: 2 } })).status).toBe(
      400,
    );
    expect(
      (
        await h.post("/api/reports", {
          name: "A",
          definition: {
            version: 1,
            parameters: [],
            panels: [{ id: "p", title: "t", dataset: "d", query: { x: "{{ghost}}" } }],
          },
        })
      ).status,
    ).toBe(400);
  });

  it("rejects a non-object body with 400, not 500", async () => {
    const h = await setup();
    expect((await h.post("/api/reports", null)).status).toBe(400);
    expect((await h.post("/api/reports", [1, 2])).status).toBe(400);
  });

  it("rejects a missing definition with 400, not a 500", async () => {
    const h = await setup();
    expect((await h.post("/api/reports", { name: "A" })).status).toBe(400);
  });

  it("rejects a non-string description with 400 instead of coercing it", async () => {
    const h = await setup();
    const bad = { name: "A", description: { x: 1 }, definition: DEF };
    expect((await h.post("/api/reports", bad)).status).toBe(400);
  });

  it("404s an unknown report", async () => {
    const h = await setup();
    expect((await h.get("/api/reports/nope")).status).toBe(404);
    expect((await h.put("/api/reports/nope", { name: "x" })).status).toBe(404);
    expect((await h.del("/api/reports/nope")).status).toBe(404);
  });
});

describe("reports service — partial update", () => {
  it("PUT name only leaves the definition intact and bumps updated_at", async () => {
    const h = await setup();
    const created = await h.post<Report>("/api/reports", { name: "A", definition: DEF });
    h.setNow(T2);
    const renamed = await h.put<Report>(`/api/reports/${created.body.id}`, { name: "B" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.updated_at).toBe(T2.toISOString()); // clock advanced
    const full = await h.get<{ name: string; definition: unknown }>(
      `/api/reports/${created.body.id}`,
    );
    expect(full.body.name).toBe("B");
    expect(full.body.definition).toEqual(DEF); // untouched
  });

  it("PUT definition only leaves name/description intact", async () => {
    const h = await setup();
    const created = await h.post<Report>("/api/reports", {
      name: "A",
      description: "keep me",
      definition: DEF,
    });
    const next = { ...DEF, panels: [{ ...DEF.panels[0], title: "Changed" }] };
    await h.put(`/api/reports/${created.body.id}`, { definition: next });
    const full = await h.get<{ name: string; description: string; definition: typeof DEF }>(
      `/api/reports/${created.body.id}`,
    );
    expect(full.body.name).toBe("A");
    expect(full.body.description).toBe("keep me");
    expect(full.body.definition.panels[0]?.title).toBe("Changed");
  });

  it("PUT with an invalid definition does not half-apply (name unchanged)", async () => {
    const h = await setup();
    const created = await h.post<Report>("/api/reports", { name: "A", definition: DEF });
    const bad = await h.put(`/api/reports/${created.body.id}`, {
      name: "B",
      definition: { version: 9 },
    });
    expect(bad.status).toBe(400);
    const full = await h.get<{ name: string }>(`/api/reports/${created.body.id}`);
    expect(full.body.name).toBe("A"); // the rename never landed
  });
});

describe("reports service — export / import", () => {
  it("exports as a downloadable envelope", async () => {
    const h = await setup();
    const created = await h.post<Report>("/api/reports", { name: "My Report", definition: DEF });
    const res = await h.raw(`/api/reports/${created.body.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("My_Report.report.json");
    const env = (await res.json()) as { kind: string; definition: unknown };
    expect(env.kind).toBe("ghreporting.report");
    expect(env.definition).toEqual(DEF);
  });

  it("import round-trips to a NEW id with an equal definition", async () => {
    const h = await setup();
    const created = await h.post<Report>("/api/reports", { name: "Orig", definition: DEF });
    const env = await (await h.raw(`/api/reports/${created.body.id}/export`)).json();
    const imported = await h.post<Report>("/api/reports/import", { envelope: env });
    expect(imported.status).toBe(200);
    expect(imported.body.id).not.toBe(created.body.id); // new id
    const full = await h.get<{ definition: unknown }>(`/api/reports/${imported.body.id}`);
    expect(full.body.definition).toEqual(DEF);
  });

  it("rejects an import with the wrong envelope kind", async () => {
    const h = await setup();
    const bad = {
      kind: "something.else",
      version: 1,
      name: "X",
      description: null,
      definition: DEF,
    };
    expect((await h.post("/api/reports/import", { envelope: bad })).status).toBe(400);
  });
});

describe("reports service — size guard", () => {
  it("rejects a definition over 1 MiB", async () => {
    const h = await setup();
    // A valid-shaped definition padded past 1 MiB with a benign literal query value.
    const huge = "x".repeat(1024 * 1024 + 10);
    const def = {
      version: 1,
      parameters: [],
      panels: [{ id: "p", title: "t", dataset: "d", query: { note: huge } }],
    };
    expect((await h.post("/api/reports", { name: "A", definition: def })).status).toBe(400);
  });
});

describe("copilot-spend seed", () => {
  it("is a valid definition that compiles to a runnable premium-requests query", () => {
    const def = validateDefinition(seed.definition);
    const plan = compile(def, { org: "acme", range: { from: "2026-01-01", to: "2026-01-31" } });
    const panel = plan.panels[0];
    expect(panel?.dataset).toBe("premium-requests");
    expect(panel?.query).toMatchObject({
      org: "acme",
      range: { from: "2026-01-01", to: "2026-01-31" },
    });
  });
});

describe("reports service — seed on init", () => {
  function bootstrap() {
    const db = openDatabase(":memory:");
    open.push(db);
    runMigrations(db, migrations);
    const bus = createEventBus(nullLogger());
    const config = { ...loadConfig({}), now: () => T1 };
    const { ctx } = createContext({ db, bus, config, log: nullLogger() });
    return { db, ctx };
  }

  it("inserts the Copilot Spend seed exactly once and is idempotent across inits", async () => {
    const { db, ctx } = bootstrap();
    const svc = createReportsService();
    await svc.init(ctx);
    await svc.init(ctx); // second boot on the same DB
    const rows = db.query("SELECT id FROM reports WHERE id='copilot-spend'").all();
    expect(rows).toHaveLength(1);
  });

  it("does not overwrite a user-edited seed on re-init", async () => {
    const { db, ctx } = bootstrap();
    const svc = createReportsService();
    await svc.init(ctx);
    db.query("UPDATE reports SET name='Edited' WHERE id='copilot-spend'").run();
    await svc.init(ctx);
    const row = db.query("SELECT name FROM reports WHERE id='copilot-spend'").get() as {
      name: string;
    };
    expect(row.name).toBe("Edited");
  });
});
