// Reusable CredentialProvider contract (PLUGIN.md §Credential Providers,
// TESTS.md §5). Every provider maps its API's answers to ok/expiring/invalid and
// never leaks secret material into the returned status. Runs the same assertions
// against every provider; each supplies fake-fetch scenarios for the three states.
import { describe, expect, it } from "bun:test";
import type { ServiceContext } from "../../kernel/ports";
import type { CredentialProvider } from "./ports";

export interface ProviderConformanceScenarios {
  now: Date; // fixed clock for the expiry math
  secret: string; // a stand-in secret; must never appear in a returned status
  ok: typeof fetch; // fake fetch yielding a healthy credential
  expiring: typeof fetch; // fake fetch yielding a soon-to-expire credential
  invalid: typeof fetch; // fake fetch yielding a rejected credential
}

export function credentialProviderConformance(
  type: string,
  make: (fetchImpl: typeof fetch) => CredentialProvider,
  s: ProviderConformanceScenarios,
) {
  const ctx = { config: { now: () => s.now } } as unknown as ServiceContext;
  describe(`CredentialProvider conformance: ${type}`, () => {
    it("maps a healthy credential to ok", async () => {
      expect((await make(s.ok).validate(s.secret, ctx)).state).toBe("ok");
    });
    it("maps a soon-to-expire credential to expiring", async () => {
      expect((await make(s.expiring).validate(s.secret, ctx)).state).toBe("expiring");
    });
    it("maps a rejected credential to invalid", async () => {
      expect((await make(s.invalid).validate(s.secret, ctx)).state).toBe("invalid");
    });
    it("leaks no secret material into the returned status", async () => {
      for (const fetchImpl of [s.ok, s.expiring, s.invalid]) {
        const result = await make(fetchImpl).validate(s.secret, ctx);
        expect(JSON.stringify(result)).not.toContain(s.secret);
      }
    });
  });
}
