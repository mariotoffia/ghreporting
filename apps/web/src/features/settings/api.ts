// Typed client over the `credentials` uService routes (/api/credentials), built on the
// shared `api` singleton. Secrets ride the request body only — never a query string or log
// (ARCHITECTURE.md §6–7). The Settings panel is driven entirely by what each provider's
// `describe()` declares, so a new Credential Provider needs no UI code (T12.1, ADR 0018).
import { api } from "../../lib/client";

/** Mirrors the server CredentialFieldSpec (credentials/ports.ts). */
export interface CredentialFieldSpec {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
}

/** Mirrors the server CredentialTypeMeta; `flow` picks the control (fields form vs device). */
export interface CredentialTypeMeta {
  type: string;
  title: string;
  helpUrl: string;
  fields: CredentialFieldSpec[];
  requiredScopes: string[];
  flow?: "fields" | "device";
}

/** One entry per registered provider (GET /api/credentials). status null = not configured. */
export interface CredentialEntry {
  id: string;
  type: string;
  describe: CredentialTypeMeta;
  status: "ok" | "expiring" | "invalid" | null;
  expiresAt: string | null;
  statusDetail: string | null;
}

/** What the browser shows for a device ceremony — never the deviceCode (kept server-side). */
export interface DeviceStart {
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export type DevicePoll = { pending: true } | { status: "ok" | "expiring" | "invalid" };

export const CREDENTIALS_KEY = ["credentials"] as const;

export const listCredentials = () => api.get<CredentialEntry[]>("/api/credentials");
export const putCredential = (id: string, secret: string) =>
  api.put<{ id: string; status: string }>(`/api/credentials/${id}`, { secret });
export const deleteCredential = (id: string) =>
  api.del<{ deleted: boolean }>(`/api/credentials/${id}`);
export const validateCredential = (id: string) =>
  api.post<{ id: string; status: string }>(`/api/credentials/${id}/validate`);
export const startDevice = (id: string) =>
  api.post<DeviceStart>(`/api/credentials/${id}/device/start`);
export const pollDevice = (id: string) =>
  api.post<DevicePoll>(`/api/credentials/${id}/device/poll`);
