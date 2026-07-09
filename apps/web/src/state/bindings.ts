// The binding store (ARCHITECTURE.md §7, ADR 0009, DDD.md §3.3): the single mediator
// between a sheet range, a dataset query, and an optional chart spec. It is the ONLY
// coupling between a sheet and a chart (DDD.md invariant 9) — the explorer creates
// bindings, SheetHost materializes their rows, ChartHost renders them.
//
// Loop prevention (DDD.md §4.9): `revisions` is bumped ONLY by value mutations
// (onSheetEdit); `selection` is a separate channel that NEVER touches revisions. That
// separation is what stops a chart→sheet→chart update loop, so guard it with a test.
import { create } from "zustand";
import { parseRange, rangesIntersect } from "../features/sheets/a1";
import { api } from "../lib/client";

/** The query that produced a binding's rows (mirrors the data service's wire shape). */
export interface DatasetQuery {
  org: string;
  range: { from: string; to: string };
  filter?: Record<string, string | string[]>;
  limit?: number;
}

/** A serializable ECharts option template (E8 owns the concrete shape). */
export type ChartSpec = Record<string, unknown>;

export interface Binding {
  id: string;
  workbookId: string;
  sheet: string;
  range: string; // sheet-relative A1, includes the header row
  dataset: string;
  query: DatasetQuery;
  chartSpec?: ChartSpec;
}

interface BindingState {
  bindings: Binding[];
  revisions: Record<string, number>; // bumped ONLY by value mutations
  selection: { bindingId: string; rows: number[] } | null; // NEVER bumps revisions
  load(workbookId: string): Promise<void>;
  add(b: Binding): void;
  bumpRevision(bindingId: string): void;
  select(sel: BindingState["selection"]): void;
  onSheetEdit(sheet: string, editedA1: string): void; // intersect → bumpRevision
}

export const useBindings = create<BindingState>((set, get) => ({
  bindings: [],
  revisions: {},
  selection: null,

  async load(workbookId) {
    const wb = await api.get<{ bindings: Binding[] }>(`/api/workspace/workbooks/${workbookId}`);
    // A fresh workbook starts every chart clean — reset revisions and selection.
    set({ bindings: wb.bindings, revisions: {}, selection: null });
  },

  add(b) {
    set((s) => ({ bindings: [...s.bindings, b] }));
  },

  bumpRevision(bindingId) {
    set((s) => ({
      revisions: { ...s.revisions, [bindingId]: (s.revisions[bindingId] ?? 0) + 1 },
    }));
  },

  // Selection is the chart→sheet channel. It must not write `revisions`, or a chart
  // brush would re-trigger the sheet→chart path and loop (DDD.md §4.9).
  select(sel) {
    set({ selection: sel });
  },

  onSheetEdit(sheet, editedA1) {
    // onValueMutation passes a sheet-relative a1 today (getA1Notation() drops the
    // sheet), but tolerate a sheet-qualified one so a future caller can't silently
    // desync every chart (a doubled "S!S!A1" prefix would match no binding at all).
    const edited = parseRange(editedA1.includes("!") ? editedA1 : `${sheet}!${editedA1}`);
    for (const b of get().bindings) {
      if (rangesIntersect(edited, parseRange(`${b.sheet}!${b.range}`))) get().bumpRevision(b.id);
    }
  },
}));
