// Shared connector plumbing: snapshot/range coverage against sync_state
// watermarks, ISO-date math, and filter → SQL translation. Pure reads; the
// sync engine owns all watermark writes.
import type { Database } from "bun:sqlite";
import type { DatasetQuery, Gap } from "../ports";

const DAY_MS = 86_400_000;

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** Enumerate inclusive ISO days from..to. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

interface WatermarkRow {
  synced_from: string | null;
  synced_to: string | null;
  last_synced_at: string | null;
}

function watermark(db: Database, dataset: string, scope: string): WatermarkRow | null {
  return db
    .query(
      "SELECT synced_from, synced_to, last_synced_at FROM sync_state WHERE dataset=?1 AND scope=?2",
    )
    .get(dataset, scope) as WatermarkRow | null;
}

function isFresh(lastSyncedAt: string | null, ttlHours: number, now: Date): boolean {
  if (!lastSyncedAt) return false;
  return now.getTime() - new Date(lastSyncedAt).getTime() < ttlHours * 3_600_000;
}

/**
 * Snapshot datasets (people, seats): the whole scope is one gap whenever the
 * last sync is older than the freshness TTL; otherwise fully covered.
 */
export function snapshotCoverage(
  db: Database,
  dataset: string,
  q: DatasetQuery,
  ttlHours: number,
  now: Date,
): Gap[] {
  const w = watermark(db, dataset, q.org);
  if (w && isFresh(w.last_synced_at, ttlHours, now)) return [];
  return [{ scope: q.org, from: q.range.from, to: q.range.to }];
}

/**
 * Date-ranged datasets: diff q.range against the watermark. When the watermark
 * has gone stale (last sync older than the TTL), the trailing TTL's worth of
 * days is re-opened — GitHub may still be filling those days in.
 */
export function rangeCoverage(
  db: Database,
  dataset: string,
  q: DatasetQuery,
  ttlHours: number,
  now: Date,
): Gap[] {
  const w = watermark(db, dataset, q.org);
  if (!w?.synced_from || !w.synced_to) {
    return [{ scope: q.org, from: q.range.from, to: q.range.to }];
  }
  const reopenDays = Math.max(1, Math.ceil(ttlHours / 24));
  const coveredTo = isFresh(w.last_synced_at, ttlHours, now)
    ? w.synced_to
    : addDays(w.synced_to, -reopenDays);
  // Gaps must ADJOIN the watermark, never be clamped to the query range:
  // markSynced widens one [synced_from, synced_to] interval with MIN/MAX, so a
  // gap that skipped the days between query and watermark would mark that hole
  // as covered without ever fetching it.
  const gaps: Gap[] = [];
  if (q.range.from < w.synced_from) {
    gaps.push({ scope: q.org, from: q.range.from, to: addDays(w.synced_from, -1) });
  }
  if (q.range.to > coveredTo) {
    gaps.push({ scope: q.org, from: addDays(coveredTo, 1), to: q.range.to });
  }
  return gaps;
}

/**
 * Translate q.filter into SQL conditions. `map` names the SQL expression for
 * each filterable column; unknown filter keys are ignored (declared columns
 * only — the route already validated shape).
 */
export function filterSql(
  map: Record<string, string>,
  filter: DatasetQuery["filter"],
): { sql: string; params: string[] } {
  let sql = "";
  const params: string[] = [];
  for (const [key, value] of Object.entries(filter ?? {})) {
    // hasOwn, not truthiness: `{"__proto__": [...]}` must not resolve to
    // Object.prototype and end up stringified into the SQL
    if (!Object.hasOwn(map, key)) continue;
    const expr = map[key] as string;
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) continue;
    sql += ` AND ${expr} IN (${values.map(() => "?").join(", ")})`;
    params.push(...values);
  }
  return { sql, params };
}
