import { afterEach, describe, expect, it } from "bun:test";
import { secretStoreConformance } from "./conformance";
import { createKeychainBackend } from "./keychain";

// The real-keychain conformance run is manual (TESTS.md §4): darwin only, and only
// when RUN_KEYCHAIN=1, so CI and non-macOS teammates stay green. Throwaway service
// name keeps it isolated from the app's real `ghreporting` entries.
const RUN = process.platform === "darwin" && process.env.RUN_KEYCHAIN === "1";
if (RUN) {
  const service = `ghreporting-test-${crypto.randomUUID()}`;
  const make = async () => createKeychainBackend({ service });
  // conformance only ever touches accounts "a1"/"nope"; scrub "a1" between cases.
  afterEach(async () => {
    await createKeychainBackend({ service }).delete("a1");
  });
  secretStoreConformance("keychain", make);
}

describe("keychain backend", () => {
  it("is unavailable off darwin (never shells out to `security`)", async () => {
    const backend = createKeychainBackend({ platform: "linux" });
    expect(await backend.available()).toBe(false);
  });

  it("defaults its service name to ghreporting", () => {
    expect(createKeychainBackend().id).toBe("keychain");
  });
});
