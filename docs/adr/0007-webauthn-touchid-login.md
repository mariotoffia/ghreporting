# 0007 — Login via WebAuthn platform authenticator (Touch ID)

Status: accepted

## Context

The requirement: a very simple login that can use the Mac's built-in
password/fingerprint "like some sites do" — and that gates decryption of stored
secrets. "Like some sites do" *is* WebAuthn with a platform authenticator.

## Decision

- One resident **passkey** registered at first run:
  `authenticatorAttachment: "platform"`, `userVerification: "required"`,
  `rpID: "localhost"` — Touch ID (or the macOS password) appears natively in the
  browser prompt. `http://localhost` is a secure context, so no TLS setup.
- Ceremonies via **@simplewebauthn/server** + **@simplewebauthn/browser** (the
  boring, maintained pair). Passkey public key + counter in SQLite `passkeys`.
- A verified assertion creates an in-memory session (`HttpOnly; SameSite=Strict`
  cookie) and **unlocks secrets**: the 32-byte master key is loaded from the OS
  keychain into process memory (`auth.unlocked` event). Sessions die with the process
  — restarting the app means one more Touch ID tap, which is the right trade.
- Off darwin (no keychain), the master key rests in a `0600` file
  `~/.ghreporting/master.key` — the honest portable fallback (same trade-off as the
  encrypted-file secret backend, ADR 0006). Logout/shutdown zeroes the in-memory key.
- Hono middleware rejects all `/api/*` except `/api/health` and `/api/auth/*` until a
  session exists; the `SecretStore` port throws `SecretsLockedError` until unlocked.

## Consequences

- No passwords to store, no password reset flow, no session persistence code.
- Both dev (:5173) and packaged (:8787) origins must be in the WebAuthn allow-list —
  config, not code.
- Recovery path if the passkey is lost: delete `passkeys` rows + keychain entry,
  re-run first-run setup (documented in the auth task). Data is local; worst case is
  re-entering the GitHub token.

## Rejected alternatives

- **Master password prompt:** another secret to remember; strictly worse UX than
  Touch ID on the target platform.
- **WebAuthn PRF extension to derive the encryption key:** elegant (key material never
  at rest) but support is still uneven; the keychain-held master key achieves the goal
  with boring parts. Revisit when PRF is universal.
- **No login at all:** violates the explicit requirement and leaves the encrypted-file
  backend keyless.
