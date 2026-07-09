// Portable secret backend for Linux/Windows/CI (ADR 0006): AES-256-GCM via
// WebCrypto, keyed by the in-memory master key from auth unlock (ADR 0007).
// Secret bytes rest only here — never in SQLite, logs, or the browser.
import { accessSync, constants, existsSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { SecretsLockedError } from "../../kernel/errors";
import type { SecretStoreBackend } from "../../kernel/ports";

interface Entry {
  iv: string; // base64, 12 bytes
  ct: string; // base64 ciphertext (includes the GCM auth tag)
}
interface Doc {
  version: 1;
  entries: Record<string, Entry>;
}

const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as Uint8Array).toString("base64");
const unb64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const aad = (account: string) => new TextEncoder().encode(account);

export function createEncryptedFileBackend(opts: {
  path: string; // ~/.ghreporting/secrets.enc.json
  keyProvider: () => Uint8Array | null; // master key; null = locked
}): SecretStoreBackend {
  function key(): Uint8Array {
    const k = opts.keyProvider();
    if (k === null) throw new SecretsLockedError();
    return k;
  }

  const importKey = (k: Uint8Array) =>
    crypto.subtle.importKey("raw", k as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);

  function readDoc(): Doc {
    if (!existsSync(opts.path)) return { version: 1, entries: {} };
    return JSON.parse(readFileSync(opts.path, "utf8")) as Doc;
  }

  async function writeDoc(doc: Doc): Promise<void> {
    // ponytail: single-writer assumption — the credentials service saves one
    // credential at a time (one PUT route, one master key). If a concurrent
    // writer is ever added, serialize read-modify-write with a promise mutex.
    const tmp = `${opts.path}.tmp`;
    await Bun.write(tmp, JSON.stringify(doc));
    renameSync(tmp, opts.path); // atomic replace within the same directory
  }

  return {
    id: "encrypted-file",
    available: async () => {
      try {
        accessSync(dirname(opts.path), constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    get: async (account) => {
      const k = key();
      const entry = readDoc().entries[account];
      if (!entry) return null; // not found is not an error
      // additionalData binds the record to its account: a ciphertext relocated to
      // another account's slot fails the GCM tag instead of decrypting silently.
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(entry.iv), additionalData: aad(account) },
        await importKey(k),
        unb64(entry.ct),
      );
      return new TextDecoder().decode(pt);
    },
    set: async (account, secret) => {
      const k = key();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(account) },
        await importKey(k),
        new TextEncoder().encode(secret),
      );
      const doc = readDoc();
      doc.entries[account] = { iv: b64(iv), ct: b64(ct) };
      await writeDoc(doc);
    },
    delete: async (account) => {
      key(); // lock-guarded like the others, even though the plaintext is not touched
      const doc = readDoc();
      if (account in doc.entries) {
        delete doc.entries[account];
        await writeDoc(doc);
      }
    },
  };
}
