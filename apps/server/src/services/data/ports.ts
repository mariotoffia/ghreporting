// Ports of the data uService. The DatasetConnector family is canonical in
// PLUGIN.md — copied verbatim (plus `limit` on DatasetQuery). GitHubClient is
// the port the octokit adapter (adapters/github/client.ts) implements.
import type { Database } from "bun:sqlite";
import type { ServiceContext } from "../../kernel/ports";

export interface ColumnMeta {
  name: string; // snake_case, matches the SQL column it selects
  type: "string" | "number" | "date";
  description: string;
}

export interface DatasetMeta {
  id: string; // kebab-case, e.g. "premium-requests"
  title: string;
  description: string; // shown in the explorer — write for humans
  columns: ColumnMeta[]; // declared schema; select() must return exactly this
  scope: "org" | "org-user"; // does the grain include a user dimension?
  freshnessTtlHours: number; // how old local data may be before it counts as a gap
}

export interface DatasetQuery {
  org: string;
  range: { from: string; to: string }; // inclusive ISO dates YYYY-MM-DD
  filter?: Record<string, string | string[]>; // column -> equals / IN
  limit?: number; // max rows select() returns (route clamps to 1000)
}

export interface Gap {
  scope: string;
  from: string;
  to: string;
}

export interface ResultSet {
  columns: ColumnMeta[];
  rows: unknown[][]; // row-major, column order = columns
  stale?: boolean; // served locally after a failed sync
}

/** One polite GitHub door: token, throttling, ETags, pagination, request budget. */
export interface GitHubClient {
  get<T>(
    route: string,
    params?: Record<string, unknown>,
    opts?: { etag?: string },
  ): Promise<{ status: 200; data: T; etag?: string } | { status: 304 }>;
  paginate<T>(route: string, params?: Record<string, unknown>): AsyncIterable<T[]>;
  /**
   * Fetch a signed download URL (Copilot usage-metrics reports, ADR 0012)
   * WITHOUT auth headers — signed-URL hosts reject Authorization.
   */
  download(url: string): Promise<string>;
  requestCount(): number;
}

export interface DatasetConnector {
  readonly meta: DatasetMeta;
  /** Which parts of q are missing/stale locally? Pure read of db + sync_state. */
  coverage(db: Database, q: DatasetQuery): Gap[];
  /** Stream remote rows for one gap. Must use gh's etagged, throttled request(). */
  fetch(gap: Gap, gh: GitHubClient, ctx: ServiceContext): AsyncIterable<Record<string, unknown>[]>;
  /** Idempotent upsert on the dataset's natural key. One transaction per batch. */
  upsert(db: Database, rows: Record<string, unknown>[]): void;
  /** Answer q from SQLite only. Never calls the network. */
  select(db: Database, q: DatasetQuery): ResultSet;
}
