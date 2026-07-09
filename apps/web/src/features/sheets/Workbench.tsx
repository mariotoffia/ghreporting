// Workbench (E7): hosts the active workbook's SheetHost and is where the live Univer
// sheet lives. It (1) loads the workbook + its bindings, (2) forwards value mutations to
// the binding store (sheet→chart revision bumps), and (3) completes a pending "insert
// into sheet" hand-off from the explorer, once the sheet facade is ready (T7.3).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/client";
import { type Binding, useBindings } from "../../state/bindings";
import { type InsertResultSet, insertIntoSheet, nextAnchor } from "../../state/insert";
import { useUi } from "../../state/ui";
import { SheetHost } from "./SheetHost";
import { type FUniver, type IWorkbookData, writeRange } from "./univer";

interface WorkbookSummary {
  id: string;
  name: string;
  updated_at: string;
}
interface WorkbookFull extends WorkbookSummary {
  snapshot: Partial<IWorkbookData>;
  bindings: Binding[];
}

const WORKBOOKS_KEY = ["workbooks"] as const;

/** Loads one workbook by a definite id, mounts its sheet, and wires the binding flows. */
function ActiveWorkbook({ id }: { id: string }) {
  const wb = useQuery({
    queryKey: ["workbook", id],
    queryFn: () => api.get<WorkbookFull>(`/api/workspace/workbooks/${id}`),
  });
  const [sheetApi, setSheetApi] = useState<FUniver | null>(null);
  const [insertError, setInsertError] = useState<string | null>(null);
  const pending = useUi((s) => s.pendingInsert);
  const clearInsert = useUi((s) => s.clearInsert);

  // Populate the binding store so onSheetEdit can intersect against this workbook's bindings.
  useEffect(() => {
    void useBindings.getState().load(id);
  }, [id]);

  // Complete a pending insert once the sheet facade exists. Consume the intent first so
  // a query refetch (which changes wb.data identity) can never double-insert.
  useEffect(() => {
    if (!pending || !sheetApi || !wb.data) return;
    const intent = pending;
    clearInsert();
    setInsertError(null);
    const targetSheet = "Sheet1"; // the default sheet of a fresh Univer workbook
    insertIntoSheet(
      {
        query: (dataset, q) =>
          api.post<InsertResultSet>("/api/data/query", { dataset, q, sync: true }),
        write: (sheet, anchor, matrix) => writeRange(sheetApi, sheet, anchor, matrix),
        saveBinding: (workbookId, body) =>
          api.post<Binding>(`/api/workspace/workbooks/${workbookId}/bindings`, body),
      },
      {
        workbookId: id,
        sheet: targetSheet,
        // Stack below existing bindings so a second insert can't clobber the first.
        anchor: nextAnchor(useBindings.getState().bindings, targetSheet),
        dataset: intent.dataset,
        query: intent.query,
      },
    ).catch((err: unknown) =>
      // Interactive failure — no server notification covers it, so show it in-place.
      setInsertError(err instanceof Error ? err.message : "Insert into sheet failed."),
    );
  }, [pending, sheetApi, wb.data, id, clearInsert]);

  if (!wb.data) return <p className="workbench-loading">Loading sheet…</p>;
  return (
    <>
      {insertError && (
        <p className="workbench-error" role="alert">
          {insertError}
        </p>
      )}
      <SheetHost
        workbookId={wb.data.id}
        name={wb.data.name}
        snapshot={wb.data.snapshot}
        onReady={setSheetApi}
        onEdit={(sheet, a1) => useBindings.getState().onSheetEdit(sheet, a1)}
      />
    </>
  );
}

export function Workbench() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: WORKBOOKS_KEY,
    queryFn: () => api.get<WorkbookSummary[]>("/api/workspace/workbooks"),
  });
  const create = useMutation({
    mutationFn: () => api.post<WorkbookSummary>("/api/workspace/workbooks", { name: "Untitled" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: WORKBOOKS_KEY }),
  });

  if (list.isLoading) return <p className="workbench">Loading workbooks…</p>;
  const first = list.data?.[0];
  if (!first) {
    return (
      <section className="workbench">
        <p className="muted">No workbooks yet.</p>
        <button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
          New workbook
        </button>
      </section>
    );
  }
  return (
    <section className="workbench">
      {/* key by id so a future workbook switch fully remounts (fresh sheetApi, no
          stale/disposed Univer facade leaking into the next workbook's insert). */}
      <ActiveWorkbook key={first.id} id={first.id} />
    </section>
  );
}
