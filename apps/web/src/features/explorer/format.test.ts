import { describe, expect, it } from "bun:test";
import { type CoverageRow, coverageForOrg, formatCell, formatCoverage, lastNDays } from "./format";

const now = Date.parse("2026-07-08T12:00:00.000Z");

function row(p: Partial<CoverageRow>): CoverageRow {
  return {
    scope: "acme",
    synced_from: null,
    synced_to: null,
    last_synced_at: null,
    status: "idle",
    error: null,
    ...p,
  };
}

describe("formatCoverage", () => {
  it("reports never synced for no watermarks", () => {
    expect(formatCoverage([], now)).toBe("never synced");
  });

  it("reports never synced when idle rows carry no range", () => {
    expect(formatCoverage([row({})], now)).toBe("never synced");
  });

  it("renders the window and relative sync time when idle", () => {
    const r = row({
      synced_from: "2026-01-01",
      synced_to: "2026-07-08",
      last_synced_at: "2026-07-08T10:00:00.000Z",
    });
    expect(formatCoverage([r], now)).toBe("2026-01-01 → 2026-07-08, synced 2 h ago");
  });

  it("prefers syncing… over everything while a scope is in flight", () => {
    const rows = [row({ status: "syncing" }), row({ status: "error", error: "boom" })];
    expect(formatCoverage(rows, now)).toBe("syncing…");
  });

  it("surfaces the error detail when a scope failed", () => {
    expect(formatCoverage([row({ status: "error", error: "bad token" })], now)).toBe(
      "error: bad token",
    );
  });

  it("widens the window across multiple scopes to the min/max", () => {
    const rows = [
      row({ scope: "a", synced_from: "2026-03-01", synced_to: "2026-06-01" }),
      row({ scope: "b", synced_from: "2026-01-01", synced_to: "2026-07-08" }),
    ];
    expect(formatCoverage(rows, now)).toBe("2026-01-01 → 2026-07-08");
  });
});

describe("coverageForOrg", () => {
  const rows = [
    row({ scope: "Thiink-LLC", synced_from: "2026-01-01", synced_to: "2026-07-08" }),
    row({ scope: "crossbreedab", status: "error", error: "policy off" }),
    row({ scope: "thiink-LLC", status: "error", error: "credential github-pat:default not found" }),
  ];

  it("keeps only the selected org's rows, so another org's error can't hijack the line", () => {
    const scoped = coverageForOrg(rows, "Thiink-LLC");
    expect(scoped.map((r) => r.scope)).toEqual(["Thiink-LLC"]);
    // the healthy Thiink-LLC coverage shows — not the crossbreedab or stale lowercase errors
    expect(formatCoverage(scoped, now)).toBe("2026-01-01 → 2026-07-08");
  });

  it("is case-sensitive, so a stale wrong-case scope does not resurface", () => {
    expect(coverageForOrg(rows, "Thiink-LLC").some((r) => r.status === "error")).toBe(false);
  });

  it("returns all rows when no org is selected (unfiltered)", () => {
    expect(coverageForOrg(rows, "")).toHaveLength(3);
  });
});

describe("formatCell", () => {
  it("blanks null/undefined, stringifies primitives, JSONs objects", () => {
    expect(formatCell(null)).toBe("");
    expect(formatCell(undefined)).toBe("");
    expect(formatCell(42)).toBe("42");
    expect(formatCell("hi")).toBe("hi");
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });
});

describe("lastNDays", () => {
  it("returns an inclusive n-day window ending today", () => {
    expect(lastNDays(new Date("2026-07-08T09:00:00.000Z"), 30)).toEqual({
      from: "2026-06-09",
      to: "2026-07-08",
    });
  });
});
