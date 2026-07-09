# GH Reporting — Ubiquitous Language

One meaning per word. Use these terms verbatim in code, tests, commits, and docs —
no synonyms (a `Dataset` is never a "table", "source", or "feed"). Organized by
bounded context ([DDD.md](DDD.md)).

## Shared kernel (`packages/domain`)

| Term | Meaning |
|------|---------|
| **Usage Fact** | One immutable, day-grained observation synced from GitHub: who used what, how much, and what it cost. The atom every report aggregates. |
| **Product Path** | GitHub's billing hierarchy for a fact: `product / sku / model?` (e.g. `copilot / copilot_premium_request / gpt-4.1`). |
| **Metric** | What a fact measures: `premium_requests`, `code_suggestions`, `seats`, … |
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

## Workspace (`workspace` uService, `sheets`/`charts` features)

| Term | Meaning |
|------|---------|
| **Workbook** | A saved Univer spreadsheet document (snapshot JSON) plus its bindings. |
| **Sheet** | One tab inside a workbook. |
| **Range** | A rectangular cell region, A1-notation (e.g. `Sheet1!A1:D200`). |
| **Binding** | The mediator triple: sheet range ⇄ dataset query ⇄ optional chart spec. The only legal coupling between sheet and chart. |
| **Chart Spec** | Serializable ECharts option template rendered by a ChartHost. |
| **Report** | A workbook template shipped with the app (first: Copilot spend per model/user). |

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
