import type { AppConfig } from "./ports";

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  const expand = (p: string) => (p.startsWith("~/") ? `${home}/${p.slice(2)}` : p);
  return Object.freeze({
    port: Number(env.PORT ?? 8787),
    dbPath: expand(env.GHR_DB_PATH ?? "~/.ghreporting/ghreporting.db"),
    org: env.GHR_ORG,
    origins: env.GHR_ORIGINS?.split(",").map((s) => s.trim()) ?? [
      "http://localhost:5173",
      "http://localhost:8787",
    ],
    secretBackend: env.GHR_SECRET_BACKEND,
    packaged: env.GHR_PACKAGED === "1",
    now: () => new Date(),
  });
}
