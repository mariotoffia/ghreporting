// GHDATA custom sheet formula — the pure, Univer-free core (T7.4). The formula
// =GHDATA("premium-requests","acme","2026-01-01","2026-06-30") spills a dataset the
// binding store already cached when it was inserted. It reads ONLY the cache, never
// the network — the {sync:false} semantics — so evaluation is synchronous. univer.ts is
// the single seam that registers it and unwraps Univer's argument value-objects (ADR 0008).
// This is discoverability sugar on top of T7.3's insert flow (the plan marks it optional).

// "|" cannot appear in a dataset id, a GitHub org login, or an ISO date, so joining on it
// never lets two distinct queries collide into one key.
const SEP = "|";

/** Canonical cache key for one dataset query's last result. */
export function resultKey(dataset: string, org: string, from: string, to: string): string {
  return [dataset, org, from, to].join(SEP);
}

/** The four GHDATA args coerced to scalar text, or null if any is unusable. */
function scalarArgs(args: unknown[]): [string, string, string, string] | null {
  if (args.length < 4) return null;
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const v = args[i];
    if (typeof v === "string") {
      // Trim to match the cache keys, whose org is stored trimmed (the explorer trims it).
      const trimmed = v.trim();
      if (trimmed === "") return null;
      out.push(trimmed);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out.push(String(v));
    } else {
      return null; // arrays (range refs), null, booleans → invalid GHDATA usage
    }
  }
  return [out[0], out[1], out[2], out[3]] as [string, string, string, string];
}

/**
 * Resolve GHDATA(dataset, org, from, to) against the cache. Returns the cached matrix
 * (header + rows) to spill on a hit, or a single-cell `#N/A` string when the args are
 * malformed or nothing is cached yet — telling the user to preview/insert it first.
 */
export function ghdataResult(
  lookup: (key: string) => unknown[][] | undefined,
  args: unknown[],
): unknown[][] | string {
  const scalars = scalarArgs(args);
  if (!scalars) return "#N/A GHDATA needs (dataset, org, from, to) as text";
  const matrix = lookup(resultKey(scalars[0], scalars[1], scalars[2], scalars[3]));
  if (!matrix) return `#N/A no cached data — insert "${scalars[0]}" into a sheet first`;
  return matrix;
}
