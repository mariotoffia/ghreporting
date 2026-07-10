import { describe, expect, it } from "bun:test";
import type { ReportDefinition } from "@ghreporting/domain";
import type { ResultSet } from "../explorer/Preview";
import { applyPivot, type PanelPlan, panelDisplay, planQueries } from "./execute";

const def: ReportDefinition = {
  version: 1,
  parameters: [
    { name: "org", kind: "org", default: "acme" },
    { name: "range", kind: "dateRange", default: { from: "2026-01-01", to: "2026-01-31" } },
  ],
  panels: [
    {
      id: "spend",
      title: "Spend",
      dataset: "premium-requests",
      query: { org: "{{org}}", range: "{{range}}" },
      transform: { pivot: { x: "day", series: "model", value: "net_usd" } },
      chartSpec: { type: "stacked-bar", xColumn: "day", seriesColumns: [] },
    },
    { id: "people", title: "People", dataset: "org-people", query: { org: "{{org}}" } },
  ],
};

describe("planQueries", () => {
  it("emits one query per panel with placeholders resolved", () => {
    const plans = planQueries(def, {
      org: "globex",
      range: { from: "2026-03-01", to: "2026-03-31" },
    });
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ panelId: "spend", dataset: "premium-requests" });
    expect(plans[0]?.query).toEqual({
      org: "globex",
      range: { from: "2026-03-01", to: "2026-03-31" },
    });
    expect(plans[1]?.query).toEqual({ org: "globex" });
  });

  it("changes only the affected panel's query when a parameter updates", () => {
    const before = planQueries(def, {
      org: "acme",
      range: { from: "2026-01-01", to: "2026-01-31" },
    });
    const after = planQueries(def, {
      org: "acme",
      range: { from: "2026-02-01", to: "2026-02-28" },
    });
    // The "spend" panel references {{range}} → its query differs (its key changes → refetch).
    expect(after[0]?.query).not.toEqual(before[0]?.query);
    // The "people" panel references only {{org}} → identical query (same key → cached, no refetch).
    expect(after[1]?.query).toEqual(before[1]?.query);
  });
});

describe("applyPivot", () => {
  it("reshapes long rows to wide, filling missing cells with 0", () => {
    const rows = [
      ["2026-01-01", "gpt", 10],
      ["2026-01-01", "claude", 5],
      ["2026-01-02", "gpt", 7], // no claude on 01-02
    ];
    const pv = applyPivot(rows, ["day", "model", "net_usd"], {
      x: "day",
      series: "model",
      value: "net_usd",
    });
    expect(pv.columns).toEqual(["day", "claude", "gpt"]); // x + sorted series
    expect(pv.rows).toEqual([
      ["2026-01-01", 5, 10],
      ["2026-01-02", 0, 7], // claude missing → 0
    ]);
  });

  it("sums duplicate (x, series) pairs", () => {
    const rows = [
      ["2026-01-01", "gpt", 10],
      ["2026-01-01", "gpt", 3],
    ];
    const pv = applyPivot(rows, ["day", "model", "net_usd"], {
      x: "day",
      series: "model",
      value: "net_usd",
    });
    expect(pv.rows).toEqual([["2026-01-01", 13]]);
  });

  it("throws when the pivot names a column the result lacks", () => {
    expect(() =>
      applyPivot([], ["day", "model"], { x: "day", series: "model", value: "net_usd" }),
    ).toThrow(/net_usd/);
  });

  it("keeps distinct (x, series) pairs a naive delimiter would collide apart", () => {
    // ("a b","c") and ("a","b c") both space-join to "a b c" — must NOT share a bucket.
    const pv = applyPivot(
      [
        ["a b", "c", 10],
        ["a", "b c", 5],
      ],
      ["x", "s", "v"],
      { x: "x", series: "s", value: "v" },
    );
    expect(pv.columns).toEqual(["x", "b c", "c"]);
    expect(pv.rows).toEqual([
      ["a", 5, 0],
      ["a b", 0, 10],
    ]);
  });
});

describe("panelDisplay", () => {
  const result: ResultSet = {
    columns: [
      { name: "day", type: "date", description: "" },
      { name: "model", type: "string", description: "" },
      { name: "net_usd", type: "number", description: "" },
    ],
    rows: [
      ["2026-01-01", "gpt", 10],
      ["2026-01-01", "claude", 5],
    ],
  };

  it("pivots the table and derives chart series from the pivoted columns", () => {
    const plan = planQueries(def, {})[0];
    if (!plan) throw new Error("no plan");
    const d = panelDisplay(plan, result);
    expect(d.table.columns.map((c) => c.name)).toEqual(["day", "claude", "gpt"]);
    expect(d.chart?.spec.xColumn).toBe("day");
    expect(d.chart?.spec.seriesColumns).toEqual(["claude", "gpt"]); // filled from pivoted cols
    expect(d.chart?.columns).toEqual(["day", "claude", "gpt"]);
  });

  it("passes the result through untouched when there is no transform or chart", () => {
    const plan = planQueries(def, {})[1];
    if (!plan) throw new Error("no plan");
    const d = panelDisplay(plan, result);
    expect(d.table).toBe(result);
    expect(d.chart).toBeNull();
  });

  it("fills a chartSpec that omits seriesColumns instead of crashing", () => {
    // chartSpec is opaque to the domain validator, so seriesColumns can be absent.
    const plan: PanelPlan = {
      panelId: "p",
      title: "T",
      dataset: "d",
      query: {},
      chartSpec: { type: "bar", xColumn: "day" }, // no seriesColumns key
    };
    const noPivot: ResultSet = {
      columns: [
        { name: "day", type: "date", description: "" },
        { name: "n", type: "number", description: "" },
      ],
      rows: [["2026-01-01", 3]],
    };
    const d = panelDisplay(plan, noPivot);
    expect(d.chart?.spec.seriesColumns).toEqual(["n"]); // filled from non-x columns
  });
});
