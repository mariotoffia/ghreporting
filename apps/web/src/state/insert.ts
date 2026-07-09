// The "Insert into sheet" flow (T7.3, ARCHITECTURE.md §7). Kept dependency-injected so
// it is unit-testable without a live Univer or network: the explorer wires the real
// deps (data query, sheet write, binding save); tests pass fakes. The steps are exactly
// the plan's: query → matrix (header first) → write at anchor → persist binding → store.
import { formatRange, parseRange, rangeFromAnchor } from "../features/sheets/a1";
import { type Binding, type DatasetQuery, useBindings } from "./bindings";

/** The subset of a data-service ResultSet the insert flow needs. */
export interface InsertResultSet {
  columns: { name: string }[];
  rows: unknown[][];
}

export interface InsertParams {
  workbookId: string;
  sheet: string;
  anchor: string; // A1 cell; the explorer dialog defaults it to "A1"
  dataset: string;
  query: DatasetQuery;
}

/** Side effects the flow needs, injected so the logic stays pure and testable. */
export interface InsertDeps {
  /** Run the dataset query (the real impl posts with `{ sync: true }`). */
  query(dataset: string, q: DatasetQuery): Promise<InsertResultSet>;
  /** Write a row-major matrix into the live sheet at the anchor (Univer facade). */
  write(sheet: string, anchor: string, matrix: unknown[][]): void;
  /** Persist the binding via the workspace service; returns it with its server id. */
  saveBinding(
    workbookId: string,
    body: Pick<Binding, "sheet" | "range" | "dataset" | "query">,
  ): Promise<Binding>;
}

/** `[header row, ...data rows]` — the matrix written into the sheet at the anchor. */
export function resultToMatrix(rs: InsertResultSet): unknown[][] {
  return [rs.columns.map((c) => c.name), ...rs.rows];
}

/**
 * The next free anchor cell on `sheet`: column A, one blank row below the lowest
 * existing binding (or A1 when the sheet is empty). Repeated inserts stack instead of
 * overwriting A1 — without this, a second insert clobbers the first and leaves two
 * bindings claiming the same cells. (A full picker/anchor dialog is future UI.)
 */
export function nextAnchor(bindings: Pick<Binding, "sheet" | "range">[], sheet: string): string {
  let maxBottom = -1;
  for (const b of bindings) {
    if (b.sheet === sheet) maxBottom = Math.max(maxBottom, parseRange(`${sheet}!${b.range}`).r1);
  }
  const row = maxBottom < 0 ? 0 : maxBottom + 2; // first insert → A1, then a 1-row gap
  return formatRange({ sheet: "", r0: row, c0: 0, r1: row, c1: 0 });
}

/** Query a dataset, drop it into a sheet with a header row, and bind the range. */
export async function insertIntoSheet(deps: InsertDeps, params: InsertParams): Promise<Binding> {
  const rs = await deps.query(params.dataset, params.query);
  const matrix = resultToMatrix(rs);
  deps.write(params.sheet, params.anchor, matrix); // header row written first
  const range = rangeFromAnchor(params.anchor, matrix.length, rs.columns.length);
  const binding = await deps.saveBinding(params.workbookId, {
    sheet: params.sheet,
    range,
    dataset: params.dataset,
    query: params.query,
  });
  useBindings.getState().add(binding);
  return binding;
}
