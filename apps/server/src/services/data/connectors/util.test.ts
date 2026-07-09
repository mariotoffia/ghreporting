import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DatasetQuery } from "../ports";
import { markSynced } from "../sync";
import { connectorContext, TEST_NOW } from "./testutil";
import { addDays, eachDay, filterSql, rangeCoverage, snapshotCoverage } from "./util";

let db: Database;
let close: () => void;
beforeEach(() => {
  const ctx = connectorContext();
  db = ctx.db;
  close = () => ctx.db.close();
});
afterEach(() => close());

const q: DatasetQuery = { org: "acme", range: { from: "2026-07-01", to: "2026-07-08" } };
const TTL = 24;

describe("date helpers", () => {
  it("addDays crosses month boundaries", () => {
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-07-01", -1)).toBe("2026-06-30");
  });
  it("eachDay is inclusive", () => {
    expect(eachDay("2026-07-01", "2026-07-03")).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });
});

describe("snapshotCoverage", () => {
  it("no watermark → one whole-scope gap", () => {
    expect(snapshotCoverage(db, "ds", q, TTL, TEST_NOW)).toEqual([
      { scope: "acme", from: "2026-07-01", to: "2026-07-08" },
    ]);
  });
  it("fresh watermark → covered", () => {
    markSynced(db, "ds", { scope: "acme", from: q.range.from, to: q.range.to }, TEST_NOW);
    expect(snapshotCoverage(db, "ds", q, TTL, TEST_NOW)).toEqual([]);
  });
  it("stale watermark → gap again", () => {
    const past = new Date(TEST_NOW.getTime() - 25 * 3_600_000);
    markSynced(db, "ds", { scope: "acme", from: q.range.from, to: q.range.to }, past);
    expect(snapshotCoverage(db, "ds", q, TTL, TEST_NOW)).toHaveLength(1);
  });
});

describe("rangeCoverage", () => {
  it("no watermark → the whole query range is one gap", () => {
    expect(rangeCoverage(db, "ds", q, TTL, TEST_NOW)).toEqual([
      { scope: "acme", from: "2026-07-01", to: "2026-07-08" },
    ]);
  });

  it("fresh watermark covering everything → no gaps", () => {
    markSynced(db, "ds", { scope: "acme", from: "2026-06-01", to: "2026-07-08" }, TEST_NOW);
    expect(rangeCoverage(db, "ds", q, TTL, TEST_NOW)).toEqual([]);
  });

  it("query wider than the watermark → gaps before and after", () => {
    markSynced(db, "ds", { scope: "acme", from: "2026-07-03", to: "2026-07-05" }, TEST_NOW);
    expect(rangeCoverage(db, "ds", q, TTL, TEST_NOW)).toEqual([
      { scope: "acme", from: "2026-07-01", to: "2026-07-02" },
      { scope: "acme", from: "2026-07-06", to: "2026-07-08" },
    ]);
  });

  it("a query disjoint from the watermark yields gaps that adjoin it (no hole)", () => {
    // MIN/MAX widening in markSynced assumes contiguity: a gap that skipped
    // the hole would mark never-fetched days as covered forever.
    markSynced(db, "ds", { scope: "acme", from: "2026-07-01", to: "2026-07-08" }, TEST_NOW);
    expect(
      rangeCoverage(
        db,
        "ds",
        { org: "acme", range: { from: "2026-08-01", to: "2026-08-05" } },
        TTL,
        TEST_NOW,
      ),
    ).toEqual([{ scope: "acme", from: "2026-07-09", to: "2026-08-05" }]);
    expect(
      rangeCoverage(
        db,
        "ds",
        { org: "acme", range: { from: "2026-06-01", to: "2026-06-05" } },
        TTL,
        TEST_NOW,
      ),
    ).toEqual([{ scope: "acme", from: "2026-06-01", to: "2026-06-30" }]);
  });

  it("a disjoint later sync does not mark the skipped hole covered", () => {
    markSynced(db, "ds", { scope: "acme", from: "2026-07-01", to: "2026-07-08" }, TEST_NOW);
    for (const gap of rangeCoverage(
      db,
      "ds",
      { org: "acme", range: { from: "2026-08-01", to: "2026-08-05" } },
      TTL,
      TEST_NOW,
    )) {
      markSynced(db, "ds", gap, TEST_NOW);
    }
    // the July 9 – Aug 5 stretch was part of the gap, so nothing was skipped:
    // a mid-hole query is now legitimately covered because it was fetched
    expect(
      rangeCoverage(
        db,
        "ds",
        { org: "acme", range: { from: "2026-07-15", to: "2026-07-20" } },
        TTL,
        TEST_NOW,
      ),
    ).toEqual([]);
  });

  it("stale watermark re-opens the trailing TTL days", () => {
    const past = new Date(TEST_NOW.getTime() - 25 * 3_600_000);
    markSynced(db, "ds", { scope: "acme", from: "2026-07-01", to: "2026-07-08" }, past);
    expect(rangeCoverage(db, "ds", q, TTL, TEST_NOW)).toEqual([
      { scope: "acme", from: "2026-07-08", to: "2026-07-08" },
    ]);
  });

  it("a reopen wider than the watermark merges into one gap (no overlap)", () => {
    const past = new Date(TEST_NOW.getTime() - 80 * 3_600_000);
    markSynced(db, "ds", { scope: "acme", from: "2026-07-03", to: "2026-07-04" }, past);
    // TTL 72h → reopen 3 days: coveredTo = 07-01, before synced_from
    expect(
      rangeCoverage(
        db,
        "ds",
        { org: "acme", range: { from: "2026-07-01", to: "2026-07-10" } },
        72,
        TEST_NOW,
      ),
    ).toEqual([{ scope: "acme", from: "2026-07-01", to: "2026-07-10" }]);
  });

  it("6h TTL still re-opens at least one day", () => {
    const past = new Date(TEST_NOW.getTime() - 7 * 3_600_000);
    markSynced(db, "ds", { scope: "acme", from: "2026-07-01", to: "2026-07-08" }, past);
    expect(rangeCoverage(db, "ds", q, 6, TEST_NOW)).toEqual([
      { scope: "acme", from: "2026-07-08", to: "2026-07-08" },
    ]);
  });
});

describe("filterSql", () => {
  const map = { user_login: "u.login", model: "f.model" };
  it("equals and IN over declared columns", () => {
    expect(filterSql(map, { user_login: "mario" })).toEqual({
      sql: " AND u.login IN (?)",
      params: ["mario"],
    });
    expect(filterSql(map, { model: ["a", "b"], user_login: "m" })).toEqual({
      sql: " AND f.model IN (?, ?) AND u.login IN (?)",
      params: ["a", "b", "m"],
    });
  });
  it("ignores unknown keys and empty lists", () => {
    expect(filterSql(map, { nope: "x", model: [] })).toEqual({ sql: "", params: [] });
    expect(filterSql(map, undefined)).toEqual({ sql: "", params: [] });
  });
});
