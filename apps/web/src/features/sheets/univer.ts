// The ONLY module allowed to import Univer (ADR 0008): an anti-corruption layer so a
// Univer version bump is contained to this file plus SheetHost. Everything else in the
// app speaks the binding store and these four thin wrappers, never `univerAPI` directly.
//
// Facade names verified against @univerjs/presets 0.25.1 (the pinned minor). The sheet
// API has moved between minors — re-verify every symbol here on any upgrade, with the
// e2e sheet tests (T11.3) as the gate (ADR 0008).
import {
  type CellValue,
  createUniver,
  type FUniver,
  type IWorkbookData,
  LocaleType,
} from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/presets/preset-sheets-core";
import sheetsCoreEnUS from "@univerjs/presets/preset-sheets-core/locales/en-US";
import { rangeFromAnchor } from "./a1";

export type { FUniver, IWorkbookData };

/**
 * Boot a Univer instance into `container`, seeded from a persisted snapshot (or a
 * fresh single-sheet workbook named `name` when the snapshot is empty/absent).
 */
export function bootUniver(
  container: HTMLElement,
  snapshot: Partial<IWorkbookData> | undefined,
  name: string,
): { univer: ReturnType<typeof createUniver>["univer"]; univerAPI: FUniver } {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: sheetsCoreEnUS },
    presets: [UniverSheetsCorePreset({ container })],
  });
  const hasSnapshot = snapshot != null && Object.keys(snapshot).length > 0;
  univerAPI.createWorkbook(hasSnapshot ? snapshot : { name });
  return { univer, univerAPI };
}

/** Write a row-major matrix into `sheet`, anchored at `a1`'s top-left cell. */
export function writeRange(api: FUniver, sheet: string, a1: string, matrix: unknown[][]): void {
  const ws = api.getActiveWorkbook()?.getSheetByName(sheet);
  if (!ws) throw new Error(`writeRange: no sheet "${sheet}"`);
  if (matrix.length === 0) return;
  // CRITICAL: Univer's setValues copies cell-by-cell bounded by the RANGE, not the
  // matrix (getRange("A1") is 1x1 → only matrix[0][0] would land). Size the target
  // range to the matrix's own extent, anchored at a1's top-left.
  const range = rangeFromAnchor(a1, matrix.length, matrix[0]?.length ?? 1);
  // Univer's CellValue is string | number | boolean (no null). Cells arrive as JSON
  // primitives; coerce null/undefined to "" (an empty cell) so the cast is honest.
  const cells = matrix.map((row) => row.map((v) => (v == null ? "" : v))) as CellValue[][];
  ws.getRange(range).setValues(cells);
}

/** Read `sheet!a1` back as a row-major matrix (empty when the sheet is gone). */
export function readRange(api: FUniver, sheet: string, a1: string): unknown[][] {
  const ws = api.getActiveWorkbook()?.getSheetByName(sheet);
  return ws ? ws.getRange(a1).getValues() : [];
}

/** The current workbook snapshot, persisted by the workspace service. */
export function saveSnapshot(api: FUniver): IWorkbookData {
  const wb = api.getActiveWorkbook();
  if (!wb) throw new Error("saveSnapshot: no active workbook");
  return wb.save();
}

/**
 * Fire `cb(sheet, a1)` for every value mutation, once per affected range. Uses the
 * typed SheetValueChanged event — 0.25.1's replacement for the raw set-range-values
 * mutation listener the plan describes. Returns an unsubscribe.
 */
export function onValueMutation(api: FUniver, cb: (sheet: string, a1: string) => void): () => void {
  const disposable = api.addEvent(api.Event.SheetValueChanged, (p) => {
    for (const r of p.effectedRanges) cb(r.getSheetName(), r.getA1Notation());
  });
  return () => disposable.dispose();
}
