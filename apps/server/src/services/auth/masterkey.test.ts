import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { secretStoreConformance } from "../../adapters/secretstore/conformance";
import { AppError } from "../../kernel/errors";
import { createMasterKeyFileBackend, loadOrCreateMasterKey } from "./masterkey";
import { memoryBackend } from "./testutil";

const tmpKeyPath = () => join(mkdtempSync(join(tmpdir(), "ghr-mk-")), "master.key");

describe("loadOrCreateMasterKey", () => {
  it("creates a 32-byte key and persists it as 64 hex chars", async () => {
    const backend = memoryBackend();
    const key = await loadOrCreateMasterKey(backend);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    const stored = backend.store.get("master-key");
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across loads — the second call returns the same bytes", async () => {
    const backend = memoryBackend();
    const first = await loadOrCreateMasterKey(backend);
    const second = await loadOrCreateMasterKey(backend);
    expect([...second]).toEqual([...first]);
    expect(backend.store.size).toBe(1); // created once, never rewritten
  });

  it("round-trips hex correctly for a known stored key", async () => {
    const backend = memoryBackend();
    await backend.set("master-key", "00ff10".padEnd(64, "a"));
    const key = await loadOrCreateMasterKey(backend);
    expect(key[0]).toBe(0x00);
    expect(key[1]).toBe(0xff);
    expect(key[2]).toBe(0x10);
    expect(key[31]).toBe(0xaa);
  });

  it("rejects a corrupt stored key instead of silently truncating it", async () => {
    // 63 chars (odd length), 62 chars (wrong length), and non-hex all corrupt.
    for (const bad of [`${"ab".repeat(31)}c`, "ab".repeat(31), "zz".repeat(32)]) {
      const backend = memoryBackend();
      await backend.set("master-key", bad);
      const err = await loadOrCreateMasterKey(backend).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe("auth.master_key_corrupt");
      expect(err.status).toBe(500);
    }
  });
});

describe("createMasterKeyFileBackend", () => {
  it("writes the key file with 0600 permissions", async () => {
    const path = tmpKeyPath();
    const backend = createMasterKeyFileBackend(path);
    await backend.set("master-key", "ab".repeat(32));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("survives a process restart (fresh backend over the same path)", async () => {
    const path = tmpKeyPath();
    await createMasterKeyFileBackend(path).set("master-key", "cd".repeat(32));
    expect(await createMasterKeyFileBackend(path).get("master-key")).toBe("cd".repeat(32));
  });

  it("writes atomically and leaves no temp file behind", async () => {
    const path = tmpKeyPath();
    await createMasterKeyFileBackend(path).set("master-key", "ef".repeat(32));
    expect(existsSync(`${path}.tmp`)).toBe(false); // temp renamed away, not left dangling
    expect(existsSync(dirname(path))).toBe(true);
  });
});

secretStoreConformance("master-key file", async () => createMasterKeyFileBackend(tmpKeyPath()));
