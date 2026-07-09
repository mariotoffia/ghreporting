// Workbench (E7): hosts the active workbook's SheetHost and is where the live Univer
// sheet lives. It (1) loads the workbook + its bindings, (2) forwards value mutations to
// the binding store (sheet→chart revision bumps), and (3) completes a pending "insert
// into sheet" hand-off from the explorer, once the sheet facade is ready (T7.3).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/client";
import { type Binding, type ChartSpec, useBindings } from "../../state/bindings";
import { type InsertResultSet, insertIntoSheet, nextAnchor } from "../../state/insert";
import { useUi } from "../../state/ui";
import { BoundChart } from "../charts/BoundChart";
import { deriveChartSpec } from "../charts/spec";
import { SheetHost } from "./SheetHost";
import { type FUniver, type IWorkbookData, readRange, writeRange } from "./univer";

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
  const bindings = useBindings((s) => s.bindings);

  // Populate the binding store so onSheetEdit can intersect against this workbook's bindings.
  useEffect(() => {
    void useBindings.getState().load(id);
  }, [id]);

  // Read a binding's live range from the sheet — memoized on the facade so BoundChart
  // re-reads once the sheet finishes booting (facade goes null → live).
  const read = useCallback(
    (sheet: string, range: string): unknown[][] =>
      sheetApi ? readRange(sheetApi, sheet, range) : [],
    [sheetApi],
  );

  // Persist a chart spec change/removal and swap just that one binding in the store, so a
  // single chart edit doesn't reset revisions/selection (and repaint every other chart) —
  // which a full `load()` would. The PUT returns the updated binding with its new chartSpec.
  // ponytail: PUTs aren't serialized, so hammering the type dropdown is last-write-wins on
  // the response; self-heals on reload. Serialize per binding if it ever matters.
  const persistSpec = useCallback(
    async (binding: Binding, next: ChartSpec | null): Promise<void> => {
      setInsertError(null);
      try {
        const updated = await api.put<Binding>(`/api/workspace/bindings/${binding.id}`, {
          chartSpec: next,
        });
        useBindings.getState().replaceBinding(updated);
      } catch (err) {
        setInsertError(err instanceof Error ? err.message : "Chart update failed.");
      }
    },
    [],
  );

  // Seed a default chart from the bound range's current shape (T8.1 done-when: a binding
  // with a chartSpec renders). Needs ≥2 columns to relate one against another.
  const addChart = useCallback(
    (binding: Binding): void => {
      const spec = deriveChartSpec(read(binding.sheet, binding.range));
      if (!spec) {
        setInsertError("Not enough columns to chart this range.");
        return;
      }
      void persistSpec(binding, spec);
    },
    [read, persistSpec],
  );

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
      {bindings.length > 0 && (
        <section className="charts">
          {bindings.map((b) =>
            b.chartSpec ? (
              <BoundChart
                key={b.id}
                binding={b}
                read={read}
                onSpecChange={(next) => void persistSpec(b, next)}
              />
            ) : (
              <div key={b.id} className="chart-add">
                <span className="muted">
                  {b.dataset} — {b.range}
                </span>
                <button type="button" onClick={() => addChart(b)}>
                  Add chart
                </button>
              </div>
            ),
          )}
        </section>
      )}
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
