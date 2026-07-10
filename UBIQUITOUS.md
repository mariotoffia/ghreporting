# GH Reporting — Ubiquitous Language

One meaning per word. Use these terms verbatim in code, tests, commits, and docs —
no synonyms (a `Dataset` is never a "table", "source", or "feed"). Organized by
bounded context ([DDD.md](DDD.md)).

## Shared kernel (`packages/domain`)

| Term | Meaning |
|------|---------|
| **Usage Fact** | One immutable, day-grained observation synced from GitHub: who used what, how much, and what it cost. The atom every report aggregates. |
| **Product Path** | GitHub's billing hierarchy for a fact: `product / sku / model?` (e.g. `copilot / copilot_premium_request / gpt-4.1`). |
| **Metric** | What a fact measures. Shipped names: `premium_requests` (org × model, day), `premium_requests_month` (user × model, month, landed on the month's last day), `usage` (billing-usage $ facts), `code_suggestions`, `code_acceptances`, `code_lines_suggested`, `code_lines_accepted`, `chats`, `engaged_users`. |
| **Multiplier** | Model-specific factor GitHub applies to premium requests (0.33, 1, 10 …). |
| **Included Allowance** | Premium requests covered by the plan before billing starts. |
| **Premium Request** | GitHub's billing unit for Copilot AI model usage — the "AI credit" this tool reports on. |

## Catalog & Sync (`data` uService)

| Term | Meaning |
|------|---------|
| **Dataset** | A named, schema-declared collection of facts the app can serve locally (e.g. `premium-requests`). Listed by the catalog endpoint; the unit of discovery. |
| **Connector** | The plugin that owns one dataset: how to detect gaps, fetch from GitHub, upsert, and select. |
| **Catalog** | The discoverable list of datasets + their schemas + coverage. |
| **Sync** | Filling local gaps from GitHub. Never a live pass-through. |
| **Gap** | A date range (per scope) the local store is missing or that has gone stale. |
| **Watermark** | Per `(dataset, scope)` record of what is already local, with ETag and sync status. |
| **Freshness TTL** | How old local data may be before `coverage()` declares it stale. |
| **Scope** | The sub-stream a watermark tracks — normally the org login. |
| **Coverage** | The answer to "which part of this query can the local store already serve?" |
| **Stale serve** | Answering from local data after a sync failure, flagged `stale: true`. |
| **Snapshot dataset** | A dataset whose local copy is current state replaced wholesale per sync (`org-people`, `copilot-seats`); its coverage is one whole-scope gap when older than the Freshness TTL. |
| **Date-ranged dataset** | A dataset accumulated day by day (`copilot-metrics`, `premium-requests`, `billing-usage`); coverage diffs the query range against the Watermark. |
| **Org Member** | A user belonging to the org (`org_members` set), independent of any team. |
| **Seat** | A current Copilot seat assignment per (org, user) — state, not a Usage Fact. |
| **Report download** | Fetching a usage-metrics report's signed URL without auth headers (`GitHubClient.download`, ADR 0012). |
| **Query Dataset** | A user-authored, read-only Dataset defined by a stored SQL `SELECT` over already-synced facts (ADR 0016). Never syncs (coverage is always empty); runs on the read-only handle. Listed in the Catalog beside built-in Datasets. Not a "view", "custom query", or "saved query". |

## Workspace (`workspace` uService, `sheets`/`charts` features)

| Term | Meaning |
|------|---------|
| **Workbook** | A saved Univer spreadsheet document (snapshot JSON) plus its bindings. |
| **Sheet** | One tab inside a workbook. |
| **Range** | A rectangular cell region, A1-notation (e.g. `Sheet1!A1:D200`). |
| **Binding** | The mediator triple: sheet range ⇄ dataset query ⇄ optional chart spec. The only legal coupling between sheet and chart. |
| **Chart Spec** | Serializable ECharts option template rendered by a ChartHost. |

## Reporting (`reports` uService)

| Term | Meaning |
|------|---------|
| **Report** | A stored, parameterized **Report Definition** that executes into a read-only report view. Not a workbook — it persists no Univer snapshot; the definition is the only source of truth. |
| **Report Definition** | The declarative, portable JSON spec of a Report: its parameters and panels. What the store holds and export/import moves. |
| **Panel** | One unit of a Report's structure: a dataset + parameterized query + optional pivot transform + optional Chart Spec. Renders as a table and/or chart. A Panel is a Binding without a persisted sheet range. |
| **Parameter** | A named Report input (org, date range, filter) with a default, substituted into panel queries at execution. Referenced in a query as `{{name}}`. |
| **Execution** | Compiling a Report Definition + parameter values into a build-plan, then running one data query per panel. Frontend-orchestrated; the server never executes a report. |
| **Export / Import** | Moving a Report Definition in/out of the app as a versioned JSON envelope. |

## Credentials (`credentials` uService)

| Term | Meaning |
|------|---------|
| **Credential** | A stored secret plus metadata (type, backend, status). Identity: `type:label`. |
| **Credential Provider** | Plugin for one credential *type*: how to obtain, validate, and describe it (first: `github-pat`). |
| **Secret Store** | The port services use to read/write secret material. |
| **Backend** | A Secret Store implementation: `keychain` (macOS) or `encrypted-file`. |
| **Account** | The key a secret is stored under inside a backend. |
| **Rotation** | Replacing a credential's secret after an expiring/invalid status. |

## Access (`auth` uService)

| Term | Meaning |
|------|---------|
| **Passkey** | The resident WebAuthn platform credential (Touch ID / macOS password). |
| **Assertion** | A verified WebAuthn login ceremony. |
| **Session** | In-memory server token behind an `HttpOnly` cookie; dies with the process. |
| **Master Key** | 32-byte key at rest in the OS keychain; in memory only while unlocked; encrypts the `encrypted-file` backend. |
| **Unlock** | The `auth.unlocked` transition that makes the Secret Store usable. |

## Notifications (`notifications` uService)

| Term | Meaning |
|------|---------|
| **Notification** | A card telling the human something needs attention. |
| **Key** | Business identity; the same key upserts instead of duplicating. |
| **Level** | `info` / `warning` / `error`. |
| **Notify** | Raise or refresh a card by key (re-fires a dismissed card). |
| **Read** | Human marks a card seen (stamps `read_at`); it stays active. |
| **Dismiss** | Human clears a card (stamps `dismissed_at`); drops from the active list. |
| **Resolve** | System auto-**Dismiss** of a card by key when its condition clears (e.g. a fixed credential). |
| **Stream** | The SSE endpoint pushing changes to the UI live. |

## Kernel & cross-cutting

| Term | Meaning |
|------|---------|
| **uService** | A module implementing `MicroService`, owning its routes under `/api/<name>` and its slice of the schema. |
| **Kernel** | The framework that composes uServices: registry, `ServiceContext`, event bus, SSE hub. |
| **Port** | A TypeScript interface a service depends on; adapters implement it. |
| **Adapter** | Concrete implementation of a port (octokit client, keychain, sqlite). |
| **Composition Root** | The only files that wire concrete adapters to services (`index.ts`, `app.ts`). |
| **AppEvent** | The typed union of everything the bus can carry. |
