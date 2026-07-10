import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import type { ResultSet } from "../explorer/Preview";
import type { PanelPlan } from "./execute";
import { PanelBody } from "./ReportView";

const result: ResultSet = {
  columns: [
    { name: "day", type: "date", description: "" },
    { name: "model", type: "string", description: "" },
    { name: "net_usd", type: "number", description: "" },
  ],
  rows: [["2026-01-01", "gpt", 10]],
};

describe("PanelBody", () => {
  it("renders a per-panel error (not a thrown SPA blank) when a pivot names a missing column", () => {
    const badPivot: PanelPlan = {
      panelId: "p",
      title: "T",
      dataset: "d",
      query: {},
      transform: { pivot: { x: "day", series: "model", value: "net_used" } }, // typo: net_usd
    };
    // renderToString would itself throw if PanelBody let the error escape — it must not.
    const html = renderToString(<PanelBody plan={badPivot} result={result} />);
    expect(html).toContain("Panel error");
    expect(html).toContain("net_used");
  });

  it("renders the table for a well-formed panel with no chart", () => {
    const plan: PanelPlan = { panelId: "p", title: "T", dataset: "d", query: {} };
    const html = renderToString(<PanelBody plan={plan} result={result} />);
    expect(html).toContain("net_usd");
    expect(html).toContain("gpt");
  });
});
