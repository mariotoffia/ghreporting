// macOS Keychain backend (ADR 0006): shells out to `security` with service name
// `ghreporting`. Argv passes the secret briefly visible in `ps` — an accepted,
// ADR-recorded single-user-desktop trade-off; the upgrade path is FFI to
// Security.framework. Never log the spawn args (they contain the secret).
import { AppError } from "../../kernel/errors";
import type { SecretStoreBackend } from "../../kernel/ports";

export function createKeychainBackend(opts?: {
  service?: string;
  platform?: string;
}): SecretStoreBackend {
  const service = opts?.service ?? "ghreporting";
  const platform = opts?.platform ?? process.platform;
  async function security(args: string[]): Promise<{ code: number; stdout: string }> {
    const p = Bun.spawn(["security", ...args], { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(p.stdout).text();
    return { code: await p.exited, stdout };
  }
  return {
    id: "keychain",
    available: async () => platform === "darwin" && (await security(["help"])).code === 0,
    get: async (account) => {
      const r = await security(["find-generic-password", "-s", service, "-a", account, "-w"]);
      return r.code === 0 ? r.stdout.trimEnd() : null; // non-zero = not found
    },
    set: async (account, secret) => {
      const r = await security([
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-w",
        secret,
      ]);
      if (r.code !== 0) throw new AppError("keychain.write_failed", `security exited ${r.code}`);
    },
    delete: async (account) => {
      await security(["delete-generic-password", "-s", service, "-a", account]); // missing = fine
    },
  };
}
