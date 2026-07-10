# GH Reporting Architecture

How the system is put together. Vocabulary: [UBIQUITOUS.md](UBIQUITOUS.md).
Domain model: [DDD.md](DDD.md). Decisions and their reasons: [docs/adr/](docs/adr/README.md).

## 1. System Overview

A single-user, local-first reporting workbench. One Bun process serves an HTTP API and
(in packaged mode) the frontend. The browser is the workbench; GitHub is a *sync source*,
never a live query backend.

```
┌────────────────────────── Browser ───────────────────────────┐
│  React shell (Vite)                                           │
│  ┌──────────┐ ┌──────────┐ ┌─────────────┐ ┌───────────────┐  │
│  │  Login   │ │ Explorer │ │ Sheets      │ │ Charts        │  │
│  │ (WebAuthn│ │ datasets │ │ (Univer)    │ │ (ECharts)     │  │
│  │  TouchID)│ │ discovery│ │  ▲ bindings │ │  ▲ bindings   │  │
│  └────┬─────┘ └────┬─────┘ └──┼──────────┘ └──┼────────────┘  │
│       │            │     shared binding store (zustand)       │
└───────┼────────────┼──────────┼────────────────┼──────────────┘
        │ HTTP /api/* + SSE /api/notifications/stream
┌───────▼────────────▼──────────▼────────────────▼──────────────┐
│  Bun server (Hono) — uService kernel                           │
│  ┌───────┐ ┌──────┐ ┌─────────────┐ ┌──────────────┐ ┌──────┐ │
│  │ auth  │ │ data │ │ credentials │ │notifications │ │work- │ │
│  │       │ │      │ │             │ │              │ │space │ │
│  └───┬───┘ └──┬───┘ └──────┬──────┘ └──────┬───────┘ └──┬───┘ │
│      │        │            │               │            │     │
│  ── ports ────┼──────── ports ─────────── ports ────────┼──── │
│  ┌────────┐ ┌─▼────────┐ ┌─▼──────────┐ ┌─▼──────────┐ ┌▼───┐ │
│  │WebAuthn│ │ GitHub   │ │ SecretStore│ │ bun:sqlite │ │ …  │ │
│  │adapter │ │ client   │ │ backends   │ │ (one DB)   │ │    │ │
│  └────────┘ │(octokit) │ │(keychain,  │ └─────┬──────┘ └────┘ │
│             └────┬─────┘ │ enc. file) │       │               │
└──────────────────┼───────┴─────┬──────┴───────┼───────────────┘
                   ▼             ▼              ▼
             GitHub REST    macOS Keychain   ~/.ghreporting/ghreporting.db
```

A sixth uService, **reports** (E8.5), sits beside `workspace` on the same shared DB: it
stores portable `ReportDefinition` documents (CRUD, export/import) and seeds the Copilot
Spend report on init. It owns no adapter — reports execute in the browser, which compiles
a definition and calls the `data` service per panel (ADR
[0014](docs/adr/0014-report-designer-standalone-definitions.md)).

## 2. Hexagonal Layers & Dependency Rule

| Layer | Lives in | May import |
|-------|----------|-----------|
| Domain (shared kernel) | `packages/domain` | nothing (zero `dependencies` in package.json — physically enforced) |
| Ports | `apps/server/src/kernel/ports.ts` + per-service `ports.ts` | domain |
| Application services (uServices) | `apps/server/src/services/*` | domain, ports, kernel |
| Adapters | `apps/server/src/adapters/*` | domain, ports (never services) |
| Composition root | `apps/server/src/index.ts`, `app.ts` | everything — the only place concrete adapters meet services |
| UI | `apps/web/src/*` | domain (types), its own modules; talks to the server only via `/api/*` |

**Dependency rule:** imports point inward (toward domain). A service never imports an
adapter module; it receives adapter instances through its `ServiceContext` or
constructor, typed as ports. Violations are review findings (no arch-lint tool yet —
see [LINT.md](LINT.md) §Architecture rules).

Sanctioned exception: `adapters/db/dims.ts` — pure SQL helper functions over the
injected `Database` (no I/O of their own). Connectors import them directly per
[PLUGIN.md](PLUGIN.md) rule 3 so dimension rows stay consistent; they are ports in
spirit, adapters by directory.

Pragmatic deviation from textbook hexagonal, recorded here on purpose: ports that need
server-only types (Hono, `bun:sqlite`'s `Database`) live in `apps/server/src/kernel`,
not in `packages/domain`. The domain package stays runtime-agnostic so the browser can
import it.

## 3. The uService Kernel

The system is a **modular monolith**: independent services composed into one process,
communicating through an in-process event bus — never by importing each other.
(ADR [0004](docs/adr/0004-uservice-kernel-modular-monolith.md).)

```ts
// apps/server/src/kernel/ports.ts (canonical — implementers copy signatures from here)
export interface MicroService {
  readonly name: string;                              // route prefix: /api/<name>
  init(ctx: ServiceContext): Promise<void> | void;    // called in registration order
  routes?(app: Hono, ctx: ServiceContext): void;      // mount HTTP routes
  shutdown?(): Promise<void> | void;                  // called in reverse order
}

export interface ServiceContext {
  db: Database;                    // bun:sqlite — one shared database
  bus: EventBus;                   // typed pub/sub, in-process
  config: AppConfig;               // env-derived, immutable
  log: Logger;                     // scoped child logger per service
  notify(n: NotificationInput): void;   // raise/refresh a notification (dedupe by key)
  secrets: SecretStore;            // locked until auth service unlocks it (§6)
}
```

Lifecycle: the composition root builds `ServiceContext`, then for each registered
service runs `init` (registration order = dependency order: notifications → credentials
→ auth → data → workspace), then `routes`. Shutdown runs in reverse. A service that
fails `init` aborts startup — no half-alive process.

### Event bus

A typed union keeps events discoverable and exhaustively matchable:

```ts
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
  ): () => void;                                       // returns unsubscribe
}
```

### SSE hub

One Server-Sent-Events endpoint (`GET /api/notifications/stream`) pushes
`notification.changed` and sync progress to the browser. SSE over WebSocket because the
flow is strictly server→client and SSE reconnects for free (ADR 0004).

## 4. Data Plane: the Local-First Sync Pipeline

Every read goes through the **data** service (ADR
[0005](docs/adr/0005-local-first-sync-pipeline.md)):

```
UI / report                      data service                        GitHub
    │  query(dataset, q, {sync})     │                                  │
    ├────────────────────────────────▶                                  │
    │                    coverage(db, q) → gaps?                        │
    │                          │  none → skip to select                 │
    │                          │  gaps & sync!==false:                  │
    │                          ├── fetch(gap) ── ETag / throttled ─────▶│
    │                          │◀─ rows (or 304 Not Modified) ──────────┤
    │                          │   upsert(rows); watermark(gap)         │
    │◀── select(db, q) ────────┤                                        │
```

- **Connector contract** (`DatasetConnector`, full definition in
  [PLUGIN.md](PLUGIN.md#dataset-connectors)): each GitHub dataset is a plugin providing
  `meta`, `coverage`, `fetch`, `upsert`, `select`.
- **Watermarks:** `sync_state(dataset, scope)` rows record what range is already local
  and the last ETag. `coverage()` diffs the query range against watermarks and the
  dataset's freshness TTL.
- **Opt-out:** `query(..., { sync: false })` answers purely from SQLite (stale is fine —
  reports over historical data shouldn't touch the network).
- **Failure:** a failed sync raises a notification and — if the range is at least
  partially local — serves stale data with a `stale: true` flag instead of failing the
  report.

### GitHub rate-limit etiquette (applies to app *and* tests)

1. Conditional requests everywhere — a `304` costs no rate-limit quota.
2. `@octokit` throttling + retry plugins; obey `Retry-After` and secondary limits.
3. `per_page=100`, smallest date windows the API allows.
4. Nightly background refresh (T2.7) exists because Copilot metrics only expose ~28 days
   of history — the local DB is what accumulates the long-term record.

### Datasets v1

| Dataset id | Source endpoint | Grain |
|------------|-----------------|-------|
| `org-people` | `/orgs/{org}/members`, `/orgs/{org}/teams` (+ members) | user, team, membership |
| `copilot-seats` | `/orgs/{org}/copilot/billing/seats` | seat per user |
| `copilot-metrics` | `/orgs/{org}/copilot/metrics` | day × editor × model engagement |
| `billing-usage` | `/organizations/{org}/settings/billing/usage` | day × product × SKU $ |
| `premium-requests` | premium-request usage endpoint (verify per T2.5d) | day × user × model |

## 5. Local Database

One SQLite file (`~/.ghreporting/ghreporting.db`, override `GHR_DB_PATH`), accessed via
`bun:sqlite` in WAL mode. Migrations are numbered SQL files applied by a ~40-line runner
(ADR [0003](docs/adr/0003-sqlite-via-bun-sqlite.md)). Star-ish schema:

```
orgs ─┬─ teams (parent_team_id → hierarchy) ─ team_members ─ users
      │
      └─ usage_facts ── skus ── products          model_prices (model, valid_from)
             │
             └ (day, org, user?, sku, model?, metric, quantity, unit,
                multiplier, gross_amount_usd, net_amount_usd, source, raw)

org_members (org ↔ user set) · copilot_seats (current seat state per org × user)
sync_state · notifications · passkeys · credentials_meta · workbooks · bindings
schema_migrations
```

Key DDL decisions (full DDL in IMPLEMENTATION_PLAN_DETAILS.md T2.2):

- `usage_facts` is **append-only per (day, scope) upsert** — facts are immutable
  observations; re-syncing a day replaces that day's rows idempotently
  (`INSERT … ON CONFLICT DO UPDATE`).
- Uniqueness uses an **expression index** because SQLite treats NULLs as distinct in
  plain UNIQUE constraints (org-level facts have `user_id IS NULL`):

  ```sql
  CREATE UNIQUE INDEX ux_usage_fact ON usage_facts(
    day, org_id, COALESCE(user_id, 0), sku_id, COALESCE(model, ''), metric, source);
  ```
- The product hierarchy is normalized (`products` → `skus` → `usage_facts.model`) so
  aggregation works at any level: product, SKU, model, user, team, arbitrary user set.
- Aggregations are SQL `VIEW`s (`v_spend_per_user_model_month`, …), not app code.
- `raw` keeps the original API row (JSON) — reports can be rebuilt when GitHub adds
  fields, without re-syncing.

### Read-only handle for query datasets (ADR 0016)

A **Query Dataset** is a user-authored SQL `SELECT` stored as a row in `query_datasets`
(never `CREATE VIEW`). The `data` service opens a **second `bun:sqlite` handle in
`{ readonly: true }` mode** (`openReadOnly`) on the same file and runs all user SQL there,
so a write/DDL throws at the driver — arbitrary read SQL cannot corrupt the app's tables (a
second guard wraps every statement as `SELECT * FROM ( … )`, making non-SELECTs a syntax
error). WAL (ADR 0003) lets it read while syncs write on the read-write handle. The dataset
resolver falls back to a `query_datasets` lookup on a built-in miss — a dataset created a
moment ago is queryable with no re-init — and `GET /api/data/datasets` merges these rows
(coverage always `[]`) beside built-ins, so the report designer lists them unchanged.

**Report-provisioned datasets (ADR 0017).** A Report Definition may embed its query datasets
inline. The `reports` service **provisions** (upserts) them into `query_datasets` through the data
service's `QueryDatasetRegistry` port on save/import, and **mark-and-sweep garbage-collects** them
(the reports table is the root set) when no report references them — so `query_datasets` is a
registry derived from reports. Reports depends only on the port; the composition root injects the
concrete. This makes a report self-contained: import the JSON and its panels resolve with no
migration or connector code.

## 6. Security Model

Single local user; the goal is that **nothing secret rests in plaintext on disk** and
**no secret ever reaches the browser**. (ADRs [0006](docs/adr/0006-pluggable-credential-store.md),
[0007](docs/adr/0007-webauthn-touchid-login.md).)

- **Login** — WebAuthn platform authenticator (Touch ID / macOS password). `localhost`
  is a secure context, so this works over plain HTTP locally. One resident passkey,
  `rpID: "localhost"`, `userVerification: "required"`. Successful assertion → random
  session token in an `HttpOnly; SameSite=Strict` cookie; sessions live in server memory
  only.
- **Gate** — Hono middleware rejects every `/api/*` call except
  `/api/health` and `/api/auth/*` until a session exists.
- **Master key** — 32 random bytes, created at first setup, stored in the OS keychain.
  Loaded into process memory at login (`auth.unlocked` event), wiped at
  logout/shutdown. It encrypts the portable fallback secret store.
- **Secret store** — port with pluggable backends: `keychain` (macOS `security` CLI,
  default on darwin) and `encrypted-file` (AES-256-GCM via WebCrypto, keyed by the
  master key — the portable fallback and the Linux/Windows path). Which accounts exist
  is tracked in `credentials_meta` (SQLite); the secret material itself never is.
- **Credential providers** — plugins that know how to validate/refresh one credential
  *type* (first: `github-pat`). A provider periodically re-validates and raises
  `credential.expiring` / `credential.invalid` — surfaced as notifications telling you
  to rotate the token.
- **Threat model honesty:** this defends secrets at rest and keeps tokens out of the
  frontend; it does not defend against malware running as your user. The `security` CLI
  briefly exposes secrets on argv when writing — acceptable for a single-user desktop
  tool; the upgrade path (FFI to Security.framework) is noted in ADR 0006.

## 7. Frontend Architecture

```
apps/web/src/
  lib/        api.ts (typed fetch wrapper) · sse.ts (EventSource client)
  state/      bindings.ts (zustand store: Binding[] + selection)
  features/
    login/         WebAuthn ceremonies (@simplewebauthn/browser)
    notifications/ bell + panel, fed by SSE
    explorer/      dataset catalog, coverage, preview table, "insert into sheet"
    sheets/        SheetHost — Univer workbook, range read/write, edit events
    charts/        ChartHost — ECharts panel (thin ~20-line wrapper, no wrapper lib)
    reports/       Designer (CRUD + import/export) · ReportView (compile → query →
                   HTML tables + ChartHost; re-runs on parameter change)
```

The `reports` feature stores nothing itself — it reads a `ReportDefinition` from
`/api/reports/:id`, `compile()`s it (shared-kernel `packages/domain/report.ts`), and
issues one `/api/data/query` per panel. Panels render as HTML tables, not Univer sheets,
so Reporting stays off the heavy sheet path.

- **Server state** via TanStack Query (`/api/data/*`, `/api/notifications`, …);
  **UI state** (bindings, selections) via one zustand store. No other state libraries.
- **Binding** is the pivot concept (see UBIQUITOUS.md): *sheet range ⇄ dataset query ⇄
  chart spec*. The explorer creates bindings; SheetHost materializes rows into the
  range; ChartHost renders the same binding.
- **Bidirectional sync:** Univer edit events on a bound range → binding store bumps a
  revision → ChartHost re-reads the range and `setOption`s. Chart brush/click → binding
  store selection → SheetHost highlights/filters the bound range. One direction of
  truth per interaction; no loops (the store is the mediator).
- Sheets and charts are lazy-loaded routes (`React.lazy`) — Univer is heavy and must not
  tax the login screen.

## 8. Runtime Topologies

| | Dev (`make serve-all`) | Packaged (`make package`, ADR [0010](docs/adr/0010-single-binary-packaging.md)) |
|---|---|---|
| Frontend | Vite dev server :5173, HMR, proxies `/api` → :8787 | `vite build` output embedded into the binary, served by Hono |
| Backend | `bun --hot apps/server/src/index.ts` :8787 | same code, compiled by `bun build --compile` |
| Artifact | — | `dist/ghreporting` single executable (+ `.app` wrapper; cross-compile via `--target`) |
| Origin | `http://localhost:5173` | `http://localhost:8787` |

WebAuthn origins for both topologies are allow-listed in `AppConfig.origins`.

## 9. Where to Read More

- Per-context domain model and invariants → [DDD.md](DDD.md)
- Plugin contracts with full TypeScript → [PLUGIN.md](PLUGIN.md)
- Task-level build instructions → [IMPLEMENTATION_PLAN_DETAILS.md](IMPLEMENTATION_PLAN_DETAILS.md)
- Every "why" → [docs/adr/](docs/adr/README.md)
