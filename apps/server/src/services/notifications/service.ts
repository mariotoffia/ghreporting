// The `notifications` uService (DDD.md §3.6, UBIQUITOUS.md §Notifications): the
// upsert-by-key card store every service pushes to via `ctx.notify`. Registered
// first (app.ts) so `ctx.notify`/`ctx.resolve` are live before any other service
// inits. A Notification dedupes on `key`; a repeating condition updates one card
// instead of spamming, and re-firing a dismissed card makes it active again.
import type { Hono } from "hono";
import { NotFoundError } from "../../kernel/errors";
import type { AppEvent, MicroService, NotificationInput, ServiceContext } from "../../kernel/ports";
import { createSseHub } from "../../kernel/sse";

// Bus events the UI subscribes to over the stream: card changes plus sync progress.
const STREAMED: ReadonlyArray<AppEvent["type"]> = [
  "notification.changed",
  "sync.started",
  "sync.completed",
  "sync.failed",
];

// Upsert by business key. ?6 is the single timestamp used for both created_at and
// updated_at on insert; on conflict only updated_at moves and dismissed_at clears
// (re-activates a dismissed card — DDD.md §3.6). created_at/read_at are preserved.
const UPSERT = `
INSERT INTO notifications(key, level, title, body, source, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
ON CONFLICT(key) DO UPDATE SET
  level=?2, title=?3, body=?4, source=?5, updated_at=?6, dismissed_at=NULL
RETURNING id;`;

export interface NotificationsService extends MicroService {
  /** Create-or-refresh a card by key; returns its storage id. Bound as `ctx.notify`. */
  notify(n: NotificationInput): number;
  /** Dismiss the active card with this key on recovery. Bound as `ctx.resolve`. */
  resolve(key: string): void;
}

export function createNotificationsService(opts: {
  bindNotify: (fn: (n: NotificationInput) => void) => void;
  bindResolve: (fn: (key: string) => void) => void;
}): NotificationsService {
  let ctx: ServiceContext;
  let hub: ReturnType<typeof createSseHub>;

  function notify(n: NotificationInput): number {
    const at = ctx.config.now().toISOString();
    const { id } = ctx.db
      .query(UPSERT)
      .get(n.key, n.level, n.title, n.body ?? null, n.source, at) as { id: number };
    ctx.bus.emit({ type: "notification.changed", id });
    return id;
  }

  // Recovery primitive: stamp dismissed_at for the still-active card with this
  // key so the refresh scheduler (which gates on an active credential.*.invalid
  // card) resumes. Guarded on `dismissed_at IS NULL` so an unknown or already
  // resolved key is a silent no-op that emits nothing.
  function resolve(key: string): void {
    const at = ctx.config.now().toISOString();
    const row = ctx.db
      .query(
        "UPDATE notifications SET dismissed_at=?2 WHERE key=?1 AND dismissed_at IS NULL RETURNING id",
      )
      .get(key, at) as { id: number } | null;
    if (row) ctx.bus.emit({ type: "notification.changed", id: row.id });
  }

  /** Stamp a single timestamp column by id; emit + return the id, or 404. */
  function stamp(column: "read_at" | "dismissed_at", idParam: string): number {
    const id = Number(idParam);
    const at = ctx.config.now().toISOString();
    const { changes } = ctx.db
      .query(`UPDATE notifications SET ${column}=?2 WHERE id=?1`)
      .run(id, at);
    if (changes === 0) throw new NotFoundError(`notification ${idParam}`);
    ctx.bus.emit({ type: "notification.changed", id });
    return id;
  }

  return {
    name: "notifications",
    notify,
    resolve,
    init(c) {
      ctx = c;
      hub = createSseHub(ctx.log.child("stream"));
      opts.bindNotify(notify);
      opts.bindResolve(resolve);
      // Fan bus events out to every connected browser (T5.2). broadcast() drops
      // dead clients itself, so these subscriptions live for the app's lifetime.
      for (const type of STREAMED) ctx.bus.on(type, (e) => hub.broadcast(type, e));
    },
    routes(app: Hono) {
      app.get("/stream", hub.handler());
      app.get("/", (c) => {
        const all = c.req.query("state") === "all";
        const where = all ? "" : "WHERE dismissed_at IS NULL";
        const rows = ctx.db
          .query(`SELECT * FROM notifications ${where} ORDER BY updated_at DESC, id DESC`)
          .all();
        return c.json(rows);
      });
      app.post("/:id/read", (c) => c.json({ id: stamp("read_at", c.req.param("id")), read: true }));
      app.post("/:id/dismiss", (c) =>
        c.json({ id: stamp("dismissed_at", c.req.param("id")), dismissed: true }),
      );
    },
  };
}
