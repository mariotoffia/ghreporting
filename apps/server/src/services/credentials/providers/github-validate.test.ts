// Direct tests for the shared GET /user check both github-pat and github-oauth delegate to.
// The provider conformance suites cover ok/expiring/invalid at a high level; this pins the
// bits that are easy to get wrong: the "YYYY-MM-DD HH:MM:SS UTC" expiry normalization, the
// 7-day expiring boundary, and non-401 error mapping.
import { describe, expect, it } from "bun:test";
import type { ServiceContext } from "../../../kernel/ports";
import { validateGithubToken } from "./github-validate";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const ctxAt = (now: Date) => ({ config: { now: () => now } }) as unknown as ServiceContext;
const SECRET = "gho_sharedsecret";

function fetchUser(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(null, { status, headers })) as unknown as typeof fetch;
}

describe("validateGithubToken", () => {
  it("parses classic scopes from x-oauth-scopes (no expiry header → ok)", async () => {
    const r = await validateGithubToken(
      SECRET,
      ctxAt(NOW),
      fetchUser(200, { "x-oauth-scopes": "read:org, manage_billing:copilot" }),
    );
    expect(r).toEqual({ state: "ok", scopes: ["read:org", "manage_billing:copilot"] });
  });

  it("normalizes the 'YYYY-MM-DD HH:MM:SS UTC' expiry header and reports expiring within 7 days", async () => {
    const r = await validateGithubToken(
      SECRET,
      ctxAt(NOW),
      fetchUser(200, { "github-authentication-token-expiration": "2026-07-15 12:00:00 UTC" }),
    );
    expect(r).toEqual({ state: "expiring", expiresAt: "2026-07-15T12:00:00.000Z", daysLeft: 6 });
  });

  it("reports ok with expiresAt when expiry is beyond 7 days", async () => {
    const r = await validateGithubToken(
      SECRET,
      ctxAt(NOW),
      fetchUser(200, {
        "x-oauth-scopes": "read:org",
        "github-authentication-token-expiration": "2027-01-01 00:00:00 UTC",
      }),
    );
    expect(r.state).toBe("ok");
    if (r.state === "ok") expect(r.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("maps 401 → invalid and any other non-ok status → invalid, leaking no secret", async () => {
    expect(await validateGithubToken(SECRET, ctxAt(NOW), fetchUser(401))).toEqual({
      state: "invalid",
      reason: "token rejected (401)",
    });
    const r = await validateGithubToken(SECRET, ctxAt(NOW), fetchUser(503));
    expect(r).toEqual({ state: "invalid", reason: "unexpected status 503" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("sends the token in the auth header, never the URL", async () => {
    const seen: { auth: string | null; url: string } = { auth: null, url: "" };
    const spy = (async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.auth = new Headers(init?.headers).get("authorization");
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await validateGithubToken(SECRET, ctxAt(NOW), spy);
    expect(seen.auth).toBe(`token ${SECRET}`);
    expect(seen.url).not.toContain(SECRET);
  });
});
