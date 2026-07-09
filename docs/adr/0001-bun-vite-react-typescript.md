# 0001 — Bun runtime, Vite + React + TypeScript frontend

Status: accepted

## Context

A local-first reporting website needs a backend runtime, a frontend stack, and glue
tooling (package manager, test runner, bundler). The fewer moving parts, the easier it
is for one developer to own the whole thing.

## Decision

- **Bun** is runtime, package manager, workspace manager, and test runner. One tool
  install; `bun:sqlite`, `bun test`, and `bun build --compile` remove three would-be
  dependencies (better-sqlite3, jest/vitest, pkg/electron).
- **React 19 + TypeScript** for the UI — the component ecosystem we depend on
  (Univer, ECharts integrations) is React-first, and strict TS is our deepest linter.
- **Vite** builds and serves the frontend. Bun *can* serve HTML directly, but Vite's
  dev server (HMR, `/api` proxy) and plugin ecosystem are the stable, boring choice for
  a React SPA; Bun's fullstack server is younger and adds nothing we need. Dev runs
  Vite :5173 → proxy → Bun :8787; production embeds `vite build` output in the binary.

## Consequences

- One `bun install` bootstraps everything; no Node/npm required.
- Frontend tests run under `bun test` too (`renderToString` smoke tests) — a single
  test runner across the repo.
- We accept coupling to Bun-specific APIs (`bun:sqlite`, `Bun.serve`, compile) in
  `apps/server`; `packages/domain` stays runtime-neutral, so a future runtime move
  would touch adapters only.

## Rejected alternatives

- **Node + Express + esbuild/webpack:** more tools, no benefit for a local app.
- **Bun-only fullstack (no Vite):** fewer parts but weaker React DX and a younger HTML
  pipeline; revisit if Vite ever becomes the bottleneck.
- **Electron/Tauri app shell:** heavyweight; a browser tab against a local server does
  the job (see ADR 0010 for packaging).
