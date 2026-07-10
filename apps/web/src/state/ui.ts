// UI (non-server) state (ARCHITECTURE.md §7): which top-level view is showing, plus a
// one-shot "insert into sheet" hand-off (the explorer stashes the intent and switches
// to the workbench, where a live Univer sheet completes the insert — T7.3). No router
// library — a router lands only when deep-linking becomes a requirement (T6.1).
import { create } from "zustand";
import type { DatasetQuery } from "./bindings"; // type-only: no runtime import cycle

export type View = "login" | "explorer" | "workbench" | "reports" | "query-datasets" | "settings";

/** A dataset the explorer asked to drop into the active workbook. */
export interface PendingInsert {
  dataset: string;
  query: DatasetQuery;
}

interface UiState {
  view: View;
  setView(view: View): void;
  pendingInsert: PendingInsert | null;
  /** Stash the intent and jump to the workbench, which owns the live sheet. */
  requestInsert(p: PendingInsert): void;
  clearInsert(): void;
}

export const useUi = create<UiState>((set) => ({
  view: "login",
  setView: (view) => set({ view }),
  pendingInsert: null,
  requestInsert: (pendingInsert) => set({ pendingInsert, view: "workbench" }),
  clearInsert: () => set({ pendingInsert: null }),
}));
