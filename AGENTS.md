# ghreporting Agent Rules

Rules for AI agents working in this repository.

## First read

1. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — pick the first unchecked task.
2. [IMPLEMENTATION_PLAN_DETAILS.md](IMPLEMENTATION_PLAN_DETAILS.md) — the spec for that task.
3. The documents that task's **Refs** line points to.

## MUST: Where to look — task → doc

| Task touches… | Read first |
|---------------|-----------|
| Layering, kernel, sync pipeline, security | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Domain types, invariants, context boundaries | [DDD.md](DDD.md) |
| Naming anything | [UBIQUITOUS.md](UBIQUITOUS.md) — use these words, no synonyms |
| Connectors, secret backends, credential types | [PLUGIN.md](PLUGIN.md) |
| Writing any test | [TESTS.md](TESTS.md) |
| Lint/typecheck failures | [LINT.md](LINT.md) |
| A past decision you want to revisit | [docs/adr/](docs/adr/README.md) — add a new ADR, don't silently diverge |

## Hard Rules

- Implementation work is driven by IMPLEMENTATION_PLAN.md → IMPLEMENTATION_PLAN_DETAILS.md.
  Never invent scope; if a task is unclear, the details file wins, then ARCHITECTURE.md.
- `make lint && make vet && make test` must be green before claiming any task done.
- Use the vocabulary from UBIQUITOUS.md verbatim in code, tests, and docs.
- Code files ≤ 500 lines; docs ≤ 600 lines (IMPLEMENTATION_PLAN\*.md are exempt);
  `packages/domain` has zero dependencies.
- Secrets: only via the SecretStore port. Never log, persist, or ship them to the browser.

## Conventions not enforced by lint

- Code files ≤ 500 lines, documentation files ≤ 600 lines — except the two
  IMPLEMENTATION_PLAN files, which grow as needed. Split before you exceed.
- Dependency rule: `packages/domain` imports nothing; services import ports, not adapters;
  only composition roots (`apps/server/src/index.ts`, `app.ts`) know concrete adapters.
- Interfaces stay small. A plugin implements only the port it needs.
- Secrets never touch SQLite, logs, or the browser. See ARCHITECTURE.md §6.
- New dependency? Climb the ladder first: existing code → Bun/Web stdlib → already-installed
  dep → then propose. Record non-obvious choices as an ADR.
- Manually compiled test binaries get a `.out` suffix (gitignored).

## How to know you're done

```bash
make lint && make vet && make test
```

All three green, plus the task's own **Done when** line in
IMPLEMENTATION_PLAN_DETAILS.md. Then tick the task's checkbox in
IMPLEMENTATION_PLAN.md (change ⬜ to ✅) in the same commit.

## Adding a new uService

Checklist in [DEVELOPMENT.md](DEVELOPMENT.md#adding-a-new-uservice). Short version:
implement `MicroService`, register it in the composition root, route prefix
`/api/<name>`, one `*.test.ts` beside every non-trivial file.
