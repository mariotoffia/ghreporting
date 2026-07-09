import type { Migration } from "../migrate";

/**
 * GitHub's published premium-request model multipliers, verified 2026-07 against
 * docs.github.com → "Model multipliers for annual plans" (request-based billing,
 * legacy since the 2026-06 move to AI credits), priced at $0.04/request.
 * Model keys are the display names the billing usage API returns in `model`.
 * Multipliers are temporal (DDD.md §3.2 ModelPrice): new pricing ⇒ new
 * valid_from rows in a later migration, never an UPDATE.
 */
const MODEL_MULTIPLIERS: ReadonlyArray<[model: string, multiplier: number]> = [
  ["Claude Haiku 4.5", 0.33],
  ["Claude Sonnet 4.5", 6],
  ["Claude Sonnet 4.6", 9],
  ["Claude Opus 4.5", 15],
  ["Claude Opus 4.6", 27],
  ["Claude Opus 4.7", 27],
  ["Claude Opus 4.8", 27],
  ["Gemini 2.5 Pro", 1],
  ["Gemini 3 Flash", 0.33],
  ["Gemini 3 Pro", 6],
  ["Gemini 3.1 Pro", 6],
  ["Gemini 3.5 Flash", 14],
  ["GPT-4o", 0.33],
  ["GPT-4o mini", 0.33],
  ["GPT-5 mini", 0.33],
  ["GPT-5.1", 3],
  ["GPT-5.1-Codex", 3],
  ["GPT-5.1-Codex-Max", 3],
  ["GPT-5.1-Codex-Mini", 0.33],
  ["GPT-5.3-Codex", 6],
  ["GPT-5.4", 6],
  ["GPT-5.4 mini", 6],
  ["GPT-5.5", 57],
  ["Raptor mini", 0.33],
  ["MAI-Code-1-Flash", 0.33],
  ["Copilot code review", 13],
];

const PRICE_PER_REQUEST_USD = 0.04;
const VALID_FROM = "2025-06-01";

const modelPriceSeed = MODEL_MULTIPLIERS.map(
  ([model, multiplier]) =>
    `INSERT INTO model_prices(model, valid_from, multiplier, price_per_unit_usd) VALUES ('${model}', '${VALID_FROM}', ${multiplier}, ${PRICE_PER_REQUEST_USD});`,
).join("\n");

export default {
  id: "0001_init",
  sql: `
CREATE TABLE orgs(id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT);
CREATE TABLE users(id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT);
CREATE TABLE teams(
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  slug TEXT NOT NULL, name TEXT, parent_team_id INTEGER REFERENCES teams(id),
  UNIQUE(org_id, slug));
CREATE TABLE team_members(
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(team_id, user_id));
CREATE TABLE products(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
CREATE TABLE skus(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL, UNIQUE(product_id, name));
CREATE TABLE model_prices(
  model TEXT NOT NULL, valid_from TEXT NOT NULL,
  multiplier REAL NOT NULL, price_per_unit_usd REAL NOT NULL,
  PRIMARY KEY(model, valid_from));
CREATE TABLE usage_facts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL, org_id INTEGER NOT NULL REFERENCES orgs(id),
  user_id INTEGER REFERENCES users(id), sku_id INTEGER NOT NULL REFERENCES skus(id),
  model TEXT, metric TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1,
  gross_amount_usd REAL, net_amount_usd REAL,
  source TEXT NOT NULL, raw TEXT);
CREATE UNIQUE INDEX ux_usage_fact ON usage_facts(
  day, org_id, COALESCE(user_id, 0), sku_id, COALESCE(model, ''), metric, source);
CREATE INDEX ix_usage_facts_day ON usage_facts(day);
CREATE INDEX ix_usage_facts_user ON usage_facts(user_id);
CREATE TABLE sync_state(
  dataset TEXT NOT NULL, scope TEXT NOT NULL,
  synced_from TEXT, synced_to TEXT, etag TEXT, last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle', error TEXT,
  PRIMARY KEY(dataset, scope));
CREATE TABLE notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
  level TEXT NOT NULL CHECK(level IN ('info','warning','error')),
  title TEXT NOT NULL, body TEXT, source TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, read_at TEXT, dismissed_at TEXT);
CREATE TABLE passkeys(
  id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
  transports TEXT, created_at TEXT NOT NULL);
CREATE TABLE credentials_meta(
  id TEXT PRIMARY KEY, type TEXT NOT NULL, backend TEXT NOT NULL, label TEXT,
  status TEXT NOT NULL, status_detail TEXT, expires_at TEXT, checked_at TEXT);
CREATE TABLE workbooks(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, snapshot TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE TABLE bindings(
  id TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  sheet TEXT NOT NULL, range TEXT NOT NULL,
  dataset TEXT NOT NULL, query TEXT NOT NULL, chart_spec TEXT,
  updated_at TEXT NOT NULL);
INSERT INTO products(name) VALUES ('copilot');
INSERT INTO skus(product_id, name)
  SELECT id, 'copilot_premium_request' FROM products WHERE name='copilot';
INSERT INTO skus(product_id, name)
  SELECT id, 'copilot_metrics' FROM products WHERE name='copilot';
${modelPriceSeed}
`,
} satisfies Migration;
