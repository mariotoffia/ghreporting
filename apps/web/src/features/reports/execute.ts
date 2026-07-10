// Pure execution orchestration for the ReportView (T8.5.4, ADR 0014). The browser owns
// execution: compile a definition against the current parameter values into per-panel data
// queries (planQueries), then shape each panel's raw result into what renders — a table and
// an optional chart (panelDisplay), pivoting long→wide first when the panel asks for it.
// No React, no I/O — ReportView issues the queries and feeds results back in.
import { compile, type ReportDefinition, type ReportPanel } from "@ghreporting/domain";
import type { ChartSpec } from "../charts/spec";
import type { ResultSet } from "../explorer/Preview";

export interface PanelPlan {
  panelId: string;
  title: string;
  dataset: string;
  query: Record<string, unknown>; // resolved DatasetQuery (send as the `q` body field)
  transform?: ReportPanel["transform"];
  chartSpec?: ReportPanel["chartSpec"];
}

/**
 * Compile the definition against parameter values into one query plan per panel. A panel's
 * `query` embeds only the parameters it references, so a parameter change alters just those
 * panels' plans — the caller keys each TanStack query by its plan and only the changed
 * panels refetch.
 */
export function planQueries(def: ReportDefinition, values: Record<string, unknown>): PanelPlan[] {
  return compile(def, values).panels.map((p) => ({
    panelId: p.id,
    title: p.title,
    dataset: p.dataset,
    query: p.query,
    transform: p.transform,
    chartSpec: p.chartSpec,
  }));
}

export interface PivotSpec {
  x: string;
  series: string;
  value: string;
}

// NUL delimiter: it can't occur in SQLite text, so distinct (x, series) pairs never share a
// bucket. A plain delimiter would merge e.g. ("a b","c") with ("a","b c") into one sum — a
// silent wrong total on a money column.
const cellKey = (x: string, s: string): string => `${x}\u0000${s}`;

/**
 * Reshape long rows to wide: one output row per distinct `x`, one column per distinct
 * `series`, cell = Σ `value` for that (x, series). Missing pairs become 0 (a gap would
 * misalign a stacked bar). x and series are sorted for a stable, deterministic layout.
 */
export function applyPivot(
  rows: unknown[][],
  columns: string[],
  pivot: PivotSpec,
): { columns: string[]; rows: unknown[][] } {
  const xi = columns.indexOf(pivot.x);
  const si = columns.indexOf(pivot.series);
  const vi = columns.indexOf(pivot.value);
  for (const [name, idx] of [
    [pivot.x, xi],
    [pivot.series, si],
    [pivot.value, vi],
  ] as const) {
    if (idx < 0) throw new Error(`pivot references a column not in the result: ${name}`);
  }

  const xs = new Set<string>();
  const series = new Set<string>();
  const sums = new Map<string, number>();
  for (const r of rows) {
    const x = String(r[xi] ?? "");
    const s = String(r[si] ?? "");
    const v = Number(r[vi] ?? 0);
    xs.add(x);
    series.add(s);
    sums.set(cellKey(x, s), (sums.get(cellKey(x, s)) ?? 0) + (Number.isFinite(v) ? v : 0));
  }
  const xValues = [...xs].sort();
  const seriesValues = [...series].sort();
  return {
    columns: [pivot.x, ...seriesValues],
    rows: xValues.map((x) => [x, ...seriesValues.map((s) => sums.get(cellKey(x, s)) ?? 0)]),
  };
}

/** Wrap a name/row matrix as a Preview ResultSet (every column numeric except the x axis). */
function toResultSet(columns: string[], rows: unknown[][], xColumn: string): ResultSet {
  return {
    columns: columns.map((name) => ({
      name,
      type: name === xColumn ? "string" : "number",
      description: "",
    })),
    rows,
  };
}

export interface PanelDisplay {
  table: ResultSet;
  chart: { spec: ChartSpec; columns: string[]; rows: unknown[][] } | null;
}

/**
 * Turn a panel's raw query result into what ReportView renders: a table (pivoted when the
 * panel declares a pivot) and, when a chartSpec is present, the ChartHost inputs. An empty
 * `seriesColumns` in the spec is filled with every non-x column of the (pivoted) result.
 */
export function panelDisplay(plan: PanelPlan, result: ResultSet): PanelDisplay {
  let columns = result.columns.map((c) => c.name);
  let rows = result.rows;
  let table = result;
  const pivot = plan.transform?.pivot;
  if (pivot) {
    const pv = applyPivot(result.rows, columns, pivot);
    columns = pv.columns;
    rows = pv.rows;
    table = toResultSet(pv.columns, pv.rows, pivot.x);
  }
  if (!plan.chartSpec) return { table, chart: null };
  const spec = plan.chartSpec as unknown as ChartSpec;
  // chartSpec is opaque to the domain validator, so seriesColumns may be missing/omitted.
  // Guard the read (a bare `.length` would throw and — with no ErrorBoundary — blank the
  // SPA) and fall back to every non-x column of the (pivoted) result.
  const declared = Array.isArray(spec.seriesColumns) ? spec.seriesColumns : [];
  const seriesColumns = declared.length > 0 ? declared : columns.filter((c) => c !== spec.xColumn);
  return { table, chart: { spec: { ...spec, seriesColumns }, columns, rows } };
}
