import type { Database } from "bun:sqlite";
import { AppError, NotFoundError, ValidationError } from "../../kernel/errors";
import type { MicroService, ServiceContext } from "../../kernel/ports";
import { billingUsageConnector } from "./connectors/billing-usage";
import { copilotMetricsConnector } from "./connectors/copilot-metrics";
import { copilotSeatsConnector } from "./connectors/copilot-seats";
import { orgPeopleConnector } from "./connectors/org-people";
import { premiumRequestsConnector } from "./connectors/premium-requests";
import { addDays } from "./connectors/util";
import type { DatasetConnector, DatasetQuery, GitHubClient, ResultSet } from "./ports";
import { type QueryDatasetRow, queryDatasetConnector } from "./query-dataset";
import { createQueryDatasetRegistry, type QueryDatasetRegistry } from "./query-dataset-registry";
import { registerQueryDatasetRoutes } from "./routes-query-datasets";
import { type SchedulerTimers, startScheduler } from "./scheduler";
import { readSyncState, syncGaps } from "./sync";

const MAX_LIMIT = 1000;
// Background scheduler backfill floor: at least ~5 months, because this app may be run only
// every few months (not daily). Each tick extends further back to the last watermark if the
// gap is longer, so a months-long absence fully backfills; coverage() then fetches only the
// missing days within that window, so a regularly-run app still does little work.
const REFRESH_WINDOW_DAYS = 153; // ≈ 5 months

function builtinConnectors(now: () => Date): DatasetConnector[] {
  return [
    orgPeopleConnector(now),
    copilotSeatsConnector(now),
    copilotMetricsConnector(now),
    premiumRequestsConnector(now),
    billingUsageConnector(now),
  ];
}

export interface DataService extends MicroService {
  registerConnector(c: DatasetConnector): void;
  queryDataset(id: string, q: DatasetQuery, opts?: { sync?: boolean }): Promise<ResultSet>;
  /** Report-provisioned query-dataset lifecycle (ADR 0017). Undefined under a `:memory:` config
   *  (no read-only handle) — the reports service then skips provisioning. */
  datasets?: QueryDatasetRegistry;
}

/**
 * The `data` uService: catalog + local-first query pipeline (ARCHITECTURE.md §4).
 * Connectors are registered during init; every read answers from SQLite after
 * syncGaps has filled what the query is missing.
 */
export function createDataService(opts: {
  gh: GitHubClient;
  connectors?: DatasetConnector[];
  /** Read-only handle for user query-dataset SQL (ADR 0016). Undefined ⇒ query datasets
   *  are inert (resolver falls through to NotFound). Tests over an in-memory DB pass their
   *  own handle over a shared file (see query-dataset.test.ts). */
  roDb?: Database;
  /** Test seam: deterministic timers/jitter for the background scheduler. */
  schedulerControls?: { timers?: SchedulerTimers; rand?: () => number };
}): DataService {
  const connectors = new Map<string, DatasetConnector>();
  let ctx: ServiceContext;
  let scheduler: { stop(): void } | undefined;
  let unsubscribeUnlock: (() => void) | undefined;

  function registerConnector(c: DatasetConnector): void {
    if (connectors.has(c.meta.id)) throw new AppError("connector.duplicate", c.meta.id, 409);
    connectors.set(c.meta.id, c);
  }

  /**
   * The org scope the Explorer prefills and the scheduler syncs. Persisted in app_config so
   * it survives restarts (the user need not re-enter it); GHR_ORG is the initial fallback.
   */
  function currentOrg(): string | null {
    const row = ctx.db.query("SELECT org FROM app_config WHERE id=1").get() as
      | { org: string | null }
      | undefined;
    return row?.org ?? ctx.config.org ?? null;
  }

  /** Read a query-dataset row by id from the read-write handle (reading it is safe there). */
  function queryDatasetRow(id: string): QueryDatasetRow | null {
    return ctx.db
      .query("SELECT * FROM query_datasets WHERE id=?")
      .get(id) as QueryDatasetRow | null;
  }

  function connector(id: string): DatasetConnector {
    const c = connectors.get(id);
    if (c) return c; // built-ins always win a name clash (create-time guard enforces it)
    // Fall back to a stored query dataset (ADR 0016): one created a moment ago is queryable
    // with no re-init. Needs the read-only handle to run its SQL.
    if (opts.roDb) {
      const row = queryDatasetRow(id);
      if (row) return queryDatasetConnector(row, opts.roDb);
    }
    throw new NotFoundError(`dataset ${id}`);
  }

  async function queryDataset(
    id: string,
    q: DatasetQuery,
    o?: { sync?: boolean },
  ): Promise<ResultSet> {
    const c = connector(id);
    const stale = o?.sync === false ? false : (await syncGaps(c, q, ctx, opts.gh)).stale;
    const rs = c.select(ctx.db, q);
    return stale ? { ...rs, stale: true } : rs;
  }

  /** Validate the wire-level query shape; returns a clean DatasetQuery. */
  function parseQuery(raw: unknown): DatasetQuery {
    const q = raw as Partial<DatasetQuery> | undefined;
    if (!q || typeof q.org !== "string" || q.org.trim() === "") {
      throw new ValidationError("q.org must be a non-empty string");
    }
    const { from, to } = q.range ?? {};
    // shape AND calendar validity: "2026-13-01" would poison the watermark
    // (lexical MAX) and later crash coverage() on every query of the dataset
    const isoDay = (d: unknown): d is string => {
      if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      const t = new Date(`${d}T00:00:00Z`); // Invalid Date has no toISOString
      return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
    };
    if (!isoDay(from) || !isoDay(to) || from > to) {
      throw new ValidationError("q.range must be calendar dates (YYYY-MM-DD) with from ≤ to");
    }
    for (const [key, value] of Object.entries(q.filter ?? {})) {
      const values = Array.isArray(value) ? value : [value];
      if (!values.every((v) => typeof v === "string")) {
        throw new ValidationError(`q.filter.${key} must be a string or string array`);
      }
    }
    const limit =
      q.limit == null // null and undefined both mean "default", never unbounded
        ? MAX_LIMIT
        : Math.min(Math.max(1, Math.floor(Number(q.limit) || 1)), MAX_LIMIT);
    return { org: q.org, range: { from, to }, filter: q.filter, limit };
  }

  // Report-provisioning port (ADR 0017). Deps are lazy closures, so this is valid to build now
  // and safe to call after init (ctx.db set, built-ins registered). Only when a read-only handle
  // exists — otherwise query datasets are inert and the reports service skips provisioning.
  const registry = opts.roDb
    ? createQueryDatasetRegistry({
        db: () => ctx.db,
        roDb: opts.roDb,
        isBuiltin: (id) => connectors.has(id),
        now: () => ctx.config.now(),
      })
    : undefined;

  return {
    name: "data",
    registerConnector,
    queryDataset,
    datasets: registry,
    init(c) {
      ctx = c;
      // tests pass their own connectors; production registers the built-ins
      const list = opts.connectors ?? builtinConnectors(() => ctx.config.now());
      for (const con of list) registerConnector(con);
      if (ctx.config.scheduler) {
        // Start unconditionally when scheduling is on: the scope is the *persisted* org
        // (currentOrg), which the user may set from the Explorer after startup — a tick with
        // no org yet simply no-ops, and picks up automatically once an org is saved.
        let unlocked = false;
        unsubscribeUnlock = ctx.bus.on("auth.unlocked", () => {
          unlocked = true;
        });
        scheduler = startScheduler({
          ctx,
          connectors: () => [...connectors.values()],
          sync: async (id) => {
            const org = currentOrg();
            if (!org) return; // no scope configured yet — nothing to sync
            const today = ctx.config.now().toISOString().slice(0, 10);
            const floor = addDays(today, -REFRESH_WINDOW_DAYS); // at least ~5 months back
            // Extend to the last watermark when the app hasn't run in longer than the floor, so
            // a months-long gap fully backfills instead of leaving a hole before the window.
            const wm = readSyncState(ctx.db, id).find((r) => r.scope === org)?.synced_to;
            const from = wm && wm < floor ? wm : floor;
            await syncGaps(connector(id), { org, range: { from, to: today } }, ctx, opts.gh);
          },
          unlocked: () => unlocked,
          ...opts.schedulerControls,
        });
      }
    },
    shutdown() {
      scheduler?.stop();
      unsubscribeUnlock?.();
    },
    routes(app) {
      // The explorer prefills its org input from the persisted scope (or GHR_ORG initially),
      // and saves it back with PUT so it survives restarts and feeds the background scheduler.
      app.get("/config", (c) => c.json({ org: currentOrg() }));
      app.put("/config", async (c) => {
        const body = (await c.req.json().catch(() => {
          throw new ValidationError("body must be JSON");
        })) as { org?: unknown };
        const org = typeof body.org === "string" && body.org.trim() !== "" ? body.org.trim() : null;
        ctx.db.query("UPDATE app_config SET org=?1 WHERE id=1").run(org);
        return c.json({ org: currentOrg() });
      });

      // Table → column names, for the query-dataset SQL editor's schema-aware autocomplete
      // (ADR 0016). Read-only introspection of the user's own DB; internal bookkeeping tables
      // are hidden. Uses the read-only handle when present, else the shared handle.
      app.get("/schema", (c) => {
        const src = opts.roDb ?? ctx.db;
        const tables = (
          src
            .query(
              "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','query_datasets') ORDER BY name",
            )
            .values() as [string][]
        ).map((r) => r[0]);
        const schema: Record<string, string[]> = {};
        for (const t of tables) {
          // t comes from sqlite_master (not user input); quote it for names with odd chars.
          schema[t] = (src.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map(
            (col) => col.name,
          );
        }
        return c.json(schema);
      });

      app.get("/datasets", (c) => {
        const builtins = [...connectors.values()].map((con) => ({
          ...con.meta,
          readonly: false, // syncs from GitHub — the Explorer offers "Sync now"
          coverage: readSyncState(ctx.db, con.meta.id),
        }));
        // Query datasets (ADR 0016) sit beside built-ins so the report designer picker lists
        // them with no change. They never sync (derived SQL) — `readonly` tells the Explorer to
        // hide sync actions and show "computed", not a misleading "never synced".
        const queryDatasets = opts.roDb
          ? (
              ctx.db.query("SELECT * FROM query_datasets ORDER BY title").all() as QueryDatasetRow[]
            ).map((row) => ({
              ...queryDatasetConnector(row, opts.roDb as Database).meta,
              readonly: true,
              coverage: [],
            }))
          : [];
        return c.json([...builtins, ...queryDatasets]);
      });

      app.post("/query", async (c) => {
        const body = (await c.req.json().catch(() => {
          throw new ValidationError("body must be JSON");
        })) as { dataset?: string; q?: unknown; sync?: boolean };
        if (typeof body.dataset !== "string") throw new ValidationError("dataset is required");
        const rs = await queryDataset(body.dataset, parseQuery(body.q), { sync: body.sync });
        return c.json(rs);
      });

      app.post("/sync", async (c) => {
        const body = (await c.req.json().catch(() => {
          throw new ValidationError("body must be JSON");
        })) as {
          dataset?: string;
          org?: string;
          range?: { from: string; to: string };
          force?: boolean;
        };
        if (typeof body.dataset !== "string") throw new ValidationError("dataset is required");
        const today = ctx.config.now().toISOString().slice(0, 10);
        const q = parseQuery({ org: body.org, range: body.range ?? { from: today, to: today } });
        // force: an explicit user "Sync now" re-fetches even an already-covered range.
        const { stale } = await syncGaps(connector(body.dataset), q, ctx, opts.gh, {
          force: body.force === true,
        });
        return c.json({ synced: !stale, stale });
      });

      // Query-dataset CRUD + preview (ADR 0016). Only when a read-only handle exists — under
      // a `:memory:` config these routes are absent (built-in datasets keep working).
      if (opts.roDb) {
        registerQueryDatasetRoutes(app, {
          db: () => ctx.db,
          roDb: opts.roDb,
          now: () => ctx.config.now(),
        });
      }
    },
  };
}
