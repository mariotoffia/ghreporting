import { describe, expect, it } from "bun:test";
import type { ServiceContext } from "../../../kernel/ports";
import { credentialProviderConformance } from "../conformance";
import { githubPatProvider } from "./github-pat";

const SECRET = "ghp_supersecrettoken";
const NOW = new Date("2026-07-09T12:00:00.000Z");

// validate() reads only ctx.config.now(); a minimal double keeps the test honest.
const ctxAt = (now: Date) => ({ config: { now: () => now } }) as unknown as ServiceContext;

/** A fake fetch that answers GET /user with the given status + response headers. */
function fetchUser(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(null, { status, headers })) as unknown as typeof fetch;
}

// The shared plugin-port contract (TESTS.md §5): ok/expiring/invalid mapping + no leak.
credentialProviderConformance("github-pat", (fetchImpl) => githubPatProvider(fetchImpl), {
  now: NOW,
  secret: SECRET,
  ok: fetchUser(200, { "x-oauth-scopes": "read:org" }),
  expiring: fetchUser(200, { "github-authentication-token-expiration": "2026-07-14 00:00:00 UTC" }),
  invalid: fetchUser(401),
});

describe("github-pat provider", () => {
  it("describes the fields and required scopes the UI must collect", () => {
    const meta = githubPatProvider().describe();
    expect(meta.type).toBe("github-pat");
    expect(meta.fields.some((f) => f.key === "token" && f.secret)).toBe(true);
    expect(meta.requiredScopes).toContain("read:org");
  });

  it("reports ok with parsed scopes for a valid classic PAT (no expiry)", async () => {
    const p = githubPatProvider(
      fetchUser(200, { "x-oauth-scopes": "read:org, manage_billing:copilot" }),
    );
    const r = await p.validate(SECRET, ctxAt(NOW));
    expect(r).toEqual({ state: "ok", scopes: ["read:org", "manage_billing:copilot"] });
  });

  it("reports ok with empty scopes for a fine-grained PAT (no x-oauth-scopes header)", async () => {
    const p = githubPatProvider(fetchUser(200, {}));
    const r = await p.validate(SECRET, ctxAt(NOW));
    expect(r).toEqual({ state: "ok", scopes: [] }); // empty scopes is NOT invalid
  });

  it("reports expiring when the token expires within 7 days (daysLeft math vs now)", async () => {
    const p = githubPatProvider(
      fetchUser(200, { "github-authentication-token-expiration": "2026-07-15 12:00:00 UTC" }),
    );
    const r = await p.validate(SECRET, ctxAt(NOW));
    expect(r).toEqual({
      state: "expiring",
      expiresAt: "2026-07-15T12:00:00.000Z",
      daysLeft: 6,
    });
  });

  it("reports ok with expiresAt when the token expires beyond 7 days", async () => {
    const p = githubPatProvider(
      fetchUser(200, {
        "x-oauth-scopes": "read:org",
        "github-authentication-token-expiration": "2027-01-01 00:00:00 UTC",
      }),
    );
    const r = await p.validate(SECRET, ctxAt(NOW));
    expect(r.state).toBe("ok");
    if (r.state === "ok") expect(r.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("reports invalid on a 401", async () => {
    const p = githubPatProvider(fetchUser(401));
    const r = await p.validate(SECRET, ctxAt(NOW));
    expect(r).toEqual({ state: "invalid", reason: "token rejected (401)" });
  });

  it("reports invalid on any other non-ok status", async () => {
    const p = githubPatProvider(fetchUser(503));
    const r = await p.validate(SECRET, ctxAt(NOW));
    expect(r).toEqual({ state: "invalid", reason: "unexpected status 503" });
  });

  it("never leaks the secret into the returned status", async () => {
    for (const status of [200, 401, 503]) {
      const p = githubPatProvider(fetchUser(status, { "x-oauth-scopes": "read:org" }));
      const r = await p.validate(SECRET, ctxAt(NOW));
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });

  it("sends the token as an Authorization header, not in the URL", async () => {
    const seen: { auth: string | null; url: string } = { auth: null, url: "" };
    const spy = (async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.auth = new Headers(init?.headers).get("authorization");
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await githubPatProvider(spy).validate(SECRET, ctxAt(NOW));
    expect(seen.auth).toBe(`token ${SECRET}`);
    expect(seen.url).not.toContain(SECRET);
  });
});
