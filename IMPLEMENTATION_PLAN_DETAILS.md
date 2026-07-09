# GH Reporting — Implementation Plan Details

Per-task specs for [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Interfaces named
here are canonical in [ARCHITECTURE.md](ARCHITECTURE.md) §3 and [PLUGIN.md](PLUGIN.md).
Vocabulary: [UBIQUITOUS.md](UBIQUITOUS.md). Code blocks below are the intended
implementation — copy them, then adapt only where a `VERIFY` note says the outside
world may have moved. Everything `bun:sqlite`-specific in this file was probe-verified
against bun 1.3 (multi-statement `db.exec`, `db.transaction(fn)()`,
`ON CONFLICT … RETURNING id`, and `ON CONFLICT` against a COALESCE expression index).

## Universal task recipe (applies to every task below)

1. Read the task's **Refs** docs first.
2. Create the **Test** file(s); write the listed cases; run
   `bun test <path>` — they must fail for the right reason.
3. Implement the minimum in **Files**; re-run until green.
4. `make lint-fix && make lint && make vet && make test` — all green.
5. `wc -l` every touched file (≤ 500 code; docs ≤ 600 — the two IMPLEMENTATION_PLAN
   files are exempt).
6. Tick the row in IMPLEMENTATION_PLAN.md; commit (imperative subject, body says why).

Conventions: tests beside code (`x.test.ts` next to `x.ts`); DB tests open
`new Database(":memory:")` + run migrations in `beforeEach`; time comes from
`ctx.config.now()`; inject `fetchImpl` wherever HTTP happens. Rules: [TESTS.md](TESTS.md).

---

## E0 Foundation

### T0.1 Workspace scaffold

Done in repo: bun workspaces (`apps/*`, `packages/*`), strict `tsconfig.base.json`,
Biome config (recommended preset — see LINT.md's probe recipe), `packages/domain`
(zero-dep, `premiumRequestCost` + `roundUsd` with tests), hello-world Hono server
(`/api/health`), Vite React shell, smoke tests for all three workspaces.

### T0.2 Makefile and toolchain

Done in repo: targets `setup serve-backend serve-frontend serve-all lint lint-fix vet
test test-integration build package bench clean generate help`. Verified green:
`make lint`, `make vet`, `make test` (8 tests), server boots, `/api/health` answers.

---

## E1 uService kernel

### T1.1 Kernel ports and errors

**Goal** The type foundation every service compiles against.
**Files** create `apps/server/src/kernel/ports.ts`, `apps/server/src/kernel/errors.ts`;
test `apps/server/src/kernel/errors.test.ts`.

**`ports.ts` — complete:**

```ts
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface AppConfig {
  port: number;
  dbPath: string;
  org?: string;
  origins: string[];        // WebAuthn + CORS allow-list (dev :5173, packaged :8787)
  secretBackend?: string;   // "keychain" | "encrypted-file" override
  packaged: boolean;        // true inside the compiled binary
  now(): Date;              // the ONLY clock services may read (TESTS.md §2.2)
}

export type AppEvent =
  | { type: "sync.started"; dataset: string; scope: string }
  | { type: "sync.completed"; dataset: string; scope: string; rows: number }
  | { type: "sync.failed"; dataset: string; scope: string; error: string }
  | { type: "credential.expiring"; id: string; daysLeft: number }
  | { type: "credential.invalid"; id: string }
  | { type: "notification.changed"; id: number }
  | { type: "auth.unlocked" };

export interface EventBus {
  emit(e: AppEvent): void;
  on<T extends AppEvent["type"]>(
    type: T,
    fn: (e: Extract<AppEvent, { type: T }>) => void,
  ): () => void; // returns unsubscribe
}

export interface NotificationInput {
  key: string;                            // dedupe identity, e.g. "credential.github-pat:default.expiring"
  level: "info" | "warning" | "error";
  title: string;
  body?: string;
  source: string;                         // service name
}

/** Service-facing secrets port. Throws SecretsLockedError until auth unlocks it. */
export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface ServiceContext {
  db: Database;
  bus: EventBus;
  config: AppConfig;
  log: Logger;
  notify(n: NotificationInput): void;
  secrets: SecretStore;
}

export interface MicroService {
  readonly name: string;                                   // route prefix /api/<name>
  init(ctx: ServiceContext): Promise<void> | void;
  routes?(app: Hono, ctx: ServiceContext): void;           // receives a sub-app mounted at /api/<name>
  shutdown?(): Promise<void> | void;
}
```

**`errors.ts` — complete:**

```ts
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly status: number = 500,
  ) {
    super(message ?? code);
    this.name = new.target.name;
  }
}
export class NotFoundError extends AppError {
  constructor(what: string) { super("not_found", `${what} not found`, 404); }
}
export class ValidationError extends AppError {
  constructor(message: string) { super("validation", message, 400); }
}
export class SecretsLockedError extends AppError {
  constructor() { super("secrets.locked", "secret store is locked — log in first", 401); }
}
```

**Tests** subclasses carry code/status; `instanceof AppError` holds for all three.
**Done when** `make vet` green with `app.ts` importing the types (type-only import).
**Refs** ARCHITECTURE.md §2–3, DDD.md §2.

### T1.2 Event bus

**Goal** Typed in-process pub/sub.
**Files** create `apps/server/src/kernel/bus.ts`; test `bus.test.ts`.

```ts
import type { AppEvent, EventBus, Logger } from "./ports";

export function createEventBus(log: Logger): EventBus {
  const listeners = new Map<AppEvent["type"], Set<(e: AppEvent) => void>>();
  return {
    emit(e) {
      for (const fn of listeners.get(e.type) ?? []) {
        try {
          fn(e);
        } catch (err) {
          log.error("bus listener failed", { type: e.type, err: String(err) });
        }
      }
    },
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      const anyFn = fn as (e: AppEvent) => void;
      set.add(anyFn);
      return () => set.delete(anyFn);
    },
  };
}
```

**Test cases (write these):**

```ts
it("delivers only to matching type", () => {
  const bus = createEventBus(nullLogger());
  const got: string[] = [];
  bus.on("auth.unlocked", () => got.push("a"));
  bus.on("sync.started", (e) => got.push(e.dataset));
  bus.emit({ type: "sync.started", dataset: "x", scope: "acme" });
  expect(got).toEqual(["x"]);
});
it("unsubscribe stops delivery", () => { /* off(); emit; expect not called */ });
it("a throwing listener does not break the others", () => { /* first throws, second still called */ });
```

**Done when** green; zero dependencies.
**Refs** ARCHITECTURE.md §3.

### T1.3 Config and logger

**Goal** Env-derived immutable config + tiny scoped logger. No logging dependency — a
30-line console logger is the whole need.
**Files** create `apps/server/src/kernel/config.ts`, `kernel/logger.ts`; tests beside.

```ts
// config.ts
import type { AppConfig } from "./ports";

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  const expand = (p: string) => (p.startsWith("~/") ? `${home}/${p.slice(2)}` : p);
  return Object.freeze({
    port: Number(env.PORT ?? 8787),
    dbPath: expand(env.GHR_DB_PATH ?? "~/.ghreporting/ghreporting.db"),
    org: env.GHR_ORG,
    origins: env.GHR_ORIGINS?.split(",").map((s) => s.trim())
      ?? ["http://localhost:5173", "http://localhost:8787"],
    secretBackend: env.GHR_SECRET_BACKEND,
    packaged: env.GHR_PACKAGED === "1",
    now: () => new Date(),
  });
}
```

```ts
// logger.ts
import type { Logger } from "./ports";

export function createLogger(scope: string): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>) =>
    console.error(JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...fields }));
  return {
    info: (m, f) => line("info", m, f),
    warn: (m, f) => line("warn", m, f),
    error: (m, f) => line("error", m, f),
    child: (s) => createLogger(`${scope}.${s}`),
  };
}
```

**Tests** defaults; every `GHR_*` override; `~` expansion; child scope is
`parent.child`. **Done when** green; `index.ts` calls `loadConfig(process.env)`.
**Refs** DEVELOPMENT.md env table.

### T1.4 Registry and app composition

**Goal** The kernel that composes uServices into one Hono app.
**Files** create `apps/server/src/kernel/registry.ts`, `kernel/context.ts`; rewrite
`apps/server/src/app.ts` (keep `/api/health`); tests `registry.test.ts` + extend
`app.test.ts`.

```ts
// registry.ts
import { Hono } from "hono";
import type { MicroService, ServiceContext } from "./ports";

export function createKernel(ctx: ServiceContext) {
  const services: MicroService[] = [];
  const started: MicroService[] = [];
  return {
    register(svc: MicroService) { services.push(svc); },
    async start(app: Hono) {
      for (const svc of services) {
        await svc.init(ctx);                 // a throwing init aborts startup — deliberate
        started.push(svc);
        if (svc.routes) {
          const sub = new Hono();
          svc.routes(sub, ctx);
          app.route(`/api/${svc.name}`, sub);
        }
        ctx.log.info("service started", { service: svc.name });
      }
    },
    async stop() {
      for (const svc of [...started].reverse()) {
        try { await svc.shutdown?.(); }
        catch (e) { ctx.log.error("shutdown failed", { service: svc.name, err: String(e) }); }
      }
    },
  };
}
```

```ts
// context.ts — ServiceContext with late-bound notify/secrets slots.
// notifications and credentials services bind themselves during their init.
import { SecretsLockedError } from "./errors";
import type { NotificationInput, SecretStore, ServiceContext } from "./ports";

export function createContext(base: Omit<ServiceContext, "notify" | "secrets">) {
  const slots = {
    notify: (n: NotificationInput) => base.log.warn("notify before notifications init", { ...n }),
    secrets: lockedSecretStore(),
  };
  const ctx: ServiceContext = {
    ...base,
    notify: (n) => slots.notify(n),
    secrets: {
      get: (a) => slots.secrets.get(a),
      set: (a, s) => slots.secrets.set(a, s),
      delete: (a) => slots.secrets.delete(a),
    },
  };
  return {
    ctx,
    bindNotify(fn: (n: NotificationInput) => void) { slots.notify = fn; },
    bindSecrets(store: SecretStore) { slots.secrets = store; },
  };
}

function lockedSecretStore(): SecretStore {
  const locked = async (): Promise<never> => { throw new SecretsLockedError(); };
  return { get: locked, set: locked, delete: locked };
}
```

`app.ts`: `buildApp(env = process.env)` → loads config, logger, bus, DB
(`openDatabase` + `runMigrations`, from T2.1), `createContext`, `createKernel`,
registers services (order: notifications, credentials, auth, data, workspace — grows
as tasks land), mounts `/api/health`, and:

```ts
app.onError((err, c) => {
  const e = err instanceof AppError ? err : new AppError("internal", String(err), 500);
  if (e.status >= 500) ctx.log.error("unhandled", { path: c.req.path, err: String(err) });
  return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
});
app.notFound((c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));
```

Returns `{ app, kernel, ctx, bind }`. `index.ts`: `const { app, kernel } =
buildApp(); await kernel.start(app); Bun.serve({ port, fetch: app.fetch })` + SIGINT →
`kernel.stop()`.
**Tests** init order recorded via fake services; failing init rejects `start`; a fake
service's route answers on `/api/fake/ping` via `app.request`; `ValidationError`
thrown in a route → 400 + envelope; unknown route → 404 envelope.
**Done when** green; `/api/health` still answers through the new composition.
**Refs** ARCHITECTURE.md §3, ADR 0004.

### T1.5 SSE hub

**Goal** One reusable server→browser push channel.
**Files** create `apps/server/src/kernel/sse.ts`; test `sse.test.ts`.

```ts
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Logger } from "./ports";

interface SseClient { write(event: string, data: string): Promise<void>; alive: boolean }

export function createSseHub(log: Logger) {
  const clients = new Set<SseClient>();
  return {
    /** Mount as: app.get("/stream", hub.handler()) */
    handler() {
      return (c: Context) =>
        streamSSE(c, async (stream) => {
          const client: SseClient = {
            alive: true,
            write: (event, data) => stream.writeSSE({ event, data }),
          };
          clients.add(client);
          stream.onAbort(() => { client.alive = false; clients.delete(client); });
          while (client.alive) {                    // keepalive comment every 25 s
            await stream.writeSSE({ event: "ping", data: "" });
            await stream.sleep(25_000);
          }
        });
    },
    broadcast(event: string, data: unknown) {
      const payload = JSON.stringify(data);
      for (const cl of clients) {
        cl.write(event, payload).catch(() => { cl.alive = false; clients.delete(cl); });
      }
    },
    clientCount: () => clients.size,
  };
}
```

**Tests** connect two readers via `app.request` (read the `ReadableStream` bodies),
broadcast, both receive `event: x`; abort one (AbortController on the request), next
broadcast doesn't throw and `clientCount()` drops.
**Done when** green. The endpoint is mounted by T5.2, not here.
**Refs** ARCHITECTURE.md §3, ADR 0004.

---

## E2 Storage and sync

### T2.1 SQLite adapter and migration runner

**Goal** One shared database + repeatable schema evolution, compile-safe.
**Files** create `apps/server/src/adapters/db/database.ts`, `db/migrate.ts`,
`db/migrations/index.ts`; tests beside.
**Notes** Migrations are **TS modules carrying SQL template strings** (not `.sql`
files) so `bun build --compile` embeds them for free (ADR 0003).

```ts
// database.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}
```

```ts
// migrate.ts
import type { Database } from "bun:sqlite";

export interface Migration { id: string; sql: string }

export function runMigrations(db: Database, all: Migration[]): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.query("SELECT id FROM schema_migrations").values().map((r) => r[0] as string));
  const applied: string[] = [];
  for (const m of all) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);                        // multi-statement — supported by bun:sqlite
      db.query("INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)")
        .run(m.id, new Date().toISOString()); // adapter-level timestamp; drives no logic
    })();
    applied.push(m.id);
  }
  return applied;
}
```

`migrations/index.ts` exports `export const migrations: Migration[] = [m0001, …]` in
order; each migration file is `export default { id: "0001_init", sql: \`…\` }`.
**Tests** applies once; second run returns `[]`; order respected; a migration with a
syntax error throws and leaves no `schema_migrations` row for itself (transaction
rollback — assert table count unchanged).
**Done when** green on `:memory:` and on a temp file path.
**Refs** ADR 0003, ARCHITECTURE.md §5.

### T2.2 Schema v1

**Goal** The core schema every service builds on.
**Files** create `apps/server/src/adapters/db/migrations/0001_init.ts` (+ index entry),
`db/dims.ts`; tests `dims.test.ts`.
**Produces** migration `0001_init` with exactly:

```sql
CREATE TABLE orgs(id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT);
CREATE TABLE users(id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT);
CREATE TABLE teams(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  slug TEXT NOT NULL, name TEXT, parent_team_id INTEGER REFERENCES teams(id),
  UNIQUE(org_id, slug));
CREATE TABLE team_members(
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(team_id, user_id));
CREATE TABLE products(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
CREATE TABLE skus(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL, UNIQUE(product_id, name));
CREATE TABLE model_prices(
  model TEXT NOT NULL, valid_from TEXT NOT NULL,
  multiplier REAL NOT NULL, price_per_unit_usd REAL NOT NULL,
  PRIMARY KEY(model, valid_from));
CREATE TABLE usage_facts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL, org_id INTEGER NOT NULL REFERENCES orgs(id),
  user_id INTEGER REFERENCES users(id), sku_id INTEGER NOT NULL REFERENCES skus(id),
  model TEXT, metric TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1,
  gross_amount_usd REAL, net_amount_usd REAL,
  source TEXT NOT NULL, raw TEXT);
CREATE UNIQUE INDEX ux_usage_fact ON usage_facts(
  day, org_id, COALESCE(user_id, 0), sku_id, COALESCE(model, ''), metric, source);
CREATE INDEX ix_usage_facts_day ON usage_facts(day);
CREATE INDEX ix_usage_facts_user ON usage_facts(user_id);
CREATE TABLE sync_state(
  dataset TEXT NOT NULL, scope TEXT NOT NULL,
  synced_from TEXT, synced_to TEXT, etag TEXT, last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle', error TEXT,
  PRIMARY KEY(dataset, scope));
CREATE TABLE notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
  level TEXT NOT NULL CHECK(level IN ('info','warning','error')),
  title TEXT NOT NULL, body TEXT, source TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, read_at TEXT, dismissed_at TEXT);
CREATE TABLE passkeys(
  id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
  transports TEXT, created_at TEXT NOT NULL);
CREATE TABLE credentials_meta(
  id TEXT PRIMARY KEY, type TEXT NOT NULL, backend TEXT NOT NULL, label TEXT,
  status TEXT NOT NULL, status_detail TEXT, expires_at TEXT, checked_at TEXT);
CREATE TABLE workbooks(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, snapshot TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE TABLE bindings(
  id TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  sheet TEXT NOT NULL, range TEXT NOT NULL,
  dataset TEXT NOT NULL, query TEXT NOT NULL, chart_spec TEXT,
  updated_at TEXT NOT NULL);
INSERT INTO products(name) VALUES ('copilot');
INSERT INTO skus(product_id, name)
  SELECT id, 'copilot_premium_request' FROM products WHERE name='copilot';
INSERT INTO skus(product_id, name)
  SELECT id, 'copilot_metrics' FROM products WHERE name='copilot';
```

Seed `model_prices` in the same migration from GitHub's published multiplier table
(`valid_from='2025-06-01'`, `price_per_unit_usd=0.04`) — copy current values from
docs.github.com ("premium requests → model multipliers") when implementing.

**Why the expression index:** SQLite treats NULLs as distinct in plain UNIQUE
constraints — org-level facts (`user_id IS NULL`) would duplicate on every re-sync.
Upserts must therefore name the expression conflict target (probe-verified):

```sql
INSERT INTO usage_facts(day, org_id, user_id, sku_id, model, metric, quantity, unit,
                        multiplier, gross_amount_usd, net_amount_usd, source, raw)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(day, org_id, COALESCE(user_id, 0), sku_id, COALESCE(model, ''), metric, source)
DO UPDATE SET quantity=excluded.quantity, multiplier=excluded.multiplier,
  gross_amount_usd=excluded.gross_amount_usd, net_amount_usd=excluded.net_amount_usd,
  raw=excluded.raw;
```

Ship that statement as `insertFactSql` from `dims.ts` so every connector uses the
same one. `dims.ts` also exports:

```ts
export function upsertOrg(db: Database, o: { id: number; login: string; name?: string | null }): number {
  return (db.query(
    "INSERT INTO orgs(id, login, name) VALUES (?1, ?2, ?3) ON CONFLICT(login) DO UPDATE SET name=COALESCE(?3, name) RETURNING id",
  ).get(o.id, o.login, o.name ?? null) as { id: number }).id;
}
// upsertUser — same shape against users
// upsertTeam(db, {id, orgId, slug, name, parentTeamId}) — ON CONFLICT(org_id, slug)
// ensureSku(db, product, sku): number — insert-or-get product row, then sku row
// modelPriceOn(db, model, day): { multiplier: number; priceUsd: number } | null
//   — SELECT … WHERE model=? AND valid_from<=? ORDER BY valid_from DESC LIMIT 1
```

**Tests** double-insert of an org-level fact leaves one row with updated quantity
(proves index + conflict target); dims round-trip; FK cascade workbook→bindings;
`modelPriceOn` picks the price valid on the fact's day.
**Done when** green on `:memory:` and file DB.
**Refs** ARCHITECTURE.md §5, DDD.md §3.2.

### T2.3 GitHub client adapter

**Goal** One polite GitHub door: token, throttling, ETags, pagination, request budget.
**Files** create `apps/server/src/adapters/github/client.ts`; test `client.test.ts`.
**Deps** `cd apps/server && bun add octokit` (official SDK; throttling + retry included).

```ts
import { Octokit } from "octokit";
import type { Logger } from "../../kernel/ports";

export interface GitHubClient {
  get<T>(route: string, params?: Record<string, unknown>, opts?: { etag?: string }):
    Promise<{ status: 200; data: T; etag?: string } | { status: 304 }>;
  paginate<T>(route: string, params?: Record<string, unknown>): AsyncIterable<T[]>;
  requestCount(): number;
}

export function createGitHubClient(opts: {
  tokenProvider: () => Promise<string>;   // credentials service (T3.4); tests: async () => "fake"
  fetchImpl?: typeof fetch;               // fixture replay injects here (T11.1)
  log: Logger;
}): GitHubClient {
  let count = 0;
  const octokit = new Octokit({
    request: opts.fetchImpl ? { fetch: opts.fetchImpl } : undefined,
    throttle: {
      onRateLimit: (retryAfter: number, _o: unknown, _c: unknown, retryCount: number) => {
        opts.log.warn("rate limited", { retryAfter, retryCount });
        return retryCount < 1;                       // retry once, then give up loudly
      },
      onSecondaryRateLimit: (retryAfter: number) => {
        opts.log.warn("secondary rate limit", { retryAfter });
        return true;
      },
    },
  });
  octokit.hook.before("request", async (o) => {      // token per request → rotation-safe
    count++;
    o.headers.authorization = `token ${await opts.tokenProvider()}`;
  });
  return {
    async get(route, params, o) {
      try {
        const res = await octokit.request(`GET ${route}`, {
          ...params,
          headers: o?.etag ? { "if-none-match": o.etag } : undefined,
        });
        return { status: 200, data: res.data, etag: res.headers.etag };
      } catch (e) {
        if (typeof e === "object" && e !== null && (e as { status?: number }).status === 304) {
          return { status: 304 };                    // 304 costs no rate-limit quota
        }
        throw e;
      }
    },
    async *paginate(route, params) {
      for await (const page of octokit.paginate.iterator(`GET ${route}`, { per_page: 100, ...params })) {
        yield page.data as never;
      }
    },
    requestCount: () => count,
  };
}
```

**VERIFY** on implementation: that the installed octokit major still (a) accepts
`request.fetch`, (b) throws on 304 with `.status` — both long-stable, but pin what you
install and adjust the two touchpoints if moved.
**Tests** (fake `fetchImpl` returning canned `Response`s) token header attached;
etag → 304 mapping; paginate follows `link` headers (two pages); `requestCount`
increments; rate-limit path logs and retries once.
**Done when** green with zero live calls.
**Refs** TESTS.md §3, ADR 0005.

### T2.4 Sync engine and data service

**Goal** The local-first pipeline and its HTTP surface.
**Files** create `apps/server/src/services/data/ports.ts` (copy the
`DatasetConnector` family from PLUGIN.md verbatim, plus `limit?: number` on
`DatasetQuery`), `services/data/sync.ts`, `services/data/service.ts`; tests beside.

```ts
// sync.ts — the engine core
export async function syncGaps(
  c: DatasetConnector, q: DatasetQuery, ctx: ServiceContext, gh: GitHubClient,
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
        key: `sync.${c.meta.id}.failed`, level: "warning",
        title: `Sync failed: ${c.meta.title}`, body: String(e), source: "data",
      });
      return { stale: true };            // caller serves whatever is local, flagged
    }
  }
  return { stale: false };
}
```

`markSyncing/markSynced/markError` are ~5-line UPSERTs against `sync_state`
(`status: 'syncing' | 'idle' | 'error'`; `markSynced` widens
`synced_from`/`synced_to` to include the gap and stamps `last_synced_at`).

`service.ts` — the `data` MicroService:

- `registerConnector(c)`: `AppError("connector.duplicate", …, 409)` on duplicate id.
- `queryDataset(id, q, opts?: { sync?: boolean })`: unknown id → `NotFoundError`;
  `opts.sync !== false` → `await syncGaps(...)`; always `c.select(ctx.db, q)`;
  set `stale` from syncGaps.
- Routes: `GET /datasets` → `[{...meta, coverage: readSyncState(db, id)}]`;
  `POST /query` `{dataset, q, sync?}` (validate: org non-empty, from ≤ to, limit
  clamped to 1000) → ResultSet; `POST /sync` `{dataset, org, range?}` → syncGaps
  summary `{synced: boolean, stale: boolean}`.

**Test cases (fake connector + fake GitHubClient):**

```ts
it("syncs the gap then answers locally", async () => { /* coverage→fetch→upsert→select order asserted via spies */ });
it("sync:false never touches fetch", async () => { /* fetch spy not called; select still answers */ });
it("fetch failure serves stale + notifies + emits sync.failed", async () => { /* ResultSet.stale===true */ });
it("duplicate connector registration throws connector.duplicate", () => {});
it("unknown dataset → 404 envelope through the route", async () => { /* app.request POST /api/data/query */ });
```

**Done when** green; catalog endpoint lists the fake connector with coverage.
**Refs** ARCHITECTURE.md §4, PLUGIN.md, ADR 0005, DDD.md §3.2 invariants.

### Connector recipe (shared by T2.5a–e)

Each connector: file `apps/server/src/services/data/connectors/<id>.ts` + colocated
test; declares `meta` (columns below); registered in the data service `init`.
Coverage: date-ranged datasets diff `q.range` against
`sync_state(synced_from, synced_to)` and re-open the trailing `freshnessTtlHours`;
snapshot datasets (people, seats) yield one whole-scope gap when `last_synced_at`
is older than the TTL. All dimension writes go through `dims.ts`; all fact writes
through `insertFactSql`. Tests per connector: fixture JSON → `fetch` parses to rows;
upsert twice → count once (idempotency); `select` honors range + filter and returns
exactly `meta.columns` in order. Auth scopes are classic-PAT names — **verify current
names on docs.github.com when implementing** (they must also match T3.3's
`requiredScopes`).

### T2.5a Connector org-people

Endpoints: `GET /orgs/{org}/members`, `GET /orgs/{org}/teams`,
`GET /orgs/{org}/teams/{team_slug}/members` (all paginated; scope `read:org`).
Snapshot dataset, TTL 24 h, scope `org`.
Columns: `user_login, user_name, team_slug, team_name, parent_team_slug`.
Writes `users`, `teams`, `team_members` (no facts). Fetch order: members → teams →
per-team members; map team hierarchy via each team's `parent.slug`. Members not in
any team appear with NULL team columns (LEFT JOIN in `select`). Team-membership rows
for the org are replaced wholesale per sync (delete org's rows, re-insert — a set,
not an event log).

### T2.5b Connector copilot-seats

Endpoint: `GET /orgs/{org}/copilot/billing/seats` (paginated `seats[]`; scope
`manage_billing:copilot`). Snapshot dataset, TTL 24 h.
Columns: `user_login, created_at, last_activity_at, last_activity_editor, plan_type,
pending_cancellation_date`.
New migration `0002_copilot_seats`:
`CREATE TABLE copilot_seats(org_id INTEGER NOT NULL REFERENCES orgs(id), user_id
INTEGER NOT NULL REFERENCES users(id), created_at TEXT, last_activity_at TEXT,
last_activity_editor TEXT, plan_type TEXT, pending_cancellation_date TEXT,
PRIMARY KEY(org_id, user_id))` — a seat is current state, not a day fact.

### T2.5c Connector copilot-metrics

Endpoint: `GET /orgs/{org}/copilot/metrics` (scope `manage_billing:copilot`; org
policy "Copilot metrics API access" must be enabled; org needs ≥ 5 Copilot licenses;
**~28 days retention** — this connector is why T2.6 exists). Date-ranged, TTL 24 h;
params `since`/`until` ISO dates.
Flatten each day: `copilot_ide_code_completions.editors[].models[]` →
metrics `code_suggestions | code_acceptances | code_lines_suggested |
code_lines_accepted | engaged_users`; `copilot_ide_chat.editors[].models[]` and
`copilot_dotcom_chat.models[]` → `chats | engaged_users`. Facts: org-level
(`user_id NULL`), sku `copilot_metrics`, `model` from payload (`name`), unit
`count`, multiplier 1, no amounts, day's raw JSON in `raw` (once per day, on the
first fact — not duplicated per row).
Columns (select): `day, model, metric, quantity`.
Quirk: the API returns only days it has — missing days inside the range are
legitimate; watermark by the *requested* range, not by returned rows.

### T2.5d Connector premium-requests

**The dataset the first report runs on: per-user, per-model premium request usage.**
Primary endpoint — **VERIFY against current docs.github.com before implementing**
(the enhanced-billing API family is new and still moving):
`GET /organizations/{org}/settings/billing/premium_request/usage` (fine-grained PAT
with org billing read). Expected grain: user × model × day-or-month; normalize month
rows to the month's last day with `metric='premium_requests_month'`, day rows to
`metric='premium_requests'`.
Fallbacks, in order, if that endpoint isn't available to your plan:
(a) whatever per-user premium-request usage endpoint current docs name — adapt paths
in this one file; the connector contract isolates the change;
(b) CSV import: GitHub's downloadable premium-request usage report (columns ≈
timestamp, user, model, requests used, exceeds-quota flag, total quota) via
`POST /api/data/import/premium-requests-csv` — same connector, `fetch` reads the
uploaded file instead of the API.
Fact mapping: sku `copilot_premium_request`, quantity = requests, `multiplier` from
payload else `modelPriceOn(db, model, day)`, `net_amount_usd =
premiumRequestCost({requests, multiplier, included: coveredByQuota ? ∞ : 0})` — i.e.
0 for quota-covered rows, price × multiplier × requests for overage rows; gross
always priced. Unknown model → store fact with multiplier 1 **and**
`ctx.notify({key: "data.premium-requests.unknown-model." + model, level: "warning", …})`
so `model_prices` gets a row added.
Columns: `day, user_login, model, requests, multiplier, gross_usd, net_usd`. TTL 6 h.

### T2.5e Connector billing-usage

Endpoint: `GET /organizations/{org}/settings/billing/usage` with `year`/`month`
params (enhanced billing platform; fine-grained PAT billing read — **verify exact
permission name**). Date-ranged at month granularity, TTL 6 h.
Maps `usageItems[]` → org-level facts: `ensureSku(db, item.product, item.sku)`,
quantity, unit = `unitType`, `gross_amount_usd = grossAmount`, `net_amount_usd =
netAmount`, multiplier 1, user NULL, day = item date else `YYYY-MM-01`.
This is the money-truth dataset — T2.5d totals must reconcile against it (checked
manually in T9.2). Columns: `day, product, sku, quantity, unit, gross_usd, net_usd`.
Quirk: `repositoryName` is dropped in v1 (kept in `raw`).

### T2.6 Background refresh scheduler

**Goal** Accumulate history for short-retention datasets without user action.
**Files** create `apps/server/src/services/data/scheduler.ts`; test beside.

```ts
export function startScheduler(opts: {
  ctx: ServiceContext;
  connectors: () => DatasetConnector[];
  sync: (datasetId: string) => Promise<void>;
  unlocked: () => boolean;
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval }; // tests fake these
}): { stop(): void }
```

Behavior: after `auth.unlocked`, first tick at +1 min; then per dataset every
`max(freshnessTtlHours / 2, 1)` hours ±10 % jitter (jitter from a seeded PRNG passed
in, not `Math.random`, so tests are exact); each tick skips when `!unlocked()` or a
`credential.*.invalid` notification for github-pat is active; `stop()` clears all
timers (wired to service `shutdown`). Enabled when `config.packaged` or
`GHR_SCHEDULER=1` (dev default off).
**Tests** (fake timers) fires per TTL; respects locked; stop clears; jitter bounded.
**Done when** green; wired into the data service `init`.
**Refs** ADR 0005, T2.5c retention note.

---

## E3 Credentials

### T3.1 Secret store ports and encrypted-file backend

**Goal** The secrets contract + the portable backend + the conformance suite.
**Files** create `apps/server/src/adapters/secretstore/conformance.ts`,
`secretstore/encfile.ts`; test `encfile.test.ts`.

Conformance suite (exported, reused by every backend — TESTS.md §5):

```ts
export function secretStoreConformance(name: string, make: () => Promise<SecretStoreBackend>) {
  describe(`SecretStoreBackend conformance: ${name}`, () => {
    it("round-trips a secret", async () => {
      const s = await make();
      await s.set("a1", "hunter2");
      expect(await s.get("a1")).toBe("hunter2");
    });
    it("returns null for a missing account", async () => {
      expect(await (await make()).get("nope")).toBeNull();
    });
    it("overwrites on set to an existing account", async () => {
      const s = await make();
      await s.set("a1", "old"); await s.set("a1", "new");
      expect(await s.get("a1")).toBe("new");
    });
    it("deletes idempotently", async () => {
      const s = await make();
      await s.set("a1", "x"); await s.delete("a1"); await s.delete("a1");
      expect(await s.get("a1")).toBeNull();
    });
  });
}
```

`encfile.ts`:

```ts
export function createEncryptedFileBackend(opts: {
  path: string;                                  // ~/.ghreporting/secrets.enc.json
  keyProvider: () => Uint8Array | null;          // master key; null = locked
}): SecretStoreBackend
```

- AES-256-GCM via `crypto.subtle`: 12-byte IV from `crypto.getRandomValues`, key via
  `crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"])`.
- File JSON `{version: 1, entries: {[account]: {iv: base64, ct: base64}}}`; write
  atomically (`Bun.write(tmp)` then `renameSync`).
- `keyProvider() === null` → throw `SecretsLockedError` on any operation.
- `available()`: parent dir writable.

**Tests** conformance suite; locked → `SecretsLockedError`; persistence across
"restart" (new instance, same tmp path); tampered ciphertext → error, not crash.
**Done when** green.
**Refs** PLUGIN.md §Secret Store Backends, ADR 0006, DDD.md §3.4.

### T3.2 macOS Keychain backend

**Goal** Secrets at rest in the OS keychain on darwin.
**Files** create `apps/server/src/adapters/secretstore/keychain.ts`; test
`keychain.test.ts` (conformance, gated per TESTS.md §4).

```ts
export function createKeychainBackend(opts?: { service?: string; platform?: string }): SecretStoreBackend {
  const service = opts?.service ?? "ghreporting";
  const platform = opts?.platform ?? process.platform;
  async function security(args: string[]): Promise<{ code: number; stdout: string }> {
    const p = Bun.spawn(["security", ...args], { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(p.stdout).text();
    return { code: await p.exited, stdout };
  }
  return {
    id: "keychain",
    available: async () =>
      platform === "darwin" && (await security(["help"])).code === 0,
    get: async (account) => {
      const r = await security(["find-generic-password", "-s", service, "-a", account, "-w"]);
      return r.code === 0 ? r.stdout.trimEnd() : null;      // non-zero = not found
    },
    set: async (account, secret) => {
      const r = await security(["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret]);
      if (r.code !== 0) throw new AppError("keychain.write_failed", `security exited ${r.code}`);
    },
    delete: async (account) => {
      await security(["delete-generic-password", "-s", service, "-a", account]);   // missing = fine
    },
  };
}
```

**Notes** argv exposure is an accepted, ADR-recorded trade-off (0006) — don't "fix"
ad hoc. Never log the spawn args (they contain the secret).
**Tests** conformance under `RUN_KEYCHAIN=1` + darwin gate (use throwaway accounts
`test.<uuid>`, delete in `afterEach`); `available()` false with
`platform: "linux"` injected.
**Done when** `RUN_KEYCHAIN=1 bun test keychain` green locally.
**Refs** PLUGIN.md, ADR 0006, TESTS.md §4.

### T3.3 Credential providers and github-pat

**Goal** Pluggable "what is this credential and is it still good".
**Files** create `apps/server/src/services/credentials/ports.ts` (copy
`CredentialProvider` family from PLUGIN.md), `credentials/providers/github-pat.ts`;
test beside.

```ts
export function githubPatProvider(fetchImpl: typeof fetch = fetch): CredentialProvider {
  return {
    type: "github-pat",
    describe: () => ({
      type: "github-pat",
      title: "GitHub Personal Access Token",
      helpUrl: "https://github.com/settings/tokens",
      fields: [{ key: "token", label: "Personal access token", secret: true, placeholder: "ghp_… / github_pat_…" }],
      requiredScopes: ["read:org", "manage_billing:copilot"],   // VERIFY names on docs.github.com
    }),
    async validate(secret, ctx) {
      const res = await fetchImpl("https://api.github.com/user", {
        headers: { authorization: `token ${secret}`, "user-agent": "ghreporting" },
      });
      if (res.status === 401) return { state: "invalid", reason: "token rejected (401)" };
      if (!res.ok) return { state: "invalid", reason: `unexpected status ${res.status}` };
      const scopes = (res.headers.get("x-oauth-scopes") ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      const exp = res.headers.get("github-authentication-token-expiration");
      if (exp) {
        // header format "YYYY-MM-DD HH:MM:SS UTC" — normalize before parsing
        const t = Date.parse(exp.replace(" UTC", "Z").replace(" ", "T"));
        const daysLeft = Math.floor((t - ctx.config.now().getTime()) / 86_400_000);
        if (daysLeft <= 7) return { state: "expiring", expiresAt: new Date(t).toISOString(), daysLeft };
        return { state: "ok", scopes, expiresAt: new Date(t).toISOString() };
      }
      return { state: "ok", scopes };
    },
  };
}
```

Fine-grained PATs send no `x-oauth-scopes` — an empty scopes list is *not* invalid;
scope gaps produce a **warning notification** (in T3.4), never a hard invalid.
**Tests** (fake fetch) ok / expiring (daysLeft math against injected now) / invalid
401 / non-ok status; expiration-header normalization; **no secret text appears in any
returned object or thrown error** (assert with `JSON.stringify(result)`).
**Done when** green.
**Refs** PLUGIN.md §Credential Providers, ADR 0006.

### T3.4 Credentials service and routes

**Goal** The uService tying backends + providers together.
**Files** create `apps/server/src/services/credentials/service.ts`; test beside.
**Produces**

- Backend selection at `init`: `config.secretBackend` override, else first
  `await backend.available()` in `[keychain, encryptedFile]`; chosen backend id
  logged and stored on new `credentials_meta` rows. The service calls
  `bind.bindSecrets(backendAsSecretStore)` (T1.4 context) — from here on
  `ctx.secrets` works for every service, still lock-guarded by the encfile
  keyProvider / by auth state.
- Account naming: secret account = `cred.<id>`, id = `<type>:default`
  (e.g. `github-pat:default`).
- `tokenProvider(id): () => Promise<string>` — reads via `ctx.secrets`; throws
  `SecretsLockedError` when locked, `NotFoundError` when absent. The composition
  root hands `tokenProvider("github-pat:default")` to `createGitHubClient`.
- Revalidation: on save + every 6 h (injected timer, same pattern as T2.6). Status
  transitions upsert `credentials_meta`, emit `credential.expiring|invalid`, and
  `ctx.notify` keys `credential.<id>.expiring|invalid` (warning|error). Missing
  required scopes (classic PAT) → warning notification
  `credential.<id>.scopes`.
- Routes: `GET /` → `[{...meta_row, describe: provider.describe()}]` (never secret
  material — assert in test); `PUT /:id` `{secret}` → validate → `invalid` ⇒ 400
  envelope + meta status updated, valid ⇒ backend.set + meta upsert;
  `POST /:id/validate` → re-run now; `DELETE /:id` → backend.delete + meta delete.

**Tests** save-valid flow (fake backend + provider spies, meta row status `ok`);
save-invalid → 400, nothing stored in backend, meta `invalid`; expiring transition
notifies with the right key; list response contains no secret; `tokenProvider` throws
`SecretsLockedError` when locked and `NotFoundError` when missing; 6 h revalidation
tick re-runs validate (fake timers).
**Done when** green; a `GitHubClient` built with the tokenProvider works end-to-end
against a fake fetch.
**Refs** ARCHITECTURE.md §6, PLUGIN.md, DDD.md §3.4.

---

## E4 Access

### T4.1 WebAuthn register and login

**Goal** Passkey ceremonies (Touch ID) against the local server.
**Files** create `apps/server/src/services/auth/webauthn.ts`, `auth/service.ts`;
tests beside.
**Deps** `cd apps/server && bun add @simplewebauthn/server`.
**Produces** routes (mounted at `/api/auth` — exempt from the session gate):

- `GET /status` → `{ registered: boolean, unlocked: boolean }` (passkey row exists;
  master key in memory).
- `POST /register/options` — 403 `AppError("auth.already_registered")` if a passkey
  exists (single-owner tool; re-registration = recovery procedure below). Otherwise:

```ts
const options = await generateRegistrationOptions({
  rpName: "ghreporting",
  rpID: "localhost",
  userName: "owner",
  attestationType: "none",
  authenticatorSelection: {
    authenticatorAttachment: "platform",      // Touch ID / Windows Hello
    userVerification: "required",
    residentKey: "preferred",
  },
});
challenges.set("register", { value: options.challenge, expires: now + 5 * 60_000 });
return c.json(options);
```

- `POST /register/verify` → `verifyRegistrationResponse({ response, expectedChallenge,
  expectedOrigin: config.origins, expectedRPID: "localhost" })` → on `verified`,
  insert `passkeys(id, public_key, counter, transports, created_at)` from
  `registrationInfo` → proceed to T4.2's session+unlock.
- `POST /login/options` → `generateAuthenticationOptions({ rpID: "localhost",
  userVerification: "required" })`, challenge stored the same way.
- `POST /login/verify` → load passkey row → `verifyAuthenticationResponse({ response,
  expectedChallenge, expectedOrigin: config.origins, expectedRPID: "localhost",
  credential: { id, publicKey, counter } })` → reject on `!verified` or counter
  regression (clone signal) → update stored counter → T4.2 session+unlock.

Challenges live in an in-memory `Map` with 5-min TTL read via `config.now()`.
**VERIFY** the exact option/field names against the installed @simplewebauthn major's
docs (they rename fields between majors; the ceremony shape above is stable).
Recovery procedure (document in the route file header): stop app, delete `passkeys`
rows (`sqlite3 ~/.ghreporting/ghreporting.db "DELETE FROM passkeys"`), keychain entry
stays — next boot offers setup again; local data is preserved.
**Tests** unit-test our glue (the library's crypto is its own project's job):
single-passkey guard 403; challenge TTL expiry → 400; counter regression → 401 +
counter unchanged; origin allow-list passed through. Real-authenticator ceremony is
T11.3 (Playwright virtual authenticator).
**Done when** green.
**Refs** ADR 0007, ARCHITECTURE.md §6.

### T4.2 Session gate and master key unlock

**Goal** Sessions + the unlock that makes secrets usable.
**Files** create `apps/server/src/services/auth/session.ts`, `auth/masterkey.ts`;
extend `app.ts` (mount middleware); tests beside.

```ts
// session.ts
export function createSessionStore(now: () => Date, idleMs = 12 * 3600_000) {
  const sessions = new Map<string, { lastSeen: number }>();
  return {
    create(): string {
      const token = crypto.randomUUID();
      sessions.set(token, { lastSeen: now().getTime() });
      return token;
    },
    touch(token: string): boolean {
      const s = sessions.get(token);
      if (!s || now().getTime() - s.lastSeen > idleMs) { sessions.delete(token); return false; }
      s.lastSeen = now().getTime();
      return true;
    },
    destroy(token: string) { sessions.delete(token); },
    clear() { sessions.clear(); },
  };
}

// gate middleware (app.ts)
import { getCookie } from "hono/cookie";
app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path === "/api/health" || path.startsWith("/api/auth/")) return next();
  const token = getCookie(c, "ghr_session");
  if (!token || !sessions.touch(token)) {
    return c.json({ error: { code: "unauthorized", message: "login required" } }, 401);
  }
  return next();
});
```

```ts
// masterkey.ts
export async function loadOrCreateMasterKey(backend: SecretStoreBackend): Promise<Uint8Array> {
  const hex = await backend.get("master-key");
  if (hex) return Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
  const key = crypto.getRandomValues(new Uint8Array(32));
  await backend.set("master-key", [...key].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return key;
}
```

Unlock flow (in auth service, after a verified register/login): master key backend =
keychain on darwin, else a `0600` file `~/.ghreporting/master.key` (honest fallback,
ADR 0007 — implement as a 20-line `SecretStoreBackend` over `Bun.file`); load key →
hand it to the encfile backend's `keyProvider` slot + flip `unlocked` state →
`bus.emit({ type: "auth.unlocked" })` → `Set-Cookie: ghr_session=<token>; HttpOnly;
SameSite=Strict; Path=/`. `POST /api/auth/logout` → destroy session, zero the key
buffer (`key.fill(0)`), lock secrets again.
**Tests** gate blocks without cookie / permits with (via `app.request` with `Cookie`
header); health + auth paths exempt; idle expiry with injected `now`; logout →
`ctx.secrets.get` throws `SecretsLockedError` again; master key created once, stable
across loads, 64 hex chars.
**Done when** full loop green with T3.x: save token → logout → locked → login →
token readable.
**Refs** ARCHITECTURE.md §6, ADR 0007, DDD.md §3.5.

---

## E5 Notifications

### T5.1 Notifications service

**Goal** The upsert-by-key notification store every service uses.
**Files** create `apps/server/src/services/notifications/service.ts`; test beside.
**Produces** `notify(n: NotificationInput): number` using exactly:

```sql
INSERT INTO notifications(key, level, title, body, source, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
ON CONFLICT(key) DO UPDATE SET
  level=?2, title=?3, body=?4, source=?5, updated_at=?6, dismissed_at=NULL
RETURNING id;
```

(re-fires a previously dismissed card — DDD.md §3.6), then
`bus.emit({type: "notification.changed", id})`. Routes:
`GET /?state=active|all` (active = `dismissed_at IS NULL`, newest `updated_at`
first); `POST /:id/read` (stamp `read_at`); `POST /:id/dismiss` (stamp
`dismissed_at`). Service `init` calls `bind.bindNotify(notify)` — first registered
service, so every later service's `ctx.notify` is live.
**Tests** same key twice → one row, fresh `updated_at`, original `created_at`;
dismissed + re-notify → active again; read/dismiss stamps; list filters; emit on
every change.
**Done when** green.
**Refs** DDD.md §3.6, UBIQUITOUS.md §Notifications, T1.4 context binding.

### T5.2 notify wiring and SSE stream

**Goal** Live push to the browser.
**Files** modify `services/notifications/service.ts`: create the T1.5 hub in `init`,
mount `GET /stream` via `hub.handler()` in `routes`, subscribe:
`bus.on("notification.changed", e => hub.broadcast("notification.changed", e))` and
likewise for `sync.started|completed|failed`. Test: SSE client (via `app.request`)
receives `notification.changed` after a `notify()`.
**Done when** green; manual `curl -N http://localhost:8787/api/notifications/stream`
(with a session cookie) shows events when a notification fires.
**Refs** T1.5, ARCHITECTURE.md §3.

---

## E6 Web shell

### T6.1 App shell, router, API client

**Goal** Frontend skeleton the features plug into.
**Files** create `apps/web/src/lib/api.ts`, `lib/sse.ts`, `state/ui.ts`; rewrite
`App.tsx` (view switch + lazy routes); tests `api.test.ts`, `ui.test.ts`.
**Deps** `cd apps/web && bun add @tanstack/react-query zustand`.
**Notes** No router library — three views (`login | explorer | workbench`) and a
zustand `ui` slice cover it (`{ view, setView }`); add a router only when
deep-linking becomes a requirement. Views load via `React.lazy` (Univer must not tax
the login screen — ADR 0008).

```ts
// api.ts
export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
export function makeApi(deps: { fetchImpl?: typeof fetch; onUnauthorized(): void }) {
  const f = deps.fetchImpl ?? fetch;
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await f(path, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) deps.onUnauthorized();
    if (!res.ok) {
      const env = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
      throw new ApiError(env?.error?.code ?? "http", env?.error?.message ?? res.statusText, res.status);
    }
    return (await res.json()) as T;
  }
  return {
    get: <T>(p: string) => request<T>("GET", p),
    post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
    put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
    del: <T>(p: string) => request<T>("DELETE", p),
  };
}
```

`sse.ts`: `startSse(onEvent: (type: string, data: unknown) => void)` — one
`EventSource("/api/notifications/stream", { withCredentials: true })`, listeners for
the event types we broadcast, native auto-reconnect; App wires `onEvent` to TanStack
Query invalidations (`["notifications"]`, `["datasets"]`).
**Tests** api: error envelope → `ApiError` with code; 401 calls `onUnauthorized`
(inject spy); ui store transitions.
**Done when** `make test` green; `make serve-all` shows the shell with working view
tabs and a react-query provider.
**Refs** ARCHITECTURE.md §7.

### T6.2 Login and first-run UI

**Goal** Touch ID register/login screens.
**Files** create `apps/web/src/features/login/Login.tsx`, `login/flows.ts`; test
`flows.test.ts`.
**Deps** `cd apps/web && bun add @simplewebauthn/browser`.

```ts
// flows.ts — pure, fully testable
export type AuthStatus = { registered: boolean; unlocked: boolean };
export function nextScreen(s: AuthStatus): "setup" | "login" | "app" {
  if (!s.registered) return "setup";
  return s.unlocked ? "app" : "login";
}
export async function register(api: Api): Promise<void> {
  const options = await api.post<PublicKeyCredentialCreationOptionsJSON>("/api/auth/register/options");
  const attestation = await startRegistration({ optionsJSON: options }); // VERIFY arg shape per installed major
  await api.post("/api/auth/register/verify", attestation);
}
export async function login(api: Api): Promise<void> {
  const options = await api.post<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options");
  const assertion = await startAuthentication({ optionsJSON: options });
  await api.post("/api/auth/login/verify", assertion);
}
```

`Login.tsx`: queries `/api/auth/status`; setup screen → "Set up Touch ID" button →
`register()`; login screen → "Unlock with Touch ID" → `login()`; treat the
user-cancelled WebAuthn error (`NotAllowedError`) as a quiet no-op, everything else
as an inline error message. On success: invalidate status query → `ui.setView` per
`nextScreen`.
**Tests** `nextScreen` matrix (3 states); register/login call sequence with mocked
api + mocked @simplewebauthn/browser module; `NotAllowedError` swallowed.
**Done when** manual: register → logout → login works in Chrome and Safari on
localhost with Touch ID prompting natively.
**Refs** ADR 0007, T4.1/T4.2 routes.

### T6.3 Notifications UI

**Goal** Live bell + panel.
**Files** create `apps/web/src/features/notifications/Bell.tsx`, `Panel.tsx`,
`badge.ts`; test `badge.test.ts`.
**Produces** `badge.ts`: `badgeCount(list) = active !read count` and
`worstLevel(list): "info" | "warning" | "error"` (pure — test the matrix). Bell:
query `["notifications"]` → `GET /api/notifications?state=active`, badge +
level-colored dot; sse `notification.changed` invalidates. Panel: cards (level icon,
title, body, relative time from `updated_at`) with read/dismiss buttons
(`POST /api/notifications/:id/read|dismiss`, optimistic update). `error`-level
unread cards additionally render a top banner in the shell until read.
**Tests** badge/worstLevel matrices; render smoke via `renderToString(<Panel …/>)`
with fixture list.
**Done when** manual: save an invalid PAT (T6.x + T3.4) → bell badge appears live
without reload.
**Refs** T5.x, UBIQUITOUS.md §Notifications.

### T6.4 Data explorer

**Goal** Discover datasets, see coverage, preview, sync.
**Files** create `apps/web/src/features/explorer/Explorer.tsx`,
`explorer/Preview.tsx`, `explorer/format.ts`; test `format.test.ts`.
**Produces** catalog table from `GET /api/data/datasets`: title, description, scope,
expandable column list (name, type, description — this *is* the "easy to discover
what data we have" requirement), coverage line (`formatCoverage(state): string` —
e.g. "2026-01-01 → 2026-07-08, synced 2 h ago", "never synced", "syncing…",
"error: …" — pure fn, test all states), buttons **Sync now**
(`POST /api/data/sync {dataset, org}`; progress chip driven by sse `sync.*` events)
and **Preview** (`POST /api/data/query {dataset, q: {org, range: last30d, limit: 50},
sync: false}` → `Preview.tsx` plain `<table>`, columns in `meta.columns` order,
`stale` renders a "showing local data" hint). Org text-input defaults from
`GET /api/data/datasets`'s config default org.
**Tests** `formatCoverage` matrix; Preview `renderToString` with a fixture ResultSet.
**Done when** against a dev server with fixture-synced DB: all five datasets listed
with correct coverage; preview renders; Sync now flips the chip live.
**Refs** ARCHITECTURE.md §7, T2.4 routes.

---

## E7 Sheets

### T7.1 Workspace uService

**Goal** Persistence for workbooks + bindings.
**Files** create `apps/server/src/services/workspace/service.ts`; test beside.
**Produces** routes (all JSON, ids `crypto.randomUUID()`):
`GET /workbooks` → `[{id, name, updated_at}]` (no snapshots — they're big);
`POST /workbooks {name, snapshot?}`; `GET /workbooks/:id` → full row + bindings;
`PUT /workbooks/:id {name?, snapshot?}` (reject snapshot > 20 MB with
`ValidationError`); `DELETE /workbooks/:id`;
`POST /workbooks/:id/bindings {sheet, range, dataset, query, chartSpec?}` (query +
chartSpec `JSON.stringify`ed into TEXT columns); `PUT /bindings/:id`;
`DELETE /bindings/:id`.
**Tests** CRUD round-trips; cascade delete (workbook → bindings, proves the FK);
size guard; list omits snapshot.
**Done when** green.
**Refs** DDD.md §3.3, T2.2 tables.

### T7.2 SheetHost Univer embed

**Goal** A working spreadsheet bound to workbook persistence.
**Files** create `apps/web/src/features/sheets/SheetHost.tsx`, `sheets/univer.ts`
(the **only** file allowed to import Univer), `sheets/a1.ts`; test `a1.test.ts`.
**Deps** `cd apps/web && bun add @univerjs/presets` — **pin the minor** (ADR 0008);
import the preset CSS in SheetHost.

```tsx
// SheetHost.tsx (core)
useEffect(() => {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    presets: [UniverSheetsCorePreset({ container: containerRef.current! })],
  });
  univerAPI.createWorkbook(snapshot ?? { name });
  apiRef.current = univerAPI;
  const off = onValueMutation(univerAPI, (range) => props.onEdit?.(range));
  return () => { off(); univer.dispose(); };
}, [workbookId]);
```

`univer.ts` exports (facade API — **VERIFY exact facade names in the pinned
version's docs**; the sheet API has moved between minors):
`writeRange(api, sheet, a1, matrix)` / `readRange(api, sheet, a1): unknown[][]`
(`getActiveWorkbook().getSheetByName(sheet).getRange(a1).setValues/getValues`),
`onValueMutation(api, cb)` (command-executed listener filtered to
set-range-values mutations; return unsubscribe),
`saveSnapshot(api): object` (`getActiveWorkbook().save()`).
`a1.ts`: `parseRange("Sheet1!A1:D3") ⇄ {sheet, r0, c0, r1, c1}` +
`rangesIntersect(a, b): boolean` — pure, exhaustive tests (column letters past Z,
single cells, mismatched sheets).
Autosave: debounce 2 s after `onValueMutation` → `PUT /api/workspace/workbooks/:id
{snapshot: saveSnapshot(api)}`.
**Tests** `a1.ts` matrix; univer.ts helpers are thin facade calls covered by T11.3.
**Done when** manual: create workbook, type values + `=SUM(A1:A3)`, reload page —
content and formula survive.
**Refs** ADR 0008, ARCHITECTURE.md §7, T7.1 routes.

### T7.3 Binding store and insert flow

**Goal** The mediator that links datasets to sheet ranges.
**Files** create `apps/web/src/state/bindings.ts`; add "Insert into sheet" to the
explorer; test `bindings.test.ts`.

```ts
export interface Binding {
  id: string; workbookId: string; sheet: string; range: string;   // A1, incl. header row
  dataset: string; query: DatasetQuery; chartSpec?: ChartSpec;
}
interface BindingState {
  bindings: Binding[];
  revisions: Record<string, number>;                 // bumped ONLY by value mutations
  selection: { bindingId: string; rows: number[] } | null;  // NEVER bumps revisions
  load(workbookId: string): Promise<void>;
  add(b: Binding): void;
  bumpRevision(bindingId: string): void;
  select(sel: BindingState["selection"]): void;
  onSheetEdit(sheet: string, editedA1: string): void;  // intersect → bumpRevision
}
export const useBindings = create<BindingState>((set, get) => ({ /* … */ }));
```

Insert flow: explorer row → "Insert into sheet" → dialog (workbook picker or
"new", sheet name, anchor cell, default `A1`) → `POST /api/data/query {sync: true}`
→ matrix = `[meta.columns.map(c => c.name), ...rows]` → `writeRange` at anchor →
binding range = anchor extended by matrix extent → `POST
/api/workspace/workbooks/:id/bindings` → `add(binding)`.
SheetHost's `onEdit` → `onSheetEdit` → `rangesIntersect` per binding →
`bumpRevision`.
**Tests** store transitions; `onSheetEdit` bumps only intersecting bindings;
**loop-prevention invariant: `select()` never changes `revisions`** (explicit test —
DDD.md invariant 9); insert flow against mocked api + mocked univer module writes
header row first.
**Done when** a dataset lands in a sheet with headers and editing a bound cell bumps
exactly that binding's revision.
**Refs** DDD.md §3.3, ARCHITECTURE.md §7, ADR 0009.

### T7.4 GHDATA formula

**(opt)** `=GHDATA("premium-requests", "acme", "2026-01-01", "2026-06-30")` spilling
a dataset into the sheet via Univer's custom-formula registration
(`univerAPI.registerFunction` family — confirm the API in the pinned version's docs).
Values come synchronously from the binding store's cached last query result
(`{sync: false}` semantics) — formula evaluation must never hit the network directly.
Skip freely: T7.3's insert flow already covers the requirement; this is
discoverability sugar.

---

## E8 Charts

### T8.1 ChartHost

**Goal** Serializable chart specs rendered next to sheets.
**Files** create `apps/web/src/features/charts/ChartHost.tsx`, `charts/spec.ts`;
test `spec.test.ts`.
**Deps** `cd apps/web && bun add echarts` (no wrapper lib — ADR 0009).

```ts
// spec.ts — pure; unit-test hard
export interface ChartSpec {
  type: "line" | "bar" | "stacked-bar" | "pie";
  xColumn: string;
  seriesColumns: string[];
  title?: string;
}
export function toEChartsOption(spec: ChartSpec, columns: string[], rows: unknown[][]): EChartsOption {
  if (!columns.includes(spec.xColumn)) throw new Error(`unknown xColumn: ${spec.xColumn}`);
  for (const s of spec.seriesColumns)
    if (!columns.includes(s)) throw new Error(`unknown series column: ${s}`);
  return {
    title: spec.title ? { text: spec.title } : undefined,
    tooltip: { trigger: spec.type === "pie" ? "item" : "axis" },
    legend: {},
    dataset: { source: [columns, ...rows] },
    xAxis: spec.type === "pie" ? undefined : { type: "category" },
    yAxis: spec.type === "pie" ? undefined : {},
    series: spec.seriesColumns.map((name) => ({
      name,
      type: spec.type === "pie" ? "pie" : spec.type === "stacked-bar" ? "bar" : spec.type,
      stack: spec.type === "stacked-bar" ? "total" : undefined,
      encode: spec.type === "pie" ? { itemName: spec.xColumn, value: name } : { x: spec.xColumn, y: name },
    })),
  };
}
```

`ChartHost.tsx` (~25 lines): `useRef` div; `echarts.init(el)`;
`chart.setOption(toEChartsOption(...), { notMerge: true })` on data/spec change;
`ResizeObserver` → `chart.resize()`; `chart.dispose()` on unmount; registers event
handlers passed as props (`onClick`, `onBrush`) — T8.2 supplies them.
**Tests** spec→option matrix per type (stack only on stacked-bar; pie has no axes;
encode correct); unknown column throws; empty rows → source has header only.
**Done when** a binding with a chartSpec renders and resizes with its pane.
**Refs** ADR 0009.

### T8.2 Bidirectional sheet chart link

**Goal** Sheet edits repaint charts; chart interactions select sheet rows.
**Files** create `apps/web/src/features/charts/link.ts`; extend `ChartHost.tsx`,
`SheetHost.tsx`; test `link.test.ts`.
**Produces**

- Sheet→chart: ChartHost subscribes to its binding's revision
  (`useBindings(s => s.revisions[bindingId])`) → on change `readRange(univerAPI,
  binding.sheet, binding.range)` → first row = columns, rest = rows → `setOption`.
  Because the chart reads the *sheet* (not the original query), formula edits inside
  the bound range flow to the chart — that's the real bidirectionality with sheet
  formulas.
- Chart→sheet: `chart.on("click", p => select(eventToRows(p)))` and
  `chart.on("brushSelected", …)`; `link.ts`:
  `eventToRows(params): number[]` — click → `[params.dataIndex]`; brush →
  flatten+dedupe `params.batch[0].selected[].dataIndex`. Row index 0 = first data
  row (header offset applied here, nowhere else). SheetHost watches `selection` →
  highlights those rows via the facade selection API on the binding's range.
- Loop prevention: **selection never bumps revisions; only value mutations do** —
  already asserted in T7.3's store test; add a regression test here that a
  `select()` does not trigger a chart re-render loop (spy on setOption count).

**Tests** `eventToRows` click + brush shapes (fixture param objects); header offset;
setOption not called on selection-only changes.
**Done when** manual: edit a bound cell → chart repaints; click a bar → sheet row
highlights; no flicker loops.
**Refs** ADR 0009, ARCHITECTURE.md §7, DDD.md invariant 9.

---

## E9 First report

### T9.1 Spend aggregation views

**Goal** SQL views answering "spend per model / user / team / month".
**Files** create `apps/server/src/adapters/db/migrations/0003_spend_views.ts`
(+ index entry); register derived datasets in the data service; tests beside.

```sql
CREATE VIEW v_premium_spend_user_model_month AS
SELECT substr(f.day, 1, 7) AS month, o.login AS org, u.login AS user, f.model AS model,
       SUM(f.quantity)                    AS requests,
       SUM(COALESCE(f.gross_amount_usd, 0)) AS gross_usd,
       SUM(COALESCE(f.net_amount_usd, 0))   AS net_usd
FROM usage_facts f
JOIN orgs o  ON o.id = f.org_id
JOIN skus s  ON s.id = f.sku_id AND s.name = 'copilot_premium_request'
LEFT JOIN users u ON u.id = f.user_id
WHERE f.metric LIKE 'premium_requests%'
GROUP BY month, org, user, model;

-- NOTE: a user in two teams counts in both team rollups (by design; documented here).
CREATE VIEW v_premium_spend_team_month AS
SELECT substr(f.day, 1, 7) AS month, o.login AS org, t.slug AS team, f.model AS model,
       SUM(f.quantity)                    AS requests,
       SUM(COALESCE(f.net_amount_usd, 0)) AS net_usd
FROM usage_facts f
JOIN orgs o ON o.id = f.org_id
JOIN skus s ON s.id = f.sku_id AND s.name = 'copilot_premium_request'
JOIN team_members tm ON tm.user_id = f.user_id
JOIN teams t ON t.id = tm.team_id
GROUP BY month, org, team, model;
```

Register **derived datasets** `spend-by-user-model-month` and `spend-by-team-month`:
connectors whose `coverage()` returns `[]` (never sync — they read what T2.5d
landed) and whose `select` queries the view with month-range + filter support
(`filter.user`, `filter.model`, `filter.team` → `IN` clauses). Their `meta.description`
must say "derived from premium-requests — sync that dataset first".
**Tests** seed facts → view rows equal hand-computed sums (include a quota-covered
row with net 0 and an overage row); user-in-two-teams counted twice in team view,
once in user view; derived dataset select honors filters; org-level facts
(`user IS NULL`) roll up under user `NULL` and are excluded from team view.
**Done when** `POST /api/data/query {dataset: "spend-by-user-model-month", …}`
returns correct aggregates from seeded facts.
**Refs** ARCHITECTURE.md §5, T2.5d, domain `premiumRequestCost`.

### T9.2 Shipped report template

**Goal** The requirement-10 deliverable: open the app, get model spend per user.
**Files** create `apps/web/src/features/reports/copilotSpend.ts` (template builder —
pure: returns the workbook name, binding payloads, and chart specs), a "Reports"
button in the shell; test `copilotSpend.test.ts` on the builder output.
**Produces** one click builds (if absent) workbook **"Copilot Spend"**:

- Sheet `Spend` ← binding `{dataset: "spend-by-user-model-month", query: {org,
  range: last 6 full months}}`, chartSpec `{type: "stacked-bar", xColumn: "month",
  seriesColumns: [per-model net_usd columns]}` — the builder pivots long→wide first:
  `pivot(rows, x: "month", series: "model", value: "net_usd")` (pure helper, tested:
  missing month×model combos become 0).
- Sheet `ByUser` ← same dataset filtered to the latest closed month, chartSpec
  `{type: "bar", xColumn: "user", seriesColumns: ["net_usd"]}`.
- Sheet `ByTeam` ← `spend-by-team-month`, table only.

Flow on open: `POST /api/data/sync {dataset: "premium-requests"}` (progress via sse)
→ query both derived datasets `{sync: false}` → write sheets → create bindings.
**Acceptance (manual, real org):** pick one closed month; download GitHub's own
premium-request usage CSV for it; the report's per-model and per-user totals match
to the cent (document any rounding delta and its cause in the task's commit message).
**Done when** template creates and renders; numbers validated once against the CSV.
**Refs** T7.3, T8.x, T9.1.

---

## E10 Packaging

### T10.1 Embed and compile

**Goal** `make package` → one executable serving API + UI.
**Files** create `scripts/gen-embed.ts`, `apps/server/src/static.ts`; commit a
default `apps/server/src/embedded.ts` (empty manifest, below); extend `app.ts` and
the Makefile; test `static.test.ts`.

Committed default (dev mode — Vite serves the UI, manifest stays empty):

```ts
// Overwritten by `make generate` for packaged builds. Keep the empty default committed.
export const embedded: Record<string, string> = {};
```

```ts
// scripts/gen-embed.ts — run from repo root by `make generate`
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
const dist = "apps/web/dist";
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(dist);
const imports = files.map((p, i) =>
  `import f${i} from "../../web/dist/${relative(dist, p)}" with { type: "file" };`);
const entries = files.map((p, i) => `  "/${relative(dist, p)}": f${i},`);
writeFileSync("apps/server/src/embedded.ts",
  `// generated by scripts/gen-embed.ts — do not commit a non-empty version\n${imports.join("\n")}\n\nexport const embedded: Record<string, string> = {\n${entries.join("\n")}\n};\n`);
console.log(`embedded ${files.length} files`);
```

(`with { type: "file" }` imports are exactly what `bun build --compile` packs into
the binary; at runtime the value is a path into the embedded filesystem that
`Bun.file` can serve.)

```ts
// static.ts
export function mountStatic(app: Hono, embedded: Record<string, string>) {
  if (Object.keys(embedded).length === 0) return;          // dev: Vite owns the UI
  app.get("*", (c) => {
    const path = c.req.path === "/" ? "/index.html" : c.req.path;
    const file = embedded[path] ?? embedded["/index.html"]; // SPA fallback
    if (!file) return c.notFound();
    return new Response(Bun.file(file));                    // content-type inferred
  });
}
```

Makefile: `generate` → `bun scripts/gen-embed.ts`; `package` → `build` + `generate` +
`bun build --compile apps/server/src/index.ts --outfile dist/ghreporting`, then
restore the committed empty manifest (`git checkout -- apps/server/src/embedded.ts`)
so the working tree stays clean.
**Tests** `mountStatic` with a fake manifest: exact path served; `/` → index; unknown
path → index (SPA); empty manifest mounts nothing (API 404 behavior unchanged).
**Done when** `make package && ./dist/ghreporting` serves the login page on
`http://localhost:8787` and the full flow works (that origin is already in the
WebAuthn allow-list).
**Refs** ADR 0010, ADR 0007 origins.

### T10.2 App wrapper and cross-compile

**Goal** Double-clickable Mac app + other-OS binaries.
**Files** create `scripts/make-app.sh`; Makefile targets `package-app`,
`package-all`.

`make-app.sh` builds `dist/GH Reporting.app`:
`Contents/MacOS/ghreporting` (the compiled binary), `Contents/MacOS/launcher`
(shell script: `GHR_PACKAGED=1 "$DIR/ghreporting" & sleep 1 && open
"http://localhost:8787"; wait`), `Contents/Info.plist` (`CFBundleExecutable=launcher`,
`CFBundleIdentifier=se.toffia.ghreporting`, `CFBundleName=GH Reporting`,
`LSUIElement=true` so no Dock bounce). End the script with `test -f` assertions on
all three files — the script is its own smoke test.
`package-all`: loop `--target=bun-darwin-arm64 bun-windows-x64 bun-linux-x64` →
`dist/ghreporting-<target>[.exe]`.
**Notes** No signing/notarization (ADR 0010) — first launch is right-click → Open.
On Windows/Linux the keychain backend reports unavailable and the encrypted-file
backend engages automatically (T3.4 selection).
**Done when** `make package-app` produces an app that launches, opens the browser,
and serves; `make package-all` emits three binaries.
**Refs** ADR 0010.

---

## E11 Quality hardening

### T11.1 Integration tests

**Goal** Prove connectors against recorded reality; keep live GitHub optional.
**Files** create `tests/fixtures/github/<dataset>/*.json`, `tests/fixtures/gen.ts`
(seeded fact generator, shared with benches), `scripts/record-fixtures.ts`,
`tests/integration/connectors.replay.test.ts`,
`tests/integration/github.live.test.ts`.
**Produces**

- Recorder (`bun scripts/record-fixtures.ts --org <org> [--redact]`): builds a real
  `GitHubClient`, runs each connector's `fetch` for a small recent gap, writes the
  raw pages as fixture JSON; `--redact` maps logins to `user1…userN` (committed
  fixtures must be redacted); obeys the 50-request budget via `requestCount()` and
  aborts loudly past it.
- Replay suite: `fetchImpl` fake that serves fixture files by URL pattern → per
  connector: coverage→fetch→upsert→select round-trip on `:memory:`, idempotent
  double-upsert, columns match `meta.columns`.
- Live suite (`describe.skipIf(!(process.env.RUN_GH_LIVE === "1" && process.env.GH_TOKEN))`):
  asserts response *shape* (fields we map exist), never values; suite-end assertion
  `expect(gh.requestCount()).toBeLessThanOrEqual(50)`.

**Done when** `make test` green offline; `make test-integration` green against a real
org; redacted fixtures checked in.
**Refs** TESTS.md §3, T2.3.

### T11.2 Benchmarks

**Goal** Know the pipeline's envelope before it matters.
**Files** create `bench/run.ts`, `bench/facts.bench.ts`, `bench/report.bench.ts`,
`bench/domain.bench.ts`; Makefile `bench` → `bun bench/run.ts`.
**Deps** `bun add -d mitata` (root).
**Produces** (mitata `bench()` + `run()`):

- `facts`: upsert 10 000 facts — one transaction vs per-row transactions (the gap is
  the lesson; print both).
- `report`: `v_premium_spend_user_model_month` query over ~100 000 generated facts
  (from `tests/fixtures/gen.ts`; file DB in the scratch dir, not `:memory:`, to
  include I/O).
- `domain`: `premiumRequestCost` hot loop (sanity that money math stays trivial).

**Done when** `make bench` prints mitata tables; add the observed report-query number
as a one-line note in README's status section.
**Refs** TESTS.md §6.

### T11.3 E2E smoke

**Goal** One browser proof that the whole thing hangs together.
**Files** create `tests/e2e/smoke.spec.ts`, `playwright.config.ts`; Makefile
`test-e2e`; add the `demo` connector (canned rows, registered only when
`GHR_E2E=1`) to the data service.
**Deps** `bun add -d @playwright/test && bunx playwright install chromium`.
**Produces** config `webServer`: `GHR_DB_PATH=<tmp> GHR_E2E=1 bun apps/server/src/index.ts`
(+ built UI via `make build` + `generate`, or Vite dev server — pick one and pin it
in the config comment). Spec (single path, smoke not suite):

```ts
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  },
});
// register → login → explorer shows "demo" → insert into sheet → A1 shows header
// → add chart → page.locator("canvas") visible
```

**Done when** `make test-e2e` green headless.
**Refs** TESTS.md §1, ADR 0007.
