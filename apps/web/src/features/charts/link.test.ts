import { describe, expect, it } from "bun:test";
import { eventToRows, selectionRangeA1 } from "./link";

describe("eventToRows — click", () => {
  it("maps a click's dataIndex to a single-row selection", () => {
    // ECharts click param (trimmed to the fields we read).
    expect(eventToRows({ componentType: "series", seriesIndex: 0, dataIndex: 3 })).toEqual([3]);
  });

  it("returns the first data row for dataIndex 0 (no phantom header offset here)", () => {
    expect(eventToRows({ dataIndex: 0 })).toEqual([0]);
  });

  it("returns [] when a click carries no dataIndex", () => {
    expect(eventToRows({ componentType: "title" })).toEqual([]);
  });
});

describe("eventToRows — brush", () => {
  it("flattens batch[0].selected[].dataIndex", () => {
    const params = { batch: [{ selected: [{ seriesIndex: 0, dataIndex: [1, 2, 3] }] }] };
    expect(eventToRows(params)).toEqual([1, 2, 3]);
  });

  it("dedupes and sorts indices selected across multiple series", () => {
    const params = {
      batch: [
        {
          selected: [
            { seriesIndex: 0, dataIndex: [2, 0] },
            { seriesIndex: 1, dataIndex: [0, 5] },
          ],
        },
      ],
    };
    expect(eventToRows(params)).toEqual([0, 2, 5]);
  });

  it("returns [] for an empty brush (drag that selected nothing)", () => {
    expect(eventToRows({ batch: [{ selected: [{ seriesIndex: 0, dataIndex: [] }] }] })).toEqual([]);
  });
});

describe("selectionRangeA1 — header offset applied here, nowhere else", () => {
  it("maps data row 0 to the row just below the binding's header", () => {
    // Binding A1:C5 → header A1, data rows A2:C5. Data index 0 → sheet row 2.
    expect(selectionRangeA1("A1:C5", [0])).toBe("A2:C2");
  });

  it("spans min..max data rows across the binding's full column width", () => {
    expect(selectionRangeA1("A1:C5", [0, 2])).toBe("A2:C4");
  });

  it("honors a binding not anchored at A1", () => {
    // Binding B3:D10 → header row 3, data starts at row 4. Data index 0 → B4.
    expect(selectionRangeA1("B3:D10", [0])).toBe("B4:D4");
  });

  it("collapses a single-column, single-row selection to one cell", () => {
    expect(selectionRangeA1("A1:A5", [1])).toBe("A3");
  });

  it("returns null for an empty selection (nothing to highlight)", () => {
    expect(selectionRangeA1("A1:C5", [])).toBeNull();
  });

  it("returns null for a header-only binding (no data rows to highlight)", () => {
    // A1:C1 is all header; data index 0 would map below the range — refuse it.
    expect(selectionRangeA1("A1:C1", [0])).toBeNull();
  });

  it("clamps an out-of-range data index to the binding's last data row", () => {
    // A1:C5 has 4 data rows (indices 0..3); index 9 must not escape to row 11.
    expect(selectionRangeA1("A1:C5", [9])).toBe("A5:C5");
  });
});
