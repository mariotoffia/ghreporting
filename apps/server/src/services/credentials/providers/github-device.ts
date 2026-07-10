// github-oauth: obtains a GitHub token by OAuth Device Flow (ADR 0018) so the user signs
// in with a short code instead of minting a PAT — no embedded client *secret*, only the
// public client_id from GHR_GITHUB_CLIENT_ID. Implements both CredentialProvider (validate
// reuses the shared GET /user check) and the optional DeviceFlowProvider port. The stored
// value is an ordinary bearer token; everything downstream of the Secret Store is untouched.
import { AppError, ValidationError } from "../../../kernel/errors";
import type { CredentialProvider, DeviceFlowProvider } from "../ports";
import { validateGithubToken } from "./github-validate";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "read:org manage_billing:copilot";

export function githubDeviceProvider(
  fetchImpl: typeof fetch = fetch,
): CredentialProvider & DeviceFlowProvider {
  return {
    type: "github-oauth",
    describe: () => ({
      type: "github-oauth",
      title: "GitHub (sign in with a code)",
      helpUrl: "https://github.com/login/device",
      flow: "device",
      fields: [],
      requiredScopes: ["read:org", "manage_billing:copilot"],
    }),
    validate: (secret, ctx) => validateGithubToken(secret, ctx, fetchImpl),

    async startDevice(ctx) {
      const clientId = ctx.config.githubClientId;
      if (!clientId) {
        throw new AppError(
          "credential.device_unconfigured",
          "GitHub sign-in is not configured — set GHR_GITHUB_CLIENT_ID to a Device-Flow OAuth App client id",
          500,
        );
      }
      const res = await fetchImpl(DEVICE_CODE_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, scope: SCOPE }),
      });
      const j = (await res.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        interval: number;
        expires_in: number;
      };
      return {
        deviceCode: j.device_code,
        userCode: j.user_code,
        verificationUri: j.verification_uri,
        interval: j.interval,
        expiresIn: j.expires_in,
      };
    },

    async pollDevice(deviceCode, ctx) {
      const res = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: ctx.config.githubClientId,
          device_code: deviceCode,
          grant_type: GRANT_TYPE,
        }),
      });
      const j = (await res.json()) as { access_token?: string; error?: string };
      if (j.access_token) return { done: true, secret: j.access_token };
      // ponytail: slow_down is treated like authorization_pending — the caller keeps
      // polling at GitHub's provided interval (already ≥5s), so a rare slow_down is
      // harmless. Surface a distinct back-off only if GitHub starts rejecting the cadence.
      if (j.error === "authorization_pending" || j.error === "slow_down") return { done: false };
      // expired_token / access_denied / unsupported_grant_type — the error CODE only,
      // never any token, so nothing secret leaks into the thrown message.
      throw new ValidationError(j.error ?? "device authorization failed");
    },
  };
}
