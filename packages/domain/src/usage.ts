/**
 * Usage reporting — shared kernel types. Pure TypeScript, zero dependencies.
 * Vocabulary is defined in UBIQUITOUS.md; invariants in DDD.md §3.1.
 */

/** Billing hierarchy exactly as GitHub reports it: product / sku / model. */
export interface ProductPath {
  /** e.g. "copilot", "actions" */
  product: string;
  /** e.g. "copilot_premium_request" */
  sku: string;
  /** e.g. "gpt-4.1", "claude-sonnet-4" — absent when the SKU has no model dimension */
  model?: string;
}

/**
 * One immutable, day-grained usage observation synced from GitHub.
 * The local database stores these; every report aggregates over them.
 */
export interface UsageFact {
  /** ISO date, YYYY-MM-DD */
  day: string;
  org: string;
  /** GitHub login — absent for org-level facts */
  user?: string;
  path: ProductPath;
  /** What was measured, e.g. "premium_requests", "code_suggestions" */
  metric: string;
  quantity: number;
  /** e.g. "requests", "seats" */
  unit: string;
  /** Premium-request model multiplier; 1 for everything else */
  multiplier: number;
  grossAmountUsd?: number;
  netAmountUsd?: number;
}

/** GitHub's list price per premium request (USD), used when the API gives no amount. */
export const DEFAULT_PREMIUM_REQUEST_PRICE_USD = 0.04;

export interface PremiumRequestCostArgs {
  /** Raw request count before the model multiplier is applied */
  requests: number;
  /** Model multiplier (e.g. 0.33 for cheap models, 1 for standard, 10 for expensive) */
  multiplier: number;
  /** Requests covered by the plan's included allowance (already multiplier-adjusted) */
  included?: number;
  pricePerRequestUsd?: number;
}

/**
 * Cost in USD of premium requests beyond the included allowance.
 * billable = max(0, requests × multiplier − included); cost = billable × price, rounded to cents.
 */
export function premiumRequestCost(args: PremiumRequestCostArgs): number {
  const { requests, multiplier, included = 0 } = args;
  const price = args.pricePerRequestUsd ?? DEFAULT_PREMIUM_REQUEST_PRICE_USD;
  if (requests < 0 || multiplier < 0 || included < 0 || price < 0) {
    throw new RangeError("premiumRequestCost: negative inputs are not allowed");
  }
  const billable = Math.max(0, requests * multiplier - included);
  return roundUsd(billable * price);
}

/** Round to whole cents, avoiding float dust (e.g. 1.005 → 1.01). */
export function roundUsd(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
