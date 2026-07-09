import type { Logger } from "./ports";

export function createLogger(scope: string): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>) =>
    console.error(JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...fields }));
  return {
    info: (m, f) => line("info", m, f),
    warn: (m, f) => line("warn", m, f),
    error: (m, f) => line("error", m, f),
    child: (s) => createLogger(`${scope}.${s}`),
  };
}
