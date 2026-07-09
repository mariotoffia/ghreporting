# ghreporting

Local-first GitHub reporting workbench. It syncs GitHub usage data (Copilot / AI model
spend first) into a local SQLite database, then lets you explore it in Excel-like sheets
with formulas and interactive charts — without hammering the GitHub API.

Built with **Bun + Hono** (backend), **React + Vite + TypeScript** (frontend),
**Univer** (sheets), **Apache ECharts** (charts), **bun:sqlite** (local store).

## Status

Scaffolded and toolchain-verified. Feature implementation is driven task-by-task from
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — the table there tells you what is done
and what is next; [IMPLEMENTATION_PLAN_DETAILS.md](IMPLEMENTATION_PLAN_DETAILS.md) tells
you exactly how to build each task.

## Features (target)

- **Local-first data pipeline** — every query is answered from SQLite; missing or stale
  ranges are synced from GitHub automatically (opt-out per call). GitHub is a sync
  source, not a query backend.
- **Model spend reporting** — premium request usage (AI credits / $) per model, per user,
  per team, aggregated over GitHub's own product / SKU / model hierarchy.
- **Excel-like sheets** — datasets populate Univer spreadsheets; formulas work in-sheet.
- **Interactive charts** — ECharts panels bound to sheet ranges; edits flow sheet → chart,
  selections flow chart → sheet.
- **Credential store** — GitHub tokens live in the macOS Keychain (pluggable backends,
  pluggable credential types), never in the database or the browser.
- **Touch ID login** — WebAuthn platform authenticator gates the app and unlocks secrets.
- **Notifications** — every uService can raise/update/dismiss notifications
  (e.g. "GitHub token expires in 5 days"), pushed live to the UI over SSE.
- **Single-binary packaging** — `bun build --compile` produces one executable with the
  frontend embedded; cross-compiles to macOS/Linux/Windows.

## Quick start

Prerequisites: [bun](https://bun.sh) ≥ 1.3 and `make`.

```bash
make setup       # install dependencies
make serve-all   # backend :8787 + frontend :5173 (Vite proxies /api)
make test        # unit tests
make lint vet    # biome + tsc --noEmit
```

Open http://localhost:5173.

## Documentation

| Document | What it answers |
|----------|-----------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the system is put together: layers, uService kernel, sync pipeline, security model |
| [DDD.md](DDD.md) | Bounded contexts, aggregates, invariants |
| [UBIQUITOUS.md](UBIQUITOUS.md) | The project vocabulary — one meaning per word |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Environment, repo layout, conventions, how to add a uService |
| [TESTS.md](TESTS.md) | Test categories and authoring rules (incl. GitHub API etiquette) |
| [LINT.md](LINT.md) | What `make lint` / `make vet` run and how to fix findings |
| [PLUGIN.md](PLUGIN.md) | Plugin contracts: dataset connectors, secret store backends, credential providers |
| [AGENTS.md](AGENTS.md) | Rules for AI agents working in this repo |
| [docs/adr/](docs/adr/README.md) | Architecture Decision Records — why things are the way they are |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Task table: what to build, in which order, current status |
| [IMPLEMENTATION_PLAN_DETAILS.md](IMPLEMENTATION_PLAN_DETAILS.md) | Per-task spec: files, interfaces, steps, tests, done-criteria |

## Project structure

```
packages/domain/    shared kernel — pure types + pure functions, zero dependencies
apps/server/        Bun + Hono backend: uService kernel, services, adapters
apps/web/           React + Vite frontend: explorer, sheets, charts, login
docs/adr/           architecture decision records
tests/integration/  cross-service and (opt-in) live GitHub tests   [arrives with T11.1]
scripts/            codegen & tooling scripts                      [arrives with T10.1]
```

## Makefile targets

`make help` lists everything. The ones you use daily:

| Target | Purpose |
|--------|---------|
| `setup` | Install dependencies |
| `serve-all` | Backend + frontend dev servers (also: `serve-backend`, `serve-frontend`) |
| `test` / `test-integration` | Unit tests / + live GitHub tests (needs `GH_TOKEN`) |
| `lint` / `lint-fix` / `vet` | Biome check / auto-fix / TypeScript typecheck |
| `build` | Production frontend bundle |
| `package` | Single-binary executable (T10.1) |
| `clean` | Remove deps and build artifacts |

## License

See [LICENSE](LICENSE).
