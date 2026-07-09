# 0011 — Biome for lint + format; `tsc --noEmit` as vet

Status: accepted

## Context

The repo needs linting, formatting, and deep static checking with minimal tool sprawl
across three workspaces.

## Decision

- **Biome** (`biome check`) is both linter (recommended preset) and formatter — one
  binary, one config (`biome.json`), VCS-aware so `.gitignore` is the ignore file.
  `make lint` checks; `make lint-fix` writes.
- **`tsc --noEmit` per workspace is our "vet"** (`make vet`): strict mode plus
  `noUncheckedIndexedAccess` and `verbatimModuleSyntax` — the type checker is the
  deepest linter we have, so it runs as its own target and in the done-criteria.
- Rule suppressions require a reasoned `biome-ignore` comment; repo-wide disables
  require an ADR.

## Consequences

- No ESLint/Prettier plugin stack to keep coherent; lint runs in milliseconds, so
  nobody skips it.
- Biome's recommended set is narrower than a tuned ESLint config — accepted; `tsc`
  strictness carries the correctness load.
- Config migrations are a known hazard: `biome migrate` once rewrote the config to
  `preset: "none"` (all rules silently off). LINT.md ships a probe recipe; run it
  after every Biome upgrade.

## Rejected alternatives

- **ESLint + Prettier (+ typescript-eslint):** the capable incumbent, but 5+ packages
  and config layering for a solo repo Biome covers in one.
- **oxlint:** fast linter, but no formatter and a younger rule set — would still need
  a second tool.
