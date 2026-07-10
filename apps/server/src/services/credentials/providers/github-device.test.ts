import { describe, expect, it } from "bun:test";
import type { ServiceContext } from "../../../kernel/ports";
import { credentialProviderConformance } from "../conformance";
import { githubDeviceProvider } from "./github-device";

const SECRET = "gho_devicesecrettoken";
const CLIENT_ID = "Iv1.testclientid";
const NOW = new Date("2026-07-09T12:00:00.000Z");

const ctxAt = (now: Date, githubClientId?: string) =>
  ({ config: { now: () => now, githubClientId } }) as unknown as ServiceContext;

/** A fake fetch that answers GET /user (validate) with the given status + headers. */
function fetchUser(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(null, { status, headers })) as unknown as typeof fetch;
}

/** A fake fetch answering the device-code and token endpoints with scripted JSON bodies. */
function fetchDevice(bodies: { code?: unknown; token?: unknown[] }): typeof fetch {
  let tokenCall = 0;
  return (async (url: string) => {
    if (url.includes("/login/device/code")) {
      return Response.json(bodies.code ?? {});
    }
    const body = bodies.token?.[tokenCall++] ?? {};
    return Response.json(body);
  }) as unknown as typeof fetch;
}

// The device provider validates a token exactly like github-pat (shared GET /user check).
credentialProviderConformance("github-oauth", (fetchImpl) => githubDeviceProvider(fetchImpl), {
  now: NOW,
  secret: SECRET,
  ok: fetchUser(200, { "x-oauth-scopes": "read:org" }),
  expiring: fetchUser(200, { "github-authentication-token-expiration": "2026-07-14 00:00:00 UTC" }),
  invalid: fetchUser(401),
});

describe("github-device provider — describe", () => {
  it("declares the device flow with no typed fields", () => {
    const meta = githubDeviceProvider().describe();
    expect(meta.type).toBe("github-oauth");
    expect(meta.flow).toBe("device");
    expect(meta.fields).toEqual([]);
    expect(meta.helpUrl).toBe("https://github.com/login/device");
  });
});

describe("github-device provider — startDevice", () => {
  it("maps the device-code response and returns the deviceCode for server use", async () => {
    const p = githubDeviceProvider(
      fetchDevice({
        code: {
          device_code: "DEVICECODE123",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        },
      }),
    );
    const r = await p.startDevice(ctxAt(NOW, CLIENT_ID));
    expect(r).toEqual({
      deviceCode: "DEVICECODE123",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 900,
    });
  });

  it("throws credential.device_unconfigured (naming the env var) when no client id is set", async () => {
    const p = githubDeviceProvider(fetchDevice({}));
    await expect(p.startDevice(ctxAt(NOW))).rejects.toMatchObject({
      code: "credential.device_unconfigured",
      status: 500,
    });
    await expect(p.startDevice(ctxAt(NOW))).rejects.toThrow(/GHR_GITHUB_CLIENT_ID/);
  });
});

describe("github-device provider — pollDevice", () => {
  it("returns { done:false } while authorization is pending, then { done:true, secret }", async () => {
    const p = githubDeviceProvider(
      fetchDevice({ token: [{ error: "authorization_pending" }, { access_token: SECRET }] }),
    );
    expect(await p.pollDevice("DC", ctxAt(NOW, CLIENT_ID))).toEqual({ done: false });
    expect(await p.pollDevice("DC", ctxAt(NOW, CLIENT_ID))).toEqual({ done: true, secret: SECRET });
  });

  it("treats slow_down as pending (no back-off surfaced through the port)", async () => {
    const p = githubDeviceProvider(fetchDevice({ token: [{ error: "slow_down" }] }));
    expect(await p.pollDevice("DC", ctxAt(NOW, CLIENT_ID))).toEqual({ done: false });
  });

  it("throws on expired_token / access_denied and leaks no token in the message", async () => {
    for (const error of ["expired_token", "access_denied", "unsupported_grant_type"]) {
      const p = githubDeviceProvider(fetchDevice({ token: [{ error }] }));
      const err = await p.pollDevice("DC", ctxAt(NOW, CLIENT_ID)).catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(error);
      expect((err as Error).message).not.toContain("gho_");
    }
  });
});
