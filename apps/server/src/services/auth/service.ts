// The `auth` uService (E4, ADR 0007): passkey ceremonies + session + unlock.
// A verified ceremony loads the Master Key into process memory (auth.unlocked),
// which keys the encrypted-file secret backend; logout zeroes it and locks again.
//
// RECOVERY PROCEDURE (lost passkey): stop the app, delete the passkey rows —
//   sqlite3 ~/.ghreporting/ghreporting.db "DELETE FROM passkeys"
// The keychain entry stays; the next boot offers first-run setup again and all
// local data (facts, workbooks, credentials) is preserved.
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AppError, ValidationError } from "../../kernel/errors";
import type { MicroService, SecretStoreBackend, ServiceContext } from "../../kernel/ports";
import { loadOrCreateMasterKey } from "./masterkey";
import type { SessionStore } from "./session";
import {
  type Ceremonies,
  createCeremonies,
  createChallengeStore,
  type WebAuthnLib,
} from "./webauthn";

export const SESSION_COOKIE = "ghr_session";

export function createAuthService(opts: {
  /** Shared with the /api/* gate middleware in app.ts (composition root). */
  sessions: SessionStore;
  /** Where the Master Key rests, priority order: [keychain, 0600 file]. */
  masterKeyBackends: SecretStoreBackend[];
  /** Hands the key to the encrypted-file backend's keyProvider slot in app.ts. */
  setMasterKey: (key: Uint8Array | null) => void;
  /** Test seam — ceremonies verify via the real @simplewebauthn/server by default. */
  lib?: WebAuthnLib;
}): MicroService {
  let ctx: ServiceContext;
  let ceremonies: Ceremonies;
  let keyBackend: SecretStoreBackend;
  let masterKey: Uint8Array | null = null;

  /** Unlock (UBIQUITOUS): load the Master Key, open the secret store, start a Session. */
  async function unlock(c: Context): Promise<void> {
    masterKey = await loadOrCreateMasterKey(keyBackend);
    opts.setMasterKey(masterKey);
    ctx.bus.emit({ type: "auth.unlocked" });
    setCookie(c, SESSION_COOKIE, opts.sessions.create(), {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
  }

  function lock(): void {
    masterKey?.fill(0); // zero the buffer wherever it's referenced
    masterKey = null;
    opts.setMasterKey(null);
  }

  async function jsonBody(c: Context): Promise<unknown> {
    return await c.req.json().catch(() => {
      throw new ValidationError("body must be JSON");
    });
  }

  return {
    name: "auth",
    async init(c) {
      ctx = c;
      for (const b of opts.masterKeyBackends) {
        if (await b.available()) {
          keyBackend = b;
          break;
        }
      }
      if (!keyBackend) {
        throw new AppError("auth.no_master_key_backend", "nowhere to keep the master key", 500);
      }
      ctx.log.info("master key backend selected", { backend: keyBackend.id });
      const challenges = createChallengeStore(() => ctx.config.now());
      ceremonies = createCeremonies({ db: ctx.db, config: ctx.config, challenges, lib: opts.lib });
    },

    routes(app: Hono) {
      app.get("/status", (c) =>
        c.json({ registered: ceremonies.registered(), unlocked: masterKey !== null }),
      );

      app.post("/register/options", async (c) => c.json(await ceremonies.registerOptions()));

      app.post("/register/verify", async (c) => {
        await ceremonies.registerVerify(await jsonBody(c));
        // Unlock persists the master key on first run; if that write fails
        // (locked keychain, read-only FS) roll back the just-committed passkey
        // row so re-registration isn't blocked by the 403 already-registered guard.
        try {
          await unlock(c);
        } catch (e) {
          lock(); // symmetric rollback: undo any partial key/unlock state too
          ceremonies.unregister();
          throw e;
        }
        return c.json({ verified: true });
      });

      app.post("/login/options", async (c) => c.json(await ceremonies.loginOptions()));

      app.post("/login/verify", async (c) => {
        await ceremonies.loginVerify(await jsonBody(c));
        await unlock(c);
        return c.json({ verified: true });
      });

      app.post("/logout", (c) => {
        const token = getCookie(c, SESSION_COOKIE);
        if (token) opts.sessions.destroy(token);
        lock();
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        return c.json({ loggedOut: true });
      });
    },

    shutdown() {
      lock();
      opts.sessions.clear();
    },
  };
}
