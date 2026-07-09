import { Database } from "bun:sqlite";
import { createEventBus } from "./bus";
import { loadConfig } from "./config";
import type { Logger, ServiceContext } from "./ports";

/** A Logger that swallows everything — for tests that don't assert on logs. */
export function nullLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, child: () => nullLogger() };
}

/** A Logger that records calls, for asserting a code path logged. */
export function recordingLogger(): Logger & { lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const push = (level: string) => (msg: string) => lines.push({ level, msg });
  const self = {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => self,
  };
  return self;
}

/**
 * A full ServiceContext backed by an in-memory DB — for unit-testing kernel pieces
 * that only need a valid context to pass around. Callers close `ctx.db` in afterEach.
 */
export function stubContext(log: Logger = nullLogger()): ServiceContext {
  return {
    db: new Database(":memory:"),
    bus: createEventBus(log),
    config: loadConfig({ HOME: "/tmp" }),
    log,
    notify: () => {},
    resolve: () => {},
    secrets: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    },
  };
}
