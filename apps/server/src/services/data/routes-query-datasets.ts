// CRUD + preview routes for query datasets (ADR 0016), mounted under /api/data by the data
// service. Split out of service.ts to keep both files ≤ 500 lines. Ids are user-supplied
// kebab-case; a built-in connector id or an existing row wins a clash (409). All SQL runs on
// the read-only handle via deriveColumns / queryDatasetConnector — this file never executes
// user SQL itself. TOCTOU discipline mirrors reports/workspace: the body read is the only
// await, then existence-check + write run with no yield (bun:sqlite is synchronous).
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { AppError, NotFoundError, ValidationError } from "../../kernel/errors";
import { capBytes, jsonObject, nonEmpty } from "../../kernel/http";
import { deriveColumns, type QueryDatasetRow, queryDatasetConnector } from "./query-dataset";

const MAX_SQL_BYTES = 64 * 1024;
const MAX_LIMIT = 1000;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // kebab-case, matches DatasetMeta.id shape

export interface QueryDatasetRouteDeps {
  db(): Database; // read-write handle (owns the query_datasets table)
  roDb: Database; // read-only handle every user SELECT runs on
  isBuiltin(id: string): boolean; // built-in connector ids win a name clash
  now(): Date;
}

/** Validate an optional description to `string | null`; reject a non-string (never coerce). */
function toDescription(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") throw new ValidationError("description must be a string or null");
  return v;
}

/**
 * Extract the optional {org, from, to} the editor sends alongside a create/update so column
 * types are inferred from REAL rows (a parameterized `WHERE org=:org …` matches nothing under
 * the fixed derive-time probe). Only honored when org is a real, non-empty string with a range;
 * otherwise undefined → deriveColumns falls back to its probe (best-effort types).
 */
function sampleFrom(
  body: Record<string, unknown>,
): { org: string; from: string; to: string } | undefined {
  const r = body.range as { from?: unknown; to?: unknown } | undefined;
  if (typeof body.org !== "string" || body.org.trim() === "") return undefined;
  if (typeof r?.from !== "string" || typeof r?.to !== "string") return undefined;
  return { org: body.org, from: r.from, to: r.to };
}

/** DB row → wire shape (columns parsed back to JSON). */
function toWire(row: QueryDatasetRow) {
  return { ...row, columns: JSON.parse(row.columns) as unknown };
}

export function registerQueryDatasetRoutes(app: Hono, deps: QueryDatasetRouteDeps): void {
  const { roDb } = deps;
  const db = deps.db;
  const rowById = (id: string): QueryDatasetRow | null =>
    db().query("SELECT * FROM query_datasets WHERE id=?").get(id) as QueryDatasetRow | null;

  app.get("/query-datasets", (c) =>
    c.json(
      db()
        .query(
          "SELECT id, title, description, updated_at FROM query_datasets ORDER BY updated_at DESC",
        )
        .all(),
    ),
  );

  app.post("/query-datasets", async (c) => {
    const body = await jsonObject(c.req);
    // Validate everything before the first write (no half-applied create).
    const id = nonEmpty(body.id, "id");
    if (!ID_RE.test(id)) throw new ValidationError("id must be kebab-case (a-z, 0-9, hyphens)");
    const title = nonEmpty(body.title, "title");
    const description = toDescription(body.description);
    const sql = capBytes(nonEmpty(body.sql, "sql"), MAX_SQL_BYTES, "sql");
    if (deps.isBuiltin(id))
      throw new AppError("dataset.reserved", `${id} is a built-in dataset`, 409);
    const columns = deriveColumns(roDb, sql, sampleFrom(body)); // ValidationError (400) on bad SQL
    if (rowById(id))
      throw new AppError("dataset.exists", `query dataset ${id} already exists`, 409);
    const at = deps.now().toISOString();
    db()
      .query(
        "INSERT INTO query_datasets(id,title,description,sql,columns,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, title, description, sql, JSON.stringify(columns), at, at);
    return c.json({ id, title, description, updated_at: at });
  });

  app.get("/query-datasets/:id", (c) => {
    const id = c.req.param("id");
    const row = rowById(id);
    if (!row) throw new NotFoundError(`query dataset ${id}`);
    return c.json(toWire(row));
  });

  app.put("/query-datasets/:id", async (c) => {
    const id = c.req.param("id");
    const body = await jsonObject(c.req); // the only await; checks + writes follow with no yield
    if (!rowById(id)) throw new NotFoundError(`query dataset ${id}`);
    // Validate ALL provided fields (incl. re-deriving columns) before writing ANY.
    const title = body.title !== undefined ? nonEmpty(body.title, "title") : undefined;
    const description =
      body.description === undefined ? undefined : toDescription(body.description);
    let sql: string | undefined;
    let columns: string | undefined;
    if (body.sql !== undefined) {
      sql = capBytes(nonEmpty(body.sql, "sql"), MAX_SQL_BYTES, "sql");
      columns = JSON.stringify(deriveColumns(roDb, sql, sampleFrom(body)));
    }
    const at = deps.now().toISOString();
    if (title !== undefined)
      db().query("UPDATE query_datasets SET title=?2 WHERE id=?1").run(id, title);
    if (description !== undefined) {
      db().query("UPDATE query_datasets SET description=?2 WHERE id=?1").run(id, description);
    }
    if (sql !== undefined) {
      db()
        .query("UPDATE query_datasets SET sql=?2, columns=?3 WHERE id=?1")
        .run(id, sql, columns as string);
    }
    db().query("UPDATE query_datasets SET updated_at=?2 WHERE id=?1").run(id, at);
    return c.json(toWire(rowById(id) as QueryDatasetRow));
  });

  app.delete("/query-datasets/:id", (c) => {
    const id = c.req.param("id");
    const { changes } = db().query("DELETE FROM query_datasets WHERE id=?").run(id);
    if (changes === 0) throw new NotFoundError(`query dataset ${id}`);
    return c.json({ id, deleted: true });
  });

  // Powers the editor Preview: derive columns + run the SQL on the read-only handle with the
  // given (or probe) params. Reuses the connector's wrap/bind so preview and real queries agree.
  app.post("/query-datasets/preview", async (c) => {
    const body = await jsonObject(c.req);
    const sql = capBytes(nonEmpty(body.sql, "sql"), MAX_SQL_BYTES, "sql");
    const org = typeof body.org === "string" ? body.org : "";
    const r = body.range as { from?: unknown; to?: unknown } | undefined;
    const from = typeof r?.from === "string" ? r.from : "1970-01-01";
    const to = typeof r?.to === "string" ? r.to : "1970-01-01";
    // Derive with the same params the rows are fetched with, so preview column types reflect
    // the previewed data (not the empty probe).
    const columns = deriveColumns(roDb, sql, sampleFrom(body));
    const previewRow: QueryDatasetRow = {
      id: "preview",
      title: "",
      description: null,
      sql,
      columns: JSON.stringify(columns),
      created_at: "",
      updated_at: "",
    };
    const rs = queryDatasetConnector(previewRow, roDb).select(roDb, {
      org,
      range: { from, to },
      limit: MAX_LIMIT,
    });
    return c.json({ columns: rs.columns, rows: rs.rows });
  });
}
