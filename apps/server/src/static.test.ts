import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountStatic } from "./static";

describe("mountStatic", () => {
  let dir: string;
  let manifest: Record<string, string>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ghr-static-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>login</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    manifest = {
      "/index.html": join(dir, "index.html"),
      "/assets/app.js": join(dir, "assets", "app.js"),
    };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("serves an exact asset path with its content", async () => {
    const app = new Hono();
    mountStatic(app, manifest);
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
  });

  it("serves index.html at /", async () => {
    const app = new Hono();
    mountStatic(app, manifest);
    const res = await app.request("/");
    expect(await res.text()).toContain("<title>login</title>");
  });

  it("falls back to index.html for an unknown path (SPA routing)", async () => {
    const app = new Hono();
    mountStatic(app, manifest);
    const res = await app.request("/reports/some-deep-link");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>login</title>");
  });

  it("mounts nothing on an empty manifest (dev mode, API 404 unchanged)", async () => {
    const app = new Hono();
    app.get("/api/health", (c) => c.json({ ok: true }));
    mountStatic(app, {});
    // API route still answers, and an unknown path is a plain 404 — not an SPA page.
    expect((await app.request("/api/health")).status).toBe(200);
    const miss = await app.request("/anything");
    expect(miss.status).toBe(404);
    expect(await miss.text()).not.toContain("<title>");
  });

  it("does not shadow API routes when mounted after them", async () => {
    const app = new Hono();
    const sub = new Hono();
    sub.get("/x", (c) => c.text("API"));
    app.route("/api/data", sub); // API mounted first (mirrors kernel.start order)
    mountStatic(app, manifest); // catch-all mounted last
    expect(await (await app.request("/api/data/x")).text()).toBe("API");
    expect(await (await app.request("/ui-route")).text()).toContain("<title>");
  });

  it("keeps unknown /api/* GETs as a JSON 404, not the SPA HTML page", async () => {
    const app = new Hono();
    app.notFound((c) => c.json({ error: { code: "not_found" } }, 404));
    mountStatic(app, manifest);
    const res = await app.request("/api/reports/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).not.toContain("<title>");
  });
});
