// SheetHost (ADR 0008, ARCHITECTURE.md §7): the single component that embeds Univer.
// It boots a workbook from the workspace snapshot, forwards value mutations to the
// binding store via `onEdit`, and autosaves the snapshot (debounced 2 s) back to the
// workspace service. Lazy-loaded (App.tsx) so Univer's weight never taxes login.
import { useEffect, useRef } from "react";
import { api } from "../../lib/client";
import { useBindings } from "../../state/bindings";
import { selectionRangeA1 } from "../charts/link";
import "@univerjs/presets/lib/styles/preset-sheets-core.css";
import {
  bootUniver,
  type FUniver,
  highlightRange,
  type IWorkbookData,
  onValueMutation,
  registerGhData,
  saveSnapshot,
} from "./univer";

const AUTOSAVE_MS = 2000;

export interface SheetHostProps {
  workbookId: string;
  name: string;
  snapshot?: Partial<IWorkbookData>;
  /** Called for every value mutation, once per affected range (drives the binding store). */
  onEdit?(sheet: string, a1: string): void;
  /** Hands the live facade to the parent (insert flow writes ranges through it, T7.3);
   * called with `null` on dispose so the parent never holds a disposed facade. */
  onReady?(api: FUniver | null): void;
}

export function SheetHost({ workbookId, name, snapshot, onEdit, onReady }: SheetHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The live facade, also kept in a ref so the chart→sheet selection effect can reach it
  // without re-booting Univer. Set on boot, cleared on dispose.
  const apiRef = useRef<FUniver | null>(null);
  // Latest callbacks kept in refs so the boot effect can depend on workbookId alone
  // (re-booting Univer on every render or callback identity change would be wrong).
  const onEditRef = useRef(onEdit);
  const onReadyRef = useRef(onReady);
  onEditRef.current = onEdit;
  onReadyRef.current = onReady;
  // Chart→sheet: when a chart click/brush sets the store selection, highlight those rows
  // on the bound range. This reads the store (never writes revisions), so it can't loop
  // back into the sheet→chart path (DDD invariant 9). `activate()` only moves the cursor.
  const selection = useBindings((s) => s.selection);

  // Re-boot Univer only when the workbook identity changes; `snapshot`/`name` are the
  // boot seed, read once here on purpose (a fresh workbookId remounts with fresh props).
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot/name intentionally seed the boot.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { univer, univerAPI } = bootUniver(container, snapshot, name);
    apiRef.current = univerAPI;
    onReadyRef.current?.(univerAPI);
    // Register =GHDATA(dataset, org, from, to) — spills the binding store's cached result
    // synchronously, never the network (T7.4). Disposed with the workbook below.
    const ghData = registerGhData(univerAPI, (key) => useBindings.getState().results[key]);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false; // an edit is waiting inside the debounce window
    // Snapshot is read synchronously (before any dispose); a rejected PUT (20 MB guard,
    // expired session, …) is logged rather than discarded with `void`, so a silent save
    // failure is at least diagnosable. No server notification covers a PUT the client
    // itself gave up on.
    const save = () => {
      dirty = false;
      api
        .put(`/api/workspace/workbooks/${workbookId}`, { snapshot: saveSnapshot(univerAPI) })
        .catch((err) => console.error("workbook autosave failed", err));
    };
    const off = onValueMutation(univerAPI, (sheet, a1) => {
      onEditRef.current?.(sheet, a1);
      dirty = true;
      // Debounce: coalesce a burst of edits into one snapshot PUT.
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, AUTOSAVE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      // Flush a pending edit so navigating away within the debounce window (or a
      // workbook switch) doesn't lose it — snapshot is captured before dispose.
      if (dirty) save();
      off();
      ghData.dispose(); // unregister GHDATA before tearing down the formula engine
      univer.dispose();
      apiRef.current = null;
      onReadyRef.current?.(null); // clear the parent's facade in lockstep with dispose
    };
  }, [workbookId]);

  // Highlight the sheet rows a chart interaction selected. Resolves the binding fresh
  // from the store (not a captured copy) so a range edit between select and highlight
  // still lands on the right cells.
  useEffect(() => {
    const facade = apiRef.current;
    if (!facade || !selection) return;
    const binding = useBindings.getState().bindings.find((b) => b.id === selection.bindingId);
    if (!binding) return;
    const a1 = selectionRangeA1(binding.range, selection.rows);
    if (a1) highlightRange(facade, binding.sheet, a1);
  }, [selection]);

  return <div className="sheet-host" ref={containerRef} />;
}
