# 0018 — GitHub sign-in via OAuth Device Flow

Status: accepted

## Context

Getting a GitHub token into the Secret Store today means a human creates a Personal Access
Token and pastes it (and until E12 there is no UI — it is a raw
`PUT /api/credentials/:id`). We want a "Connect GitHub" sign-in that mints it for the
user. The app ships as a single public binary every user downloads (ADR 0010) and runs on
`localhost` for one user.

Any browser-based OAuth needs the app to identify itself to GitHub. The three grants
differ in what secret they require at the token-exchange step:

- **OAuth App, web (authorization-code) flow** — exchanges the code for a token using a
  client **secret**.
- **GitHub App** — signs a JWT with a **private key**, then mints installation/user
  tokens (user tokens also expire in 8h and need refresh).
- **OAuth App, Device Flow** — the user authorizes out-of-band by typing a short code at
  `github.com/login/device`; the app polls for the token using only its **public**
  `client_id`. No secret, no callback server.

A secret or private key embedded in a downloadable binary is not secret. That rules out
the web flow and the GitHub App for the distributed case.

## Decision

- Add a **`github-oauth`** Credential Provider that obtains a token by **OAuth Device
  Flow** and stores it in the same Secret Store the pasted PAT uses. Only the public
  `client_id` (from `GHR_GITHUB_CLIENT_ID`) is embedded; the maintainer registers one
  OAuth App with **Device Flow enabled**.
- Device capability is a **separate optional port** (`DeviceFlowProvider` with
  `startDevice`/`pollDevice`); `CredentialProvider` is unchanged. A provider implements
  only the ports it needs (interface segregation).
- The `credentials` service exposes two ceremony routes (`/:id/device/start`,
  `/:id/device/poll`) and holds pending device codes in memory only; the `device_code`
  never reaches the browser.
- The one `GitHubClient` reads the first configured of
  `["github-oauth:default", "github-pat:default"]`, so a device-flow token or a pasted PAT
  feeds it interchangeably. PAT entry stays as a supported fallback (air-gapped setups,
  fine-grained tokens, CI).

## Consequences

- Sign-in is "click → type an 8-char code at github.com → done"; no token minting, no
  scope-picking mistakes. Downstream (Secret Store, `tokenProvider`, `GitHubClient`,
  sync) is untouched — the stored value is still just a bearer token.
- OAuth App tokens use **classic scopes** (coarser than a GitHub App's fine-grained
  permissions) and count against the per-user rate limit rather than a higher
  per-installation one. Acceptable for a single-user local tool; revisit only if scale or
  fine-grained org permissions demand a GitHub App (which reintroduces the
  key-distribution problem).
- Org SAML SSO: the resulting token must be SSO-authorized — identical to PATs today.
- A `slow_down`/`expired_token` handshake must be handled in the poll loop.

## Rejected alternatives

- **OAuth web flow** — needs an embedded client secret; unsafe in a distributed binary.
- **GitHub App** — needs an embedded private key + install flow, 8h user tokens with
  refresh; heavy for a single-user localhost tool.
- **Keep PAT-only** — the friction we are removing; retained as a fallback, not the
  primary path.
