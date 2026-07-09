import type { AppConfig } from "./ports";

const DEFAULT_ORIGINS = ["http://localhost:5173", "http://localhost:8787"];

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
    org: env.GHR_ORG,
    origins: origins && origins.length > 0 ? origins : DEFAULT_ORIGINS,
    secretBackend: env.GHR_SECRET_BACKEND,
    packaged: env.GHR_PACKAGED === "1",
    // background refresh: on in the packaged app, opt-in (GHR_SCHEDULER=1) in dev
    scheduler: env.GHR_PACKAGED === "1" || env.GHR_SCHEDULER === "1",
    now: () => new Date(),
  });
}
