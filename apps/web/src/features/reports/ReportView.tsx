// ReportView (T8.5.4, ADR 0014) — the read-only "execute" half. GET the definition, render
// parameter controls seeded from defaults, compile → one /api/data/query per panel (keyed by
// the resolved query, so changing a parameter refetches only the panels that use it), and
// render each panel as an HTML table (reusing explorer/Preview) plus a ChartHost when a
// chartSpec is present. The server never executes a report — this is all frontend.
import type { ReportDefinition, ReportParameter } from "@ghreporting/domain";
import { type UseQueryResult, useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/client";
import { ChartHost } from "../charts/ChartHost";
import { Preview, type ResultSet } from "../explorer/Preview";
import { getReport, REPORTS_KEY } from "./api";
import { type PanelDisplay, type PanelPlan, panelDisplay, planQueries } from "./execute";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const numStr = (v: unknown): string => (typeof v === "number" ? String(v) : "");

/**
 * A panel can run once its query carries a non-empty org (every dataset needs one) and, if
 * it carries a range, both ends are filled — so a half-typed date doesn't fire a query the
 * server rejects with a 400 mid-edit.
 */
const isRunnable = (query: Record<string, unknown>): boolean => {
  if (typeof query.org !== "string" || query.org.trim() === "") return false;
  const range = query.range as { from?: unknown; to?: unknown } | undefined;
  if (range && typeof range === "object") return Boolean(range.from) && Boolean(range.to);
  return true;
};

function defaultsOf(parameters: ReportParameter[]): Record<string, unknown> {
  return Object.fromEntries(parameters.map((p) => [p.name, p.default]));
}

export function ReportView({ reportId, onBack }: { reportId: string; onBack: () => void }) {
  const report = useQuery({
    queryKey: [...REPORTS_KEY, reportId],
    queryFn: () => getReport(reportId),
  });
  return (
    <section className="report-view">
      <header className="reports-head">
        <h2>{report.data?.name ?? "Report"}</h2>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </header>
      {report.isLoading && <p>Loading…</p>}
      {report.isError && <p className="form-error">Failed to load report.</p>}
      {report.data && <ReportRunner definition={report.data.definition} />}
    </section>
  );
}

function ReportRunner({ definition }: { definition: ReportDefinition }) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    defaultsOf(definition.parameters),
  );
  // Prefill an empty org from the configured scope so the seeded report runs out of the box.
  const config = useQuery({
    queryKey: ["data", "config"],
    queryFn: () => api.get<{ org: string | null }>("/api/data/config"),
  });
  useEffect(() => {
    const orgParam = definition.parameters.find((p) => p.kind === "org");
    const org = config.data?.org;
    if (!orgParam || !org) return;
    setValues((v) => (v[orgParam.name] ? v : { ...v, [orgParam.name]: org }));
  }, [config.data, definition.parameters]);

  const plans = planQueries(definition, values);
  const results = useQueries({
    queries: plans.map((p) => ({
      queryKey: ["report-panel", p.panelId, p.dataset, p.query] as const,
      queryFn: () =>
        api.post<ResultSet>("/api/data/query", { dataset: p.dataset, q: p.query, sync: true }),
      enabled: isRunnable(p.query),
    })),
  });

  return (
    <>
      <ParamControls parameters={definition.parameters} values={values} onChange={setValues} />
      <div className="report-panels">
        {results.map((state, i) => {
          const plan = plans[i];
          if (!plan) return null;
          return (
            <PanelView
              key={plan.panelId}
              plan={plan}
              runnable={isRunnable(plan.query)}
              state={state}
            />
          );
        })}
      </div>
    </>
  );
}

function ParamControls({
  parameters,
  values,
  onChange,
}: {
  parameters: ReportParameter[];
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  if (parameters.length === 0) return null;
  const set = (name: string, value: unknown) => onChange({ ...values, [name]: value });
  return (
    <div className="report-params">
      {parameters.map((p) =>
        p.kind === "dateRange" ? (
          <fieldset key={p.name} className="field">
            <legend>{p.name}</legend>
            <DateRange value={values[p.name]} onChange={(r) => set(p.name, r)} />
          </fieldset>
        ) : (
          <label key={p.name} className="field">
            {p.name}
            <input
              type={p.kind === "number" ? "number" : "text"}
              value={p.kind === "number" ? numStr(values[p.name]) : str(values[p.name])}
              onChange={(e) =>
                set(p.name, p.kind === "number" ? Number(e.target.value) : e.target.value)
              }
            />
          </label>
        ),
      )}
    </div>
  );
}

function DateRange({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (r: { from: string; to: string }) => void;
}) {
  const r = (value ?? {}) as { from?: string; to?: string };
  return (
    <span className="date-range">
      <input
        type="date"
        value={r.from ?? ""}
        onChange={(e) => onChange({ from: e.target.value, to: r.to ?? "" })}
      />
      <input
        type="date"
        value={r.to ?? ""}
        onChange={(e) => onChange({ from: r.from ?? "", to: e.target.value })}
      />
    </span>
  );
}

function PanelView({
  plan,
  runnable,
  state,
}: {
  plan: PanelPlan;
  runnable: boolean;
  state: UseQueryResult<ResultSet>;
}) {
  return (
    <div className="report-panel">
      <h3>{plan.title}</h3>
      {!runnable ? (
        <p className="hint">
          Complete the parameters (organization and date range) to run this panel.
        </p>
      ) : state.isPending ? (
        <p>Loading…</p>
      ) : state.isError ? (
        <p className="form-error">{(state.error as Error)?.message ?? "Query failed"}</p>
      ) : state.data ? (
        <PanelBody plan={plan} result={state.data} />
      ) : null}
    </div>
  );
}

export function PanelBody({ plan, result }: { plan: PanelPlan; result: ResultSet }) {
  // panelDisplay runs during render and applyPivot throws on a mis-authored pivot (a column
  // the result lacks). There is no ErrorBoundary in the app, so an uncaught throw here would
  // blank the whole SPA — contain it to this one panel instead.
  let display: PanelDisplay;
  try {
    display = panelDisplay(plan, result);
  } catch (e) {
    return <p className="form-error">Panel error: {(e as Error).message}</p>;
  }
  return (
    <>
      <Preview result={display.table} />
      {display.chart && (
        <ChartHost
          spec={display.chart.spec}
          columns={display.chart.columns}
          rows={display.chart.rows}
        />
      )}
    </>
  );
}
