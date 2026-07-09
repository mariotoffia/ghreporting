import type { Database } from "bun:sqlite";

/**
 * Dimension-table helpers — the only way connectors write shared tables
 * (orgs, users, teams, skus), so dimension rows stay consistent (PLUGIN.md rule 3).
 */

// All three upserts conflict on the STABLE GitHub numeric id, not the mutable
// login/slug: a rename must update in place, not abort on the id PK and
// crash-loop every later sync. (A reused login under a new id still fails
// loudly on the UNIQUE(login) constraint — rare enough to stay an error.)

export function upsertOrg(
  db: Database,
  o: { id: number; login: string; name?: string | null },
): number {
  return (
    db
      .query(
        "INSERT INTO orgs(id, login, name) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET login=?2, name=COALESCE(?3, name) RETURNING id",
      )
      .get(o.id, o.login, o.name ?? null) as { id: number }
  ).id;
}

export function upsertUser(
  db: Database,
  u: { id: number; login: string; name?: string | null },
): number {
  return (
    db
      .query(
        "INSERT INTO users(id, login, name) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET login=?2, name=COALESCE(?3, name) RETURNING id",
      )
      .get(u.id, u.login, u.name ?? null) as { id: number }
  ).id;
}

export function upsertTeam(
  db: Database,
  t: {
    id: number;
    orgId: number;
    slug: string;
    name?: string | null;
    parentTeamId?: number | null;
  },
): number {
  return (
    db
      .query(
        "INSERT INTO teams(id, org_id, slug, name, parent_team_id) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET org_id=?2, slug=?3, name=COALESCE(?4, name), parent_team_id=?5 RETURNING id",
      )
      .get(t.id, t.orgId, t.slug, t.name ?? null, t.parentTeamId ?? null) as { id: number }
  ).id;
}

/** Insert-or-get the product row, then the sku row; returns the sku id. */
export function ensureSku(db: Database, product: string, sku: string): number {
  const productId = (
    db
      .query(
        "INSERT INTO products(name) VALUES (?1) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id",
      )
      .get(product) as { id: number }
  ).id;
  return (
    db
      .query(
        "INSERT INTO skus(product_id, name) VALUES (?1, ?2) ON CONFLICT(product_id, name) DO UPDATE SET name=?2 RETURNING id",
      )
      .get(productId, sku) as { id: number }
  ).id;
}

/** The price row valid on `day` for `model`, or null when the model is unknown. */
export function modelPriceOn(
  db: Database,
  model: string,
  day: string,
): { multiplier: number; priceUsd: number } | null {
  const row = db
    .query(
      "SELECT multiplier, price_per_unit_usd FROM model_prices WHERE model=?1 AND valid_from<=?2 ORDER BY valid_from DESC LIMIT 1",
    )
    .get(model, day) as { multiplier: number; price_per_unit_usd: number } | null;
  return row ? { multiplier: row.multiplier, priceUsd: row.price_per_unit_usd } : null;
}

/**
 * The one shared fact upsert every connector uses. The conflict target must name
 * the ux_usage_fact expression index — SQLite treats NULLs as distinct in plain
 * UNIQUE constraints, so org-level facts (user_id IS NULL) would otherwise
 * duplicate on every re-sync (ARCHITECTURE.md §5).
 */
export const insertFactSql = `INSERT INTO usage_facts(day, org_id, user_id, sku_id, model, metric, quantity, unit,
                        multiplier, gross_amount_usd, net_amount_usd, source, raw)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(day, org_id, COALESCE(user_id, 0), sku_id, COALESCE(model, ''), metric, source)
DO UPDATE SET quantity=excluded.quantity, multiplier=excluded.multiplier,
  gross_amount_usd=excluded.gross_amount_usd, net_amount_usd=excluded.net_amount_usd,
  raw=excluded.raw`;
