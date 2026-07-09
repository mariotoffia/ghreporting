// Test doubles shared by connector tests (unit-level fixture replay,
// TESTS.md §3): a GitHubClient that serves canned data per route and a
// migrated in-memory ServiceContext.
import { openDatabase } from "../../../adapters/db/database";
import { runMigrations } from "../../../adapters/db/migrate";
import { migrations } from "../../../adapters/db/migrations";
import { createEventBus } from "../../../kernel/bus";
import { loadConfig } from "../../../kernel/config";
import type { NotificationInput, ServiceContext } from "../../../kernel/ports";
import { nullLogger } from "../../../kernel/testutil";
import type { GitHubClient } from "../ports";

export const TEST_NOW = new Date("2026-07-09T12:00:00.000Z");

/** Migrated :memory: context with a fixed clock; caller closes ctx.db. */
export function connectorContext(): ServiceContext & { notes: NotificationInput[] } {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const notes: NotificationInput[] = [];
  return {
    db,
    bus: createEventBus(nullLogger()),
    config: { ...loadConfig({}), now: () => TEST_NOW },
    log: nullLogger(),
    notify: (n) => notes.push(n),
    resolve: () => {},
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    notes,
  };
}

/**
 * Substitute {params} into the route and append leftover params as a sorted
 * query string — the fixture key format used by fakeGitHub.
 */
export function routeKey(route: string, params?: Record<string, unknown>): string {
  const used = new Set<string>();
  const path = route.replace(/\{(\w+)\}/g, (_, name: string) => {
    used.add(name);
    return String(params?.[name]);
  });
  const rest = Object.entries(params ?? {})
    .filter(([k, v]) => !used.has(k) && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return rest.length ? `${path}?${rest.join("&")}` : path;
}

/** Fixture value marking a GET that fails with an HTTP status (e.g. 404). */
export function ghError(status: number): unknown {
  return { __ghError: status };
}

/**
 * Canned GitHubClient. `gets`/`pages` map a routeKey() (path + sorted query)
 * to a response body / page arrays; `downloads` maps a URL to file text.
 * Records every call; throws on a miss so an unexpected request fails the
 * test loudly. A `ghError(status)` value makes the call throw like octokit.
 */
export function fakeGitHub(fixtures: {
  gets?: Record<string, unknown>;
  pages?: Record<string, unknown[][]>;
  downloads?: Record<string, string>;
}): GitHubClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get<T>(route: string, params?: Record<string, unknown>) {
      const url = routeKey(route, params);
      calls.push(`GET ${url}`);
      const body = fixtures.gets?.[url];
      if (body === undefined) throw new Error(`fakeGitHub: no fixture for GET ${url}`);
      const err = (body as { __ghError?: number }).__ghError;
      if (typeof body === "object" && body !== null && err) {
        throw Object.assign(new Error(`fakeGitHub: ${err}`), { status: err });
      }
      return { status: 200 as const, data: body as T };
    },
    async download(url: string) {
      calls.push(`DOWNLOAD ${url}`);
      const text = fixtures.downloads?.[url];
      if (text === undefined) throw new Error(`fakeGitHub: no fixture for DOWNLOAD ${url}`);
      return text;
    },
    async *paginate<T>(route: string, params?: Record<string, unknown>) {
      const url = routeKey(route, params);
      calls.push(`PAGINATE ${url}`);
      const pages = fixtures.pages?.[url];
      if (!pages) throw new Error(`fakeGitHub: no fixture for PAGINATE ${url}`);
      for (const page of pages) yield page as T[];
    },
    requestCount: () => calls.length,
  };
}
