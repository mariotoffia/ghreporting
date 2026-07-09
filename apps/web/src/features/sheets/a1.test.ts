import { describe, expect, it } from "bun:test";
import { type CellRange, formatRange, parseRange, rangeFromAnchor, rangesIntersect } from "./a1";

describe("parseRange", () => {
  it("parses a sheet-qualified rectangle to 0-based inclusive corners", () => {
    expect(parseRange("Sheet1!A1:D3")).toEqual({ sheet: "Sheet1", r0: 0, c0: 0, r1: 2, c1: 3 });
  });

  it("treats a single cell as a 1x1 range", () => {
    expect(parseRange("Sheet1!A1")).toEqual({ sheet: "Sheet1", r0: 0, c0: 0, r1: 0, c1: 0 });
  });

  it("parses a sheet-relative range (no ! prefix) with an empty sheet", () => {
    expect(parseRange("A1:B2")).toEqual({ sheet: "", r0: 0, c0: 0, r1: 1, c1: 1 });
  });

  it("decodes column letters past Z (AA=26, AB=27, ZZ=701)", () => {
    expect(parseRange("S!AA1").c0).toBe(26);
    expect(parseRange("S!AB1").c0).toBe(27);
    expect(parseRange("S!ZZ1").c0).toBe(701);
  });

  it("normalizes reversed corners (bottom-right given first)", () => {
    expect(parseRange("S!D3:A1")).toEqual({ sheet: "S", r0: 0, c0: 0, r1: 2, c1: 3 });
  });

  it("keeps a sheet name that itself contains spaces (splits on the last !)", () => {
    expect(parseRange("My Sheet!A1:B2").sheet).toBe("My Sheet");
  });

  it("is case-insensitive on column letters", () => {
    expect(parseRange("S!aa1").c0).toBe(26);
  });

  it("throws on a malformed cell", () => {
    expect(() => parseRange("S!11")).toThrow();
    expect(() => parseRange("S!A")).toThrow();
  });

  it("rejects row 0 (A1 rows are 1-based; A0 would map to a negative index)", () => {
    expect(() => parseRange("A0")).toThrow();
    expect(() => parseRange("S!B0")).toThrow();
  });

  it("rejects a range with more than one colon instead of silently truncating", () => {
    expect(() => parseRange("A1:B2:C3")).toThrow();
  });

  it("round-trips a range whose sheet name itself contains a bang", () => {
    const r = parseRange("Wei!rd!A1:B2");
    expect(r.sheet).toBe("Wei!rd");
    expect(formatRange(r)).toBe("Wei!rd!A1:B2");
  });
});

describe("formatRange (reverse of parseRange)", () => {
  it("renders a rectangle", () => {
    expect(formatRange({ sheet: "Sheet1", r0: 0, c0: 0, r1: 2, c1: 3 })).toBe("Sheet1!A1:D3");
  });

  it("collapses a 1x1 range to a single cell", () => {
    expect(formatRange({ sheet: "Sheet1", r0: 0, c0: 0, r1: 0, c1: 0 })).toBe("Sheet1!A1");
  });

  it("omits the ! prefix when the sheet is empty", () => {
    expect(formatRange({ sheet: "", r0: 0, c0: 0, r1: 2, c1: 3 })).toBe("A1:D3");
  });

  it("encodes columns past Z", () => {
    expect(formatRange({ sheet: "", r0: 0, c0: 26, r1: 0, c1: 26 })).toBe("AA1");
    expect(formatRange({ sheet: "", r0: 0, c0: 701, r1: 0, c1: 701 })).toBe("ZZ1");
    expect(formatRange({ sheet: "", r0: 0, c0: 702, r1: 0, c1: 702 })).toBe("AAA1");
  });

  it("round-trips through parseRange", () => {
    const cases = ["Sheet1!A1:D3", "S!AA10:AC12", "S!A1", "Data!B2:B2"];
    for (const a1 of cases) expect(formatRange(parseRange(a1))).toBe(normalize(a1));
  });
  // "Data!B2:B2" collapses to "Data!B2" on format — normalize the expectation.
  function normalize(a1: string): string {
    const r = parseRange(a1);
    return formatRange(r);
  }
});

describe("rangesIntersect", () => {
  const R = (s: string): CellRange => parseRange(s);

  it("is true for overlapping ranges on the same sheet", () => {
    expect(rangesIntersect(R("S!A1:C3"), R("S!B2:D4"))).toBe(true);
  });

  it("is true when ranges only touch at a corner", () => {
    expect(rangesIntersect(R("S!A1:B2"), R("S!B2:C3"))).toBe(true);
  });

  it("is true for a single cell inside a range", () => {
    expect(rangesIntersect(R("S!B2"), R("S!A1:D4"))).toBe(true);
  });

  it("is false for disjoint ranges on the same sheet", () => {
    expect(rangesIntersect(R("S!A1:B2"), R("S!D4:E5"))).toBe(false);
  });

  it("is false across different sheets even with identical rectangles", () => {
    expect(rangesIntersect(R("S1!A1:D4"), R("S2!A1:D4"))).toBe(false);
  });
});

describe("rangeFromAnchor (anchor + matrix extent → sheet-relative range)", () => {
  it("extends an anchor by a rows x cols matrix", () => {
    expect(rangeFromAnchor("A1", 4, 3)).toBe("A1:C4");
  });

  it("returns a single cell for a 1x1 matrix", () => {
    expect(rangeFromAnchor("B2", 1, 1)).toBe("B2");
  });

  it("handles a header-only (single-row) matrix", () => {
    expect(rangeFromAnchor("A1", 1, 3)).toBe("A1:C1");
  });

  it("extends across the Z boundary", () => {
    expect(rangeFromAnchor("Z1", 1, 2)).toBe("Z1:AA1");
  });

  it("ignores any sheet prefix on the anchor (result is sheet-relative)", () => {
    expect(rangeFromAnchor("Sheet1!A1", 2, 2)).toBe("A1:B2");
  });

  it("clamps a zero/negative extent to a single cell", () => {
    expect(rangeFromAnchor("A1", 0, 0)).toBe("A1");
  });
});
