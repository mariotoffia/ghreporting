// Passkey ceremonies (T4.1, ADR 0007): glue between our passkeys table and
// @simplewebauthn/server v13. One resident platform passkey (Touch ID),
// rpID "localhost" — a secure context over plain local HTTP.
// The lib is injectable so unit tests exercise our glue, not WebAuthn crypto.
import type { Database } from "bun:sqlite";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { AppError } from "../../kernel/errors";
import type { AppConfig } from "../../kernel/ports";

export const RP_ID = "localhost";
export const RP_NAME = "ghreporting";
const CHALLENGE_TTL_MS = 5 * 60_000;

export interface WebAuthnLib {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

export const realWebAuthnLib: WebAuthnLib = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

/** In-memory, single-use challenges with a 5-min TTL read via config.now(). */
export function createChallengeStore(now: () => Date, ttlMs = CHALLENGE_TTL_MS) {
  const challenges = new Map<"register" | "login", { value: string; expires: number }>();
  return {
    put(kind: "register" | "login", value: string) {
      challenges.set(kind, { value, expires: now().getTime() + ttlMs });
    },
    /** Consumes the challenge — a second take (replay) returns null. */
    take(kind: "register" | "login"): string | null {
      const c = challenges.get(kind);
      challenges.delete(kind);
      if (!c || now().getTime() > c.expires) return null;
      return c.value;
    },
  };
}

export type ChallengeStore = ReturnType<typeof createChallengeStore>;

interface PasskeyRow {
  id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  created_at: string;
}

const expiredChallenge = () =>
  new AppError(
    "auth.challenge_expired",
    "challenge missing or expired — restart the ceremony",
    400,
  );
const verifyFailed = (detail: string) =>
  new AppError("auth.verify_failed", `ceremony verification failed: ${detail}`, 401);

export function createCeremonies(opts: {
  db: Database;
  config: AppConfig;
  challenges: ChallengeStore;
  lib?: WebAuthnLib;
}) {
  const { db, config, challenges } = opts;
  const lib = opts.lib ?? realWebAuthnLib;

  const passkey = () => db.query("SELECT * FROM passkeys LIMIT 1").get() as PasskeyRow | null;

  /** Single-owner tool: one passkey ever; re-registration is the recovery procedure. */
  function guardUnregistered(): void {
    if (passkey()) {
      throw new AppError(
        "auth.already_registered",
        "a passkey already exists — see the recovery procedure in services/auth/service.ts",
        403,
      );
    }
  }

  return {
    registered: () => passkey() !== null,

    /** Compensating rollback: drop the passkey row if unlock fails post-insert. */
    unregister() {
      db.query("DELETE FROM passkeys").run();
    },

    async registerOptions() {
      guardUnregistered();
      const options = await lib.generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: "owner",
        attestationType: "none",
        authenticatorSelection: {
          authenticatorAttachment: "platform", // Touch ID / Windows Hello
          userVerification: "required",
          residentKey: "preferred",
        },
      });
      challenges.put("register", options.challenge);
      return options;
    },

    async registerVerify(response: unknown): Promise<void> {
      guardUnregistered();
      const expectedChallenge = challenges.take("register");
      if (!expectedChallenge) throw expiredChallenge();
      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await lib.verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge,
          expectedOrigin: config.origins,
          expectedRPID: RP_ID,
        });
      } catch (e) {
        throw verifyFailed(String(e));
      }
      if (!verification.verified || !verification.registrationInfo) {
        throw verifyFailed("attestation not verified");
      }
      const cred = verification.registrationInfo.credential;
      db.query(
        `INSERT INTO passkeys(id, public_key, counter, transports, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)`,
      ).run(
        cred.id,
        cred.publicKey,
        cred.counter,
        cred.transports ? JSON.stringify(cred.transports) : null,
        config.now().toISOString(),
      );
    },

    async loginOptions() {
      const options = await lib.generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: "required",
      });
      challenges.put("login", options.challenge);
      return options;
    },

    async loginVerify(response: unknown): Promise<void> {
      const row = passkey();
      if (!row) throw new AppError("auth.not_registered", "no passkey registered", 401);
      const expectedChallenge = challenges.take("login");
      if (!expectedChallenge) throw expiredChallenge();
      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        verification = await lib.verifyAuthenticationResponse({
          response: response as AuthenticationResponseJSON,
          expectedChallenge,
          expectedOrigin: config.origins,
          expectedRPID: RP_ID,
          credential: {
            id: row.id,
            // copy: bun:sqlite BLOBs are Uint8Array<ArrayBufferLike>; the lib wants ArrayBuffer-backed
            publicKey: new Uint8Array(row.public_key),
            counter: row.counter,
            transports: row.transports ? JSON.parse(row.transports) : undefined,
          },
        });
      } catch (e) {
        throw verifyFailed(String(e));
      }
      if (!verification.verified) throw verifyFailed("assertion not verified");
      const newCounter = verification.authenticationInfo.newCounter;
      // Clone signal (DDD.md §3.5): a counter that stopped increasing means a copy
      // of the credential may exist. Counter 0 → 0 is fine (platform authenticators
      // commonly never increment); an actual regression or stall is not.
      if ((row.counter > 0 || newCounter > 0) && newCounter <= row.counter) {
        throw new AppError(
          "auth.counter_regression",
          "assertion counter did not increase — possible cloned authenticator",
          401,
        );
      }
      db.query("UPDATE passkeys SET counter=?1 WHERE id=?2").run(newCounter, row.id);
    },
  };
}

export type Ceremonies = ReturnType<typeof createCeremonies>;
