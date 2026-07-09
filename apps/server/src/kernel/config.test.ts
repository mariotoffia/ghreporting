import { describe, expect, it } from "bun:test";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("applies defaults when env is empty", () => {
    const c = loadConfig({ HOME: "/home/me" });
    expect(c.port).toBe(8787);
    expect(c.dbPath).toBe("/home/me/.ghreporting/ghreporting.db");
    expect(c.org).toBeUndefined();
    expect(c.origins).toEqual(["http://localhost:5173", "http://localhost:8787"]);
    expect(c.secretBackend).toBeUndefined();
    expect(c.packaged).toBe(false);
    expect(c.now()).toBeInstanceOf(Date);
  });

  it("honors every GHR_* / PORT override", () => {
    const c = loadConfig({
      HOME: "/home/me",
      PORT: "9000",
      GHR_DB_PATH: "/data/app.db",
      GHR_ORG: "acme",
      GHR_ORIGINS: "http://a.test , http://b.test",
      GHR_SECRET_BACKEND: "encrypted-file",
      GHR_PACKAGED: "1",
    });
    expect(c.port).toBe(9000);
    expect(c.dbPath).toBe("/data/app.db");
    expect(c.org).toBe("acme");
    expect(c.origins).toEqual(["http://a.test", "http://b.test"]);
    expect(c.secretBackend).toBe("encrypted-file");
    expect(c.packaged).toBe(true);
  });

  it("expands a leading ~/ against HOME", () => {
    expect(loadConfig({ HOME: "/Users/test", GHR_DB_PATH: "~/db.sqlite" }).dbPath).toBe(
      "/Users/test/db.sqlite",
    );
  });

  it("falls back to USERPROFILE then '.' for ~ expansion", () => {
    expect(loadConfig({ USERPROFILE: "C:/Users/w", GHR_DB_PATH: "~/x" }).dbPath).toBe(
      "C:/Users/w/x",
    );
    expect(loadConfig({ GHR_DB_PATH: "~/x" }).dbPath).toBe("./x");
  });

  it("only expands a leading ~/, not a mid-path tilde", () => {
    expect(loadConfig({ HOME: "/h", GHR_DB_PATH: "/a/~/b" }).dbPath).toBe("/a/~/b");
  });

  it("returns a frozen, immutable config", () => {
    const c = loadConfig({ HOME: "/h" });
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("GHR_PACKAGED other than '1' is not packaged", () => {
    expect(loadConfig({ HOME: "/h", GHR_PACKAGED: "true" }).packaged).toBe(false);
  });

  it("falls back to the default port for empty or non-numeric PORT", () => {
    expect(loadConfig({ HOME: "/h", PORT: "" }).port).toBe(8787);
    expect(loadConfig({ HOME: "/h", PORT: "abc" }).port).toBe(8787);
  });

  it("falls back to default origins when GHR_ORIGINS is empty or all blanks", () => {
    const def = ["http://localhost:5173", "http://localhost:8787"];
    expect(loadConfig({ HOME: "/h", GHR_ORIGINS: "" }).origins).toEqual(def);
    expect(loadConfig({ HOME: "/h", GHR_ORIGINS: " , " }).origins).toEqual(def);
  });

  it("drops blank entries but keeps real origins", () => {
    expect(
      loadConfig({ HOME: "/h", GHR_ORIGINS: "http://a.test, ,http://b.test" }).origins,
    ).toEqual(["http://a.test", "http://b.test"]);
  });
});
