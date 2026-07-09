import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openDatabase } from "../../adapters/db/database";
import { runMigrations } from "../../adapters/db/migrate";
import { migrations } from "../../adapters/db/migrations";
import { createEventBus } from "../../kernel/bus";
import { loadConfig } from "../../kernel/config";
import type { AppEvent, NotificationInput, ServiceContext } from "../../kernel/ports";
import { nullLogger } from "../../kernel/testutil";
import type { DatasetConnector, DatasetQuery, Gap, GitHubClient } from "./ports";
import { markSynced, readSyncState, syncGaps } from "./sync";

const NOW = new Date("2026-07-09T12:00:00.000Z");

let db: Database;
let events: AppEvent[];
let notes: NotificationInput[];
let ctx: ServiceContext;

beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db, migrations);
  events = [];
  notes = [];
  const bus = createEventBus(nullLogger());
  for (const t of ["sync.started", "sync.completed", "sync.failed"] as const) {
    bus.on(t, (e) => events.push(e));
  }
  ctx = {
    db,
    bus,
    config: { ...loadConfig({}), now: () => NOW },
    log: nullLogger(),
    notify: (n) => notes.push(n),
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
  };
});
afterEach(() => db.close());

const gh = {} as GitHubClient; // the engine only passes it through to the connector
const q: DatasetQuery = { org: "acme", range: { from: "2026-07-01", to: "2026-07-05" } };

function connector(opts: {
  gaps: Gap[];
  batches?: Record<string, unknown>[][];
  failOn?: string; // gap.from value whose fetch should throw
  calls?: string[];
}): DatasetConnector {
  const calls = opts.calls ?? [];
  return {
    meta: {
      id: "fake-ds",
      title: "Fake dataset",
      description: "test double",
      columns: [{ name: "day", type: "date", description: "day" }],
      scope: "org",
      freshnessTtlHours: 24,
    },
    coverage: () => {
      calls.push("coverage");
      return opts.gaps;
    },
    fetch: async function* (gap) {
      calls.push(`fetch:${gap.from}`);
      if (opts.failOn === gap.from) throw new Error("boom");
      for (const b of opts.batches ?? [[{ day: gap.from }]]) yield b;
    },
    upsert: () => {
      calls.push("upsert");
    },
    select: () => {
      calls.push("select");
      return { columns: [], rows: [] };
    },
  };
}

describe("syncGaps", () => {
  it("fetches each gap, upserts batches, watermarks, and emits started/completed", async () => {
    const calls: string[] = [];
    const c = connector({
      gaps: [{ scope: "acme", from: "2026-07-01", to: "2026-07-05" }],
      batches: [[{ day: "a" }], [{ day: "b" }]],
      calls,
    });
    const res = await syncGaps(c, q, ctx, gh);
    expect(res).toEqual({ stale: false });
    expect(calls).toEqual(["coverage", "fetch:2026-07-01", "upsert", "upsert"]);
    expect(events).toEqual([
      { type: "sync.started", dataset: "fake-ds", scope: "acme" },
      { type: "sync.completed", dataset: "fake-ds", scope: "acme", rows: 2 },
    ]);
    const [state] = readSyncState(db, "fake-ds");
    expect(state).toMatchObject({
      scope: "acme",
      synced_from: "2026-07-01",
      synced_to: "2026-07-05",
      status: "idle",
      error: null,
      last_synced_at: NOW.toISOString(),
    });
  });

  it("markSynced widens an existing watermark instead of shrinking it", () => {
    markSynced(db, "fake-ds", { scope: "acme", from: "2026-07-03", to: "2026-07-04" }, NOW);
    markSynced(db, "fake-ds", { scope: "acme", from: "2026-07-01", to: "2026-07-02" }, NOW);
    markSynced(db, "fake-ds", { scope: "acme", from: "2026-07-05", to: "2026-07-08" }, NOW);
    const [state] = readSyncState(db, "fake-ds");
    expect(state?.synced_from).toBe("2026-07-01");
    expect(state?.synced_to).toBe("2026-07-08");
  });

  it("no gaps → no fetch, not stale", async () => {
    const calls: string[] = [];
    const c = connector({ gaps: [], calls });
    expect(await syncGaps(c, q, ctx, gh)).toEqual({ stale: false });
    expect(calls).toEqual(["coverage"]);
    expect(events).toEqual([]);
  });

  it("a failing fetch marks error, notifies, emits sync.failed, and stops", async () => {
    const calls: string[] = [];
    const c = connector({
      gaps: [
        { scope: "acme", from: "2026-07-01", to: "2026-07-02" },
        { scope: "acme", from: "2026-07-03", to: "2026-07-04" },
      ],
      failOn: "2026-07-01",
      calls,
    });
    const res = await syncGaps(c, q, ctx, gh);
    expect(res).toEqual({ stale: true });
    expect(calls).toEqual(["coverage", "fetch:2026-07-01"]); // second gap never attempted
    expect(events).toEqual([
      { type: "sync.started", dataset: "fake-ds", scope: "acme" },
      { type: "sync.failed", dataset: "fake-ds", scope: "acme", error: "Error: boom" },
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      key: "sync.fake-ds.failed",
      level: "warning",
      source: "data",
    });
    const [state] = readSyncState(db, "fake-ds");
    expect(state?.status).toBe("error");
    expect(state?.error).toContain("boom");
  });

  it("a later successful sync clears the error state", async () => {
    const gaps = [{ scope: "acme", from: "2026-07-01", to: "2026-07-02" }];
    await syncGaps(connector({ gaps, failOn: "2026-07-01" }), q, ctx, gh);
    await syncGaps(connector({ gaps }), q, ctx, gh);
    const [state] = readSyncState(db, "fake-ds");
    expect(state?.status).toBe("idle");
    expect(state?.error).toBeNull();
  });
});
