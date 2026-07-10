import type { AppConfig } from "./ports";

const DEFAULT_ORIGINS = ["http://localhost:5173", "http://localhost:8787"];

// Public OAuth App client id for GitHub Device Flow sign-in (ADR 0018). SAFE TO COMMIT — a
// client *id* is public (it rides every device-flow request and appears in URLs); only the
// client *secret* must stay hidden, and device flow never uses one. Baked in here so end users
// need zero setup. Leave "" until the maintainer registers the app (then the Settings panel
// shows a clear "sign-in not configured" message and the pasted-PAT path still works).
// GHR_GITHUB_CLIENT_ID can still override this for forks / self-hosted OAuth Apps.
const GITHUB_CLIENT_ID = "Ov23liy55Xl6hGJvlKGk";

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  const expand = (p: string) => (p.startsWith("~/") ? `${home}/${p.slice(2)}` : p);
  // Drop blanks so `GHR_ORIGINS=""` or `"a, ,b"` never yields an empty/`""` allow-list.
  const origins = env.GHR_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Object.freeze({
    // `Number(env.PORT) || 8787`: unset/empty/non-numeric all fall back to the default.
    port: Number(env.PORT) || 8787,
    dbPath: expand(env.GHR_DB_PATH ?? "~/.ghreporting/ghreporting.db"),
    secretsPath: expand(env.GHR_SECRETS_PATH ?? "~/.ghreporting/secrets.enc.json"),
    masterKeyPath: expand(env.GHR_MASTER_KEY_PATH ?? "~/.ghreporting/master.key"),
    org: env.GHR_ORG,
    origins: origins && origins.length > 0 ? origins : DEFAULT_ORIGINS,
    secretBackend: env.GHR_SECRET_BACKEND,
    // Committed default (GITHUB_CLIENT_ID) so users need no env var; env override wins for
    // forks. An empty default stays `undefined` so the provider shows the "not configured" error.
    githubClientId: env.GHR_GITHUB_CLIENT_ID ?? (GITHUB_CLIENT_ID || undefined),
    packaged: env.GHR_PACKAGED === "1",
    // background refresh: on in the packaged app, opt-in (GHR_SCHEDULER=1) in dev
    scheduler: env.GHR_PACKAGED === "1" || env.GHR_SCHEDULER === "1",
    now: () => new Date(),
  });
}
