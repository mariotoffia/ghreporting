# GH Reporting Lint

## What runs

| Target | Tool | Checks |
|--------|------|--------|
| `make lint` | [Biome](https://biomejs.dev) (`biome check .`) | lint rules (recommended preset) **and** formatting, all workspaces |
| `make lint-fix` | `biome check --write .` | auto-applies safe fixes + formatting |
| `make vet` | `tsc --noEmit` per workspace (`packages/domain`, `apps/server`, `apps/web`) | strict type checking (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) |

One linter+formatter on purpose (ADR
[0011](docs/adr/0011-biome-lint-format.md)): Biome replaces ESLint + Prettier with a
single fast tool and zero plugin config. `tsc` is our "vet" — types are the deepest
linter we have.

## Configuration

- `biome.json` (repo root) — VCS-integrated: respects `.gitignore`, so build output and
  `node_modules` are never checked. Formatter: 2-space indent, 100-col lines, double
  quotes, semicolons.
- `tsconfig.base.json` — shared strict compiler options; each workspace extends it.

## Reading the output

- Biome prints file:line:col plus the rule id, e.g. `lint/suspicious/noDebugger`.
  The rule id is googleable as `https://biomejs.dev/linter/rules/<rule-name>/`.
- `FIXABLE` findings disappear with `make lint-fix`. Run that first, always.
- `tsc` errors reference the workspace's `tsconfig.json`; fix the type, not the config.

## Failure → fix recipes

| Finding | Fix |
|---------|-----|
| Formatting diff | `make lint-fix` |
| `noExplicitAny` | Type the value; if truly unknown, use `unknown` and narrow |
| `noNonNullAssertion` warning | Prefer a narrow check; suppress only with a reasoned `biome-ignore` (see below) |
| `noUncheckedIndexedAccess` (tsc) | Handle the `undefined` arm — this rule exists because usage rows are index-accessed everywhere |
| Import cycle reported by Biome | You probably crossed a layer boundary — re-read ARCHITECTURE.md §2 |

## Escape hatch

```ts
// biome-ignore lint/<group>/<rule>: <why this specific line is fine>
```

The reason is mandatory and reviewed. Repo-wide rule disables go through an ADR, not a
config drive-by.

## Architecture rules (not machine-enforced)

No arch-lint tool is wired in (deliberate — small repo, one team). Reviewers check:

1. `packages/domain` still has zero `dependencies`.
2. No `services/*` file imports from `adapters/*` or a sibling service.
3. Secrets never appear in logs, SQLite, or API responses.

If the repo grows teams, `dependency-cruiser` is the known upgrade path — record it as
an ADR when it happens.

## Verify the linter is alive

After any Biome upgrade or config migration, confirm rules still fire:

```bash
printf 'export function f(){\n  debugger;\n  return 1;\n}\n' > /tmp/probe.ts \
  && bunx biome check /tmp/probe.ts; rm /tmp/probe.ts
```

Expect a `lint/suspicious/noDebugger` error. Silence means the config broke —
`biome migrate` once rewrote `recommended: true` into `preset: "none"` (all rules off)
in this very repo. Trust, but probe.
