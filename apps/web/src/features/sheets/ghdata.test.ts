import { describe, expect, it } from "bun:test";
import { ghdataResult, resultKey } from "./ghdata";

describe("resultKey", () => {
  it("is stable for the same query", () => {
    expect(resultKey("premium-requests", "acme", "2026-01-01", "2026-06-30")).toBe(
      resultKey("premium-requests", "acme", "2026-01-01", "2026-06-30"),
    );
  });

  it("distinguishes datasets, orgs, and date bounds", () => {
    const base = resultKey("premium-requests", "acme", "2026-01-01", "2026-06-30");
    expect(resultKey("billing-usage", "acme", "2026-01-01", "2026-06-30")).not.toBe(base);
    expect(resultKey("premium-requests", "globex", "2026-01-01", "2026-06-30")).not.toBe(base);
    expect(resultKey("premium-requests", "acme", "2026-02-01", "2026-06-30")).not.toBe(base);
    expect(resultKey("premium-requests", "acme", "2026-01-01", "2026-07-30")).not.toBe(base);
  });

  it("keeps distinct tuples distinct across the '|' separator (fields are '|'-free)", () => {
    // Dataset ids, GitHub org logins, and ISO dates never contain '|', so shifting a
    // character across a boundary can't reproduce another tuple's key.
    expect(resultKey("a", "b", "c", "d")).not.toBe(resultKey("a", "b", "cd", ""));
    expect(resultKey("ds", "acme", "2026-01-01", "2026-06-30")).not.toBe(
      resultKey("ds", "acme", "2026-01-01", "2026-06-3"),
    );
  });
});

describe("ghdataResult", () => {
  const matrix = [
    ["day", "requests"],
    ["2026-07-01", 12],
  ];
  const cache = { [resultKey("premium-requests", "acme", "2026-01-01", "2026-06-30")]: matrix };
  const lookup = (k: string) => cache[k];

  it("spills the cached matrix (header + rows) on a hit", () => {
    expect(ghdataResult(lookup, ["premium-requests", "acme", "2026-01-01", "2026-06-30"])).toEqual(
      matrix,
    );
  });

  it("returns a helpful #N/A string when nothing is cached for those args", () => {
    const out = ghdataResult(lookup, ["premium-requests", "acme", "2026-01-01", "2026-12-31"]);
    expect(typeof out).toBe("string");
    expect(out).toContain("premium-requests");
  });

  it("rejects fewer than four arguments", () => {
    expect(typeof ghdataResult(lookup, ["premium-requests", "acme"])).toBe("string");
  });

  it("rejects a blank/whitespace argument", () => {
    expect(
      typeof ghdataResult(lookup, ["premium-requests", "  ", "2026-01-01", "2026-06-30"]),
    ).toBe("string");
  });

  it("rejects a range/array argument (GHDATA takes scalars, not cell ranges)", () => {
    expect(
      typeof ghdataResult(lookup, [[["premium-requests"]], "acme", "2026-01-01", "2026-06-30"]),
    ).toBe("string");
  });

  it("coerces a numeric argument to text before keying", () => {
    const numCache = { [resultKey("ds", "42", "2026-01-01", "2026-06-30")]: matrix };
    expect(ghdataResult((k) => numCache[k], ["ds", 42, "2026-01-01", "2026-06-30"])).toEqual(
      matrix,
    );
  });

  it("trims surrounding whitespace so spaced args still hit the trimmed cache key", () => {
    expect(
      ghdataResult(lookup, [" premium-requests ", " acme ", "2026-01-01", "2026-06-30"]),
    ).toEqual(matrix);
  });
});
