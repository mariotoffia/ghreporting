# 0006 — Pluggable credential store; macOS Keychain first

Status: accepted

## Context

GitHub tokens must be stored so the app can use them automatically after login, but a
plaintext token on disk (or in SQLite) is the classic local-tool failure. Different
platforms have different secure stores, and different credential *types* (PAT now,
maybe GitHub App later) have different validation/rotation logic.

## Decision

Two orthogonal plugin ports (full contracts in PLUGIN.md):

- **`SecretStoreBackend`** — where secret bytes rest. First: `keychain`
  (macOS, shelling out to `security add/find/delete-generic-password`, service name
  `ghreporting`); fallback: `encrypted-file` (AES-256-GCM via WebCrypto, keyed by the
  master key from ADR 0007) for Linux/Windows/CI. Selection: `GHR_SECRET_BACKEND`
  override, else first `available()`.
- **`CredentialProvider`** — what a credential *is*: describes the fields the UI
  collects, validates server-side, reports `ok/expiring/invalid`. First:
  `github-pat`. Status changes emit events → notifications ("rotate your token").

Metadata (which credentials exist, status, expiry) lives in SQLite
`credentials_meta`; secret material never does.

## Consequences

- The `security` CLI passes secrets via argv, briefly visible in `ps` — accepted for a
  single-user desktop tool. Upgrade path if that stops being acceptable: FFI to
  Security.framework (no new process). Recorded here so nobody re-litigates it in
  review.
- No keychain enumeration: we only touch accounts we created (tracked in
  `credentials_meta`).
- Adding Windows Credential Manager / libsecret later = one new backend file + the
  conformance suite.

## Rejected alternatives

- **keytar / node-keytar:** unmaintained native module; poor fit for Bun.
- **Encrypt everything into SQLite:** couples secrets to DB backups and violates
  "secrets never in the DB" (DDD invariant 5).
- **Plain dotfile token (gh CLI style):** gh gets away with it by mandate; we can do
  better with the OS keychain at near-zero cost.
