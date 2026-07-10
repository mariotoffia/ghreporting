// The report designer (T8.5.3, ADR 0014): list / create / edit / delete / import / export
// Report Definitions. Server state via TanStack Query; the form assembles a definition and
// validates it with the SAME domain validator the server uses (panelForm → validateForm),
// surfacing errors inline before submit. Opening a report hands its id up to the feature
// shell, which swaps in the read-only ReportView (T8.5.4) — no router (state/ui.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/client";
import type { CatalogEntry } from "../explorer/format";
import {
  createReport,
  deleteReport,
  getReport,
  importReport,
  listReports,
  REPORTS_KEY,
  type ReportInput,
  type ReportSummary,
  reportExportPath,
  updateReport,
} from "./api";
import {
  type PanelFormFields,
  type ParameterFields,
  toPanelFields,
  toParameterFields,
  validateForm,
} from "./panelForm";

const DATASETS_KEY = ["datasets"] as const;
const PARAM_KINDS = ["org", "dateRange", "string", "number"] as const;

type Mode = { kind: "list" } | { kind: "new" } | { kind: "edit"; id: string };

const blankPanel = (): PanelFormFields => ({ id: "", title: "", dataset: "", queryText: "{}" });

function updateAt<T>(arr: T[], i: number, patch: Partial<T>): T[] {
  return arr.map((x, idx) => (idx === i ? { ...x, ...patch } : x));
}

export function Designer({ onOpen }: { onOpen: (id: string) => void }) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  if (mode.kind === "list") {
    return (
      <ReportList
        onOpen={onOpen}
        onNew={() => setMode({ kind: "new" })}
        onEdit={(id) => setMode({ kind: "edit", id })}
      />
    );
  }
  return (
    <ReportForm
      editId={mode.kind === "edit" ? mode.id : null}
      onDone={() => setMode({ kind: "list" })}
    />
  );
}

function ReportList({
  onOpen,
  onNew,
  onEdit,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
}) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: REPORTS_KEY, queryFn: listReports });
  const del = useMutation({
    mutationFn: deleteReport,
    onSettled: () => qc.invalidateQueries({ queryKey: REPORTS_KEY }),
  });
  const [importError, setImportError] = useState<string | null>(null);
  const imp = useMutation({
    mutationFn: importReport,
    // Surface a server rejection (e.g. a wrong-kind envelope → 400), not just parse errors.
    onError: (e: Error) => setImportError(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: REPORTS_KEY }),
  });

  async function onImportFile(file: File) {
    setImportError(null);
    try {
      imp.mutate(JSON.parse(await file.text()));
    } catch {
      setImportError("That file is not valid report JSON.");
    }
  }

  return (
    <section className="reports">
      <header className="reports-head">
        <h2>Reports</h2>
        <div className="reports-actions">
          <button type="button" onClick={onNew}>
            New report
          </button>
          <label className="import-btn">
            Import…
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImportFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </header>
      {importError && (
        <p className="form-error" role="alert">
          {importError}
        </p>
      )}
      {list.isLoading && <p>Loading…</p>}
      {list.isError && <p className="form-error">Failed to load reports.</p>}
      {list.data && (
        <ReportTable
          reports={list.data}
          onOpen={onOpen}
          onEdit={onEdit}
          onDelete={(id) => del.mutate(id)}
        />
      )}
    </section>
  );
}

/** Presentational list table — data + handlers as props, so it renders under SSR in tests. */
export function ReportTable({
  reports,
  onOpen,
  onEdit,
  onDelete,
}: {
  reports: ReportSummary[];
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (reports.length === 0) {
    return <p className="reports-empty">No reports yet — create one or import a file.</p>;
  }
  return (
    <table className="reports-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Description</th>
          <th>Updated</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {reports.map((r) => (
          <tr key={r.id}>
            <td>{r.name}</td>
            <td>{r.description}</td>
            <td>{r.updated_at}</td>
            <td className="row-actions">
              <button type="button" onClick={() => onOpen(r.id)}>
                Open
              </button>
              <button type="button" onClick={() => onEdit(r.id)}>
                Edit
              </button>
              <a href={reportExportPath(r.id)} download>
                Export
              </a>
              <button type="button" className="danger" onClick={() => onDelete(r.id)}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReportForm({ editId, onDone }: { editId: string | null; onDone: () => void }) {
  const qc = useQueryClient();
  const catalog = useQuery({
    queryKey: DATASETS_KEY,
    queryFn: () => api.get<CatalogEntry[]>("/api/data/datasets"),
  });
  const existing = useQuery({
    queryKey: [...REPORTS_KEY, editId],
    queryFn: () => getReport(editId as string),
    enabled: editId !== null,
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [params, setParams] = useState<ParameterFields[]>([]);
  const [panels, setPanels] = useState<PanelFormFields[]>([blankPanel()]);
  const [error, setError] = useState<string | null>(null);

  // Seed the form from the loaded report exactly once (edit mode). The ref guard stops a
  // later refetch/invalidation from re-seeding over the user's in-progress edits.
  const seeded = useRef(false);
  useEffect(() => {
    const r = existing.data;
    if (!r || seeded.current) return;
    seeded.current = true;
    setName(r.name);
    setDescription(r.description ?? "");
    setParams(r.definition.parameters.map(toParameterFields));
    setPanels(r.definition.panels.map(toPanelFields));
  }, [existing.data]);

  const save = useMutation({
    mutationFn: (body: ReportInput) => (editId ? updateReport(editId, body) : createReport(body)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: REPORTS_KEY });
      onDone();
    },
    onError: (e: Error) => setError(e.message),
  });

  function onSubmit() {
    setError(null);
    if (name.trim() === "") {
      setError("Name is required.");
      return;
    }
    const result = validateForm(params, panels);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    save.mutate({
      name: name.trim(),
      description: description.trim() || null,
      definition: result.definition,
    });
  }

  const datasets = catalog.data ?? [];
  return (
    <section className="reports report-form">
      <header className="reports-head">
        <h2>{editId ? "Edit report" : "New report"}</h2>
        <div className="reports-actions">
          <button type="button" onClick={onDone}>
            Cancel
          </button>
          <button type="button" onClick={onSubmit} disabled={save.isPending}>
            Save
          </button>
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <label className="field">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <fieldset>
        <legend>Parameters</legend>
        {params.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: form rows are positional
          <div key={i} className="param-row">
            <input
              placeholder="name"
              value={p.name}
              onChange={(e) => setParams(updateAt(params, i, { name: e.target.value }))}
            />
            <select
              value={p.kind}
              onChange={(e) =>
                setParams(updateAt(params, i, { kind: e.target.value as ParameterFields["kind"] }))
              }
            >
              {PARAM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              placeholder="default"
              value={p.defaultText}
              onChange={(e) => setParams(updateAt(params, i, { defaultText: e.target.value }))}
            />
            <button type="button" onClick={() => setParams(params.filter((_, idx) => idx !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setParams([...params, { name: "", kind: "string", defaultText: "" }])}
        >
          Add parameter
        </button>
      </fieldset>

      <fieldset>
        <legend>Panels</legend>
        {panels.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: form rows are positional
          <div key={i} className="panel-row">
            <input
              placeholder="id"
              value={p.id}
              onChange={(e) => setPanels(updateAt(panels, i, { id: e.target.value }))}
            />
            <input
              placeholder="title"
              value={p.title}
              onChange={(e) => setPanels(updateAt(panels, i, { title: e.target.value }))}
            />
            <select
              value={p.dataset}
              onChange={(e) => setPanels(updateAt(panels, i, { dataset: e.target.value }))}
            >
              <option value="">— dataset —</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
            <textarea
              placeholder="query JSON"
              value={p.queryText}
              onChange={(e) => setPanels(updateAt(panels, i, { queryText: e.target.value }))}
            />
            <textarea
              placeholder="pivot JSON (optional)"
              value={p.pivotText ?? ""}
              onChange={(e) => setPanels(updateAt(panels, i, { pivotText: e.target.value }))}
            />
            <textarea
              placeholder="chartSpec JSON (optional)"
              value={p.chartSpecText ?? ""}
              onChange={(e) => setPanels(updateAt(panels, i, { chartSpecText: e.target.value }))}
            />
            <button type="button" onClick={() => setPanels(panels.filter((_, idx) => idx !== i))}>
              Remove panel
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setPanels([...panels, blankPanel()])}>
          Add panel
        </button>
      </fieldset>
    </section>
  );
}
