import { describe, expect, it } from "bun:test";
import { createApp } from "./app";

describe("GET /api/health", () => {
  it("returns ok without starting a listener", async () => {
    const res = await createApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "ghreporting" });
  });
});
