import { describe, expect, it, mock } from "bun:test";
import { renderToString } from "react-dom/server";
import type { CredentialEntry } from "./api";

// No real network: the pure loop is tested directly; the component only renders its button.
mock.module("../../lib/client", () => ({
  api: { get: mock(), post: mock(), put: mock(), del: mock() },
}));

const { runDeviceSignIn, DeviceFlow, isExpiredError } = await import("./DeviceFlow");

const START = {
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  interval: 5,
  expiresIn: 900,
};

const entry = (status: CredentialEntry["status"]): CredentialEntry => ({
  id: "github-oauth:default",
  type: "github-oauth",
  status,
  expiresAt: null,
  statusDetail: null,
  describe: {
    type: "github-oauth",
    title: "GitHub (sign in)",
    helpUrl: "https://github.com/login/device",
    flow: "device",
    fields: [],
    requiredScopes: [],
  },
});

describe("runDeviceSignIn — pure poll loop (no real time or network)", () => {
  it("polls at the interval until authorized, then returns the status", async () => {
    const polls: Array<{ pending: true } | { status: "ok" }> = [
      { pending: true },
      { status: "ok" },
    ];
    let i = 0;
    const slept: number[] = [];
    const r = await runDeviceSignIn({
      start: START,
      poll: async () => polls[i++] ?? { pending: true },
      sleep: async (ms) => void slept.push(ms),
      now: () => 0, // never past the deadline
    });
    expect(r).toEqual({ status: "ok" });
    expect(i).toBe(2); // polled twice (pending, then ok)
    expect(slept).toEqual([5000, 5000]); // waited `interval` seconds before each poll
  });

  it("returns { expired: true } once the clock passes expiresIn", async () => {
    let t = 0;
    const r = await runDeviceSignIn({
      start: { ...START, expiresIn: 10 },
      poll: async () => ({ pending: true }),
      sleep: async () => {
        t += 20_000; // jump past the 10s deadline
      },
      now: () => t,
    });
    expect(r).toEqual({ expired: true });
  });

  it("returns { cancelled: true } and stops polling when cancelled mid-wait", async () => {
    let cancelled = false;
    const poll = mock(async () => ({ pending: true }) as { pending: true });
    const r = await runDeviceSignIn({
      start: START,
      poll,
      sleep: async () => {
        cancelled = true;
      },
      now: () => 0,
      cancelled: () => cancelled,
    });
    expect(r).toEqual({ cancelled: true });
    expect(poll).not.toHaveBeenCalled(); // cancelled before the first poll fired
  });
});

describe("isExpiredError", () => {
  it("recognizes the server's 410 device-expired code so the UI shows the expired state", () => {
    expect(isExpiredError({ code: "credential.device_expired" })).toBe(true);
    expect(isExpiredError({ code: "validation" })).toBe(false);
    expect(isExpiredError(new Error("boom"))).toBe(false);
    expect(isExpiredError(null)).toBe(false);
  });
});

describe("DeviceFlow — initial render", () => {
  it("offers 'Connect GitHub' when unconfigured", () => {
    const html = renderToString(<DeviceFlow entry={entry(null)} onChanged={() => {}} />);
    expect(html).toContain("Connect GitHub");
  });

  it("offers 'Reconnect' when already configured", () => {
    const html = renderToString(<DeviceFlow entry={entry("ok")} onChanged={() => {}} />);
    expect(html).toContain("Reconnect");
  });
});
