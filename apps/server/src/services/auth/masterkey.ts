// Master Key: 32 random bytes at rest only inside the OS keychain (darwin) or a
// 0600 file (honest fallback, ADR 0007); in process memory only while unlocked.
// It keys the encrypted-file secret backend (ARCHITECTURE.md §6).
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../../kernel/errors";
import type { SecretStoreBackend } from "../../kernel/ports";

const MASTER_KEY_ACCOUNT = "master-key";
const MASTER_KEY_HEX = /^[0-9a-f]{64}$/i; // exactly 32 bytes

/** Load the master key from the backend, creating and persisting it on first run. */
export async function loadOrCreateMasterKey(backend: SecretStoreBackend): Promise<Uint8Array> {
  const hex = await backend.get(MASTER_KEY_ACCOUNT);
  if (hex) {
    // Reject a corrupt store loudly instead of silently truncating (`.match(/.{2}/g)`
    // drops an odd trailing char) into a wrong-length key that only fails later at
    // AES-GCM importKey with an opaque 500. 32 bytes or bust.
    if (!MASTER_KEY_HEX.test(hex)) {
      throw new AppError(
        "auth.master_key_corrupt",
        "stored master key is corrupt — run the recovery procedure (delete passkeys + master key, re-run setup)",
        500,
      );
    }
    return Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  await backend.set(
    MASTER_KEY_ACCOUNT,
    [...key].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
  return key;
}

/**
 * Non-darwin fallback for the master key: one 0600 file (~/.ghreporting/master.key).
 * ponytail: single-file backend — it stores exactly one secret (the master key),
 * so the account name never varies; grow a per-account dir only if a second
 * caller ever appears.
 */
export function createMasterKeyFileBackend(path: string): SecretStoreBackend {
  return {
    id: "master-key-file",
    available: async () => true, // mkdir on write; a read-only HOME surfaces at set()
    get: async () => {
      const file = Bun.file(path);
      return (await file.exists()) ? (await file.text()).trim() : null;
    },
    set: async (_account, secret) => {
      mkdirSync(dirname(path), { recursive: true });
      // Atomic temp+rename (like encfile.ts's writeDoc): a crash mid-write must not
      // leave a truncated master.key that loadOrCreateMasterKey would reject/mangle.
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, secret, { mode: 0o600 });
      chmodSync(tmp, 0o600); // mode above only applies on create; enforce on overwrite too
      renameSync(tmp, path);
    },
    delete: async () => {
      rmSync(path, { force: true }); // idempotent
    },
  };
}
