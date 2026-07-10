import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";
import { AppError, NotFoundError, SecretsLockedError, ValidationError } from "./kernel/errors";
import type { ServiceContext } from "./kernel/ports";
import { fakeWebAuthnLib, memoryBackend } from "./services/auth/testutil";

// explicit minimal env: a developer's GHR_* variables must not change what
// these tests compose (e.g. GHR_SCHEDULER registering timers). Force the
// encrypted-file backend so composition never shells out to the real macOS
// keychain — keeping the suite hermetic and identical on darwin and CI/Linux.
const testEnv = {
  HOME: "/tmp",
  GHR_DB_PATH: ":memory:",
  GHR_SECRET_BACKEND: "encrypted-file",
};

// the master-key backend is always injected in tests — never the real keychain
const build = (env: Record<string, string> = testEnv) =>
  buildApp(env, { masterKeyBackend: memoryBackend(), webauthnLib: fakeWebAuthnLib().lib });

/** A Cookie header for a fresh live session — how tests get past the gate. */
const authed = (built: ReturnType<typeof buildApp>) => ({
  headers: { Cookie: `ghr_session=${built.sessions.create()}` },
});

describe("buildApp", () => {
  let ctx: ServiceContext | undefined;
  afterEach(() => ctx?.db.close());

  it("serves /api/health through the composition without a session", async () => {
    const built = build();
    ctx = built.ctx;
    const res = await built.app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "ghreporting" });
  });

  it("maps a thrown AppError to its status and envelope", async () => {
    const built = build();
    ctx = built.ctx;
    built.app.get("/api/boom", () => {
      throw new ValidationError("bad org");
    });
    const res = await built.app.request("/api/boom", authed(built));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "validation", message: "bad org" } });
  });

  it("clamps an out-of-range AppError status to 500 instead of throwing in onError", async () => {
    const built = build();
    ctx = built.ctx;
    built.app.get("/api/weird", () => {
      throw new AppError("weird", "off the scale", 0);
    });
    const res = await built.app.request("/api/weird", authed(built));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "weird", message: "off the scale" } });
  });

  it("maps an unexpected throw to a 500 internal envelope", async () => {
    const built = build();
    ctx = built.ctx;
    built.app.get("/api/kaboom", () => {
      throw new Error("surprise");
    });
    const res = await built.app.request("/api/kaboom", authed(built));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal");
  });

  it("maps an error thrown in a kernel-mounted service route to the envelope", async () => {
    const built = build();
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
    const res = await built.app.request("/api/faily/x", authed(built));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "widget not found" } });
  });

  it("registers the data service: the catalog lists the five built-in datasets", async () => {
    const built = build();
    ctx = built.ctx;
    await built.kernel.start(built.app);
    try {
      const res = await built.app.request("/api/data/datasets", authed(built));
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ id: string }>;
      expect(list.map((d) => d.id).sort()).toEqual([
        "billing-usage",
        "copilot-metrics",
        "copilot-seats",
        "org-people",
        "premium-requests",
      ]);
    } finally {
      await built.kernel.stop();
    }
  });

  it("registers the reports service: /api/reports lists the seeded Copilot Spend report", async () => {
    // Exercises the REAL kernel mount (/api/reports) + seed-on-init: guards against the
    // route resolving to /api/reports/reports (a doubled prefix the unit harness can't see).
    const built = build();
    ctx = built.ctx;
    await built.kernel.start(built.app);
    try {
      const res = await built.app.request("/api/reports", authed(built));
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ id: string; name: string }>;
      expect(list.some((r) => r.id === "copilot-spend")).toBe(true);
    } finally {
      await built.kernel.stop();
    }
  });

  it("returns a 404 envelope for unknown routes (behind the gate)", async () => {
    const built = build();
    ctx = built.ctx;
    const res = await built.app.request("/api/nope", authed(built));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "no such route" } });
  });
});

describe("session gate (T4.2)", () => {
  let ctx: ServiceContext | undefined;
  afterEach(() => ctx?.db.close());

  it("rejects any /api/* call without a session cookie with 401", async () => {
    const built = build();
    ctx = built.ctx;
    await built.kernel.start(built.app);
    try {
      const res = await built.app.request("/api/data/datasets");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: "unauthorized", message: "login required" },
      });
    } finally {
      await built.kernel.stop();
    }
  });

  it("rejects a forged/expired session token", async () => {
    const built = build();
    ctx = built.ctx;
    const res = await built.app.request("/api/anything", {
      headers: { Cookie: "ghr_session=forged" },
    });
    expect(res.status).toBe(401);
  });

  it("exempts /api/health and /api/auth/* from the gate", async () => {
    const built = build();
    ctx = built.ctx;
    await built.kernel.start(built.app);
    try {
      expect((await built.app.request("/api/health")).status).toBe(200);
      expect((await built.app.request("/api/auth/status")).status).toBe(200);
    } finally {
      await built.kernel.stop();
    }
  });

  it("permits a live session and keeps permitting as it slides", async () => {
    const built = build();
    ctx = built.ctx;
    await built.kernel.start(built.app);
    try {
      const opts = authed(built);
      expect((await built.app.request("/api/data/datasets", opts)).status).toBe(200);
      expect((await built.app.request("/api/data/datasets", opts)).status).toBe(200);
    } finally {
      await built.kernel.stop();
    }
  });
});

describe("full unlock loop (T4.2 done-when, with T3.x)", () => {
  let ctx: ServiceContext | undefined;
  afterEach(() => ctx?.db.close());

  const post = (built: ReturnType<typeof buildApp>, path: string, cookie?: string) =>
    built.app.request(path, {
      method: "POST",
      body: JSON.stringify({ id: "passkey-1" }),
      headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    });

  it("save token → logout → locked → login → token readable", async () => {
    // fresh temp secrets file: the encrypted-file store must not leak state between runs
    const secretsPath = join(mkdtempSync(join(tmpdir(), "ghr-app-")), "secrets.enc.json");
    const built = build({ ...testEnv, GHR_SECRETS_PATH: secretsPath });
    ctx = built.ctx;
    await built.kernel.start(built.app);
    try {
      // before unlock: the secrets port is locked
      await expect(built.ctx.secrets.get("cred.github-pat:default")).rejects.toBeInstanceOf(
        SecretsLockedError,
      );

      // register (first-run setup) → unlocked
      await post(built, "/api/auth/register/options");
      const reg = await post(built, "/api/auth/register/verify");
      expect(reg.status).toBe(200);
      const cookie = /ghr_session=[^;]+/.exec(reg.headers.get("set-cookie") ?? "")?.[0] ?? "";
      expect(cookie).not.toBe("");

      // save a token through the now-unlocked encrypted-file store
      await built.ctx.secrets.set("cred.github-pat:default", "ghp_secret_token");
      expect(await built.ctx.secrets.get("cred.github-pat:default")).toBe("ghp_secret_token");

      // logout → locked again
      const out = await post(built, "/api/auth/logout", cookie);
      expect(out.status).toBe(200);
      await expect(built.ctx.secrets.get("cred.github-pat:default")).rejects.toBeInstanceOf(
        SecretsLockedError,
      );
      // and the old session no longer passes the gate
      expect(
        (await built.app.request("/api/data/datasets", { headers: { Cookie: cookie } })).status,
      ).toBe(401);

      // login → unlocked → the token is readable again
      await post(built, "/api/auth/login/options");
      const login = await post(built, "/api/auth/login/verify");
      expect(login.status).toBe(200);
      expect(await built.ctx.secrets.get("cred.github-pat:default")).toBe("ghp_secret_token");
    } finally {
      await built.kernel.stop();
    }
  });
});
