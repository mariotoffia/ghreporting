import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Binding } from "./bindings"; // type-only: erased, does not load the module

// Mock the HTTP client before importing the store (load() is the only method that
// touches it; the pure transitions below don't). Keeps this suite network-free and,
// crucially, free of any Univer import.
const get = mock(async (_p: string) => ({ bindings: [] }) as unknown);
mock.module("../lib/client", () => ({ api: { get } }));

const { useBindings } = await import("./bindings");

function binding(p: Partial<Binding> & Pick<Binding, "id" | "sheet" | "range">): Binding {
  return {
    workbookId: "wb1",
    dataset: "premium-requests",
    query: { org: "acme", range: { from: "2026-01-01", to: "2026-06-30" } },
    ...p,
  };
}

beforeEach(() => useBindings.setState({ bindings: [], revisions: {}, selection: null }));
afterEach(() => get.mockClear());

describe("binding store — transitions", () => {
  it("starts empty", () => {
    const s = useBindings.getState();
    expect(s.bindings).toEqual([]);
    expect(s.revisions).toEqual({});
    expect(s.selection).toBeNull();
  });

  it("add appends a binding", () => {
    useBindings.getState().add(binding({ id: "b1", sheet: "Sheet1", range: "A1:B2" }));
    expect(useBindings.getState().bindings.map((b) => b.id)).toEqual(["b1"]);
  });

  it("bumpRevision increments from undefined→1→2 for that binding only", () => {
    const s = useBindings.getState();
    s.bumpRevision("b1");
    expect(useBindings.getState().revisions).toEqual({ b1: 1 });
    s.bumpRevision("b1");
    s.bumpRevision("b2");
    expect(useBindings.getState().revisions).toEqual({ b1: 2, b2: 1 });
  });
});

describe("binding store — loop-prevention invariant (DDD.md §4.9)", () => {
  it("select() sets selection and NEVER changes revisions", () => {
    useBindings.getState().bumpRevision("b1"); // revisions = { b1: 1 }
    const before = useBindings.getState().revisions;
    useBindings.getState().select({ bindingId: "b1", rows: [0, 2, 5] });
    const after = useBindings.getState();
    expect(after.selection).toEqual({ bindingId: "b1", rows: [0, 2, 5] });
    expect(after.revisions).toBe(before); // same reference — untouched, no re-render of charts
  });

  it("clearing the selection also leaves revisions untouched", () => {
    useBindings.getState().bumpRevision("b1");
    const before = useBindings.getState().revisions;
    useBindings.getState().select(null);
    expect(useBindings.getState().revisions).toBe(before);
  });
});

describe("binding store — onSheetEdit intersects then bumps", () => {
  beforeEach(() => {
    useBindings.setState({
      bindings: [
        binding({ id: "b1", sheet: "Sheet1", range: "A1:B2" }),
        binding({ id: "b2", sheet: "Sheet1", range: "D1:E2" }),
        binding({ id: "b3", sheet: "Sheet2", range: "A1:B2" }),
      ],
    });
  });

  it("bumps only the binding whose range intersects the edit", () => {
    useBindings.getState().onSheetEdit("Sheet1", "A1");
    expect(useBindings.getState().revisions).toEqual({ b1: 1 });
  });

  it("bumps a different binding for a non-overlapping edit on the same sheet", () => {
    useBindings.getState().onSheetEdit("Sheet1", "D2");
    expect(useBindings.getState().revisions).toEqual({ b2: 1 });
  });

  it("bumps nothing when the edit is on an unbound region", () => {
    useBindings.getState().onSheetEdit("Sheet1", "Z99");
    expect(useBindings.getState().revisions).toEqual({});
  });

  it("never crosses sheets — a Sheet2 edit does not bump the same-range Sheet1 binding", () => {
    useBindings.getState().onSheetEdit("Sheet2", "A1");
    expect(useBindings.getState().revisions).toEqual({ b3: 1 });
  });

  it("bumps multiple bindings when a wide edit overlaps both", () => {
    useBindings.getState().onSheetEdit("Sheet1", "A1:D1"); // spans A1:B2 and D1:E2
    expect(useBindings.getState().revisions).toEqual({ b1: 1, b2: 1 });
  });

  it("tolerates an already sheet-qualified editedA1 (no double-prefix desync)", () => {
    useBindings.getState().onSheetEdit("Sheet1", "Sheet1!A1");
    expect(useBindings.getState().revisions).toEqual({ b1: 1 });
  });
});

describe("binding store — load", () => {
  it("replaces bindings from the workspace API and resets revisions/selection", async () => {
    useBindings.setState({ revisions: { stale: 3 }, selection: { bindingId: "x", rows: [1] } });
    get.mockImplementationOnce(
      async () =>
        ({
          bindings: [binding({ id: "b9", sheet: "Sheet1", range: "A1:C4" })],
        }) as unknown,
    );
    await useBindings.getState().load("wb1");
    const s = useBindings.getState();
    expect(get).toHaveBeenCalledWith("/api/workspace/workbooks/wb1");
    expect(s.bindings.map((b) => b.id)).toEqual(["b9"]);
    expect(s.revisions).toEqual({});
    expect(s.selection).toBeNull();
  });
});
