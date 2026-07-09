import { beforeEach, describe, expect, it } from "bun:test";
import { useBindings } from "./bindings";
import { type InsertDeps, insertIntoSheet, nextAnchor, resultToMatrix } from "./insert";

const query = { org: "acme", range: { from: "2026-01-01", to: "2026-06-30" }, limit: 100 };

function fakeDeps(overrides: Partial<InsertDeps> = {}) {
  const writes: Array<{ sheet: string; anchor: string; matrix: unknown[][] }> = [];
  const deps: InsertDeps = {
    query: async () => ({
      columns: [{ name: "day" }, { name: "cost" }],
      rows: [
        ["2026-01-01", 5],
        ["2026-01-02", 7],
      ],
    }),
    write: (sheet, anchor, matrix) => writes.push({ sheet, anchor, matrix }),
    saveBinding: async (workbookId, body) => ({ id: "b-new", workbookId, ...body }),
    ...overrides,
  };
  return { deps, writes };
}

beforeEach(() => useBindings.setState({ bindings: [], revisions: {}, selection: null }));

describe("resultToMatrix", () => {
  it("prepends the column-name header row to the data rows", () => {
    const m = resultToMatrix({ columns: [{ name: "a" }, { name: "b" }], rows: [[1, 2]] });
    expect(m).toEqual([
      ["a", "b"],
      [1, 2],
    ]);
  });
});

describe("nextAnchor (stack inserts, never clobber)", () => {
  it("is A1 on an empty sheet", () => {
    expect(nextAnchor([], "Sheet1")).toBe("A1");
  });

  it("lands one blank row below the lowest binding on that sheet", () => {
    // A1:B3 occupies rows 1-3 → next anchor skips row 4, lands at A5
    expect(nextAnchor([{ sheet: "Sheet1", range: "A1:B3" }], "Sheet1")).toBe("A5");
  });

  it("ignores bindings on other sheets", () => {
    expect(nextAnchor([{ sheet: "Other", range: "A1:Z99" }], "Sheet1")).toBe("A1");
  });

  it("uses the lowest bottom across several bindings", () => {
    const bs = [
      { sheet: "Sheet1", range: "A1:B3" },
      { sheet: "Sheet1", range: "A5:C10" },
    ];
    expect(nextAnchor(bs, "Sheet1")).toBe("A12"); // below row 10, one gap
  });
});

describe("insertIntoSheet", () => {
  it("writes the header row first, then the data rows, at the anchor", async () => {
    const { deps, writes } = fakeDeps();
    await insertIntoSheet(deps, {
      workbookId: "wb1",
      sheet: "Sheet1",
      anchor: "A1",
      dataset: "premium-requests",
      query,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sheet).toBe("Sheet1");
    expect(writes[0]?.anchor).toBe("A1");
    expect(writes[0]?.matrix[0]).toEqual(["day", "cost"]); // header row is first
    expect(writes[0]?.matrix).toHaveLength(3); // header + 2 data rows
  });

  it("saves a binding whose range is the anchor extended by the matrix extent", async () => {
    const saved: unknown[] = [];
    const { deps } = fakeDeps({
      saveBinding: async (workbookId, body) => {
        saved.push({ workbookId, ...body });
        return { id: "b1", workbookId, ...body };
      },
    });
    await insertIntoSheet(deps, {
      workbookId: "wb1",
      sheet: "Sheet1",
      anchor: "B2",
      dataset: "premium-requests",
      query,
    });
    // 3 rows x 2 cols anchored at B2 → B2:C4
    expect(saved[0]).toMatchObject({
      workbookId: "wb1",
      sheet: "Sheet1",
      range: "B2:C4",
      dataset: "premium-requests",
      query,
    });
  });

  it("adds the created binding to the store", async () => {
    const { deps } = fakeDeps();
    const b = await insertIntoSheet(deps, {
      workbookId: "wb1",
      sheet: "Sheet1",
      anchor: "A1",
      dataset: "premium-requests",
      query,
    });
    expect(b.id).toBe("b-new");
    expect(useBindings.getState().bindings.map((x) => x.id)).toEqual(["b-new"]);
  });

  it("handles a header-only result (no data rows) as a single-row binding", async () => {
    const saved: Array<{ range: string }> = [];
    const { deps, writes } = fakeDeps({
      query: async () => ({ columns: [{ name: "day" }, { name: "cost" }], rows: [] }),
      saveBinding: async (workbookId, body) => {
        saved.push({ range: body.range });
        return { id: "b1", workbookId, ...body };
      },
    });
    await insertIntoSheet(deps, {
      workbookId: "wb1",
      sheet: "Sheet1",
      anchor: "A1",
      dataset: "premium-requests",
      query,
    });
    expect(writes[0]?.matrix).toHaveLength(1); // header only
    expect(saved[0]?.range).toBe("A1:B1");
  });
});
