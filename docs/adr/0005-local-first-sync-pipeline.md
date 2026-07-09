# 0005 — Local-first sync pipeline with watermarks and ETags

Status: accepted

## Context

Reporting means many repeated, exploratory queries. GitHub's REST API is rate-limited
(5 000 req/h) and some sources (Copilot metrics) retain only ~28 days of history.
Querying GitHub per report is both rude and lossy.

## Decision

Every read goes through the `data` service: **answer from SQLite; sync only the gaps
first** (opt-out per call with `{sync: false}`).

- Each dataset is a `DatasetConnector` plugin (PLUGIN.md) declaring schema, gap
  detection (`coverage`), remote fetch, idempotent upsert, and local select.
- `sync_state(dataset, scope)` watermarks record local coverage + last ETag + a
  per-dataset freshness TTL — staleness is a gap like any other.
- The GitHub adapter sends conditional requests (304s are quota-free), uses octokit's
  throttling/retry plugins, and honors `Retry-After`.
- A background scheduler refreshes short-retention datasets daily so the local DB
  accumulates history GitHub itself discards.
- On sync failure with partial local coverage: serve stale (`stale: true`) + raise a
  notification, instead of failing the report.

## Consequences

- Reports are fast and repeatable offline; GitHub sees a bounded, polite request
  pattern.
- The local DB becomes the *only* long-term record of model usage — backups matter
  (documented in README once packaging lands).
- Connectors carry natural-key discipline (DDD.md §3.2) so re-sync is idempotent.
- Status note (E2): `sync_state.etag` and the client's If-None-Match support exist,
  but no connector persists/replays ETags yet — snapshot datasets re-fetch whole
  scopes each TTL. Wire it when request volume warrants (tracked for T11.x).

## Rejected alternatives

- **Live pass-through with an in-memory cache:** loses history, dies on rate limits,
  caches can't answer "last 12 months".
- **Full-mirror sync (cron everything always):** wasteful for datasets nobody queries;
  gap-driven sync fetches only what reports actually touch, plus the scheduled
  short-retention set.
