// Pure formatting for the dataset catalog (UBIQUITOUS.md §Storage). The coverage
// line collapses a dataset's per-scope watermark rows into one human phrase; kept
// pure so every state is unit-tested without rendering.
import { relativeTime } from "../../lib/time";

/** One watermark row as GET /api/data/datasets embeds it (server SyncStateRow). */
export interface CoverageRow {
  scope: string;
  synced_from: string | null;
  synced_to: string | null;
  last_synced_at: string | null;
  status: "idle" | "syncing" | "error";
  error: string | null;
}

/** A catalog entry: dataset metadata plus its coverage watermarks. */
export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  scope: "org" | "org-user";
  columns: { name: string; type: "string" | "number" | "date"; description: string }[];
  freshnessTtlHours: number;
  coverage: CoverageRow[];
}

/**
 * Collapse a dataset's watermark rows into one coverage phrase:
 *   "2026-01-01 → 2026-07-08, synced 2 h ago" · "never synced" ·
 *   "syncing…" · "error: <detail>".
 * An in-progress sync on any scope wins over an error, which wins over idle.
 */
export function formatCoverage(rows: CoverageRow[], now: number): string {
  if (rows.length === 0) return "never synced";
  if (rows.some((r) => r.status === "syncing")) return "syncing…";
  const errored = rows.find((r) => r.status === "error");
  if (errored) return `error: ${errored.error ?? "sync failed"}`;
  const froms = rows.map((r) => r.synced_from).filter((v): v is string => v !== null);
  const tos = rows.map((r) => r.synced_to).filter((v): v is string => v !== null);
  if (froms.length === 0 || tos.length === 0) return "never synced";
  const from = froms.reduce((a, b) => (a < b ? a : b));
  const to = tos.reduce((a, b) => (a > b ? a : b));
  const lasts = rows.map((r) => r.last_synced_at).filter((v): v is string => v !== null);
  const synced = lasts.length
    ? `, synced ${relativeTime(
        lasts.reduce((a, b) => (a > b ? a : b)),
        now,
      )}`
    : "";
  return `${from} → ${to}${synced}`;
}

/** Render one preview cell: null/undefined → blank, objects → JSON, else String. */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Inclusive ISO date window ending today, `n` days wide (preview default: 30). */
export function lastNDays(today: Date, n: number): { from: string; to: string } {
  const to = today.toISOString().slice(0, 10);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (n - 1));
  return { from: start.toISOString().slice(0, 10), to };
}
