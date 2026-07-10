// Query datasets (ADR 0016): the generic connector kind that backs every `query_datasets`
// row, plus column derivation. A Query Dataset is a stored SQL SELECT the user authored in
// the browser; it never syncs (coverage() → []) and only ever reads, on the read-only handle
// (adapters/db/database.ts `openReadOnly`). Two independent guards make writes/DDL impossible:
//   1. every user statement is wrapped `SELECT * FROM ( <sql> ) LIMIT n`, so a DELETE/DROP is
//      a *syntax error* before it reaches the driver, and
//   2. the handle is `{ readonly: true }`, so any write that were somehow valid throws.
// No SQL blacklist — the trust model (single-user local DB) is spelled out in ADR 0016.
import type { Database } from "bun:sqlite";
import { AppError, ValidationError } from "../../kernel/errors";
import type { ColumnMeta, DatasetConnector, DatasetQuery, ResultSet } from "./ports";

const MAX_LIMIT = 1000;

export interface QueryDatasetRow {
  id: string;
  title: string;
  description: string | null;
  sql: string; // one SELECT; uses :org, :from, :to named params
  columns: string; // cached ColumnMeta[] as JSON
  created_at: string;
  updated_at: string;
}

// Probe params for validation/derivation: harmless values that satisfy :org/:from/:to. Keys
// carry the `:` prefix — bun:sqlite binds a bare key as NULL against a `:name` param. Extra
// named params the SQL doesn't reference are ignored (both verified), so binding all three is
// safe whether or not a given dataset uses them.
const PROBE = { ":org": "", ":from": "1970-01-01", ":to": "1970-01-01" };

function bind(q: DatasetQuery): Record<string, string> {
  return { ":org": q.org, ":from": q.range.from, ":to": q.range.to };
}

/** Wrap user SQL so any non-SELECT is a syntax error; the driver readonly guard is the backstop. */
function wrap(sql: string, limit: number): string {
  return `SELECT * FROM ( ${sql} ) LIMIT ${limit}`;
}

/**
 * Run wrapped user SQL on the read-only handle and return its column names + rows, capped at
 * `limit` in JS. The SQL `LIMIT` is best-effort only — a crafted SELECT can close the wrapper
 * paren (`… ) --`) and drop it — so `.slice(0, limit)` is the AUTHORITATIVE cap that guarantees
 * at most `limit` rows leave this function regardless of the SQL. (Writes stay impossible two
 * ways: the readonly handle throws on any write, and bun runs only the first statement, which
 * is always the wrapper's SELECT.)
 * ponytail: an escaped LIMIT still materializes the full result internally before the slice — a
 * self-inflicted memory transient on the user's own local DB (ADR 0016 trust model), not a leak.
 */
function runWrapped(
  roDb: Database,
  sql: string,
  params: Record<string, string>,
  limit: number,
): { names: string[]; rows: unknown[][] } {
  const stmt = roDb.query(wrap(sql, limit));
  const rows = (stmt.values(params) as unknown[][]).slice(0, limit);
  return { names: stmt.columnNames, rows };
}

// ponytail: sample-based type inference; refine to per-column typing if a chart mistypes.
function inferType(v: unknown): ColumnMeta["type"] {
  if (typeof v === "number" || typeof v === "bigint") return "number";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return "date";
  return "string";
}

/**
 * Derive the result schema by running the SELECT on the READ-ONLY handle: this validates syntax
 * AND rejects writes/DDL. Column names come from the prepared statement; each type is inferred
 * from a single sample row. Throws ValidationError (carrying the SQLite message) on bad or
 * writing SQL, so the route answers 400.
 */
export function deriveColumns(
  roDb: Database,
  sql: string,
  // Sample params for type inference. Callers with real org/range (create/update from the editor
  // after a Preview) pass them so a parameterized dataset (WHERE org=:org …) samples REAL rows —
  // the fixed PROBE matches nothing for such datasets, so every column would infer as "string".
  sample?: { org: string; from: string; to: string },
): ColumnMeta[] {
  const params = sample ? { ":org": sample.org, ":from": sample.from, ":to": sample.to } : PROBE;
  let names: string[];
  let row: unknown[] | undefined;
  try {
    const r = runWrapped(roDb, sql, params, 1);
    names = r.names;
    row = r.rows[0];
  } catch (e) {
    throw new ValidationError(`query dataset SQL rejected: ${(e as Error).message}`);
  }
  if (names.length === 0) throw new ValidationError("query dataset SQL selected no columns");
  return names.map((name, i) => ({ name, type: inferType(row?.[i]), description: "" }));
}

/**
 * Wrap a stored row as a DatasetConnector. It never syncs (coverage → [], fetch/upsert throw);
 * select() runs the stored SELECT on the read-only handle with {org, from, to} bound and the
 * query's (already-clamped) limit, returning rows in the cached column order.
 */
export function queryDatasetConnector(row: QueryDatasetRow, roDb: Database): DatasetConnector {
  const columns = JSON.parse(row.columns) as ColumnMeta[];
  const readonly = () => {
    throw new AppError("dataset.readonly", `${row.id} is a query dataset — read-only`, 400);
  };
  return {
    meta: {
      id: row.id,
      title: row.title,
      description: row.description ?? "",
      columns,
      scope: "org",
      freshnessTtlHours: 0, // never syncs; coverage() is empty so TTL is moot
    },
    coverage: () => [],
    // biome-ignore lint/correctness/useYield: intentionally throws — a query dataset never fetches
    fetch: async function* () {
      readonly();
    },
    upsert: readonly,
    select: (_db, q): ResultSet => {
      // Self-defending clamp: a negative SQL LIMIT means "unlimited" in SQLite and a negative
      // slice end drops from the tail — so bound to [1, MAX_LIMIT] here, not just at the route.
      const limit = Math.min(Math.max(1, Math.floor(q.limit ?? MAX_LIMIT)), MAX_LIMIT);
      // A saved dataset can pass create-time validation yet throw at real-query time: a
      // value-dependent SQLite error (e.g. json_extract on a non-JSON :org) is gated behind a
      // branch the derive-time probe never takes. Translate that to a 400, not a 500.
      try {
        return { columns, rows: runWrapped(roDb, row.sql, bind(q), limit).rows };
      } catch (e) {
        throw new AppError("dataset.query_failed", `${row.id}: ${(e as Error).message}`, 400);
      }
    },
  };
}
