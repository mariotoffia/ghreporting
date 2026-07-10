// The loop-prevention regression the plan demands for T8.2: spy on ECharts `setOption`
// and prove a chart→sheet `select()` triggers NO chart repaint, while a value-mutation
// `bumpRevision()` does (DDD invariant 9). Needs a DOM to run effects, so this is the one
// suite that registers happy-dom (ADR 0015) — the rest render via renderToString.
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Binding } from "../../state/bindings";

// Register once per process — another DOM suite may already have (bun shares globals across
// files); a second GlobalRegistrator.register() throws "already globally registered".
if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  GlobalRegistrator.register();
}
// happy-dom ships no ResizeObserver; ChartHost only needs it to exist.
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Spy on setOption; the chart never really paints (no canvas), we only count repaints.
const setOption = mock(() => {});
mock.module("echarts", () => ({
  init: () => ({ setOption, resize() {}, dispose() {}, on() {} }),
}));

// Dynamic imports AFTER the echarts mock so ChartHost binds to the spy (bindings.ts pattern).
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useBindings } = await import("../../state/bindings");
const { BoundChart } = await import("./BoundChart");

const binding: Binding = {
  id: "b1",
  workbookId: "wb1",
  sheet: "Sheet1",
  range: "A1:B3", // header + 2 data rows
  dataset: "premium-requests",
  query: { org: "acme", range: { from: "2026-01-01", to: "2026-06-30" } },
  chartSpec: { type: "bar", xColumn: "day", seriesColumns: ["requests"] },
};
const matrix = [
  ["day", "requests"],
  ["2026-07-01", 12],
  ["2026-07-02", 7],
];
const read = () => matrix;

let container: HTMLElement;
// biome-ignore lint/suspicious/noExplicitAny: react-dom Root type isn't worth importing here
let root: any;

beforeEach(() => {
  useBindings.setState({ bindings: [binding], revisions: {}, selection: null });
  setOption.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

describe("BoundChart — no chart re-render on selection (loop prevention, DDD invariant 9)", () => {
  it("paints on mount, repaints on a revision bump, but NOT on a selection change", () => {
    act(() => {
      root.render(createElement(BoundChart, { binding, read, onSpecChange: () => {} }));
    });
    const afterMount = setOption.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0); // mounted + range read → first paint

    // A value mutation bumps the binding's revision → chart re-reads and repaints.
    act(() => {
      useBindings.getState().bumpRevision("b1");
    });
    const afterBump = setOption.mock.calls.length;
    expect(afterBump).toBeGreaterThan(afterMount);

    // A chart→sheet selection must NOT repaint the chart — that separation is the loop-breaker.
    act(() => {
      useBindings.getState().select({ bindingId: "b1", rows: [0, 1] });
    });
    expect(setOption.mock.calls.length).toBe(afterBump);
  });
});
