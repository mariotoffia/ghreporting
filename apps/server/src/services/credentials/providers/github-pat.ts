// The github-pat reference provider (PLUGIN.md, ADR 0006). A human mints a Personal
// Access Token and pastes it (Settings → fields form, T12.1). Validation is the shared
// GET /user check (see github-validate.ts) — the same one github-oauth's device token
// uses. The secret only ever rides the auth header.
import type { CredentialProvider } from "../ports";
import { validateGithubToken } from "./github-validate";

export function githubPatProvider(fetchImpl: typeof fetch = fetch): CredentialProvider {
  return {
    type: "github-pat",
    describe: () => ({
      type: "github-pat",
      title: "GitHub Personal Access Token",
      helpUrl: "https://github.com/settings/tokens",
      flow: "fields",
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
    validate: (secret, ctx) => validateGithubToken(secret, ctx, fetchImpl),
  };
}
