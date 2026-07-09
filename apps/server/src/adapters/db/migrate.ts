import type { Database } from "bun:sqlite";

/** A schema step: TS module carrying a SQL template string (ADR 0003). */
export interface Migration {
  id: string;
  sql: string;
}

/**
 * Apply pending migrations in array order, each inside its own transaction so a
 * failing migration leaves no trace of itself. Returns the ids applied this run.
 */
export function runMigrations(db: Database, all: Migration[]): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const done = new Set(
    db
      .query("SELECT id FROM schema_migrations")
      .values()
      .map((r) => r[0] as string),
  );
  const applied: string[] = [];
  for (const m of all) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql); // multi-statement — supported by bun:sqlite
      db.query("INSERT INTO schema_migrations(id, applied_at) VALUES (?, ?)").run(
        m.id,
        new Date().toISOString(), // adapter-level timestamp; drives no logic
      );
    })();
    applied.push(m.id);
  }
  return applied;
}
