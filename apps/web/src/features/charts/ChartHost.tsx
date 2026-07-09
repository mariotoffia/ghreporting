// ChartHost (ADR 0009, ARCHITECTURE.md §7): the only component that imports the ECharts
// runtime — a ~30-line wrapper, no wrapper lib. It renders a compiled ChartSpec and
// forwards interaction events; it holds no store and no Univer facade, so the mediator
// (the binding store) stays the single coupling between sheet and chart (DDD invariant 9).
// The revision→re-read and event→selection wiring lives one layer up in the chart pane
// (T8.2); ChartHost just paints `columns`/`rows` and reports clicks/brushes.
import { type EChartsType, init } from "echarts";
import { useEffect, useRef } from "react";
import { type ChartSpec, toEChartsOption } from "./spec";

export interface ChartHostProps {
  spec: ChartSpec;
  /** Header row for the chart's dataset (first row of the bound range in T8.2). */
  columns: string[];
  /** Data rows, header excluded. */
  rows: unknown[][];
  /** A point click — the pane maps it to a sheet-row selection (T8.2). */
  onClick?(params: unknown): void;
  /** A brush/box selection — the pane flattens it to sheet rows (T8.2). */
  onBrush?(params: unknown): void;
}

export function ChartHost({ spec, columns, rows, onClick, onBrush }: ChartHostProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  // Latest handlers in refs so the init effect depends on nothing — re-creating the
  // ECharts instance on every handler identity change would drop its internal state.
  const onClickRef = useRef(onClick);
  const onBrushRef = useRef(onBrush);
  onClickRef.current = onClick;
  onBrushRef.current = onBrush;

  // Init once: create the instance, subscribe to interaction events, track size.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const chart = init(el);
    chartRef.current = chart;
    chart.on("click", (p) => onClickRef.current?.(p));
    chart.on("brushSelected", (p) => onBrushRef.current?.(p));
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // Repaint whenever the spec or its data changes. `notMerge` so a shape change (e.g.
  // fewer series) fully replaces the option instead of leaving stale series behind.
  // Skip the empty-data window before the pane's first range read (columns === []), which
  // would otherwise throw "unknown xColumn" on every mount; then the catch is reserved for
  // a genuinely drifted spec (a column the data lost) rather than crying wolf at startup.
  useEffect(() => {
    if (columns.length === 0) return;
    try {
      chartRef.current?.setOption(toEChartsOption(spec, columns, rows), { notMerge: true });
    } catch (err) {
      console.error("chart render failed", err);
    }
  }, [spec, columns, rows]);

  return <div className="chart-host" ref={elRef} />;
}
