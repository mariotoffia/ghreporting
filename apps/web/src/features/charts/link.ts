// The chart→sheet half of the bidirectional link (ADR 0009, ARCHITECTURE.md §7, DDD
// invariant 9). Pure and exhaustively tested; the sheet-bound pane (BoundChart) and
// SheetHost call these, but they hold no ECharts/Univer types themselves.
//
// Data-row indices are the currency here: ECharts' dataset has the column header as
// source[0], so a click/brush `dataIndex` of 0 is the FIRST DATA ROW. The header→sheet
// offset (+1) is applied exactly once, in selectionRangeA1 — nowhere else (the loop the
// mediator prevents starts if two places disagree on where the header sits).
import { formatRange, parseRange } from "../sheets/a1";

/** An ECharts click carries a scalar `dataIndex`; a brush carries `batch[].selected[]`. */
interface ChartEvent {
  dataIndex?: number;
  batch?: { selected?: { dataIndex?: number[] }[] }[];
}

/**
 * The selected data-row indices from a click or brush event, deduped and ascending.
 * Click → `[dataIndex]`; brush → every `batch[].selected[].dataIndex`, flattened. Returns
 * `[]` when the interaction selected nothing (a click off any mark, an empty drag).
 */
export function eventToRows(params: unknown): number[] {
  const p = params as ChartEvent;
  if (p.batch) {
    const rows = new Set<number>();
    for (const b of p.batch) {
      for (const sel of b.selected ?? []) {
        for (const i of sel.dataIndex ?? []) if (i >= 0) rows.add(i);
      }
    }
    return [...rows].sort((a, b) => a - b);
  }
  if (typeof p.dataIndex === "number" && p.dataIndex >= 0) return [p.dataIndex];
  return [];
}

/**
 * The sheet-relative A1 range to highlight for a set of selected data rows, within a
 * binding whose `range` includes the header row. Spans min..max of `dataRows` (a
 * non-contiguous brush collapses to its enclosing block — `activate()` takes one range)
 * across the binding's full column width. `null` when nothing is selected.
 * ponytail: enclosing-block highlight; per-row multi-select if a user asks for it.
 */
export function selectionRangeA1(bindingRange: string, dataRows: number[]): string | null {
  if (dataRows.length === 0) return null;
  const r = parseRange(bindingRange);
  const firstDataRow = r.r0 + 1; // +1 skips the header row
  if (firstDataRow > r.r1) return null; // header-only binding: no data rows to highlight
  // Clamp both ends into the range's own data rows [firstDataRow, r1] so a stray index
  // (negative or past the last row) can't escape the binding — defensive against any caller
  // (ECharts can't emit one for the current wiring).
  const clamp = (row: number) => Math.max(firstDataRow, Math.min(row, r.r1));
  const top = clamp(firstDataRow + Math.min(...dataRows));
  const bottom = clamp(firstDataRow + Math.max(...dataRows));
  return formatRange({ sheet: "", r0: top, c0: r.c0, r1: bottom, c1: r.c1 });
}
