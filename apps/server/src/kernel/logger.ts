import type { Logger } from "./ports";

export function createLogger(scope: string): Logger {
  const line = (level: string, msg: string, fields?: Record<string, unknown>) => {
    // Reserved keys win over caller fields (a field named `level`/`scope` must not
    // relabel the record), and a logger must never throw — an unserializable field
    // (BigInt, circular) would otherwise defeat the catch blocks that call it.
    const base = { t: new Date().toISOString(), level, scope, msg };
    let out: string;
    try {
      out = JSON.stringify({ ...fields, ...base });
    } catch {
      out = JSON.stringify({ ...base, fields: "[unserializable]" });
    }
    console.error(out);
  };
  return {
    info: (m, f) => line("info", m, f),
    warn: (m, f) => line("warn", m, f),
    error: (m, f) => line("error", m, f),
    child: (s) => createLogger(`${scope}.${s}`),
  };
}
