/**
 * Report Definitions — the shared-kernel Reporting aggregate (DDD.md §3.7,
 * UBIQUITOUS.md §Reporting). Pure TypeScript, zero dependencies (ARCHITECTURE.md §2
 * dependency rule) so the server (validate on write/import) and the web designer
 * (validate while editing) run this exact code. A Report is *data*, not code: a stored,
 * parameterized definition that compiles + executes into a read-only view (ADR 0014).
 */

/** A named report input, substituted into panel queries as `{{name}}` at execution. */
export interface ReportParameter {
  name: string;
  kind: "org" | "dateRange" | "string" | "number";
  default: unknown;
}

/** One unit of report structure: a dataset + parameterized query (+ optional pivot/chart). */
export interface ReportPanel {
  id: string;
  title: string;
  dataset: string; // exactly one dataset per panel
  query: Record<string, unknown>; // DatasetQuery with "{{param}}" placeholders; opaque here
  transform?: { pivot: { x: string; series: string; value: string } };
  chartSpec?: Record<string, unknown>; // ChartSpec; opaque here — ChartHost validates deeply
}

/**
 * A query dataset the report carries inline (ADR 0017). The `reports` service provisions these
 * into the data catalog on save/import and GCs them when no report references them, so a Report
 * is self-contained: import the JSON and its panels resolve with no migration or connector code.
 */
export interface QueryDatasetDef {
  id: string; // kebab-case catalog id
  title: string;
  description?: string;
  sql: string; // one SELECT; uses :org, :from, :to
}

/** The declarative, portable spec of a Report. The store's only source of truth. */
export interface ReportDefinition {
  version: 1;
  parameters: ReportParameter[];
  panels: ReportPanel[];
  datasets?: QueryDatasetDef[]; // embedded query datasets, provisioned on save/import (ADR 0017)
}

/** A compiled definition: panels with every `{{placeholder}}` resolved. */
export interface BuildPlan {
  panels: ReportPanel[];
}

/** The versioned wrapper export/import moves a Report as. */
export interface ExportEnvelope {
  kind: "ghreporting.report";
  version: 1;
  name: string;
  description: string | null;
  definition: ReportDefinition;
}

/**
 * Thrown when a definition or envelope violates an invariant. Distinct from the server
 * kernel's `ValidationError` (which this package must not import) — the reports service
 * translates it to the HTTP 400 error at the route boundary.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ValidationError(`${what} must be an object`);
  }
  return v as Record<string, unknown>;
}

function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ValidationError(`${what} must be an array`);
  return v;
}

/** `{{ name }}` → captures the trimmed `name`. Lazy inner match stops at the first `}`. */
const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Every parameter name referenced by a `{{placeholder}}` anywhere in `value`. */
function* placeholdersIn(value: unknown): Iterable<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(PLACEHOLDER)) {
      const name = m[1]?.trim();
      if (name) yield name;
    }
  } else if (Array.isArray(value)) {
    for (const v of value) yield* placeholdersIn(v);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) yield* placeholdersIn(v);
  }
}

/**
 * Validate the envelope invariants of a Report Definition and narrow the type. Does NOT
 * inspect the shape of `query`/`chartSpec` beyond placeholder scanning — the data service
 * and `ChartHost` own that. Throws `ValidationError` on any violation.
 */
export function validateDefinition(json: unknown): ReportDefinition {
  const def = asObject(json, "definition");
  if (def.version !== 1) throw new ValidationError("version must be 1");

  const parameterNames = new Set<string>();
  for (const raw of asArray(def.parameters, "parameters")) {
    const p = asObject(raw, "parameter");
    if (typeof p.name !== "string" || p.name.trim() === "") {
      throw new ValidationError("parameter name must be a non-empty string");
    }
    if (parameterNames.has(p.name)) {
      throw new ValidationError(`duplicate parameter name: ${p.name}`);
    }
    parameterNames.add(p.name);
  }

  // Embedded query datasets (ADR 0017). Shape + intra-definition consistency only — this
  // zero-dependency package cannot know built-in ids or validate SQL (the data service does that
  // at provision time). `description` is optional; ids are kebab-case and unique.
  if (def.datasets !== undefined) {
    const datasetIds = new Set<string>();
    for (const raw of asArray(def.datasets, "datasets")) {
      const ds = asObject(raw, "dataset");
      if (typeof ds.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ds.id)) {
        throw new ValidationError("dataset id must be kebab-case (a-z, 0-9, hyphens)");
      }
      if (datasetIds.has(ds.id)) throw new ValidationError(`duplicate dataset id: ${ds.id}`);
      datasetIds.add(ds.id);
      if (typeof ds.title !== "string" || ds.title.trim() === "") {
        throw new ValidationError(`dataset ${ds.id} title must be a non-empty string`);
      }
      if (typeof ds.sql !== "string" || ds.sql.trim() === "") {
        throw new ValidationError(`dataset ${ds.id} sql must be a non-empty string`);
      }
      if (ds.description !== undefined && typeof ds.description !== "string") {
        throw new ValidationError(`dataset ${ds.id} description must be a string`);
      }
    }
  }

  const panelIds = new Set<string>();
  for (const raw of asArray(def.panels, "panels")) {
    const panel = asObject(raw, "panel");
    if (typeof panel.id !== "string" || panel.id.trim() === "") {
      throw new ValidationError("panel id must be a non-empty string");
    }
    if (panelIds.has(panel.id)) throw new ValidationError(`duplicate panel id: ${panel.id}`);
    panelIds.add(panel.id);
    if (typeof panel.dataset !== "string" || panel.dataset.trim() === "") {
      throw new ValidationError(`panel ${panel.id} dataset must be a non-empty string`);
    }
    for (const ref of placeholdersIn(asObject(panel.query, `panel ${panel.id} query`))) {
      if (!parameterNames.has(ref)) {
        throw new ValidationError(`panel ${panel.id} references undeclared parameter: ${ref}`);
      }
    }
  }

  return json as ReportDefinition;
}

/**
 * Replace placeholders in one string. A whole-value `"{{p}}"` preserves the value's type
 * and is cloned, so the BuildPlan never shares an object reference with the definition or
 * the caller's `values` (keeps compile's deep-clone guarantee for object-typed parameters).
 */
function resolveString(s: string, resolve: (name: string) => unknown): unknown {
  const whole = s.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (whole?.[1]) return structuredClone(resolve(whole[1].trim()));
  return s.replace(PLACEHOLDER, (_m, name: string) => String(resolve(name.trim()) ?? ""));
}

/** Recursively rebuild a value (a fresh clone) with placeholder strings resolved. */
function substitute(value: unknown, resolve: (name: string) => unknown): unknown {
  if (typeof value === "string") return resolveString(value, resolve);
  if (Array.isArray(value)) return value.map((v) => substitute(v, resolve));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, resolve)]));
  }
  return value;
}

/**
 * Compile a definition against parameter values: deep-clone each panel and resolve every
 * `{{name}}` in its query to `values[name] ?? parameter.default`. Pure — no clock, no I/O.
 * `transform`/`chartSpec` are cloned untouched (placeholders live only in `query`).
 */
export function compile(def: ReportDefinition, values: Record<string, unknown>): BuildPlan {
  const defaults = new Map(def.parameters.map((p) => [p.name, p.default]));
  const resolve = (name: string): unknown => values[name] ?? defaults.get(name);
  const panels = def.panels.map((panel) => ({
    ...structuredClone(panel),
    query: substitute(panel.query, resolve) as Record<string, unknown>,
  }));
  return { panels };
}

/** Wrap a definition in the versioned export envelope. */
export function toExport(
  name: string,
  description: string | null,
  def: ReportDefinition,
): ExportEnvelope {
  return { kind: "ghreporting.report", version: 1, name, description, definition: def };
}

/** Unwrap + re-validate an export envelope. Rejects a wrong kind/version before the body. */
export function parseExport(json: unknown): {
  name: string;
  description: string | null;
  definition: ReportDefinition;
} {
  const env = asObject(json, "envelope");
  if (env.kind !== "ghreporting.report") {
    throw new ValidationError("envelope kind must be ghreporting.report");
  }
  if (env.version !== 1) throw new ValidationError("envelope version must be 1");
  if (typeof env.name !== "string" || env.name.trim() === "") {
    throw new ValidationError("envelope name must be a non-empty string");
  }
  if (env.description != null && typeof env.description !== "string") {
    throw new ValidationError("envelope description must be a string or null");
  }
  return {
    name: env.name,
    description: env.description == null ? null : env.description,
    definition: validateDefinition(env.definition),
  };
}
