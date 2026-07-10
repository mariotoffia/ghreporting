import { beforeEach, describe, expect, it, mock } from "bun:test";

// Mock the native WebAuthn ceremonies before importing flows (which binds them
// at module load). The mocks record their calls and hand back fake credentials.
const startRegistration = mock(async (_: unknown) => ({ id: "att" }));
const startAuthentication = mock(async (_: unknown) => ({ id: "asr" }));
mock.module("@simplewebauthn/browser", () => ({ startRegistration, startAuthentication }));

const { nextScreen, register, login, runCeremony } = await import("./flows");

import type { Api } from "../../lib/api";

/** A minimal Api double: post() returns scripted values in call order. */
function fakeApi(posts: unknown[]) {
  const calls: Array<[string, unknown]> = [];
  let i = 0;
  const api = {
    post: async (path: string, body?: unknown) => {
      calls.push([path, body]);
      return posts[i++];
    },
  } as unknown as Api;
  return { api, calls };
}

describe("nextScreen", () => {
  it("routes an unregistered device to setup", () => {
    expect(nextScreen({ registered: false, unlocked: false, hasSession: false })).toBe("setup");
    expect(nextScreen({ registered: false, unlocked: true, hasSession: false })).toBe("setup");
  });
  it("routes a registered but session-less device to login", () => {
    expect(nextScreen({ registered: true, unlocked: false, hasSession: false })).toBe("login");
  });
  it("routes a registered + session device to the app", () => {
    expect(nextScreen({ registered: true, unlocked: true, hasSession: true })).toBe("app");
  });
  it("routes to login when the server is unlocked but THIS browser has no session (the 401-loop bug)", () => {
    // Server-global unlock must not put a session-less browser into the app — it would 401 forever.
    expect(nextScreen({ registered: true, unlocked: true, hasSession: false })).toBe("login");
  });
});

describe("register", () => {
  beforeEach(() => startRegistration.mockClear());

  it("fetches options, runs startRegistration, posts attestation to verify", async () => {
    const options = { challenge: "c" };
    const { api, calls } = fakeApi([options, { verified: true }]);
    await register(api);
    expect(calls[0]?.[0]).toBe("/api/auth/register/options");
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: options });
    expect(calls[1]).toEqual(["/api/auth/register/verify", { id: "att" }]);
  });
});

describe("login", () => {
  beforeEach(() => startAuthentication.mockClear());

  it("fetches options, runs startAuthentication, posts assertion to verify", async () => {
    const options = { challenge: "c2" };
    const { api, calls } = fakeApi([options, { verified: true }]);
    await login(api);
    expect(calls[0]?.[0]).toBe("/api/auth/login/options");
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
    expect(calls[1]).toEqual(["/api/auth/login/verify", { id: "asr" }]);
  });
});

describe("runCeremony", () => {
  it("swallows a user-cancelled prompt (NotAllowedError) and reports not-completed", async () => {
    const cancel = () => {
      const e = new Error("The operation either timed out or was not allowed.");
      e.name = "NotAllowedError";
      return Promise.reject(e);
    };
    expect(await runCeremony(cancel)).toBe(false);
  });
  it("returns true when the ceremony completes", async () => {
    expect(await runCeremony(async () => {})).toBe(true);
  });
  it("re-throws every non-cancellation error", async () => {
    const boom = () => Promise.reject(new Error("server said no"));
    await expect(runCeremony(boom)).rejects.toThrow("server said no");
  });
});
