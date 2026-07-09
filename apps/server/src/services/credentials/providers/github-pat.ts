// The github-pat reference provider (PLUGIN.md, ADR 0006). Validates via
// GET /user: 401 → invalid, classic scopes from x-oauth-scopes, expiry from
// github-authentication-token-expiration. Fine-grained PATs send no scopes
// header — an empty scope list is NOT invalid (scope gaps become a warning in
// the service, never a hard invalid). The secret only ever rides the auth header.
import type { CredentialProvider } from "../ports";

export function githubPatProvider(fetchImpl: typeof fetch = fetch): CredentialProvider {
  return {
    type: "github-pat",
    describe: () => ({
      type: "github-pat",
      title: "GitHub Personal Access Token",
      helpUrl: "https://github.com/settings/tokens",
      fields: [
        {
          key: "token",
          label: "Personal access token",
          secret: true,
          placeholder: "ghp_… / github_pat_…",
        },
      ],
      requiredScopes: ["read:org", "manage_billing:copilot"],
    }),
    async validate(secret, ctx) {
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
        if (daysLeft <= 7)
          return { state: "expiring", expiresAt: new Date(t).toISOString(), daysLeft };
        return { state: "ok", scopes, expiresAt: new Date(t).toISOString() };
      }
      return { state: "ok", scopes };
    },
  };
}
