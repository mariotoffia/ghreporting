import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connectorContext } from "./connectors/testutil";
import type { DatasetConnector } from "./ports";
import { mulberry32, type SchedulerTimers, startScheduler } from "./scheduler";

const HOUR = 3_600_000;

/** Deterministic manual clock driving setInterval/clearInterval. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  const timers: SchedulerTimers = {
    setInterval: ((fn: () => void, ms: number) => {
      const id = nextId++;
      intervals.set(id, { every: ms, next: now + ms, fn });
      return id;
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => {
      intervals.delete(id);
    }) as unknown as typeof clearInterval,
  };
  return {
    timers,
    active: () => intervals.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...intervals.values()]
          .filter((t) => t.next <= target)
          .sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.every;
        due.fn();
      }
      now = target;
    },
  };
}

function connectorStub(id: string, ttl: number): DatasetConnector {
  return {
    meta: { id, title: id, description: id, columns: [], scope: "org", freshnessTtlHours: ttl },
    coverage: () => [],
    fetch: async function* () {},
    upsert: () => {},
    select: () => ({ columns: [], rows: [] }),
  };
}

let ctx: ReturnType<typeof connectorContext>;
let clock: ReturnType<typeof fakeTimers>;
let synced: string[];
let stop: () => void;

function start(opts: { unlocked?: () => boolean; rand?: () => number } = {}) {
  const s = startScheduler({
    ctx,
    connectors: () => [connectorStub("copilot-metrics", 24), connectorStub("premium-requests", 6)],
    sync: async (id) => {
      synced.push(id);
    },
    unlocked: opts.unlocked ?? (() => true),
    timers: clock.timers,
    rand: opts.rand ?? (() => 0.5), // 0.9 + 0.2·0.5 = exactly 1.0 → no jitter
  });
  stop = s.stop;
  return s;
}

beforeEach(() => {
  ctx = connectorContext();
  clock = fakeTimers();
  synced = [];
  stop = () => {};
});
afterEach(() => {
  stop();
  ctx.db.close();
});

describe("startScheduler", () => {
  it("stays idle until auth.unlocked, then warm-up tick fires at +1 min", () => {
    let unlocked = false;
    start({ unlocked: () => unlocked });
    clock.advance(10 * HOUR);
    expect(synced).toEqual([]);
    unlocked = true;
    ctx.bus.emit({ type: "auth.unlocked" });
    clock.advance(59_000);
    expect(synced).toEqual([]);
    clock.advance(1_000);
    expect(synced).toEqual(["copilot-metrics", "premium-requests"]);
  });

  it("then refreshes each dataset every max(ttl/2, 1)h", () => {
    start();
    ctx.bus.emit({ type: "auth.unlocked" });
    clock.advance(60_000);
    synced = [];
    clock.advance(3 * HOUR); // premium-requests: 6h TTL → every 3h
    expect(synced).toEqual(["premium-requests"]);
    clock.advance(9 * HOUR); // 12h mark: metrics (24h TTL → 12h) + 3 more premium ticks
    expect(synced.filter((s) => s === "copilot-metrics")).toHaveLength(1);
    expect(synced.filter((s) => s === "premium-requests")).toHaveLength(4);
  });

  it("jitter is bounded at ±10 % and comes from the injected PRNG", () => {
    start({ rand: () => 1 }); // worst case: ×1.1
    ctx.bus.emit({ type: "auth.unlocked" });
    clock.advance(60_000);
    synced = [];
    clock.advance(3 * HOUR); // 3h < 3.3h → nothing yet
    expect(synced).toEqual([]);
    clock.advance(0.3 * HOUR + 1);
    expect(synced).toEqual(["premium-requests"]);
  });

  it("mulberry32 yields deterministic values in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seq = [a(), a(), a()];
    expect(seq).toEqual([b(), b(), b()]);
    for (const v of seq) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("skips ticks while locked", () => {
    let unlocked = true;
    start({ unlocked: () => unlocked });
    ctx.bus.emit({ type: "auth.unlocked" });
    clock.advance(60_000);
    synced = [];
    unlocked = false;
    clock.advance(6 * HOUR);
    expect(synced).toEqual([]);
    unlocked = true;
    clock.advance(3 * HOUR);
    expect(synced).toContain("premium-requests");
  });

  it("skips ticks while a github-pat credential.invalid notification is active", () => {
    start();
    ctx.bus.emit({ type: "auth.unlocked" });
    clock.advance(60_000);
    synced = [];
    ctx.db
      .query(
        `INSERT INTO notifications(key, level, title, source, created_at, updated_at)
         VALUES ('credential.github-pat:default.invalid', 'error', 't', 'credentials', '2026-01-01', '2026-01-01')`,
      )
      .run();
    clock.advance(6 * HOUR);
    expect(synced).toEqual([]);
    ctx.db.query("UPDATE notifications SET dismissed_at='2026-01-02'").run();
    clock.advance(3 * HOUR);
    expect(synced).toContain("premium-requests");
  });

  it("stop clears every timer and later unlocks re-arm nothing", () => {
    start();
    ctx.bus.emit({ type: "auth.unlocked" });
    clock.advance(60_000);
    stop();
    expect(clock.active()).toBe(0);
    synced = [];
    ctx.bus.emit({ type: "auth.unlocked" });
    clock.advance(24 * HOUR);
    expect(synced).toEqual([]);
  });

  it("arms immediately when unlock happened before start", () => {
    ctx.bus.emit({ type: "auth.unlocked" });
    start(); // unlocked() is already true
    clock.advance(60_000);
    expect(synced).toEqual(["copilot-metrics", "premium-requests"]);
  });
});
