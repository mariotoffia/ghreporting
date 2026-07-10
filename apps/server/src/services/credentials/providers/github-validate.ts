// Shared GitHub bearer-token health check (PLUGIN.md §Credential Providers, ADR 0018).
// Both github-pat (pasted token) and github-oauth (device flow) mint the same kind of
// token, so scope/expiry logic lives here once. Validates via GET /user: 401 → invalid,
// classic scopes from x-oauth-scopes, expiry from github-authentication-token-expiration.
// Fine-grained tokens send no scopes header — an empty scope list is NOT invalid (scope
// gaps become a service-level warning, never a hard invalid). The secret only ever rides
// the auth header; it never reaches the returned status.
import type { ServiceContext } from "../../../kernel/ports";
import type { CredentialStatus } from "../ports";

export async function validateGithubToken(
  secret: string,
  ctx: ServiceContext,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialStatus> {
  const res = await fetchImpl("https://api.github.com/user", {
    headers: { authorization: `token ${secret}`, "user-agent": "ghreporting" },
  });
  if (res.status === 401) return { state: "invalid", reason: "token rejected (401)" };
  if (!res.ok) return { state: "invalid", reason: `unexpected status ${res.status}` };
  const scopes = (res.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const exp = res.headers.get("github-authentication-token-expiration");
  if (exp) {
    // header format "YYYY-MM-DD HH:MM:SS UTC" — normalize before parsing
    const t = Date.parse(exp.replace(" UTC", "Z").replace(" ", "T"));
    const daysLeft = Math.floor((t - ctx.config.now().getTime()) / 86_400_000);
    if (daysLeft <= 7) return { state: "expiring", expiresAt: new Date(t).toISOString(), daysLeft };
    return { state: "ok", scopes, expiresAt: new Date(t).toISOString() };
  }
  return { state: "ok", scopes };
}
