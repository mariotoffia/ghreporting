import { afterEach, describe, expect, it } from "bun:test";
import { buildApp } from "./app";
import { NotFoundError, ValidationError } from "./kernel/errors";
import type { ServiceContext } from "./kernel/ports";

const testEnv = { ...process.env, GHR_DB_PATH: ":memory:" };

describe("buildApp", () => {
  let ctx: ServiceContext | undefined;
  afterEach(() => ctx?.db.close());

  it("serves /api/health through the composition", async () => {
    const built = buildApp(testEnv);
    ctx = built.ctx;
    const res = await built.app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "ghreporting" });
  });

  it("maps a thrown AppError to its status and envelope", async () => {
    const built = buildApp(testEnv);
    ctx = built.ctx;
    built.app.get("/api/boom", () => {
      throw new ValidationError("bad org");
    });
    const res = await built.app.request("/api/boom");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "validation", message: "bad org" } });
  });

  it("maps an unexpected throw to a 500 internal envelope", async () => {
    const built = buildApp(testEnv);
    ctx = built.ctx;
    built.app.get("/api/kaboom", () => {
      throw new Error("surprise");
    });
    const res = await built.app.request("/api/kaboom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal");
  });

  it("maps an error thrown in a kernel-mounted service route to the envelope", async () => {
    const built = buildApp(testEnv);
    ctx = built.ctx;
    built.kernel.register({
      name: "faily",
      init: () => {},
      routes: (sub) => {
        sub.get("/x", () => {
          throw new NotFoundError("widget");
        });
      },
    });
    await built.kernel.start(built.app);
    const res = await built.app.request("/api/faily/x");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "widget not found" } });
  });

  it("returns a 404 envelope for unknown routes", async () => {
    const built = buildApp(testEnv);
    ctx = built.ctx;
    const res = await built.app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "no such route" } });
  });
});
