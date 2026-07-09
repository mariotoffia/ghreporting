# GH Reporting — Domain Model (DDD)

Bounded contexts, aggregates, and invariants. Words used here are defined in
[UBIQUITOUS.md](UBIQUITOUS.md); how contexts map to code is in
[ARCHITECTURE.md](ARCHITECTURE.md) §2–§3.

## 1. Bounded contexts at a glance

| Context | Kind | Implemented as | One-line purpose |
|---------|------|----------------|------------------|
| Shared Kernel | shared | `packages/domain` | Types and pure math every context agrees on |
| Catalog & Sync | **core** | `data` uService | Own the local copy of GitHub usage data and its freshness |
| Workspace | core | `workspace` uService + web `sheets`/`charts` | Turn facts into sheets, charts, and saved reports |
| Credentials | supporting | `credentials` uService | Obtain, validate, and store secrets for external APIs |
| Access | supporting | `auth` uService | Prove the human is the owner; unlock secrets |
| Notifications | generic | `notifications` uService | Tell the human something needs attention |

Core = where this product wins (long-term local usage history GitHub itself doesn't
keep, and the sheet/chart workbench on top). Everything else exists to serve that.

## 2. Context map — who talks to whom

```
            ┌────────────── Shared Kernel (types only) ──────────────┐
            │            every context imports it, it imports nothing │
            └─────────────────────────────────────────────────────────┘
 Access ──unlocks──▶ Credentials ──provides token──▶ Catalog & Sync ──facts──▶ Workspace
    │                     │                              │                        │
    └──────── events ─────┴──────────── events ──────────┴──── events ───────────┘
                                        ▼
                                  Notifications
```

Relationships are **event-driven** (`AppEvent` bus) or **port calls** — never direct
imports between services. Notifications is a downstream generic context: everyone
publishes to it; it depends on no one.

## 3. Aggregates, entities, value objects per context

### 3.1 Shared Kernel — `packages/domain`

| Element | Kind | Notes |
|---------|------|-------|
| `UsageFact` | immutable fact (value) | day-grained observation; never mutated, only replaced by re-sync |
| `ProductPath` | value object | `product / sku / model?` — GitHub's own billing hierarchy |
| `premiumRequestCost()` | domain service (pure fn) | overage cost = max(0, requests × multiplier − included) × price |
| `roundUsd()` | pure fn | money rounds to whole cents, half-up |

Invariant: this package has **zero dependencies** and no I/O. If a function needs a
clock, a DB, or fetch — it does not belong here.

### 3.2 Catalog & Sync — core

| Element | Kind | Identity | Invariants |
|---------|------|----------|-----------|
| `Dataset` | aggregate root | `meta.id` | schema (`columns`) is declared, not inferred; scope is `org` or `org-user` |
| `SyncWatermark` | entity (in `sync_state`) | `(dataset, scope)` | advances monotonically; carries last ETag |
| `Gap` | value object | — | `[from, to]` inclusive ISO dates; produced by `coverage()`, consumed by `fetch()` |
| `Organization`, `User`, `Team` | entities | GitHub numeric id | team hierarchy via `parent_team_id`; membership is a set |
| `ModelPrice` | value object (temporal) | `(model, valid_from)` | multipliers change over time; cost math must pick the price valid on the fact's day |

Domain events: `sync.started`, `sync.completed`, `sync.failed`.

Hard invariants:
1. A query is **always answered from the local store** — sync fills the store first;
   it never streams API responses through to callers.
2. Re-syncing a range is **idempotent** (upsert on the fact's natural key).
3. A fact's natural key is `(day, org, user?, sku, model?, metric, source)`.

### 3.3 Workspace — core

| Element | Kind | Identity | Invariants |
|---------|------|----------|-----------|
| `Workbook` | aggregate root | uuid | owns its Univer snapshot; saved atomically |
| `Binding` | entity (child of Workbook) | uuid | links one sheet range ⇄ one dataset query ⇄ at most one chart spec |
| `ChartSpec` | value object | — | serializable ECharts option template, never live objects |

Invariants: a Binding's range belongs to its own workbook; deleting a workbook deletes
its bindings (FK cascade); chart and sheet never talk to each other directly — the
Binding is the mediator.

### 3.4 Credentials — supporting

| Element | Kind | Identity | Invariants |
|---------|------|----------|-----------|
| `Credential` | aggregate root | id (e.g. `github-pat:default`) | secret material lives only behind the `SecretStore` port; the aggregate persists metadata only |
| `CredentialStatus` | value object | — | `ok`/`expiring(days)`/`invalid` + checked-at |
| `CredentialProvider` | domain service (plugin) | `type` | knows how to validate one credential type and describe how to obtain it |
| `SecretStoreBackend` | port (plugin) | `id` | get/set/delete by account; no enumeration of foreign secrets |

Domain events: `credential.expiring`, `credential.invalid`.
Invariant: no code path returns secret material to the browser; validation happens
server-side.

### 3.5 Access — supporting

| Element | Kind | Notes |
|---------|------|-------|
| `Passkey` | aggregate root | one resident WebAuthn platform credential; counter must increase per assertion (clone detection) |
| `Session` | entity (in-memory) | random token, `HttpOnly` cookie; absent after restart by design |
| `MasterKey` | value object (in-memory) | 32 bytes; at rest only inside the OS keychain |

Invariant: `secrets` port stays **locked** (every call throws `SecretsLockedError`)
until a verified assertion emits `auth.unlocked`.

### 3.6 Notifications — generic

| Element | Kind | Identity | Invariants |
|---------|------|----------|-----------|
| `Notification` | aggregate root | `key` (business identity), `id` (storage) | same `key` upserts — a repeating condition updates one card instead of spamming |

Levels: `info | warning | error`. Lifecycle: `active → read → dismissed`; dismissed
notifications re-activate if the condition fires again (fresh `updated_at`).

## 4. Invariant summary (one line each)

1. Domain package imports nothing.
2. Reports read SQLite, never the GitHub API.
3. Sync is idempotent; facts are immutable observations keyed by their natural key.
4. Money is USD cents-rounded via `roundUsd`; multipliers are temporal (`ModelPrice`).
5. Secrets: keychain or encrypted file only; never SQLite, logs, or browser.
6. Secrets port is locked until WebAuthn unlock.
7. Notifications dedupe by `key`.
8. Services communicate via events and ports, never imports.
9. A Binding is the only coupling between a sheet and a chart.

## 5. Where to read more

- Contracts for the plugin-shaped elements → [PLUGIN.md](PLUGIN.md)
- Storage shape of each aggregate → IMPLEMENTATION_PLAN_DETAILS.md T2.2 (DDL)
- Why each boundary sits where it does → [docs/adr/](docs/adr/README.md) 0004–0007
