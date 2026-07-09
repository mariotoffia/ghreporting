import type { Database } from "bun:sqlite";
import type { Hono } from "hono";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface AppConfig {
  port: number;
  dbPath: string;
  secretsPath: string; // ~/.ghreporting/secrets.enc.json (encrypted-file backend)
  masterKeyPath: string; // ~/.ghreporting/master.key (non-darwin master-key fallback)
  org?: string;
  origins: string[]; // WebAuthn + CORS allow-list (dev :5173, packaged :8787)
  secretBackend?: string; // "keychain" | "encrypted-file" override
  packaged: boolean; // true inside the compiled binary
  scheduler: boolean; // background refresh (T2.6): packaged || GHR_SCHEDULER=1
  now(): Date; // the ONLY clock services may read (TESTS.md §2.2)
}

export type AppEvent =
  | { type: "sync.started"; dataset: string; scope: string }
  | { type: "sync.completed"; dataset: string; scope: string; rows: number }
  | { type: "sync.failed"; dataset: string; scope: string; error: string }
  | { type: "credential.expiring"; id: string; daysLeft: number }
  | { type: "credential.invalid"; id: string }
  | { type: "notification.changed"; id: number }
  | { type: "auth.unlocked" };

export interface EventBus {
  emit(e: AppEvent): void;
  on<T extends AppEvent["type"]>(
    type: T,
    fn: (e: Extract<AppEvent, { type: T }>) => void,
  ): () => void; // returns unsubscribe
}

export interface NotificationInput {
  key: string; // dedupe identity, e.g. "credential.github-pat:default.expiring"
  level: "info" | "warning" | "error";
  title: string;
  body?: string;
  source: string; // service name
}

/** Service-facing secrets port. Throws SecretsLockedError until auth unlocks it. */
export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

/**
 * A place secret bytes rest (keychain, encrypted file, …). The credentials
 * service picks one via `available()` and binds it as the `SecretStore`. No
 * `list()` on purpose — which accounts exist lives in `credentials_meta`, so a
 * backend never enumerates a user's whole keychain (PLUGIN.md §Secret Store).
 */
export interface SecretStoreBackend {
  readonly id: string; // "keychain" | "encrypted-file" | …
  /** Can this backend work here? (platform, binary present, dir writable) */
  available(): Promise<boolean>;
  get(account: string): Promise<string | null>; // null = not found (not an error)
  set(account: string, secret: string): Promise<void>; // overwrite allowed
  delete(account: string): Promise<void>; // idempotent
}

export interface ServiceContext {
  db: Database;
  bus: EventBus;
  config: AppConfig;
  log: Logger;
  notify(n: NotificationInput): void;
  secrets: SecretStore;
}

export interface MicroService {
  readonly name: string; // route prefix /api/<name>
  init(ctx: ServiceContext): Promise<void> | void;
  routes?(app: Hono, ctx: ServiceContext): void; // receives a sub-app mounted at /api/<name>
  shutdown?(): Promise<void> | void;
}
