import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { createLogger } from "./logger";

const errSpy = spyOn(console, "error").mockImplementation(() => {});
const logSpy = spyOn(console, "log").mockImplementation(() => {});

afterEach(() => {
  errSpy.mockClear();
  logSpy.mockClear();
});
afterAll(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
});

function lastLine(): Record<string, unknown> {
  const call = errSpy.mock.calls.at(-1);
  return JSON.parse(String(call?.[0]));
}

describe("createLogger", () => {
  it("writes a JSON line with level, scope, msg, timestamp, and fields", () => {
    createLogger("app").info("hello", { a: 1 });
    const line = lastLine();
    expect(line.level).toBe("info");
    expect(line.scope).toBe("app");
    expect(line.msg).toBe("hello");
    expect(line.a).toBe(1);
    expect(typeof line.t).toBe("string");
    expect(Number.isNaN(Date.parse(String(line.t)))).toBe(false);
  });

  it("supports info / warn / error levels", () => {
    const log = createLogger("svc");
    log.warn("w");
    expect(lastLine().level).toBe("warn");
    log.error("e");
    expect(lastLine().level).toBe("error");
  });

  it("child scope is parent.child", () => {
    createLogger("app").child("data").info("x");
    expect(lastLine().scope).toBe("app.data");
  });

  it("nests child scopes", () => {
    createLogger("app").child("data").child("sync").info("x");
    expect(lastLine().scope).toBe("app.data.sync");
  });

  it("logs to stderr (console.error), never stdout", () => {
    createLogger("app").info("x");
    expect(errSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("reserved keys win over caller fields (a `level` field cannot relabel the record)", () => {
    createLogger("svc").warn("careful", { level: "info", scope: "attacker", extra: 1 });
    const line = lastLine();
    expect(line.level).toBe("warn");
    expect(line.scope).toBe("svc");
    expect(line.msg).toBe("careful");
    expect(line.extra).toBe(1); // non-reserved fields still pass through
  });

  it("never throws on an unserializable field (BigInt / circular)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => createLogger("app").error("boom", { big: 10n })).not.toThrow();
    expect(() => createLogger("app").error("boom", circular)).not.toThrow();
    expect(lastLine().fields).toBe("[unserializable]");
  });
});
