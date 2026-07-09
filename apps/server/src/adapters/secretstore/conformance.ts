// Reusable SecretStoreBackend contract (PLUGIN.md §Secret Store, TESTS.md §5).
// Every backend is "done" when this passes — not when its author's hand-picked
// tests pass. keychain.test.ts runs it only under RUN_KEYCHAIN=1 on darwin.
import { describe, expect, it } from "bun:test";
import type { SecretStoreBackend } from "../../kernel/ports";

export function secretStoreConformance(name: string, make: () => Promise<SecretStoreBackend>) {
  describe(`SecretStoreBackend conformance: ${name}`, () => {
    it("round-trips a secret", async () => {
      const s = await make();
      await s.set("a1", "hunter2");
      expect(await s.get("a1")).toBe("hunter2");
    });
    it("returns null for a missing account", async () => {
      expect(await (await make()).get("nope")).toBeNull();
    });
    it("overwrites on set to an existing account", async () => {
      const s = await make();
      await s.set("a1", "old");
      await s.set("a1", "new");
      expect(await s.get("a1")).toBe("new");
    });
    it("deletes idempotently", async () => {
      const s = await make();
      await s.set("a1", "x");
      await s.delete("a1");
      await s.delete("a1");
      expect(await s.get("a1")).toBeNull();
    });
  });
}
