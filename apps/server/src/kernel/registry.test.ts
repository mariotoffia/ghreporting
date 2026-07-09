import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { MicroService, ServiceContext } from "./ports";
import { createKernel } from "./registry";
import { stubContext } from "./testutil";

describe("createKernel", () => {
  let ctx: ServiceContext;
  afterEach(() => ctx?.db.close());

  it("runs init in registration order", async () => {
    ctx = stubContext();
    const order: string[] = [];
    const mk = (name: string): MicroService => ({ name, init: () => void order.push(name) });
    const kernel = createKernel(ctx);
    kernel.register(mk("a"));
    kernel.register(mk("b"));
    await kernel.start(new Hono());
    expect(order).toEqual(["a", "b"]);
  });

  it("aborts startup and rejects when an init throws", async () => {
    ctx = stubContext();
    const started: string[] = [];
    const kernel = createKernel(ctx);
    kernel.register({ name: "ok", init: () => void started.push("ok") });
    kernel.register({
      name: "bad",
      init: () => {
        throw new Error("nope");
      },
    });
    kernel.register({ name: "never", init: () => void started.push("never") });
    await expect(kernel.start(new Hono())).rejects.toThrow("nope");
    expect(started).toEqual(["ok"]);
  });

  it("mounts service routes under /api/<name>", async () => {
    ctx = stubContext();
    const svc: MicroService = {
      name: "fake",
      init: () => {},
      routes: (app) => {
        app.get("/ping", (c) => c.text("pong"));
      },
    };
    const kernel = createKernel(ctx);
    kernel.register(svc);
    const app = new Hono();
    await kernel.start(app);
    const res = await app.request("/api/fake/ping");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });

  it("runs shutdown in reverse and a throwing shutdown does not stop the others", async () => {
    ctx = stubContext();
    const order: string[] = [];
    const kernel = createKernel(ctx);
    kernel.register({ name: "a", init: () => {}, shutdown: () => void order.push("a") });
    kernel.register({
      name: "b",
      init: () => {},
      shutdown: () => {
        throw new Error("x");
      },
    });
    kernel.register({ name: "c", init: () => {}, shutdown: () => void order.push("c") });
    await kernel.start(new Hono());
    await kernel.stop();
    expect(order).toEqual(["c", "a"]);
  });

  it("only shuts down services that actually started", async () => {
    ctx = stubContext();
    const stopped: string[] = [];
    const kernel = createKernel(ctx);
    kernel.register({ name: "ok", init: () => {}, shutdown: () => void stopped.push("ok") });
    kernel.register({
      name: "bad",
      init: () => {
        throw new Error("boom");
      },
      shutdown: () => void stopped.push("bad"),
    });
    await expect(kernel.start(new Hono())).rejects.toThrow();
    await kernel.stop();
    expect(stopped).toEqual(["ok"]);
  });
});
