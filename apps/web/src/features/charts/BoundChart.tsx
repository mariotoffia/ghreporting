// BoundChart (T8.2): the sheet-bound wiring around the pure ChartHost. It closes the
// bidirectional loop for one binding — sheet→chart via the store's revision, chart→sheet
// via the store's selection — while ChartHost itself stays sheet-agnostic (so the reports
// feature can reuse it with query results, ARCHITECTURE.md §7).
//
//   sheet edit → onValueMutation → store.bumpRevision → (here) re-read range → ChartHost
//   chart click/brush → eventToRows → store.select → (SheetHost) highlight rows
//
// The range is read from the live SHEET, not the original query, so in-sheet formula
// edits inside the bound range flow to the chart — the real bidirectionality (ADR 0009).
import { useEffect, useState } from "react";
import { type Binding, type ChartSpec, useBindings } from "../../state/bindings";
import { ChartHost } from "./ChartHost";
import { eventToRows } from "./link";

const CHART_TYPES: ChartSpec["type"][] = ["bar", "line", "stacked-bar", "pie"];

export interface BoundChartProps {
  binding: Binding;
  /** Read the bound range's live values (header + rows) from the sheet facade. */
  read(sheet: string, range: string): unknown[][];
  /** Persist a spec change (type switch) or removal (`null`), then refresh the store. */
  onSpecChange(next: ChartSpec | null): void;
}

export function BoundChart({ binding, read, onSpecChange }: BoundChartProps) {
  const revision = useBindings((s) => s.revisions[binding.id] ?? 0);
  const select = useBindings((s) => s.select);
  const [data, setData] = useState<{ columns: string[]; rows: unknown[][] }>({
    columns: [],
    rows: [],
  });

  // Re-read on mount and on every revision bump (a value mutation inside the bound range).
  // `read` is memoized on the sheet facade upstream, so a not-yet-ready facade re-reads
  // once the sheet boots. `revision`'s value is unused on purpose — the bump IS the
  // signal that the bound cells changed, so it must stay in the dep list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the re-read trigger, not read inside.
  useEffect(() => {
    const [header = [], ...rows] = read(binding.sheet, binding.range);
    setData({ columns: header.map((c) => String(c)), rows });
  }, [revision, binding.sheet, binding.range, read]);

  const spec = binding.chartSpec;
  if (!spec) return null; // parent only mounts BoundChart for bound charts; guard for types

  // Both interactions map to the same channel: selected data rows → store selection.
  const onSelect = (p: unknown) => select({ bindingId: binding.id, rows: eventToRows(p) });

  return (
    <div className="bound-chart">
      <div className="bound-chart-controls">
        <label>
          {binding.dataset}
          <select
            value={spec.type}
            onChange={(e) => onSpecChange({ ...spec, type: e.target.value as ChartSpec["type"] })}
          >
            {CHART_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="link" onClick={() => onSpecChange(null)}>
          Remove chart
        </button>
      </div>
      <ChartHost
        spec={spec}
        columns={data.columns}
        rows={data.rows}
        onClick={onSelect}
        onBrush={onSelect}
      />
    </div>
  );
}
