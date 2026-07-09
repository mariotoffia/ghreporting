// Test doubles for the auth uService: a scripted WebAuthnLib (the library's
// crypto is its own project's job — we unit-test our glue, TESTS.md §4) and an
// in-memory SecretStoreBackend so no test ever touches the real macOS keychain.
import type { SecretStoreBackend } from "../../kernel/ports";
import type { WebAuthnLib } from "./webauthn";

/** A controllable clock for injected `config.now()` (TESTS.md §2.2). */
export function fakeClock(startIso = "2026-07-09T10:00:00Z") {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

export interface FakeWebAuthnScript {
  /** Counter the fake's verifyAuthenticationResponse reports back. */
  newCounter?: number;
  /** Force !verified results. */
  verified?: boolean;
  /** Make verify calls throw (simulates the library rejecting a response). */
  throwOnVerify?: Error;
}

/** Records every call's args in `calls` so tests can assert what we passed through. */
export function fakeWebAuthnLib(script: FakeWebAuthnScript = {}) {
  const calls: Record<string, unknown[]> = {
    generateRegistrationOptions: [],
    verifyRegistrationResponse: [],
    generateAuthenticationOptions: [],
    verifyAuthenticationResponse: [],
  };
  const verified = script.verified ?? true;
  // the double returns only the minimal shape our glue reads; one honest cast at the end
  const fake = {
    generateRegistrationOptions: async (opts: unknown) => {
      calls.generateRegistrationOptions?.push(opts);
      return { challenge: "reg-challenge" };
    },
    verifyRegistrationResponse: async (opts: unknown) => {
      calls.verifyRegistrationResponse?.push(opts);
      if (script.throwOnVerify) throw script.throwOnVerify;
      if (!verified) return { verified: false };
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: "passkey-1",
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
            transports: ["internal"],
          },
        },
      };
    },
    generateAuthenticationOptions: async (opts: unknown) => {
      calls.generateAuthenticationOptions?.push(opts);
      return { challenge: "login-challenge" };
    },
    verifyAuthenticationResponse: async (opts: unknown) => {
      calls.verifyAuthenticationResponse?.push(opts);
      if (script.throwOnVerify) throw script.throwOnVerify;
      return {
        verified,
        authenticationInfo: { newCounter: script.newCounter ?? 1 },
      };
    },
  };
  return { lib: fake as unknown as WebAuthnLib, calls };
}

/** In-memory SecretStoreBackend — for master-key tests without keychain or disk. */
export function memoryBackend(id = "memory"): SecretStoreBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    id,
    store,
    available: async () => true,
    get: async (account) => store.get(account) ?? null,
    set: async (account, secret) => {
      store.set(account, secret);
    },
    delete: async (account) => {
      store.delete(account);
    },
  };
}
