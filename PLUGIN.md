# Plugin Guide

Three extension points, all "ports-first": you implement a small interface, register it
in a registry, and prove it with the shared conformance suite ([TESTS.md](TESTS.md) §5).
Interfaces here are the canonical signatures — implementation tasks copy them verbatim.

| Plugin | Port | Registry | Reference implementations |
|--------|------|----------|---------------------------|
| Dataset connector | `DatasetConnector` | `data` service | `premium-requests`, `copilot-metrics`, `copilot-seats`, `billing-usage`, `org-people` |
| Secret store backend | `SecretStoreBackend` | `credentials` service | `keychain` (macOS), `encrypted-file` |
| Credential provider | `CredentialProvider` | `credentials` service | `github-pat` |

## Dataset Connectors

A connector owns one dataset end-to-end: schema, gap detection, remote fetch, local
storage, local query. File: `apps/server/src/services/data/connectors/<id>.ts`.

```ts
// apps/server/src/services/data/ports.ts
export interface ColumnMeta {
  name: string;                       // snake_case, matches the SQL column it selects
  type: "string" | "number" | "date";
  description: string;
}

export interface DatasetMeta {
  id: string;                         // kebab-case, e.g. "premium-requests"
  title: string;
  description: string;                // shown in the explorer — write for humans
  columns: ColumnMeta[];              // declared schema; select() must return exactly this
  scope: "org" | "org-user";          // does the grain include a user dimension?
  freshnessTtlHours: number;          // how old local data may be before it counts as a gap
}

export interface DatasetQuery {
  org: string;
  range: { from: string; to: string };            // inclusive ISO dates YYYY-MM-DD
  filter?: Record<string, string | string[]>;     // column -> equals / IN
}

export interface Gap { scope: string; from: string; to: string }

export interface ResultSet {
  columns: ColumnMeta[];
  rows: unknown[][];                  // row-major, column order = columns
  stale?: boolean;                    // served locally after a failed sync
}

export interface DatasetConnector {
  readonly meta: DatasetMeta;
  /** Which parts of q are missing/stale locally? Pure read of db + sync_state. */
  coverage(db: Database, q: DatasetQuery): Gap[];
  /** Stream remote rows for one gap. Must use gh's etagged, throttled request(). */
  fetch(gap: Gap, gh: GitHubClient, ctx: ServiceContext): AsyncIterable<Record<string, unknown>[]>;
  /** Idempotent upsert on the dataset's natural key. One transaction per batch. */
  upsert(db: Database, rows: Record<string, unknown>[]): void;
  /** Answer q from SQLite only. Never calls the network. */
  select(db: Database, q: DatasetQuery): ResultSet;
}
```

Registration (in the data service):

```ts
// apps/server/src/services/data/service.ts
const connectors = new Map<string, DatasetConnector>();
export function registerConnector(c: DatasetConnector): void {
  if (connectors.has(c.meta.id)) throw new AppError("connector.duplicate", c.meta.id);
  connectors.set(c.meta.id, c);
}
```

Rules:

1. `fetch` never writes; `upsert` never fetches; `select` never syncs. The sync engine
   (`sync.ts`) is the only orchestrator.
2. Natural keys make re-sync idempotent — see DDD.md §3.2 invariant 3.
3. Keep the connector's SQL in the connector file. Shared tables (`orgs`, `users`,
   `skus`) are written through small helpers in `adapters/db/dims.ts` so dimension rows
   stay consistent.
4. Conformance: `datasetConnectorConformance(id, factory, fixtureRows)` asserts
   coverage→fetch→upsert→select round-trips, idempotent double-upsert, and that
   `select` matches `meta.columns`.

## Secret Store Backends

File: `apps/server/src/adapters/secretstore/<id>.ts`.

```ts
// apps/server/src/kernel/ports.ts
export interface SecretStoreBackend {
  readonly id: string;                          // "keychain" | "encrypted-file" | …
  /** Can this backend work here? (platform, binary present, dir writable) */
  available(): Promise<boolean>;
  get(account: string): Promise<string | null>; // null = not found (not an error)
  set(account: string, secret: string): Promise<void>;   // overwrite allowed
  delete(account: string): Promise<void>;       // idempotent
}
```

Notes:

- No `list()` on purpose — enumeration of which accounts exist lives in
  `credentials_meta` (SQLite metadata), so backends stay minimal and we never scan a
  user's whole keychain.
- The service picks the backend: `GHR_SECRET_BACKEND` override → first `available()`
  in priority order (`keychain`, then `encrypted-file`).
- `keychain` shells out to `security add/find/delete-generic-password` with service
  name `ghreporting` (ADR 0006 records the argv-exposure trade-off and upgrade path).
- `encrypted-file` stores `{account: {iv, ciphertext}}` (AES-256-GCM, WebCrypto) in
  `~/.ghreporting/secrets.enc.json`, keyed by the in-memory master key; throws
  `SecretsLockedError` while locked.
- Conformance: `secretStoreConformance(name, factory)` — round-trip, missing→null,
  idempotent delete, overwrite. Keychain runs it only under `RUN_KEYCHAIN=1` on darwin.

## Credential Providers

A provider understands one credential *type* — how to describe it to the UI, and how to
validate it server-side. File: `apps/server/src/services/credentials/providers/<type>.ts`.

```ts
// apps/server/src/services/credentials/ports.ts
export interface CredentialFieldSpec {
  key: string; label: string; secret: boolean; placeholder?: string;
}

export interface CredentialTypeMeta {
  type: string;                        // "github-pat"
  title: string;                       // "GitHub Personal Access Token"
  helpUrl: string;                     // where a human creates one
  fields: CredentialFieldSpec[];       // what the UI must collect
  requiredScopes: string[];            // documented, also checked by validate()
}

export type CredentialStatus =
  | { state: "ok"; scopes?: string[]; expiresAt?: string }
  | { state: "expiring"; expiresAt: string; daysLeft: number }
  | { state: "invalid"; reason: string };

export interface CredentialProvider {
  readonly type: string;
  describe(): CredentialTypeMeta;
  /** Server-side check against the real API. Cheap; called at save + every 6h. */
  validate(secret: string, ctx: ServiceContext): Promise<CredentialStatus>;
}
```

The `github-pat` reference: validates via `GET /user` (+ `GET /rate_limit` sanity),
reads classic scopes from the `x-oauth-scopes` response header and expiry from
`github-authentication-token-expiration`; `expiring` when < 7 days remain. On
`expiring`/`invalid` the credentials service emits the matching `AppEvent` and a
notification with key `credential.<id>.<state>` — this is the "please rotate your
token" flow.

Conformance: `credentialProviderConformance(type, factory, fakeFetchScenarios)` —
ok/expiring/invalid mapping, no secret material in thrown errors or logs.

## Module conventions (all plugin kinds)

- One plugin per file, file name = plugin id.
- A plugin imports domain, its port file, and adapters' *ports* — never a service.
- Registration happens in the composition root or the owning service's `init` — a
  plugin file has no import-time side effects (keeps tests able to import it bare).
- New plugin ⇒ new row in this file's tables ⇒ conformance suite green ⇒ vocabulary
  additions to UBIQUITOUS.md if any.
