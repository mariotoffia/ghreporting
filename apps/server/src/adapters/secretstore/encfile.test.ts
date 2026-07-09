import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretsLockedError } from "../../kernel/errors";
import { secretStoreConformance } from "./conformance";
import { createEncryptedFileBackend } from "./encfile";

// A fixed 32-byte master key; the real one is 32 bytes from the OS keychain.
const KEY = new Uint8Array(32).fill(7);

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ghr-encfile-"));
  dirs.push(dir);
  return join(dir, "secrets.enc.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A fresh file per conformance run so the four cases never see each other's state.
secretStoreConformance("encrypted-file", async () =>
  createEncryptedFileBackend({ path: tmpFile(), keyProvider: () => KEY }),
);

describe("encrypted-file backend", () => {
  it("throws SecretsLockedError on every op while the key is null", async () => {
    const s = createEncryptedFileBackend({ path: tmpFile(), keyProvider: () => null });
    await expect(s.get("a")).rejects.toBeInstanceOf(SecretsLockedError);
    await expect(s.set("a", "x")).rejects.toBeInstanceOf(SecretsLockedError);
    await expect(s.delete("a")).rejects.toBeInstanceOf(SecretsLockedError);
  });

  it("persists across a restart (new instance, same path and key)", async () => {
    const path = tmpFile();
    const first = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    await first.set("github-pat:default", "ghp_secret");
    const restarted = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    expect(await restarted.get("github-pat:default")).toBe("ghp_secret");
  });

  it("never writes the plaintext secret to disk", async () => {
    const path = tmpFile();
    const s = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    await s.set("a", "super-secret-token");
    expect(readFileSync(path, "utf8")).not.toContain("super-secret-token");
  });

  it("stores an AES-GCM record with base64 iv + ciphertext under version 1", async () => {
    const path = tmpFile();
    const s = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    await s.set("a", "x");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.version).toBe(1);
    expect(typeof doc.entries.a.iv).toBe("string");
    expect(typeof doc.entries.a.ct).toBe("string");
  });

  it("rejects a ciphertext relocated to another account (account bound as AAD)", async () => {
    const path = tmpFile();
    const s = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    await s.set("low-priv", "A-secret");
    await s.set("high-priv", "B-secret");
    // attacker with file-write but no key swaps low-priv's blob into high-priv's slot
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.entries["high-priv"] = doc.entries["low-priv"];
    writeFileSync(path, JSON.stringify(doc));
    const reopened = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    await expect(reopened.get("high-priv")).rejects.toBeDefined(); // must NOT return "A-secret"
  });

  it("errors (not crashes) when the ciphertext has been tampered with", async () => {
    const path = tmpFile();
    const s = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    await s.set("a", "x");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.entries.a.ct = Buffer.from("garbage-ciphertext").toString("base64");
    writeFileSync(path, JSON.stringify(doc));
    const reopened = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    await expect(reopened.get("a")).rejects.toBeDefined();
  });

  it("reports available() from the parent directory being writable", async () => {
    const path = tmpFile();
    const s = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    expect(await s.available()).toBe(true);
    const missing = createEncryptedFileBackend({
      path: "/no/such/dir/secrets.enc.json",
      keyProvider: () => KEY,
    });
    expect(await missing.available()).toBe(false);
  });

  it("writes atomically, leaving no temp file behind", async () => {
    const path = tmpFile();
    const s = createEncryptedFileBackend({ path, keyProvider: () => KEY });
    await s.set("a", "x");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
