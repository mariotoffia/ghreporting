import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createEventBus } from "./bus";
import { loadConfig } from "./config";
import { createContext } from "./context";
import { SecretsLockedError } from "./errors";
import type { NotificationInput, ServiceContext } from "./ports";
import { nullLogger, recordingLogger } from "./testutil";

function base(log = nullLogger()): Omit<ServiceContext, "notify" | "secrets"> {
  return {
    db: new Database(":memory:"),
    bus: createEventBus(log),
    config: loadConfig({ HOME: "/tmp" }),
    log,
  };
}

describe("createContext", () => {
  let db: Database | undefined;
  afterEach(() => db?.close());

  it("keeps secrets locked until bindSecrets is called", async () => {
    const b = base();
    db = b.db;
    const { ctx } = createContext(b);
    await expect(ctx.secrets.get("x")).rejects.toBeInstanceOf(SecretsLockedError);
    await expect(ctx.secrets.set("x", "y")).rejects.toBeInstanceOf(SecretsLockedError);
    await expect(ctx.secrets.delete("x")).rejects.toBeInstanceOf(SecretsLockedError);
  });

  it("routes secrets to the bound store, and rebinding is live", async () => {
    const b = base();
    db = b.db;
    const { ctx, bindSecrets } = createContext(b);
    const mem = new Map<string, string>();
    bindSecrets({
      get: async (a) => mem.get(a) ?? null,
      set: async (a, s) => void mem.set(a, s),
      delete: async (a) => void mem.delete(a),
    });
    await ctx.secrets.set("k", "v");
    expect(await ctx.secrets.get("k")).toBe("v");
    await ctx.secrets.delete("k");
    expect(await ctx.secrets.get("k")).toBeNull();

    // rebinding a second time is live too — the slot is re-assignable, not one-shot.
    bindSecrets({ get: async () => "second", set: async () => {}, delete: async () => {} });
    expect(await ctx.secrets.get("k")).toBe("second");
  });

  it("warns on notify before bindNotify, then delegates after", () => {
    const log = recordingLogger();
    const b = base(log);
    db = b.db;
    const { ctx, bindNotify } = createContext(b);
    const n: NotificationInput = { key: "k", level: "info", title: "t", source: "s" };
    ctx.notify(n);
    expect(log.lines.some((l) => l.level === "warn")).toBe(true);
    const got: NotificationInput[] = [];
    bindNotify((x) => got.push(x));
    ctx.notify(n);
    expect(got).toEqual([n]);
  });
});
