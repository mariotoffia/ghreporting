import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../adapters/db/migrate";
import { migrations } from "../../adapters/db/migrations";
import { loadConfig } from "../../kernel/config";
import { AppError } from "../../kernel/errors";
import type { AppConfig } from "../../kernel/ports";
import { fakeClock, fakeWebAuthnLib } from "./testutil";
import { createCeremonies, createChallengeStore } from "./webauthn";

const MIN = 60_000;

function harness(script: Parameters<typeof fakeWebAuthnLib>[0] = {}) {
  const clock = fakeClock();
  const db = new Database(":memory:");
  runMigrations(db, migrations);
  const config: AppConfig = { ...loadConfig({ HOME: "/tmp" }), now: clock.now };
  const challenges = createChallengeStore(config.now);
  const { lib, calls } = fakeWebAuthnLib(script);
  const ceremonies = createCeremonies({ db, config, challenges, lib });
  return { clock, db, config, challenges, ceremonies, calls };
}

// the response payload is opaque to our glue — the (fake) library interprets it
const response = { id: "passkey-1" };

async function register(h: ReturnType<typeof harness>) {
  await h.ceremonies.registerOptions();
  await h.ceremonies.registerVerify(response);
}

describe("challenge store", () => {
  it("take() returns the stored challenge once, then null", () => {
    const clock = fakeClock();
    const store = createChallengeStore(clock.now);
    store.put("register", "abc");
    expect(store.take("register")).toBe("abc");
    expect(store.take("register")).toBeNull(); // single-use
  });

  it("expires a challenge after the 5-minute TTL", () => {
    const clock = fakeClock();
    const store = createChallengeStore(clock.now);
    store.put("login", "abc");
    clock.advance(5 * MIN + 1);
    expect(store.take("login")).toBeNull();
  });
});

describe("register ceremony", () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h.db.close());

  it("issues options and remembers the challenge", async () => {
    h = harness();
    await h.ceremonies.registerOptions();
    expect(h.challenges.take("register")).toBe("reg-challenge");
    const args = h.calls.generateRegistrationOptions?.[0] as Record<string, unknown>;
    expect(args.rpID).toBe("localhost");
    expect(args.userName).toBe("owner");
  });

  it("guards the single passkey: a second registration is 403", async () => {
    h = harness();
    await register(h);
    expect(h.ceremonies.registered()).toBe(true);
    const err = await h.ceremonies.registerOptions().catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("auth.already_registered");
    expect(err.status).toBe(403);
    // the verify path is guarded too, not just options
    const err2 = await h.ceremonies.registerVerify(response).catch((e) => e);
    expect(err2.code).toBe("auth.already_registered");
  });

  it("rejects a verify whose challenge has expired with 400", async () => {
    h = harness();
    await h.ceremonies.registerOptions();
    h.clock.advance(5 * MIN + 1);
    const err = await h.ceremonies.registerVerify(response).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(400);
    expect(h.ceremonies.registered()).toBe(false);
  });

  it("passes the configured origin allow-list through to the library", async () => {
    h = harness();
    await register(h);
    const args = h.calls.verifyRegistrationResponse?.[0] as Record<string, unknown>;
    expect(args.expectedOrigin).toEqual(h.config.origins);
    expect(args.expectedRPID).toBe("localhost");
    expect(args.expectedChallenge).toBe("reg-challenge");
  });

  it("persists the passkey row from registrationInfo.credential", async () => {
    h = harness();
    await register(h);
    const row = h.db.query("SELECT * FROM passkeys").get() as {
      id: string;
      public_key: Uint8Array;
      counter: number;
      transports: string;
      created_at: string;
    };
    expect(row.id).toBe("passkey-1");
    expect([...row.public_key]).toEqual([1, 2, 3, 4]);
    expect(row.counter).toBe(0);
    expect(JSON.parse(row.transports)).toEqual(["internal"]);
    expect(row.created_at).toBe(h.config.now().toISOString());
  });

  it("maps a library rejection to a 401 and stores nothing", async () => {
    h = harness({ throwOnVerify: new Error("bad attestation") });
    await h.ceremonies.registerOptions();
    const err = await h.ceremonies.registerVerify(response).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(h.ceremonies.registered()).toBe(false);
  });

  it("maps a !verified result to a 401", async () => {
    h = harness({ verified: false });
    await h.ceremonies.registerOptions();
    const err = await h.ceremonies.registerVerify(response).catch((e) => e);
    expect(err.status).toBe(401);
  });
});

describe("login ceremony", () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => h.db.close());

  const storedCounter = () =>
    (h.db.query("SELECT counter FROM passkeys").get() as { counter: number }).counter;

  it("rejects login when no passkey is registered", async () => {
    h = harness();
    await h.ceremonies.loginOptions();
    const err = await h.ceremonies.loginVerify(response).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
  });

  it("verifies an assertion and advances the stored counter", async () => {
    h = harness({ newCounter: 7 });
    await register(h);
    await h.ceremonies.loginOptions();
    await h.ceremonies.loginVerify(response);
    expect(storedCounter()).toBe(7);
    const args = h.calls.verifyAuthenticationResponse?.[0] as {
      credential: { id: string; publicKey: Uint8Array; counter: number; transports: string[] };
      expectedOrigin: string[];
    };
    expect(args.credential.id).toBe("passkey-1");
    expect([...args.credential.publicKey]).toEqual([1, 2, 3, 4]);
    expect(args.credential.transports).toEqual(["internal"]);
    expect(args.expectedOrigin).toEqual(h.config.origins);
  });

  it("accepts counter 0 → 0 (platform authenticators that never increment)", async () => {
    h = harness({ newCounter: 0 });
    await register(h);
    await h.ceremonies.loginOptions();
    await h.ceremonies.loginVerify(response); // must not throw
    expect(storedCounter()).toBe(0);
  });

  it("rejects a counter regression with 401 and leaves the counter unchanged", async () => {
    h = harness({ newCounter: 7 });
    await register(h);
    await h.ceremonies.loginOptions();
    await h.ceremonies.loginVerify(response); // counter now 7
    const { lib: cloned } = fakeWebAuthnLib({ newCounter: 3 }); // clone replays an old counter
    const ceremonies = createCeremonies({
      db: h.db,
      config: h.config,
      challenges: h.challenges,
      lib: cloned,
    });
    await ceremonies.loginOptions();
    const err = await ceremonies.loginVerify(response).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("auth.counter_regression");
    expect(err.status).toBe(401);
    expect(storedCounter()).toBe(7); // unchanged
  });

  it("rejects a login whose challenge has expired with 400", async () => {
    h = harness();
    await register(h);
    await h.ceremonies.loginOptions();
    h.clock.advance(5 * MIN + 1);
    const err = await h.ceremonies.loginVerify(response).catch((e) => e);
    expect(err.status).toBe(400);
  });

  it("maps a library rejection to a 401 and leaves the counter unchanged", async () => {
    h = harness({ newCounter: 7 });
    await register(h);
    await h.ceremonies.loginOptions();
    await h.ceremonies.loginVerify(response);
    const { lib: throwing } = fakeWebAuthnLib({ throwOnVerify: new Error("bad signature") });
    const ceremonies = createCeremonies({
      db: h.db,
      config: h.config,
      challenges: h.challenges,
      lib: throwing,
    });
    await ceremonies.loginOptions();
    const err = await ceremonies.loginVerify(response).catch((e) => e);
    expect(err.status).toBe(401);
    expect(storedCounter()).toBe(7);
  });
});
