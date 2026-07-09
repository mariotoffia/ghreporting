# Test Authoring Rules

All tests run with `bun test` (Jest-compatible API, built into the runtime — no test
framework dependency). Playwright drives the only browser tests.

## 1. Three categories

| Category | Lives | Network | Runs in |
|----------|-------|---------|---------|
| Unit | `*.test.ts` beside the code | never | `make test` |
| Integration | `tests/integration/**` | GitHub **only** when opted in | `make test` (replay) / `make test-integration` (live) |
| E2E smoke | `tests/e2e/**` (Playwright) | localhost only | `make test-e2e` (T11.3) |

### Decision tree

Testing one module's logic → unit. Testing services/adapters composed together (sync
pipeline against a real SQLite file, kernel lifecycle) → integration. Testing "a human
can log in and see a sheet" → e2e smoke, and keep it to a handful.

## 2. Anti-flake rules (every category)

1. **No sleeps.** Await promises, use fake timers, or assert on events. A `sleep(50)`
   in a test is a review reject.
2. **Time is injected.** Logic reads `ctx.config.now()`, tests pass a fixed clock.
   `new Date()` inside domain/service logic is a bug.
3. **No shared state between tests.** Every DB test opens its own
   `new Database(":memory:")` and runs migrations in `beforeEach` — migrations are fast
   enough (< 5 ms) that sharing is pure risk.
4. **Determinism over realism.** Fixtures are checked-in JSON, not recorded live during
   the run.
5. **Cleanup is ordered.** `afterEach` closes DBs and aborts SSE clients; a leaked
   handle fails the suite under `bun test` timeouts, which is the point.

## 3. GitHub API tests — be fair to the rate limit

The GitHub REST API is throttled (5 000 req/h per token) and shared with your real
usage. Integration tests therefore run in two modes:

- **Replay (default, CI-safe):** connectors are tested against checked-in fixture JSON
  served by an injected `fetch` fake. `make test` never touches the network. Fixtures
  live in `tests/fixtures/github/<dataset>/*.json` and are refreshed by
  `scripts/record-fixtures.ts` (T11.1) — run manually, rarely.
- **Live (opt-in):** `make test-integration` with `RUN_GH_LIVE=1` and `GH_TOKEN` set.
  Guard in code:

  ```ts
  import { describe } from "bun:test";
  const live = process.env.RUN_GH_LIVE === "1" && !!process.env.GH_TOKEN;
  describe.skipIf(!live)("premium-requests connector (live)", () => { /* … */ });
  ```

Live-test etiquette (MUST):

1. Read-only endpoints only. Live tests never mutate anything on GitHub.
2. Conditional requests (ETag) wherever repeatable — 304s don't consume quota.
3. Small windows: request the minimum date range / `per_page` that proves the contract.
4. Budget: a full live run stays under **50 requests**. Add a counting assertion to the
   shared live client so exceeding the budget fails loudly.
5. Respect `Retry-After` (the throttled octokit client from the app is reused in tests —
   same etiquette, same code path).

## 4. Unit tests

- Name by behavior: `it("bills only the overage at the default price")`, not
  `it("works")`.
- One logical assertion cluster per `it`. Table-driven loops are fine; hide no logic in
  helpers that themselves need tests.
- SQLite in unit tests is allowed (in-memory) — it *is* our stdlib storage; faking SQL
  with maps tests the fake.
- Forbidden: network, real keychain, real timers, `~/.ghreporting`, ordering
  dependencies between `it`s.
- The macOS Keychain backend is exercised by a **manually run** conformance test
  (`describe.skipIf(process.platform !== "darwin" || !process.env.RUN_KEYCHAIN)`) so CI
  and teammates without macOS stay green.

## 5. Conformance suites (plugin contracts)

Every plugin port ships a reusable conformance suite (see PLUGIN.md): a function taking
a factory and running the same behavioral assertions against every implementation.

```ts
export function secretStoreConformance(name: string, make: () => Promise<SecretStoreBackend>) {
  describe(`SecretStoreBackend conformance: ${name}`, () => {
    it("round-trips a secret", async () => { /* … */ });
    it("returns null for a missing account", async () => { /* … */ });
    it("deletes idempotently", async () => { /* … */ });
    it("overwrites on set to an existing account", async () => { /* … */ });
  });
}
```

A new backend/connector/provider is done when the conformance suite passes — not when
its author's hand-picked tests pass.

## 6. Benchmarks

`make bench` (T11.2) runs [mitata](https://github.com/evanwashere/mitata) benches in
`bench/*.bench.ts`: fact upsert throughput (10k rows), report query latency on a
representative DB (~100k facts), and the premium-cost math. Benchmarks reuse the same
fixture generators as integration tests — no separate data path.

## 7. Coverage

`bun test --coverage` when you want it; no enforced threshold. The enforced bar is
behavioral: every plan task lists the tests it must ship, and conformance suites gate
plugins.
