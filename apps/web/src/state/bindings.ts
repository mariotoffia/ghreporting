// The binding store (ARCHITECTURE.md §7, ADR 0009, DDD.md §3.3): the single mediator
// between a sheet range, a dataset query, and an optional chart spec. It is the ONLY
// coupling between a sheet and a chart (DDD.md invariant 9) — the explorer creates
// bindings, SheetHost materializes their rows, ChartHost renders them.
//
// Loop prevention (DDD.md §4.9): `revisions` is bumped ONLY by value mutations
// (onSheetEdit); `selection` is a separate channel that NEVER touches revisions. That
// separation is what stops a chart→sheet→chart update loop, so guard it with a test.
import { create } from "zustand";
import type { ChartSpec } from "../features/charts/spec";
import { parseRange, rangesIntersect } from "../features/sheets/a1";
import { resultKey } from "../features/sheets/ghdata";
import { api } from "../lib/client";

// E8 owns the concrete ChartSpec shape (features/charts/spec.ts); re-exported here so a
// Binding's optional chart spec is fully typed and consumers keep importing it from the store.
export type { ChartSpec };

/** The query that produced a binding's rows (mirrors the data service's wire shape). */
export interface DatasetQuery {
  org: string;
  range: { from: string; to: string };
  filter?: Record<string, string | string[]>;
  limit?: number;
}

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
  results: Record<string, unknown[][]>; // last query result per query, for the GHDATA formula (T7.4)
  load(workbookId: string): Promise<void>;
  add(b: Binding): void;
  replaceBinding(b: Binding): void; // swap one binding (e.g. after a chartSpec edit) in place
  cacheResult(dataset: string, query: DatasetQuery, matrix: unknown[][]): void;
  bumpRevision(bindingId: string): void;
  select(sel: BindingState["selection"]): void;
  onSheetEdit(sheet: string, editedA1: string): void; // intersect → bumpRevision
}

export const useBindings = create<BindingState>((set, get) => ({
  bindings: [],
  revisions: {},
  selection: null,
  results: {},

  async load(workbookId) {
    const wb = await api.get<{ bindings: Binding[] }>(`/api/workspace/workbooks/${workbookId}`);
    // A fresh workbook starts every chart clean — reset revisions and selection. `results`
    // is query-keyed, not workbook-scoped, so it survives a workbook switch (GHDATA cache).
    set({ bindings: wb.bindings, revisions: {}, selection: null });
  },

  add(b) {
    set((s) => ({ bindings: [...s.bindings, b] }));
  },

  // Swap one binding by id, preserving `revisions`/`selection`. Used after a chartSpec
  // edit so a single chart change doesn't reset (and repaint) every other chart the way a
  // full `load()` would (its revisions/selection reset is only wanted on workbook load).
  replaceBinding(b) {
    set((s) => ({ bindings: s.bindings.map((x) => (x.id === b.id ? b : x)) }));
  },

  // Cache a query's result so the GHDATA formula can spill it synchronously (T7.4). Keyed
  // by (dataset, org, from, to) only — the 4-arg formula can't express query.filter/limit,
  // so two same-tuple queries that differ only by filter are last-write-wins (acceptable:
  // GHDATA is unfiltered-query sugar). GHDATA reflects data already fetched for those args
  // (else #N/A); it never hits the network from formula evaluation.
  // ponytail: unbounded per-tuple growth; add a small LRU cap if a long session's cache bites.
  cacheResult(dataset, query, matrix) {
    const key = resultKey(dataset, query.org, query.range.from, query.range.to);
    set((s) => ({ results: { ...s.results, [key]: matrix } }));
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
