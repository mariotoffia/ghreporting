// Credential provider contract (PLUGIN.md §Credential Providers, DDD.md §3.4).
// A provider understands one credential *type*: how to describe it to the UI and
// how to validate it server-side. Secret material never reaches the browser.
import type { ServiceContext } from "../../kernel/ports";

export interface CredentialFieldSpec {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
}

export interface CredentialTypeMeta {
  type: string; // "github-pat"
  title: string; // "GitHub Personal Access Token"
  helpUrl: string; // where a human creates one
  fields: CredentialFieldSpec[]; // what the UI must collect
  requiredScopes: string[]; // documented, also checked by validate()
}

export type CredentialStatus =
  | { state: "ok"; scopes?: string[]; expiresAt?: string }
  | { state: "expiring"; expiresAt: string; daysLeft: number }
  | { state: "invalid"; reason: string };

export interface CredentialProvider {
  readonly type: string;
  describe(): CredentialTypeMeta;
  /** Server-side check against the real API. Cheap; called at save + every 6h. */
  validate(secret: string, ctx: ServiceContext): Promise<CredentialStatus>;
}
