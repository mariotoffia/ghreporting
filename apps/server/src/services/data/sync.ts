import type { Database } from "bun:sqlite";
import type { ServiceContext } from "../../kernel/ports";
import type { DatasetConnector, DatasetQuery, Gap, GitHubClient } from "./ports";

/** One watermark row as the catalog endpoint reports it. */
export interface SyncStateRow {
  scope: string;
  synced_from: string | null;
  synced_to: string | null;
  etag: string | null;
  last_synced_at: string | null;
  status: "idle" | "syncing" | "error";
  error: string | null;
}

export function readSyncState(db: Database, dataset: string): SyncStateRow[] {
  return db
    .query(
      "SELECT scope, synced_from, synced_to, etag, last_synced_at, status, error FROM sync_state WHERE dataset=?1 ORDER BY scope",
    )
    .all(dataset) as SyncStateRow[];
}

export function markSyncing(db: Database, dataset: string, gap: Gap): void {
  db.query(
    `INSERT INTO sync_state(dataset, scope, status) VALUES (?1, ?2, 'syncing')
     ON CONFLICT(dataset, scope) DO UPDATE SET status='syncing', error=NULL`,
  ).run(dataset, gap.scope);
}

/** Widen the watermark to include the gap and stamp last_synced_at. */
export function markSynced(db: Database, dataset: string, gap: Gap, now: Date): void {
  db.query(
    `INSERT INTO sync_state(dataset, scope, synced_from, synced_to, last_synced_at, status)
     VALUES (?1, ?2, ?3, ?4, ?5, 'idle')
     ON CONFLICT(dataset, scope) DO UPDATE SET
       synced_from = MIN(COALESCE(synced_from, ?3), ?3),
       synced_to = MAX(COALESCE(synced_to, ?4), ?4),
       last_synced_at = ?5, status='idle', error=NULL`,
  ).run(dataset, gap.scope, gap.from, gap.to, now.toISOString());
}

export function markError(db: Database, dataset: string, gap: Gap, error: string): void {
  db.query(
    `INSERT INTO sync_state(dataset, scope, status, error) VALUES (?1, ?2, 'error', ?3)
     ON CONFLICT(dataset, scope) DO UPDATE SET status='error', error=?3`,
  ).run(dataset, gap.scope, error);
}

/**
 * The engine core (ADR 0005): fill every gap coverage() reports, then let the
 * caller answer from SQLite. On a failed fetch the caller serves whatever is
 * local, flagged stale, and the human gets one deduped notification.
 */
export async function syncGaps(
  c: DatasetConnector,
  q: DatasetQuery,
  ctx: ServiceContext,
  gh: GitHubClient,
): Promise<{ stale: boolean }> {
  for (const gap of c.coverage(ctx.db, q)) {
    markSyncing(ctx.db, c.meta.id, gap);
    ctx.bus.emit({ type: "sync.started", dataset: c.meta.id, scope: gap.scope });
    try {
      let rows = 0;
      for await (const batch of c.fetch(gap, gh, ctx)) {
        ctx.db.transaction(() => c.upsert(ctx.db, batch))();
        rows += batch.length;
      }
      markSynced(ctx.db, c.meta.id, gap, ctx.config.now());
      ctx.bus.emit({ type: "sync.completed", dataset: c.meta.id, scope: gap.scope, rows });
    } catch (e) {
      markError(ctx.db, c.meta.id, gap, String(e));
      ctx.bus.emit({ type: "sync.failed", dataset: c.meta.id, scope: gap.scope, error: String(e) });
      ctx.notify({
        key: `sync.${c.meta.id}.failed`,
        level: "warning",
        title: `Sync failed: ${c.meta.title}`,
        body: String(e),
        source: "data",
      });
      return { stale: true }; // caller serves whatever is local, flagged
    }
  }
  return { stale: false };
}
