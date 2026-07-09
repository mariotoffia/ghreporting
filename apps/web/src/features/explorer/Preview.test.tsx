import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { Preview, type ResultSet } from "./Preview";

const fixture: ResultSet = {
  columns: [
    { name: "day", type: "date", description: "usage day" },
    { name: "model", type: "string", description: "model id" },
    { name: "requests", type: "number", description: "count" },
  ],
  rows: [
    ["2026-07-01", "gpt-4o", 12],
    ["2026-07-02", "claude", 3],
  ],
};

describe("Preview", () => {
  it("renders header + rows in column order", () => {
    const html = renderToString(<Preview result={fixture} />);
    expect(html.indexOf("day")).toBeLessThan(html.indexOf("model"));
    expect(html).toContain("gpt-4o");
    expect(html).toContain("12");
  });

  it("shows the stale hint only when flagged", () => {
    expect(renderToString(<Preview result={fixture} />)).not.toContain("Showing local data");
    expect(renderToString(<Preview result={{ ...fixture, stale: true }} />)).toContain(
      "Showing local data",
    );
  });

  it("shows an empty state when there are no rows", () => {
    expect(renderToString(<Preview result={{ ...fixture, rows: [] }} />)).toContain(
      "No rows in range.",
    );
  });
});
