# Development Guide

## Prerequisites

- [bun](https://bun.sh) ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`)
- `make` (ships with macOS command line tools)
- macOS for the full experience (Keychain backend, Touch ID login). The code runs on
  Linux/Windows with the `encrypted-file` backend instead.

No global npm/node install is needed — bun is runtime, package manager, test runner,
and bundler-compiler in one.

## Getting started

```bash
make setup        # bun install across all workspaces
make serve-all    # backend :8787 + frontend :5173 (Ctrl-C stops both)
make test         # bun test — unit tests, fast, no network
make lint vet     # biome check + tsc --noEmit per workspace
```

`make help` lists every target with a one-liner.

## Repository structure

```
packages/domain/          shared kernel — pure types + functions, zero dependencies
apps/server/src/
  kernel/                 uService kernel: ports.ts, registry.ts, bus.ts, sse.ts,
                          config.ts, logger.ts
  adapters/               db/ (sqlite + migrations) · github/ (octokit) ·
                          secretstore/ (keychain, encrypted file)
  services/               data/ · credentials/ · auth/ · notifications/ · workspace/
  app.ts, index.ts        composition root
apps/web/src/
  lib/                    api.ts, sse.ts
  state/                  bindings.ts (zustand)
  features/               login/ · notifications/ · explorer/ · sheets/ · charts/
tests/integration/        cross-service + opt-in live GitHub tests   [T11.1]
scripts/                  gen-embed.ts, record-fixtures.ts           [T10.1, T11.1]
docs/adr/                 decision records
```

Directories marked `[T…]` arrive with that task in IMPLEMENTATION_PLAN.md.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8787` | API server port |
| `GHR_DB_PATH` | `~/.ghreporting/ghreporting.db` | SQLite location (tests use `:memory:`) |
| `GHR_ORG` | — | Default GitHub org for the explorer; the background scheduler needs it as its sync scope |
| `GHR_SCHEDULER` | off in dev (`1` enables; packaged builds are always on) | Background refresh of short-retention datasets — no-op without `GHR_ORG` |
| `GHR_SECRET_BACKEND` | `keychain` on darwin, else `encrypted-file` | Secret store backend id |
| `RUN_GH_LIVE` | unset | Set to `1` to run live GitHub integration tests |
| `GH_TOKEN` | — | Token used **only** by live integration tests |

## Code conventions

- **File length:** code ≤ 500 lines, docs ≤ 600 lines (the two IMPLEMENTATION_PLAN
  files are exempt — they grow with the backlog). Check with `wc -l`; split before you
  exceed. Splitting rule: by responsibility, not by size alone.
- **Interfaces are small.** A plugin implements only the port it needs — see the
  deliberately narrow ports in [PLUGIN.md](PLUGIN.md).
- **Dependency rule** (ARCHITECTURE.md §2): services import ports, adapters implement
  them, only composition roots connect the two. `packages/domain` imports nothing.
- **Naming** comes from [UBIQUITOUS.md](UBIQUITOUS.md) — verbatim, no synonyms.
- **Errors:** throw typed errors extending `AppError` (kernel) with a stable `code`
  string; Hono's `onError` maps them to JSON `{ error: { code, message } }`. Never
  throw strings; never swallow errors without a notification or log line.
- **Time and randomness are injected** where logic depends on them (`ctx.config.now()`
  in services) so tests stay deterministic — see [TESTS.md](TESTS.md).
- **New dependencies** climb the ladder: existing code → Bun/Web stdlib → an
  already-installed dep → only then something new, recorded in an ADR if load-bearing.
- **Compiled scratch binaries** get a `.out` suffix (gitignored). Real builds land in
  `dist/` (also gitignored).

## Adding a new uService

1. Create `apps/server/src/services/<name>/service.ts` exporting a `MicroService`
   (copy signatures from `kernel/ports.ts`; contract in ARCHITECTURE.md §3).
2. Own your schema: add a numbered migration under `apps/server/src/adapters/db/migrations/`.
3. Mount routes under `/api/<name>` via `routes(app, ctx)`.
4. Communicate with other services **only** through `ctx.bus` events or ports —
   extend the `AppEvent` union, never import a sibling service.
5. Register it in `apps/server/src/index.ts` in dependency order.
6. Tests beside the code (`service.test.ts`, in-memory DB). Rules: [TESTS.md](TESTS.md).
7. New vocabulary? Add it to [UBIQUITOUS.md](UBIQUITOUS.md) in the same PR.

## Adding a plugin (connector / backend / provider)

Follow the matching contract + conformance suite in [PLUGIN.md](PLUGIN.md).

## Definition of done

```bash
make lint && make vet && make test
```

green, the task's **Done when** criterion in IMPLEMENTATION_PLAN_DETAILS.md holds, and
the row in IMPLEMENTATION_PLAN.md is ticked in the same commit.

## Commits

Imperative subject, ≤ 72 chars, body says *why*. One task (or one coherent step of a
task) per commit — the plan's steps are sized to be committable.
