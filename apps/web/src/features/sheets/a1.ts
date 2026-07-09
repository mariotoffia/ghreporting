// A1-notation math (ARCHITECTURE.md §7). Pure and exhaustively tested — the sheet
// facade (univer.ts) and the binding store (state/bindings.ts) build on it, so the
// awkward parts (bijective base-26 columns, corner normalization, sheet-qualified
// ranges) are solved once here and nowhere else.

/** A rectangle in 0-based, inclusive corners. `sheet` is "" for a sheet-relative range. */
export interface CellRange {
  sheet: string;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

// Spreadsheet columns are *bijective* base-26: A..Z, then AA..ZZ, then AAA — there is
// no "zero digit", so A=1 in 1-indexed space and we subtract 1 for the 0-based column.
function letterToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function colToLetter(col: number): string {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

function parseCell(cell: string): { row: number; col: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(cell.trim());
  const letters = m?.[1];
  const digits = m?.[2];
  if (letters === undefined || digits === undefined) throw new Error(`bad A1 cell: ${cell}`);
  const row = Number(digits);
  if (row < 1) throw new Error(`bad A1 cell (rows are 1-based): ${cell}`); // A0 → negative index
  return { col: letterToCol(letters), row: row - 1 };
}

/** `"Sheet1!A1:D3"` / `"A1"` → a normalized {@link CellRange} (corners min/maxed). */
export function parseRange(a1: string): CellRange {
  const bang = a1.lastIndexOf("!"); // split on the LAST ! so sheet names may contain !/spaces
  const sheet = bang >= 0 ? a1.slice(0, bang) : "";
  const parts = a1.slice(bang + 1).split(":");
  if (parts.length > 2) throw new Error(`bad A1 range (too many colons): ${a1}`);
  const [start, end] = parts;
  if (start === undefined) throw new Error(`bad A1 range: ${a1}`);
  const s = parseCell(start);
  const e = end === undefined ? s : parseCell(end);
  return {
    sheet,
    r0: Math.min(s.row, e.row),
    c0: Math.min(s.col, e.col),
    r1: Math.max(s.row, e.row),
    c1: Math.max(s.col, e.col),
  };
}

/** Inverse of {@link parseRange}; a 1x1 range collapses to a single cell. */
export function formatRange(r: CellRange): string {
  const a = `${colToLetter(r.c0)}${r.r0 + 1}`;
  const b = `${colToLetter(r.c1)}${r.r1 + 1}`;
  const cells = a === b ? a : `${a}:${b}`;
  return r.sheet ? `${r.sheet}!${cells}` : cells;
}

/** Do two ranges overlap? Different sheets never intersect; edges/corners count. */
export function rangesIntersect(a: CellRange, b: CellRange): boolean {
  if (a.sheet !== b.sheet) return false;
  return a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
}

/**
 * The sheet-relative range an `rows x cols` matrix occupies when written at `anchor`
 * (the insert flow, T7.3). Any sheet prefix on the anchor is ignored — the result is
 * sheet-relative, matching how a Binding stores `range` separately from `sheet`.
 */
export function rangeFromAnchor(anchor: string, rows: number, cols: number): string {
  const a = parseRange(anchor);
  return formatRange({
    sheet: "",
    r0: a.r0,
    c0: a.c0,
    r1: a.r0 + Math.max(1, rows) - 1,
    c1: a.c0 + Math.max(1, cols) - 1,
  });
}
