// Query-datasets screen (T8.6.4, ADR 0016): list / create / edit / delete a stored SQL SELECT,
// with a Preview that runs it read-only and shows derived columns + sample rows. Server state via
// TanStack Query; presentational bits (the list table) take data+handlers as props so they render
// under SSR in tests. Once saved, a query dataset appears in the report designer's dataset picker
// automatically (fed by /api/data/datasets) — no report-designer change. The SQL field is a
// CodeMirror 6 editor with schema-aware autocomplete (SqlField), lazy-loaded so it stays out of
// the initial bundle and never loads under the DOM-free SSR tests.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../../lib/client";
import { lastNDays } from "../explorer/format";
import { Preview } from "../explorer/Preview";
import {
  DATASETS_KEY,
  deleteQueryDataset,
  getQueryDataset,
  getSchema,
  listQueryDatasets,
  type PreviewResult,
  previewQueryDataset,
  QUERY_DATASETS_KEY,
  type QueryDatasetSummary,
  updateQueryDataset,
} from "./api";

// CodeMirror is heavy and DOM-only — lazy-load it so the SSR table tests never pull it in and it
// stays out of the initial chunk (this whole feature is already a lazy route in App.tsx).
const SqlField = lazy(() => import("./SqlField").then((m) => ({ default: m.SqlField })));

type Mode = { kind: "list" } | { kind: "edit"; id: string };

export function Editor() {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  if (mode.kind === "list") {
    return <QueryDatasetList onEdit={(id) => setMode({ kind: "edit", id })} />;
  }
  return <QueryDatasetForm editId={mode.id} onDone={() => setMode({ kind: "list" })} />;
}

function QueryDatasetList({ onEdit }: { onEdit: (id: string) => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: QUERY_DATASETS_KEY, queryFn: listQueryDatasets });
  const del = useMutation({
    mutationFn: deleteQueryDataset,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: QUERY_DATASETS_KEY });
      qc.invalidateQueries({ queryKey: DATASETS_KEY });
    },
  });

  return (
    <section className="query-datasets">
      <header className="reports-head">
        <h2>Query datasets</h2>
      </header>
      {/* Datasets are provisioned from reports (ADR 0017): they're authored in the report designer.
          Edits here are transient — the owning report's next save re-provisions and reverts them. */}
      <p className="reports-empty">
        Managed by reports. Author datasets in a report's Datasets section; edits here are temporary
        until the owning report is saved again.
      </p>
      {list.isLoading && <p>Loading…</p>}
      {list.isError && <p className="form-error">Failed to load query datasets.</p>}
      {list.data && (
        <QueryDatasetTable datasets={list.data} onEdit={onEdit} onDelete={(id) => del.mutate(id)} />
      )}
    </section>
  );
}

/** Presentational list table — data + handlers as props, so it renders under SSR in tests. */
export function QueryDatasetTable({
  datasets,
  onEdit,
  onDelete,
}: {
  datasets: QueryDatasetSummary[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (datasets.length === 0) {
    return <p className="reports-empty">No query datasets yet — add one to a report.</p>;
  }
  return (
    <table className="reports-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Description</th>
          <th>Updated</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {datasets.map((d) => (
          <tr key={d.id}>
            <td>{d.title}</td>
            <td>{d.description}</td>
            <td>{d.updated_at}</td>
            <td className="row-actions">
              <button type="button" onClick={() => onEdit(d.id)}>
                Edit
              </button>
              <button type="button" className="danger" onClick={() => onDelete(d.id)}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function QueryDatasetForm({ editId, onDone }: { editId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const existing = useQuery({
    queryKey: [...QUERY_DATASETS_KEY, editId],
    queryFn: () => getQueryDataset(editId),
  });
  // The configured org (GHR_ORG) prefills the sample org, like the explorer does.
  const config = useQuery({
    queryKey: ["data", "config"],
    queryFn: () => api.get<{ org: string | null }>("/api/data/config"),
  });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sql, setSql] = useState("SELECT ");
  // Sample org + range: bound to :org/:from/:to so Preview shows real rows and Save infers real
  // column types. Default range = last 180 days (≈ the copilot-spend report's 6-month default).
  const defaults = lastNDays(new Date(), 180);
  const [org, setOrg] = useState("");
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the form from the loaded row exactly once (edit mode); the ref guard stops a later
  // refetch from clobbering in-progress edits (same pattern as the report designer).
  const seeded = useRef(false);
  useEffect(() => {
    const r = existing.data;
    if (!r || seeded.current) return;
    seeded.current = true;
    setTitle(r.title);
    setDescription(r.description ?? "");
    setSql(r.sql);
  }, [existing.data]);

  // Prefill the sample org from the server default, once, without clobbering user edits.
  const orgSeeded = useRef(false);
  useEffect(() => {
    if (orgSeeded.current || !config.data) return;
    orgSeeded.current = true;
    setOrg(config.data.org ?? "");
  }, [config.data]);

  // Table → columns for the editor's schema-aware autocomplete.
  const schema = useQuery({ queryKey: ["data", "schema"], queryFn: getSchema });

  const sample = () => ({ org: org.trim(), range: { from, to } });

  const previewMut = useMutation({
    mutationFn: () => previewQueryDataset({ sql, ...sample() }),
    onSuccess: (r) => {
      setError(null);
      setPreview(r);
    },
    onError: (e: Error) => setError(e.message),
  });

  const save = useMutation({
    mutationFn: () =>
      updateQueryDataset(editId, {
        title: title.trim(),
        description: description.trim() || null,
        sql,
        ...sample(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_DATASETS_KEY });
      qc.invalidateQueries({ queryKey: DATASETS_KEY });
      onDone();
    },
    onError: (e: Error) => setError(e.message),
  });

  function onSave() {
    setError(null);
    if (title.trim() === "") return setError("Title is required.");
    if (sql.trim() === "") return setError("SQL is required.");
    save.mutate();
  }

  return (
    <section className="query-datasets query-dataset-form">
      <header className="reports-head">
        <h2>Edit query dataset</h2>
        <div className="reports-actions">
          <button type="button" onClick={onDone}>
            Cancel
          </button>
          <button type="button" onClick={() => previewMut.mutate()} disabled={previewMut.isPending}>
            Preview
          </button>
          <button type="button" onClick={onSave} disabled={save.isPending}>
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
        Id
        {/* Immutable: the id is the report-provisioned catalog id (ADR 0017). */}
        <input value={editId} disabled />
      </label>
      <label className="field">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="field">
        <span className="sql-label">
          SQL — one SELECT; use <code>:org</code>, <code>:from</code>, <code>:to</code>
          {/* Autocomplete schema is cached per session; reload it after syncing new fact tables. */}
          <button
            type="button"
            className="reload-schema"
            onClick={() => schema.refetch()}
            disabled={schema.isFetching}
          >
            {schema.isFetching ? "Reloading…" : "Reload schema"}
          </button>
        </span>
        <Suspense fallback={<p className="loading">Loading editor…</p>}>
          <SqlField value={sql} onChange={setSql} schema={schema.data} />
        </Suspense>
      </div>
      {/* Sample params bound to :org/:from/:to — drive Preview and the derived column types. */}
      <fieldset className="sample-params">
        <legend>Sample parameters (Preview &amp; type inference)</legend>
        <label className="field">
          Org
          <input value={org} placeholder="my-org" onChange={(e) => setOrg(e.target.value)} />
        </label>
        <label className="field">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </fieldset>
      {preview && (
        <div className="query-preview">
          <h3>Preview</h3>
          <Preview result={{ columns: preview.columns, rows: preview.rows }} />
        </div>
      )}
    </section>
  );
}
