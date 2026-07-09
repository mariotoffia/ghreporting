// The `workspace` uService (DDD.md §3.3, UBIQUITOUS.md §Workspace): persistence for
// Workbooks (a saved Univer snapshot) and their Bindings. A Binding is the mediator
// triple — sheet range ⇄ dataset query ⇄ optional chart spec — and the only legal
// coupling between a sheet and a chart (DDD.md invariant 9). Deleting a Workbook
// cascades to its Bindings through the FK (schema T2.2), so no app-level cleanup here.
//
// Wire contract note: Workbook fields stay snake_case (`updated_at`) per the plan;
// Binding I/O is camelCase (`workbookId`, `chartSpec`) matching the web `Binding`
// type. The snake_case columns (`workbook_id`, `chart_spec`) never leak past
// `toBinding` / the INSERT — one translation seam, nowhere else.
import type { Hono } from "hono";
import { NotFoundError, ValidationError } from "../../kernel/errors";
import type { MicroService, ServiceContext } from "../../kernel/ports";

// Univer snapshots are large; cap what we persist so one runaway document can't
// wedge the single local SQLite file. 20 MiB is generous for a spreadsheet snapshot.
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

interface BindingRow {
  id: string;
  workbook_id: string;
  sheet: string;
  range: string;
  dataset: string;
  query: string; // JSON.stringify'd DatasetQuery
  chart_spec: string | null; // JSON.stringify'd ChartSpec, or NULL
  updated_at: string;
}

/** DB row (snake_case, JSON-in-TEXT) → wire Binding (camelCase, parsed). */
function toBinding(r: BindingRow) {
  return {
    id: r.id,
    workbookId: r.workbook_id,
    sheet: r.sheet,
    range: r.range,
    dataset: r.dataset,
    query: JSON.parse(r.query) as unknown,
    // undefined (not null) so JSON.stringify omits it — mirrors the optional `chartSpec?`
    chartSpec: r.chart_spec == null ? undefined : (JSON.parse(r.chart_spec) as unknown),
  };
}

/** Reject a missing/blank string field the same way everywhere. */
function nonEmpty(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new ValidationError(`${field} is required`);
  return v;
}

/**
 * Stringify a snapshot and enforce the size cap. `undefined` means "no snapshot" →
 * defaults to "{}". `null` / a non-object is malformed and — on PUT — would silently
 * wipe a saved workbook (the column is NOT NULL), so reject it like serializeQuery.
 */
function serializeSnapshot(snapshot: unknown): string {
  if (snapshot !== undefined && (snapshot === null || typeof snapshot !== "object")) {
    throw new ValidationError("snapshot must be an object");
  }
  const s = JSON.stringify(snapshot ?? {});
  if (Buffer.byteLength(s, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new ValidationError("snapshot exceeds the 20 MB limit");
  }
  return s;
}

/** Serialize a query/chartSpec into their TEXT columns from a (partial) body. */
function serializeQuery(query: unknown): string {
  if (query == null || typeof query !== "object")
    throw new ValidationError("query must be an object");
  return JSON.stringify(query);
}

/**
 * Parse a request body as a JSON object. `c.req.json()` accepts a bare `null`, a JSON
 * array, or a primitive without rejecting — reading `.name`/`.sheet` off those would
 * throw a raw TypeError (a 500). Normalize to a 400 here so every write route is safe.
 */
async function jsonObject(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  const parsed = await req.json().catch(() => {
    throw new ValidationError("body must be JSON");
  });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function createWorkspaceService(): MicroService {
  let ctx: ServiceContext;
  const db = () => ctx.db;
  const exists = (table: "workbooks" | "bindings", id: string): boolean =>
    db().query(`SELECT 1 FROM ${table} WHERE id=?`).get(id) != null;

  return {
    name: "workspace",
    init(c) {
      ctx = c;
    },
    routes(app: Hono) {
      // --- Workbooks ---
      app.get("/workbooks", (c) =>
        c.json(
          db().query("SELECT id, name, updated_at FROM workbooks ORDER BY updated_at DESC").all(),
        ),
      );

      app.post("/workbooks", async (c) => {
        const body = await jsonObject(c.req);
        // Validate everything before the first write (no half-applied create).
        const name = nonEmpty(body.name, "name");
        const snapshot = serializeSnapshot(body.snapshot);
        const id = crypto.randomUUID();
        const at = ctx.config.now().toISOString();
        db()
          .query("INSERT INTO workbooks(id, name, snapshot, updated_at) VALUES (?1, ?2, ?3, ?4)")
          .run(id, name, snapshot, at);
        return c.json({ id, name, updated_at: at });
      });

      app.get("/workbooks/:id", (c) => {
        const id = c.req.param("id");
        const wb = db()
          .query("SELECT id, name, snapshot, updated_at FROM workbooks WHERE id=?")
          .get(id) as { id: string; name: string; snapshot: string; updated_at: string } | null;
        if (!wb) throw new NotFoundError(`workbook ${id}`);
        const bindings = (
          db()
            .query("SELECT * FROM bindings WHERE workbook_id=? ORDER BY updated_at")
            .all(id) as BindingRow[]
        ).map(toBinding);
        return c.json({
          id: wb.id,
          name: wb.name,
          snapshot: JSON.parse(wb.snapshot) as unknown,
          updated_at: wb.updated_at,
          bindings,
        });
      });

      app.put("/workbooks/:id", async (c) => {
        const id = c.req.param("id");
        // Read the body (the ONLY await) up front. Everything after is synchronous
        // (bun:sqlite is sync), so the existence check and the writes run with no yield
        // between them — a concurrent DELETE can't slip in (no TOCTOU: 200-with-null).
        const body = await jsonObject(c.req);
        if (!exists("workbooks", id)) throw new NotFoundError(`workbook ${id}`);
        // Validate BOTH fields before writing EITHER, so an oversized/invalid snapshot
        // never leaves a half-applied rename behind.
        const name = body.name !== undefined ? nonEmpty(body.name, "name") : undefined;
        const snapshot = body.snapshot !== undefined ? serializeSnapshot(body.snapshot) : undefined;
        const at = ctx.config.now().toISOString();
        if (name !== undefined)
          db().query("UPDATE workbooks SET name=?2 WHERE id=?1").run(id, name);
        // Only rewrite the (potentially large) snapshot when the caller sent one.
        if (snapshot !== undefined) {
          db().query("UPDATE workbooks SET snapshot=?2 WHERE id=?1").run(id, snapshot);
        }
        db().query("UPDATE workbooks SET updated_at=?2 WHERE id=?1").run(id, at);
        return c.json(db().query("SELECT id, name, updated_at FROM workbooks WHERE id=?").get(id));
      });

      app.delete("/workbooks/:id", (c) => {
        const id = c.req.param("id");
        const { changes } = db().query("DELETE FROM workbooks WHERE id=?").run(id);
        if (changes === 0) throw new NotFoundError(`workbook ${id}`);
        return c.json({ id, deleted: true }); // bindings drop via ON DELETE CASCADE
      });

      // --- Bindings ---
      app.post("/workbooks/:id/bindings", async (c) => {
        const workbookId = c.req.param("id");
        // Body read first (only await); parent check + insert then run with no yield
        // between them, so a concurrent workbook DELETE can't turn the FK insert into a
        // raw 500 instead of a clean 404.
        const body = await jsonObject(c.req);
        if (!exists("workbooks", workbookId)) throw new NotFoundError(`workbook ${workbookId}`);
        const sheet = nonEmpty(body.sheet, "sheet");
        const range = nonEmpty(body.range, "range");
        const dataset = nonEmpty(body.dataset, "dataset");
        const query = serializeQuery(body.query);
        const chartSpec = body.chartSpec == null ? null : JSON.stringify(body.chartSpec);
        const id = crypto.randomUUID();
        const at = ctx.config.now().toISOString();
        db()
          .query(
            "INSERT INTO bindings(id, workbook_id, sheet, range, dataset, query, chart_spec, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
          )
          .run(id, workbookId, sheet, range, dataset, query, chartSpec, at);
        return c.json(
          toBinding(db().query("SELECT * FROM bindings WHERE id=?").get(id) as BindingRow),
        );
      });

      app.put("/bindings/:id", async (c) => {
        const id = c.req.param("id");
        // Body read first (only await); the read-existing → merge → update sequence then
        // runs with no yield, so the response can't describe a binding a concurrent
        // DELETE removed mid-flight (no fabricated 200).
        const body = await jsonObject(c.req);
        const existing = db()
          .query("SELECT * FROM bindings WHERE id=?")
          .get(id) as BindingRow | null;
        if (!existing) throw new NotFoundError(`binding ${id}`);
        // Merge onto the stored row, validating each provided field first.
        const next: BindingRow = { ...existing };
        if (body.sheet !== undefined) next.sheet = nonEmpty(body.sheet, "sheet");
        if (body.range !== undefined) next.range = nonEmpty(body.range, "range");
        if (body.dataset !== undefined) next.dataset = nonEmpty(body.dataset, "dataset");
        if (body.query !== undefined) next.query = serializeQuery(body.query);
        if (body.chartSpec !== undefined) {
          next.chart_spec = body.chartSpec === null ? null : JSON.stringify(body.chartSpec);
        }
        next.updated_at = ctx.config.now().toISOString();
        db()
          .query(
            "UPDATE bindings SET sheet=?2, range=?3, dataset=?4, query=?5, chart_spec=?6, updated_at=?7 WHERE id=?1",
          )
          .run(
            next.id,
            next.sheet,
            next.range,
            next.dataset,
            next.query,
            next.chart_spec,
            next.updated_at,
          );
        return c.json(toBinding(next));
      });

      app.delete("/bindings/:id", (c) => {
        const id = c.req.param("id");
        const { changes } = db().query("DELETE FROM bindings WHERE id=?").run(id);
        if (changes === 0) throw new NotFoundError(`binding ${id}`);
        return c.json({ id, deleted: true });
      });
    },
  };
}
