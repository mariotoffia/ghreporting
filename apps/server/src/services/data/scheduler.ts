// Background refresh (T2.6, ADR 0005): short-retention datasets (Copilot
// metrics keeps ~1y of daily reports, the legacy API kept 28 days) accumulate
// history locally only if something syncs them without user action.
import type { ServiceContext } from "../../kernel/ports";
import type { DatasetConnector } from "./ports";

const FIRST_TICK_MS = 60_000;

export interface SchedulerTimers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

/** Deterministic PRNG (mulberry32) — jitter must be seedable, never Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * After `auth.unlocked`: one warm-up tick at +1 min, then per dataset every
 * max(freshnessTtlHours / 2, 1) hours ±10 % jitter. Ticks are skipped while
 * locked or while an active credential.*.invalid notification names the
 * github-pat — syncing with a known-bad token only spams failures.
 */
export function startScheduler(opts: {
  ctx: ServiceContext;
  connectors: () => DatasetConnector[];
  sync: (datasetId: string) => Promise<void>;
  unlocked: () => boolean;
  timers?: SchedulerTimers;
  rand?: () => number;
}): { stop(): void } {
  const timers = opts.timers ?? { setInterval, clearInterval };
  const rand = opts.rand ?? mulberry32(0xc0ffee);
  const handles: ReturnType<typeof setInterval>[] = [];
  let armed = false;

  function credentialInvalid(): boolean {
    return (
      opts.ctx.db
        .query(
          "SELECT 1 FROM notifications WHERE key LIKE 'credential.github-pat%.invalid' AND dismissed_at IS NULL LIMIT 1",
        )
        .get() !== null
    );
  }

  function tick(datasetId: string): void {
    if (!opts.unlocked() || credentialInvalid()) return;
    opts.sync(datasetId).catch((e) => {
      // syncGaps already notified the human; this is operator-level breadcrumb
      opts.ctx.log.warn("scheduled refresh failed", { dataset: datasetId, err: String(e) });
    });
  }

  function arm(): void {
    if (armed) return;
    armed = true;
    const warmup = timers.setInterval(() => {
      timers.clearInterval(warmup);
      handles.splice(handles.indexOf(warmup), 1);
      // ticks are fire-and-forget: the shared octokit throttle paces concurrent
      // syncs, and premium-requests enumerates members itself when org-people
      // hasn't populated org_members yet — ordering is not load-bearing
      for (const c of opts.connectors()) {
        tick(c.meta.id);
        const baseMs = Math.max(c.meta.freshnessTtlHours / 2, 1) * 3_600_000;
        const jittered = Math.round(baseMs * (0.9 + 0.2 * rand()));
        handles.push(timers.setInterval(() => tick(c.meta.id), jittered));
      }
    }, FIRST_TICK_MS);
    handles.push(warmup);
  }

  const unsubscribe = opts.ctx.bus.on("auth.unlocked", arm);
  if (opts.unlocked()) arm(); // unlock may predate the scheduler

  return {
    stop() {
      unsubscribe();
      for (const h of handles.splice(0)) timers.clearInterval(h);
    },
  };
}
