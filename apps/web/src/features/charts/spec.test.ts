import { describe, expect, it } from "bun:test";
import { type ChartSpec, deriveChartSpec, toEChartsOption } from "./spec";

// A tiny two-series dataset shared by the matrix below.
const columns = ["day", "gpt-4o", "claude"];
const rows: unknown[][] = [
  ["2026-07-01", 12, 3],
  ["2026-07-02", 7, 9],
];

function spec(p: Partial<ChartSpec> = {}): ChartSpec {
  return { type: "line", xColumn: "day", seriesColumns: ["gpt-4o", "claude"], ...p };
}

// biome-ignore lint/suspicious/noExplicitAny: reaching into the untyped EChartsOption for assertions
const asAny = (o: unknown) => o as any;

describe("toEChartsOption — dataset + shared shape", () => {
  it("puts the header row first, then data rows, in dataset.source", () => {
    const opt = asAny(toEChartsOption(spec(), columns, rows));
    expect(opt.dataset.source).toEqual([columns, ...rows]);
  });

  it("emits header-only source when there are no rows", () => {
    const opt = asAny(toEChartsOption(spec(), columns, []));
    expect(opt.dataset.source).toEqual([columns]);
  });

  it("adds a title only when the spec carries one", () => {
    expect(asAny(toEChartsOption(spec(), columns, rows)).title).toBeUndefined();
    expect(asAny(toEChartsOption(spec({ title: "Spend" }), columns, rows)).title).toEqual({
      text: "Spend",
    });
  });

  it("emits one series per seriesColumn, named after the column", () => {
    const opt = asAny(toEChartsOption(spec(), columns, rows));
    expect(opt.series.map((s: { name: string }) => s.name)).toEqual(["gpt-4o", "claude"]);
  });
});

describe("toEChartsOption — per type", () => {
  it("line: category x-axis, y-axis, axis tooltip, xy encode, no stack", () => {
    const opt = asAny(toEChartsOption(spec({ type: "line" }), columns, rows));
    expect(opt.xAxis).toEqual({ type: "category" });
    expect(opt.yAxis).toEqual({});
    expect(opt.tooltip.trigger).toBe("axis");
    expect(opt.series[0]).toMatchObject({ type: "line", encode: { x: "day", y: "gpt-4o" } });
    expect(opt.series[0].stack).toBeUndefined();
  });

  it("bar: series type bar, still axis tooltip, no stack", () => {
    const opt = asAny(toEChartsOption(spec({ type: "bar" }), columns, rows));
    expect(opt.series[0].type).toBe("bar");
    expect(opt.series[0].stack).toBeUndefined();
    expect(opt.tooltip.trigger).toBe("axis");
  });

  it("stacked-bar: series type bar with a shared 'total' stack", () => {
    const opt = asAny(toEChartsOption(spec({ type: "stacked-bar" }), columns, rows));
    expect(opt.series[0]).toMatchObject({ type: "bar", stack: "total" });
    expect(opt.series[1]).toMatchObject({ type: "bar", stack: "total" });
  });

  it("pie: no axes, item tooltip, itemName/value encode", () => {
    const opt = asAny(toEChartsOption(spec({ type: "pie" }), columns, rows));
    expect(opt.xAxis).toBeUndefined();
    expect(opt.yAxis).toBeUndefined();
    expect(opt.tooltip.trigger).toBe("item");
    expect(opt.series[0]).toMatchObject({
      type: "pie",
      encode: { itemName: "day", value: "gpt-4o" },
    });
  });

  it("pie: collapses multiple series columns to a SINGLE pie (no overlapping pies)", () => {
    // A pie relates one measure to the category; two seriesColumns must not draw two
    // concentric pies on top of each other.
    const opt = asAny(toEChartsOption(spec({ type: "pie" }), columns, rows));
    expect(opt.series).toHaveLength(1);
  });
});

describe("toEChartsOption — brush interaction", () => {
  it("enables a rect brush + toolbox on bar charts (bar has a brushSelector)", () => {
    for (const type of ["bar", "stacked-bar"] as const) {
      const opt = asAny(toEChartsOption(spec({ type }), columns, rows));
      expect(opt.brush).toBeDefined();
      expect(opt.toolbox?.feature?.brush).toBeDefined();
    }
  });

  it("omits brush on line and pie (ECharts populates no brushed dataIndex for them)", () => {
    for (const type of ["line", "pie"] as const) {
      const opt = asAny(toEChartsOption(spec({ type }), columns, rows));
      expect(opt.brush).toBeUndefined();
      expect(opt.toolbox).toBeUndefined();
    }
  });
});

describe("deriveChartSpec — a sensible default from the bound range", () => {
  it("uses column 0 as x and the numeric columns as series (bar)", () => {
    const matrix = [
      ["day", "gpt-4o", "claude"],
      ["2026-07-01", 12, 3],
    ];
    expect(deriveChartSpec(matrix)).toEqual({
      type: "bar",
      xColumn: "day",
      seriesColumns: ["gpt-4o", "claude"],
    });
  });

  it("treats numeric strings (sheet cells) as series columns", () => {
    const matrix = [
      ["day", "requests"],
      ["2026-07-01", "12"],
    ];
    expect(deriveChartSpec(matrix)?.seriesColumns).toEqual(["requests"]);
  });

  it("drops non-numeric columns from the series (keeps x)", () => {
    const matrix = [
      ["day", "label", "requests"],
      ["2026-07-01", "gpt-4o", 12],
    ];
    expect(deriveChartSpec(matrix)?.seriesColumns).toEqual(["requests"]);
  });

  it("falls back to all non-x columns when no column is numeric", () => {
    const matrix = [
      ["day", "label"],
      ["2026-07-01", "gpt-4o"],
    ];
    expect(deriveChartSpec(matrix)?.seriesColumns).toEqual(["label"]);
  });

  it("does not treat a non-finite numeric string ('Infinity') as a series column", () => {
    const matrix = [
      ["day", "bogus", "requests"],
      ["2026-07-01", "Infinity", 12],
    ];
    expect(deriveChartSpec(matrix)?.seriesColumns).toEqual(["requests"]);
  });

  it("returns null when there aren't at least two columns to chart", () => {
    expect(deriveChartSpec([["day"], ["2026-07-01"]])).toBeNull();
    expect(deriveChartSpec([])).toBeNull();
  });
});

describe("toEChartsOption — validation", () => {
  it("throws when xColumn is not among the columns", () => {
    expect(() => toEChartsOption(spec({ xColumn: "nope" }), columns, rows)).toThrow(
      "unknown xColumn: nope",
    );
  });

  it("throws when a series column is not among the columns", () => {
    expect(() =>
      toEChartsOption(spec({ seriesColumns: ["gpt-4o", "ghost"] }), columns, rows),
    ).toThrow("unknown series column: ghost");
  });
});
