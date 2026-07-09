// Pure WebAuthn ceremony orchestration (ADR 0007, T4.1/T4.2 routes). Kept free of
// React so the register/login sequences and the cancellation rule are unit-testable
// without a DOM; Login.tsx is a thin shell over these.
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type { Api } from "../../lib/api";

export type AuthStatus = { registered: boolean; unlocked: boolean };

/** Which screen the auth status maps to (first-run setup → login → app). */
export function nextScreen(s: AuthStatus): "setup" | "login" | "app" {
  if (!s.registered) return "setup";
  return s.unlocked ? "app" : "login";
}

/** First-run: create a passkey. A verified ceremony unlocks the server-side. */
export async function register(api: Api): Promise<void> {
  const options = await api.post<PublicKeyCredentialCreationOptionsJSON>(
    "/api/auth/register/options",
  );
  const attestation = await startRegistration({ optionsJSON: options });
  await api.post("/api/auth/register/verify", attestation);
}

/** Unlock an existing passkey and open a session. */
export async function login(api: Api): Promise<void> {
  const options = await api.post<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options");
  const assertion = await startAuthentication({ optionsJSON: options });
  await api.post("/api/auth/login/verify", assertion);
}

/**
 * Run a ceremony, treating a user-cancelled prompt (`NotAllowedError`, which the
 * browser lib passes through unwrapped) as a quiet no-op. Returns whether it
 * completed; every other error propagates to become an inline message.
 */
export async function runCeremony(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    if (e instanceof Error && e.name === "NotAllowedError") return false;
    throw e;
  }
}
