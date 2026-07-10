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
  flow?: "fields" | "device"; // default "fields"; the Settings UI picks the control
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

/** What the browser needs to display the device ceremony (never the deviceCode). */
export interface DeviceFlowStart {
  userCode: string;
  verificationUri: string;
  interval: number; // seconds between polls (GitHub's minimum)
  expiresIn: number; // seconds until the code dies
}

/**
 * Optional secondary port (interface segregation, ADR 0018): a CredentialProvider MAY also
 * implement it to obtain its secret by OAuth Device Flow instead of a typed field. The
 * `deviceCode` returned by `startDevice` stays server-side — only the service holds it.
 */
export interface DeviceFlowProvider {
  startDevice(ctx: ServiceContext): Promise<DeviceFlowStart & { deviceCode: string }>;
  /** pending → { done:false }; authorized → { done:true, secret }; hard errors throw. */
  pollDevice(
    deviceCode: string,
    ctx: ServiceContext,
  ): Promise<{ done: false } | { done: true; secret: string }>;
}
