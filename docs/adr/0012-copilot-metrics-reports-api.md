# 0012 — Copilot metrics via the usage-metrics reports API

Status: accepted

## Context

IMPLEMENTATION_PLAN_DETAILS T2.5c specified `GET /orgs/{org}/copilot/metrics`
(day × editor × model engagement, `copilot_ide_code_completions.editors[].models[]`).
GitHub sunset that API on 2026-04-02 (changelog 2026-01-29, "Closing down notice
of legacy Copilot metrics APIs"). The replacement is the usage-metrics reports
API: `GET /orgs/{org}/copilot/metrics/reports/organization-1-day?day=…` returns
signed download links to NDJSON files with a different record shape, ~1 year of
history (reports exist since 2025-10-10).

## Decision

- The `copilot-metrics` connector fetches the **organization-1-day** report per
  day in the gap and keeps the dataset's declared columns
  (`day, model, metric, quantity`) — the dataset contract is unchanged; only the
  wire format moved, which is exactly what the connector boundary isolates.
- Field → Metric mapping (UBIQUITOUS.md vocabulary kept):
  `code_generation_activity_count` → `code_suggestions`,
  `code_acceptance_activity_count` → `code_acceptances`,
  `loc_suggested_to_add_sum` → `code_lines_suggested`,
  `loc_added_sum` → `code_lines_accepted`,
  `daily_active_users` → `engaged_users` (org totals, `model` NULL);
  per-model rows come from `totals_by_model_feature[]` summed by model, with
  `user_initiated_interaction_count` → `chats`.
- `GitHubClient` gains `download(url)`: the report links are signed URLs on a
  non-API host, and signed-URL hosts reject requests that also carry an
  `Authorization` header — so downloads deliberately send none. Downloads count
  toward `requestCount()` (they spend the same live-test budget).
- A missing day (404/204) is legitimate — reports only exist since 2025-10 —
  and never fails the sync; the watermark advances over the *requested* range.

## Consequences

- The nightly scheduler (T2.6) still matters: history beyond ~1 year is only in
  our SQLite file.
- Per-user metrics (users-1-day reports) are available upstream but out of v1
  scope; the org aggregate serves the shipped report. Revisit if a per-user
  engagement report is requested.

## Rejected alternatives

- **Implementing the sunset endpoint as specced:** returns 404 in production.
- **users-1-day reports (per-user grain):** richer, but v1 reports need org ×
  model × day only; per-user premium-request spend already comes from the
  billing API (T2.5d).
