# 0003 — SQLite via `bun:sqlite`, numbered SQL migrations

Status: accepted

## Context

The whole point of the app (ADR 0005) is a local store that outlives GitHub's short
metric retention windows and absorbs repeated report queries. Single user, one machine,
relational aggregation queries, needs to ship inside a single binary.

## Decision

- **SQLite through `bun:sqlite`** — synchronous, in-runtime, zero dependencies, WAL
  mode. One database file: `~/.ghreporting/ghreporting.db` (`GHR_DB_PATH` override;
  tests use `:memory:`).
- **Migrations are numbered `.sql` files** (`adapters/db/migrations/0001_init.sql`, …)
  applied by a ~40-line runner tracking `schema_migrations`. No ORM: the reporting
  queries *are* SQL (views, GROUP BY over facts); an ORM would hide the part we care
  about most.
- Aggregations ship as SQL views, versioned in migrations like tables.

## Consequences

- Report queries are plain SQL — easy to inspect with any sqlite CLI, easy to bench.
- Synchronous `bun:sqlite` calls are fine at our scale (100k-row facts, sub-ms reads)
  and keep service code free of accidental await-ordering bugs.
- We own schema evolution discipline: additive migrations only; destructive changes
  require an ADR.

## Rejected alternatives

- **Drizzle/Prisma:** type-safe query builders are nice, but the schema is small, the
  queries are analytical SQL, and every dependency must earn its place.
- **DuckDB:** better for huge analytics; our facts volume is tiny and SQLite is in the
  runtime already.
- **Postgres:** a server dependency in a single-binary desktop tool — no.
