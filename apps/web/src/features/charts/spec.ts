// The ChartSpec value object (DDD.md §3.3, UBIQUITOUS.md "Chart Spec") and its pure
// compiler to an ECharts `option`. E8 owns the concrete shape the binding store defers
// to (state/bindings.ts). Kept pure and echarts-value-free — only the *type* is imported,
// so this module (and its test) never loads the charting engine. ChartHost is the only
// place that imports the echarts runtime, mirroring univer.ts for Univer (ADR 0008/0009).
import type { EChartsOption } from "echarts";

/** A serializable chart definition — saved with a binding, rebuilt on load, never a live object. */
export interface ChartSpec {
  type: "line" | "bar" | "stacked-bar" | "pie";
  /** Column whose values form the category axis (bar/line) or slice names (pie). */
  xColumn: string;
  /** One data series per column; each becomes an ECharts series encoded against xColumn. */
  seriesColumns: string[];
  title?: string;
}

/** Is a sheet/query cell chartable as a value? Finite numbers and finite numeric strings
 * (Univer reads cells back as either), but not blanks or "Infinity"/"1e400" (which would
 * collapse a y-axis). Used to pick default series columns. */
function isNumericCell(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
}

/**
 * A sensible default ChartSpec for a `[header, ...rows]` matrix (the bound range): column
 * 0 is the category axis, the numeric columns become bar series. Falls back to every
 * non-x column when the sample row has no numbers, and returns `null` when there aren't
 * two columns to relate. The user retypes/​edits from here — this is just the seed the
 * "Add chart" affordance drops in so a binding gets a chart in one click.
 */
export function deriveChartSpec(matrix: unknown[][]): ChartSpec | null {
  const [xColumn, ...rest] = (matrix[0] ?? []).map((c) => String(c));
  if (xColumn === undefined || rest.length === 0) return null; // need x + ≥1 series column
  const sample = matrix[1] ?? [];
  const numeric = rest.filter((_, i) => isNumericCell(sample[i + 1]));
  return { type: "bar", xColumn, seriesColumns: numeric.length > 0 ? numeric : rest };
}

/**
 * Compile a {@link ChartSpec} against the materialized `columns`/`rows` (the sheet range
 * or a query result) into an ECharts `option`. Uses ECharts' dataset + `encode` so the
 * same `[header, ...rows]` source drives every series — no per-series data copying.
 * Throws if the spec references a column the data doesn't have (a stale spec after a
 * query's shape changed), surfacing the mismatch instead of rendering an empty chart.
 */
export function toEChartsOption(
  spec: ChartSpec,
  columns: string[],
  rows: unknown[][],
): EChartsOption {
  if (!columns.includes(spec.xColumn)) throw new Error(`unknown xColumn: ${spec.xColumn}`);
  for (const s of spec.seriesColumns) {
    if (!columns.includes(s)) throw new Error(`unknown series column: ${s}`);
  }
  const isPie = spec.type === "pie";
  const seriesType = isPie ? "pie" : spec.type === "stacked-bar" ? "bar" : spec.type;
  // A pie relates ONE measure to the category — collapse multiple series columns to the
  // first, or two concentric pies would overlap. Cartesian charts keep every series.
  const seriesColumns = isPie ? spec.seriesColumns.slice(0, 1) : spec.seriesColumns;
  // Brush lets a box-select drive the sheet selection (T8.2), but ECharts only populates
  // a brushed series' dataIndex when that series has a brushSelector — bar does, line and
  // pie do NOT. Advertising a brush button on a line chart that silently selects nothing
  // is worse than none, so enable brush + its toolbox only for the brushable bar types.
  const brushable = spec.type === "bar" || spec.type === "stacked-bar";
  return {
    title: spec.title ? { text: spec.title } : undefined,
    tooltip: { trigger: isPie ? "item" : "axis" },
    legend: {},
    dataset: { source: [columns, ...rows] },
    xAxis: isPie ? undefined : { type: "category" },
    yAxis: isPie ? undefined : {},
    toolbox: brushable ? { feature: { brush: { type: ["rect", "clear"] } } } : undefined,
    brush: brushable
      ? { xAxisIndex: 0, brushType: "rect", throttleType: "debounce", throttleDelay: 100 }
      : undefined,
    series: seriesColumns.map((name) => ({
      name,
      type: seriesType,
      stack: spec.type === "stacked-bar" ? "total" : undefined,
      encode: isPie ? { itemName: spec.xColumn, value: name } : { x: spec.xColumn, y: name },
    })),
    // The series objects are structurally valid ECharts series but their computed union
    // type is wider than any single SeriesOption member; assert at this single boundary.
  } as EChartsOption;
}
