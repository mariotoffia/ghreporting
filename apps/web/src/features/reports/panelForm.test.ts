import { describe, expect, it } from "bun:test";
import { ValidationError } from "@ghreporting/domain";
import {
  assembleDefinition,
  buildPanel,
  buildParameter,
  type PanelFormFields,
  toPanelFields,
  toParameterFields,
  validateForm,
} from "./panelForm";

const goodPanel: PanelFormFields = {
  id: "spend",
  title: "Spend",
  dataset: "premium-requests",
  queryText: '{ "org": "{{org}}", "range": "{{range}}" }',
};

const orgParam = { name: "org", kind: "org" as const, defaultText: "acme" };
const rangeParam = {
  name: "range",
  kind: "dateRange" as const,
  defaultText: '{ "from": "2026-01-01", "to": "2026-01-31" }',
};

describe("buildPanel", () => {
  it("assembles a panel and parses the query JSON", () => {
    const panel = buildPanel(goodPanel);
    expect(panel).toEqual({
      id: "spend",
      title: "Spend",
      dataset: "premium-requests",
      query: { org: "{{org}}", range: "{{range}}" },
    });
  });

  it("attaches an optional pivot and chartSpec when provided", () => {
    const panel = buildPanel({
      ...goodPanel,
      pivotText: '{ "x": "day", "series": "model", "value": "net_usd" }',
      chartSpecText: '{ "type": "stacked-bar", "xColumn": "day", "seriesColumns": [] }',
    });
    expect(panel.transform).toEqual({ pivot: { x: "day", series: "model", value: "net_usd" } });
    expect(panel.chartSpec).toEqual({ type: "stacked-bar", xColumn: "day", seriesColumns: [] });
  });

  it("rejects malformed query JSON with a ValidationError", () => {
    expect(() => buildPanel({ ...goodPanel, queryText: "{ not json" })).toThrow(ValidationError);
    expect(() => buildPanel({ ...goodPanel, queryText: "[]" })).toThrow(/query/);
  });

  it("rejects a pivot missing a field", () => {
    expect(() => buildPanel({ ...goodPanel, pivotText: '{ "x": "day" }' })).toThrow(/pivot/);
  });
});

describe("assembleDefinition", () => {
  it("builds and validates a full definition", () => {
    const def = assembleDefinition([orgParam, rangeParam], [goodPanel]);
    expect(def.version).toBe(1);
    expect(def.panels[0]?.dataset).toBe("premium-requests");
    expect(def.parameters[1]?.default).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });

  it("coerces a number parameter default", () => {
    const def = assembleDefinition([{ name: "top", kind: "number", defaultText: "10" }], []);
    expect(def.parameters[0]?.default).toBe(10);
  });

  it("delegates to the domain validator (rejects an unbound placeholder)", () => {
    // Panel references {{ghost}}, which no parameter declares.
    const bad: PanelFormFields = { ...goodPanel, queryText: '{ "org": "{{ghost}}" }' };
    expect(() => assembleDefinition([orgParam], [bad])).toThrow(ValidationError);
    expect(() => assembleDefinition([orgParam], [bad])).toThrow(/ghost/);
  });
});

describe("round-trip (edit mode)", () => {
  it("buildPanel(toPanelFields(x)) recovers the panel", () => {
    const panel = buildPanel({
      ...goodPanel,
      pivotText: '{ "x": "day", "series": "model", "value": "net_usd" }',
      chartSpecText: '{ "type": "bar", "xColumn": "day", "seriesColumns": ["net_usd"] }',
    });
    expect(buildPanel(toPanelFields(panel))).toEqual(panel);
  });

  it("buildParameter(toParameterFields(x)) recovers each parameter kind", () => {
    for (const p of [
      buildParameter(orgParam),
      buildParameter(rangeParam),
      buildParameter({ name: "top", kind: "number", defaultText: "10" }),
    ]) {
      expect(buildParameter(toParameterFields(p))).toEqual(p);
    }
  });
});

describe("validateForm", () => {
  it("returns a definition when valid", () => {
    const r = validateForm([orgParam, rangeParam], [goodPanel]);
    expect("definition" in r).toBe(true);
  });

  it("returns an error message when invalid, not a throw", () => {
    const r = validateForm([], [{ ...goodPanel, queryText: '{ "org": "{{ghost}}" }' }]);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/ghost/);
  });
});
