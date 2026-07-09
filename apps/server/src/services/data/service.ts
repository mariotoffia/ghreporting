import { AppError, NotFoundError, ValidationError } from "../../kernel/errors";
import type { MicroService, ServiceContext } from "../../kernel/ports";
import { billingUsageConnector } from "./connectors/billing-usage";
import { copilotMetricsConnector } from "./connectors/copilot-metrics";
import { copilotSeatsConnector } from "./connectors/copilot-seats";
import { orgPeopleConnector } from "./connectors/org-people";
import { premiumRequestsConnector } from "./connectors/premium-requests";
import { addDays } from "./connectors/util";
import type { DatasetConnector, DatasetQuery, GitHubClient, ResultSet } from "./ports";
import { startScheduler } from "./scheduler";
import { readSyncState, syncGaps } from "./sync";

const MAX_LIMIT = 1000;
// the scheduler keeps a trailing window warm; 28 days covers every dataset TTL
const REFRESH_WINDOW_DAYS = 27;

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
}

/**
 * The `data` uService: catalog + local-first query pipeline (ARCHITECTURE.md §4).
 * Connectors are registered during init; every read answers from SQLite after
 * syncGaps has filled what the query is missing.
 */
export function createDataService(opts: {
  gh: GitHubClient;
  connectors?: DatasetConnector[];
}): DataService {
  const connectors = new Map<string, DatasetConnector>();
  let ctx: ServiceContext;
  let scheduler: { stop(): void } | undefined;
  let unsubscribeUnlock: (() => void) | undefined;

  function registerConnector(c: DatasetConnector): void {
    if (connectors.has(c.meta.id)) throw new AppError("connector.duplicate", c.meta.id, 409);
    connectors.set(c.meta.id, c);
  }

  function connector(id: string): DatasetConnector {
    const c = connectors.get(id);
    if (!c) throw new NotFoundError(`dataset ${id}`);
    return c;
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
    if (typeof from !== "string" || typeof to !== "string" || from > to) {
      throw new ValidationError("q.range.from must be ≤ q.range.to (ISO dates)");
    }
    const limit =
      q.limit === undefined
        ? undefined
        : Math.min(Math.max(1, Math.floor(Number(q.limit) || 1)), MAX_LIMIT);
    return { org: q.org, range: { from, to }, filter: q.filter, limit };
  }

  return {
    name: "data",
    registerConnector,
    queryDataset,
    init(c) {
      ctx = c;
      // tests pass their own connectors; production registers the built-ins
      const list = opts.connectors ?? builtinConnectors(() => ctx.config.now());
      for (const con of list) registerConnector(con);
      if (ctx.config.scheduler && ctx.config.org) {
        const org = ctx.config.org;
        let unlocked = false;
        unsubscribeUnlock = ctx.bus.on("auth.unlocked", () => {
          unlocked = true;
        });
        scheduler = startScheduler({
          ctx,
          connectors: () => [...connectors.values()],
          sync: async (id) => {
            const today = ctx.config.now().toISOString().slice(0, 10);
            const range = { from: addDays(today, -REFRESH_WINDOW_DAYS), to: today };
            await syncGaps(connector(id), { org, range }, ctx, opts.gh);
          },
          unlocked: () => unlocked,
        });
      }
    },
    shutdown() {
      scheduler?.stop();
      unsubscribeUnlock?.();
    },
    routes(app) {
      app.get("/datasets", (c) =>
        c.json(
          [...connectors.values()].map((con) => ({
            ...con.meta,
            coverage: readSyncState(ctx.db, con.meta.id),
          })),
        ),
      );

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
        })) as { dataset?: string; org?: string; range?: { from: string; to: string } };
        if (typeof body.dataset !== "string") throw new ValidationError("dataset is required");
        const today = ctx.config.now().toISOString().slice(0, 10);
        const q = parseQuery({ org: body.org, range: body.range ?? { from: today, to: today } });
        const { stale } = await syncGaps(connector(body.dataset), q, ctx, opts.gh);
        return c.json({ synced: !stale, stale });
      });
    },
  };
}
