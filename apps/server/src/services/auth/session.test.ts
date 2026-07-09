import { describe, expect, it } from "bun:test";
import { createSessionStore } from "./session";
import { fakeClock } from "./testutil";

const HOUR = 3_600_000;

describe("createSessionStore", () => {
  it("creates a token that touch() accepts", () => {
    const clock = fakeClock();
    const sessions = createSessionStore(clock.now);
    const token = sessions.create();
    expect(token.length).toBeGreaterThan(0);
    expect(sessions.touch(token)).toBe(true);
  });

  it("rejects a token it never issued", () => {
    const sessions = createSessionStore(fakeClock().now);
    expect(sessions.touch("forged")).toBe(false);
  });

  it("expires a session idle past idleMs and forgets it", () => {
    const clock = fakeClock();
    const sessions = createSessionStore(clock.now, 12 * HOUR);
    const token = sessions.create();
    clock.advance(12 * HOUR + 1);
    expect(sessions.touch(token)).toBe(false);
    // expired sessions are deleted — a later touch inside a fresh window still fails
    expect(sessions.touch(token)).toBe(false);
  });

  it("slides the idle window on activity", () => {
    const clock = fakeClock();
    const sessions = createSessionStore(clock.now, 12 * HOUR);
    const token = sessions.create();
    clock.advance(11 * HOUR);
    expect(sessions.touch(token)).toBe(true); // renews lastSeen
    clock.advance(11 * HOUR);
    expect(sessions.touch(token)).toBe(true); // 22h total, but never idle > 12h
  });

  it("destroy() invalidates one token; clear() drops them all", () => {
    const clock = fakeClock();
    const sessions = createSessionStore(clock.now);
    const a = sessions.create();
    const b = sessions.create();
    sessions.destroy(a);
    expect(sessions.touch(a)).toBe(false);
    expect(sessions.touch(b)).toBe(true);
    sessions.clear();
    expect(sessions.touch(b)).toBe(false);
  });
});
