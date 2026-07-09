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
import { createNotificationsService } from "./service";

const T1 = new Date("2026-07-09T12:00:00.000Z");
const T2 = new Date("2026-07-09T12:05:00.000Z");

interface Row {
  id: number;
  key: string;
  level: string;
  title: string;
  body: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  dismissed_at: string | null;
}

const open: Array<{ close(): void }> = [];
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
// TESTS.md §2.5: abort SSE clients first (cancel → onAbort → clients.delete), then
// close DBs. Cancelling in afterEach — not inline — keeps a thrown assertion from
// leaking an open keepalive loop (bun force-exits orphaned timers, so nothing else flags it).
afterEach(async () => {
  await Promise.all(readers.splice(0).map((r) => r.cancel().catch(() => {})));
  for (const d of open.splice(0)) d.close();
});

async function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  runMigrations(db, migrations);
  let now = T1;
  const changed: number[] = [];
  const bus = createEventBus(nullLogger());
  bus.on("notification.changed", (e) => changed.push(e.id));
  const config = { ...loadConfig({}), now: () => now };
  const { ctx, bindNotify, bindResolve } = createContext({ db, bus, config, log: nullLogger() });
  const svc = createNotificationsService({ bindNotify, bindResolve });
  await svc.init(ctx);

  const app = new Hono();
  const sub = new Hono();
  svc.routes?.(sub, ctx);
  app.route("/", sub);
  wireErrorEnvelope(app, nullLogger());

  const row = (id: number) =>
    ctx.db.query("SELECT * FROM notifications WHERE id=?").get(id) as Row | null;
  return {
    ctx,
    svc,
    app,
    changed,
    row,
    setNow: (d: Date) => {
      now = d;
    },
  };
}

describe("notifications service — notify upserts by key", () => {
  it("keeps one row on a repeat key, preserving created_at with a fresh updated_at", async () => {
    const h = await setup();
    const id1 = h.svc.notify({ key: "k", level: "info", title: "first", source: "test" });
    h.setNow(T2);
    const id2 = h.svc.notify({
      key: "k",
      level: "warning",
      title: "second",
      body: "more",
      source: "test",
    });

    expect(id2).toBe(id1);
    const rows = h.ctx.db.query("SELECT * FROM notifications").all() as Row[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.created_at).toBe(T1.toISOString());
    expect(rows[0]?.updated_at).toBe(T2.toISOString());
    expect(rows[0]?.title).toBe("second");
    expect(rows[0]?.level).toBe("warning");
    expect(rows[0]?.body).toBe("more");
  });

  it("re-fires a dismissed card: same key clears dismissed_at", async () => {
    const h = await setup();
    const id = h.svc.notify({ key: "k", level: "error", title: "boom", source: "test" });
    await h.app.request(`/${id}/dismiss`, { method: "POST" });
    expect(h.row(id)?.dismissed_at).not.toBeNull();

    h.svc.notify({ key: "k", level: "error", title: "boom again", source: "test" });
    expect(h.row(id)?.dismissed_at).toBeNull();
  });

  it("preserves read_at across a re-fire (verbatim upsert only clears dismissed_at)", async () => {
    const h = await setup();
    const id = h.svc.notify({ key: "k", level: "warning", title: "recurring", source: "test" });
    await h.app.request(`/${id}/read`, { method: "POST" });
    expect(h.row(id)?.read_at).toBe(T1.toISOString());

    h.setNow(T2);
    h.svc.notify({ key: "k", level: "warning", title: "recurring again", source: "test" });
    const row = h.row(id);
    expect(row?.read_at).toBe(T1.toISOString()); // untouched — DDD.md §3.6, spec SQL
    expect(row?.updated_at).toBe(T2.toISOString()); // moved
  });

  it("stores an optional body as NULL when omitted", async () => {
    const h = await setup();
    const id = h.svc.notify({ key: "k", level: "info", title: "no body", source: "test" });
    expect(h.row(id)?.body).toBeNull();
  });
});

describe("notifications service — read/dismiss stamps", () => {
  it("POST /:id/read stamps read_at", async () => {
    const h = await setup();
    const id = h.svc.notify({ key: "k", level: "info", title: "hi", source: "test" });
    const res = await h.app.request(`/${id}/read`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(h.row(id)?.read_at).toBe(T1.toISOString());
  });

  it("POST /:id/dismiss stamps dismissed_at", async () => {
    const h = await setup();
    const id = h.svc.notify({ key: "k", level: "info", title: "hi", source: "test" });
    const res = await h.app.request(`/${id}/dismiss`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(h.row(id)?.dismissed_at).toBe(T1.toISOString());
  });

  it("returns 404 for read/dismiss of an unknown id", async () => {
    const h = await setup();
    expect((await h.app.request("/999/read", { method: "POST" })).status).toBe(404);
    expect((await h.app.request("/999/dismiss", { method: "POST" })).status).toBe(404);
  });
});

describe("notifications service — list filters", () => {
  it("GET /?state=active hides dismissed cards, newest updated_at first", async () => {
    const h = await setup();
    const a = h.svc.notify({ key: "a", level: "info", title: "a", source: "test" });
    h.setNow(T2);
    h.svc.notify({ key: "b", level: "info", title: "b", source: "test" });
    await h.app.request(`/${a}/dismiss`, { method: "POST" });

    const res = await h.app.request("/?state=active");
    const list = (await res.json()) as Row[];
    expect(list.map((n) => n.key)).toEqual(["b"]);
  });

  it("GET /?state=all returns dismissed cards too, newest updated_at first", async () => {
    const h = await setup();
    const a = h.svc.notify({ key: "a", level: "info", title: "a", source: "test" });
    h.setNow(T2);
    h.svc.notify({ key: "b", level: "info", title: "b", source: "test" });
    await h.app.request(`/${a}/dismiss`, { method: "POST" });

    const res = await h.app.request("/?state=all");
    const list = (await res.json()) as Row[];
    expect(list.map((n) => n.key)).toEqual(["b", "a"]);
  });

  it("defaults to active when state is missing", async () => {
    const h = await setup();
    const a = h.svc.notify({ key: "a", level: "info", title: "a", source: "test" });
    await h.app.request(`/${a}/dismiss`, { method: "POST" });
    const res = await h.app.request("/");
    expect((await res.json()) as Row[]).toEqual([]);
  });

  it("breaks an updated_at tie deterministically (newest id first)", async () => {
    const h = await setup();
    // same fixed clock → identical updated_at; the id DESC tiebreaker orders them
    const a = h.svc.notify({ key: "a", level: "info", title: "a", source: "test" });
    const b = h.svc.notify({ key: "b", level: "info", title: "b", source: "test" });
    const res = await h.app.request("/?state=all");
    expect(((await res.json()) as Row[]).map((n) => n.id)).toEqual([b, a]);
  });
});

describe("notifications service — resolve by key", () => {
  // scheduler.ts gates background refresh on this exact query (T2.6).
  const GATE =
    "SELECT 1 FROM notifications WHERE key LIKE 'credential.github-pat%.invalid' AND dismissed_at IS NULL LIMIT 1";

  it("clears the active credential card the scheduler gates on", async () => {
    const h = await setup();
    h.svc.notify({
      key: "credential.github-pat:default.invalid",
      level: "error",
      title: "bad token",
      source: "credentials",
    });
    expect(h.ctx.db.query(GATE).get()).not.toBeNull();

    h.svc.resolve("credential.github-pat:default.invalid");
    expect(h.ctx.db.query(GATE).get()).toBeNull();
  });

  it("is a no-op for an unknown key (no event)", async () => {
    const h = await setup();
    h.changed.length = 0;
    h.svc.resolve("nothing.here");
    expect(h.changed).toEqual([]);
  });

  it("does not re-emit when the card is already dismissed", async () => {
    const h = await setup();
    const id = h.svc.notify({ key: "k", level: "info", title: "x", source: "test" });
    await h.app.request(`/${id}/dismiss`, { method: "POST" });
    h.changed.length = 0;
    h.svc.resolve("k"); // guard is `dismissed_at IS NULL` → short-circuits, no event
    expect(h.changed).toEqual([]);
    expect(h.row(id)?.dismissed_at).not.toBeNull();
  });
});

describe("notifications service — SSE stream (T5.2)", () => {
  /**
   * Open the stream, then drain one read so the hub has registered this client
   * (the handler adds itself and writes an initial ping before parking on
   * keepalive). No sleeps: reads are pulled deterministically.
   */
  async function connect(app: Hono) {
    const res = await app.request("/stream");
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    readers.push(reader); // afterEach cancels it (TESTS.md §2.5)
    await reader.read(); // initial ping — guarantees the client is in the hub
    return reader;
  }

  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) {
    const dec = new TextDecoder();
    let buf = "";
    for (let i = 0; i < 5 && !buf.includes(needle); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buf += dec.decode(value);
    }
    return buf;
  }

  it("pushes notification.changed to a connected client after a notify()", async () => {
    const h = await setup();
    const reader = await connect(h.app);
    h.svc.notify({ key: "k", level: "info", title: "live", source: "test" });
    const buf = await readUntil(reader, "notification.changed");
    expect(buf).toContain("notification.changed");
  });

  it("relays sync.* bus events to connected clients", async () => {
    const h = await setup();
    const reader = await connect(h.app);
    h.ctx.bus.emit({ type: "sync.completed", dataset: "premium-requests", scope: "acme", rows: 3 });
    const buf = await readUntil(reader, "sync.completed");
    expect(buf).toContain("sync.completed");
    expect(buf).toContain("premium-requests");
  });
});

describe("notifications service — emits notification.changed on every change", () => {
  it("emits on notify, read, dismiss, and resolve", async () => {
    const h = await setup();
    const id = h.svc.notify({
      key: "credential.github-pat:default.invalid",
      level: "error",
      title: "x",
      source: "test",
    });
    expect(h.changed).toEqual([id]);

    await h.app.request(`/${id}/read`, { method: "POST" });
    await h.app.request(`/${id}/dismiss`, { method: "POST" });
    // re-fire, then resolve by key
    h.svc.notify({
      key: "credential.github-pat:default.invalid",
      level: "error",
      title: "x2",
      source: "test",
    });
    h.svc.resolve("credential.github-pat:default.invalid");

    // notify, read, dismiss, notify(re-fire), resolve → 5 emits, all the same id
    expect(h.changed).toEqual([id, id, id, id, id]);
  });
});
