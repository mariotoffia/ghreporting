import { describe, expect, it } from "bun:test";
import {
  compile,
  parseExport,
  type ReportDefinition,
  toExport,
  ValidationError,
  validateDefinition,
} from "./report";

/** A minimal, valid definition used as the accept baseline. */
function validDef(): ReportDefinition {
  return {
    version: 1,
    parameters: [
      { name: "org", kind: "org", default: "acme" },
      { name: "range", kind: "dateRange", default: { from: "2026-01-01", to: "2026-01-31" } },
    ],
    panels: [
      {
        id: "spend",
        title: "Spend",
        dataset: "premium-requests",
        query: { org: "{{org}}", range: "{{range}}", limit: 1000 },
      },
    ],
  };
}

describe("validateDefinition", () => {
  it("accepts a well-formed definition and returns it", () => {
    const def = validDef();
    expect(validateDefinition(def)).toEqual(def);
  });

  it("rejects a wrong version", () => {
    expect(() => validateDefinition({ ...validDef(), version: 2 })).toThrow(ValidationError);
    expect(() => validateDefinition({ ...validDef(), version: 2 })).toThrow(/version/);
  });

  it("rejects a non-object definition", () => {
    expect(() => validateDefinition(null)).toThrow(ValidationError);
    expect(() => validateDefinition([])).toThrow(ValidationError);
    expect(() => validateDefinition("nope")).toThrow(ValidationError);
  });

  it("rejects non-array parameters/panels", () => {
    expect(() => validateDefinition({ version: 1, parameters: {}, panels: [] })).toThrow(
      /parameters must be an array/,
    );
    expect(() => validateDefinition({ version: 1, parameters: [], panels: "x" })).toThrow(
      /panels must be an array/,
    );
  });

  it("rejects an empty parameter name", () => {
    const bad = { version: 1, parameters: [{ name: "  ", kind: "org", default: 0 }], panels: [] };
    expect(() => validateDefinition(bad)).toThrow(/parameter name/);
  });

  it("rejects duplicate parameter names", () => {
    const bad = {
      version: 1,
      parameters: [
        { name: "org", kind: "org", default: 0 },
        { name: "org", kind: "string", default: 0 },
      ],
      panels: [],
    };
    expect(() => validateDefinition(bad)).toThrow(/duplicate parameter/);
  });

  it("rejects an empty panel id", () => {
    const bad = {
      version: 1,
      parameters: [],
      panels: [{ id: "", title: "T", dataset: "d", query: {} }],
    };
    expect(() => validateDefinition(bad)).toThrow(/panel id/);
  });

  it("rejects duplicate panel ids", () => {
    const bad = {
      version: 1,
      parameters: [],
      panels: [
        { id: "p", title: "A", dataset: "d", query: {} },
        { id: "p", title: "B", dataset: "d", query: {} },
      ],
    };
    expect(() => validateDefinition(bad)).toThrow(/duplicate panel id/);
  });

  it("rejects an empty dataset", () => {
    const bad = {
      version: 1,
      parameters: [],
      panels: [{ id: "p", title: "T", dataset: "", query: {} }],
    };
    expect(() => validateDefinition(bad)).toThrow(/dataset/);
  });

  it("rejects a placeholder that names an undeclared parameter", () => {
    const bad = {
      version: 1,
      parameters: [],
      panels: [{ id: "p", title: "T", dataset: "d", query: { org: "{{nope}}" } }],
    };
    expect(() => validateDefinition(bad)).toThrow(/undeclared parameter: nope/);
  });

  it("accepts placeholders nested inside arrays and objects", () => {
    const def = validDef();
    def.panels = [
      {
        id: "p",
        title: "T",
        dataset: "d",
        query: { filter: { logins: ["{{org}}", "literal"] }, nested: { deep: "{{range}}" } },
      },
    ];
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it("catches an undeclared placeholder buried in a nested array", () => {
    const bad = {
      version: 1,
      parameters: [],
      panels: [
        { id: "p", title: "T", dataset: "d", query: { filter: { xs: [{ y: "{{ghost}}" }] } } },
      ],
    };
    expect(() => validateDefinition(bad)).toThrow(/ghost/);
  });
});

describe("compile", () => {
  it("substitutes whole-value placeholders preserving the value's type", () => {
    const plan = compile(validDef(), {
      org: "globex",
      range: { from: "2026-03-01", to: "2026-03-31" },
    });
    expect(plan.panels[0]?.query).toEqual({
      org: "globex",
      range: { from: "2026-03-01", to: "2026-03-31" },
      limit: 1000,
    });
  });

  it("falls back to the parameter default when a value is omitted", () => {
    const plan = compile(validDef(), {});
    expect(plan.panels[0]?.query.org).toBe("acme");
    expect(plan.panels[0]?.query.range).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });

  it("leaves a placeholder-free value intact", () => {
    const plan = compile(validDef(), { org: "globex" });
    expect(plan.panels[0]?.query.limit).toBe(1000);
  });

  it("passes non-string primitives through untouched", () => {
    const def: ReportDefinition = {
      version: 1,
      parameters: [],
      panels: [
        { id: "p", title: "T", dataset: "d", query: { limit: 1000, live: true, note: null } },
      ],
    };
    expect(compile(def, {}).panels[0]?.query).toEqual({ limit: 1000, live: true, note: null });
  });

  it("recurses into nested arrays and objects", () => {
    const def = validDef();
    def.panels = [
      {
        id: "p",
        title: "T",
        dataset: "d",
        query: { filter: { logins: ["{{org}}"] }, deep: { r: "{{range}}" } },
      },
    ];
    const plan = compile(def, { org: "globex", range: { from: "a", to: "b" } });
    expect(plan.panels[0]?.query).toEqual({
      filter: { logins: ["globex"] },
      deep: { r: { from: "a", to: "b" } },
    });
  });

  it("interpolates a placeholder embedded in a larger string", () => {
    const def: ReportDefinition = {
      version: 1,
      parameters: [{ name: "org", kind: "org", default: "acme" }],
      panels: [{ id: "p", title: "T", dataset: "d", query: { note: "org={{org}}!" } }],
    };
    const plan = compile(def, { org: "globex" });
    expect(plan.panels[0]?.query.note).toBe("org=globex!");
  });

  it("does not mutate the source definition", () => {
    const def = validDef();
    const before = JSON.stringify(def);
    compile(def, { org: "globex", range: { from: "a", to: "b" } });
    expect(JSON.stringify(def)).toBe(before);
  });

  it("clones an object-typed value instead of sharing the input reference", () => {
    const range = { from: "a", to: "b" };
    const plan = compile(validDef(), { org: "x", range });
    expect(plan.panels[0]?.query.range).toEqual(range);
    expect(plan.panels[0]?.query.range).not.toBe(range); // BuildPlan is independent
  });
});

describe("export envelope", () => {
  it("round-trips through JSON", () => {
    const def = validDef();
    const env = toExport("Copilot Spend", "monthly spend", def);
    const round = JSON.parse(JSON.stringify(env));
    expect(parseExport(round)).toEqual({
      name: "Copilot Spend",
      description: "monthly spend",
      definition: def,
    });
  });

  it("round-trips a null description", () => {
    const env = toExport("R", null, validDef());
    const round = JSON.parse(JSON.stringify(env));
    expect(parseExport(round).description).toBeNull();
  });

  it("rejects a wrong kind", () => {
    const env = { ...toExport("R", null, validDef()), kind: "something.else" };
    expect(() => parseExport(env)).toThrow(/kind/);
  });

  it("rejects a wrong envelope version", () => {
    const env = { ...toExport("R", null, validDef()), version: 2 };
    expect(() => parseExport(env)).toThrow(/version/);
  });

  it("re-validates the wrapped definition", () => {
    const env = toExport("R", null, validDef());
    // Corrupt the inner definition after wrapping.
    (env.definition as { panels: unknown[] }).panels = [
      { id: "", title: "", dataset: "x", query: {} },
    ];
    expect(() => parseExport(env)).toThrow(/panel id/);
  });
});
