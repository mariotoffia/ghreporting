// Pure form→domain assembly for the report designer. The Designer's form fields are all
// strings (inputs / JSON textareas); these helpers turn them into a ReportDefinition and
// run the SAME domain `validateDefinition` the server uses, so edit-time errors match
// write-time errors exactly (ADR 0014 — one validator, both tiers). No React here.
import {
  type ReportDefinition,
  type ReportPanel,
  type ReportParameter,
  ValidationError,
  validateDefinition,
} from "@ghreporting/domain";

export interface ParameterFields {
  name: string;
  kind: ReportParameter["kind"];
  /** Raw text: a literal for org/string, a number for number, JSON {from,to} for dateRange. */
  defaultText: string;
}

export interface PanelFormFields {
  id: string;
  title: string;
  dataset: string;
  queryText: string; // JSON DatasetQuery, may contain "{{param}}" placeholders
  pivotText?: string; // JSON { x, series, value } → transform.pivot
  chartSpecText?: string; // JSON ChartSpec
}

const hasText = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

/** Parse a text field as a JSON object, with a field-scoped 400-style message. */
function parseJsonObject(text: string, field: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ValidationError(`${field} must be valid JSON`);
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ValidationError(`${field} must be a JSON object`);
  }
  return v as Record<string, unknown>;
}

function parsePivot(text: string): { x: string; series: string; value: string } {
  const o = parseJsonObject(text, "pivot");
  const need = (k: "x" | "series" | "value"): string => {
    const val = o[k];
    if (typeof val !== "string" || val.trim() === "") {
      throw new ValidationError(`pivot.${k} must be a non-empty string`);
    }
    return val;
  };
  return { x: need("x"), series: need("series"), value: need("value") };
}

/** Turn one parameter's raw default text into a typed default by its kind. */
function parseDefault(text: string, kind: ReportParameter["kind"]): unknown {
  if (kind === "number") {
    const n = Number(text);
    if (!Number.isFinite(n)) throw new ValidationError("number default must be numeric");
    return n;
  }
  if (kind === "dateRange") return parseJsonObject(text, "date range default");
  return text; // org / string: the literal value
}

export function buildParameter(f: ParameterFields): ReportParameter {
  return { name: f.name.trim(), kind: f.kind, default: parseDefault(f.defaultText, f.kind) };
}

/** Reverse of buildParameter: a stored parameter → editable form fields (for edit mode). */
export function toParameterFields(p: ReportParameter): ParameterFields {
  return {
    name: p.name,
    kind: p.kind,
    defaultText: p.kind === "dateRange" ? JSON.stringify(p.default) : String(p.default ?? ""),
  };
}

/** Reverse of buildPanel: a stored panel → editable form fields (pretty-printed JSON). */
export function toPanelFields(panel: ReportPanel): PanelFormFields {
  return {
    id: panel.id,
    title: panel.title,
    dataset: panel.dataset,
    queryText: JSON.stringify(panel.query, null, 2),
    pivotText: panel.transform ? JSON.stringify(panel.transform.pivot, null, 2) : "",
    chartSpecText: panel.chartSpec ? JSON.stringify(panel.chartSpec, null, 2) : "",
  };
}

/** Assemble a ReportPanel from raw form fields (throws ValidationError on bad JSON). */
export function buildPanel(f: PanelFormFields): ReportPanel {
  const panel: ReportPanel = {
    id: f.id.trim(),
    title: f.title.trim(),
    dataset: f.dataset.trim(),
    query: parseJsonObject(f.queryText, "query"),
  };
  if (hasText(f.pivotText)) panel.transform = { pivot: parsePivot(f.pivotText) };
  if (hasText(f.chartSpecText)) panel.chartSpec = parseJsonObject(f.chartSpecText, "chart spec");
  return panel;
}

/** Build the full definition and run the domain validator (throws ValidationError). */
export function assembleDefinition(
  params: ParameterFields[],
  panels: PanelFormFields[],
): ReportDefinition {
  const def: ReportDefinition = {
    version: 1,
    parameters: params.map(buildParameter),
    panels: panels.map(buildPanel),
  };
  return validateDefinition(def);
}

/** Non-throwing wrapper for inline form errors: `{ definition }` or `{ error }`. */
export function validateForm(
  params: ParameterFields[],
  panels: PanelFormFields[],
): { definition: ReportDefinition } | { error: string } {
  try {
    return { definition: assembleDefinition(params, panels) };
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    throw e;
  }
}
