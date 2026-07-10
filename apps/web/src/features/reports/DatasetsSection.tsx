// The report designer's embedded-datasets editor (T8.7.4, ADR 0017). A report carries its query
// datasets inline; here the author adds/edits {id, title, description, sql} rows with the same
// CodeMirror SQL field + Preview as the standalone Query-datasets tab. Presentational: data +
// onChange come from the ReportForm, so the definition it assembles includes these datasets and
// Save/Export carry them. SqlField is lazy so CodeMirror stays out of the reports chunk / SSR.
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { Preview } from "../explorer/Preview";
import { getSchema, type PreviewResult, previewQueryDataset } from "../query-datasets/api";
import type { DatasetFormFields } from "./panelForm";

const SqlField = lazy(() =>
  import("../query-datasets/SqlField").then((m) => ({ default: m.SqlField })),
);

const blank = (): DatasetFormFields => ({ id: "", title: "", description: "", sql: "SELECT " });

export function DatasetsSection({
  datasets,
  onChange,
}: {
  datasets: DatasetFormFields[];
  onChange: (datasets: DatasetFormFields[]) => void;
}) {
  const schema = useQuery({ queryKey: ["data", "schema"], queryFn: getSchema });
  const [previews, setPreviews] = useState<Record<number, PreviewResult>>({});
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<DatasetFormFields>) =>
    onChange(datasets.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));

  async function runPreview(i: number, sql: string) {
    setError(null);
    try {
      const r = await previewQueryDataset({ sql });
      setPreviews((p) => ({ ...p, [i]: r }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <fieldset>
      <legend>Datasets (SQL, provisioned with the report)</legend>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {datasets.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: form rows are positional
        <div key={i} className="dataset-row">
          <div className="dataset-meta">
            <input
              placeholder="id (kebab-case)"
              value={d.id}
              onChange={(e) => update(i, { id: e.target.value })}
            />
            <input
              placeholder="title"
              value={d.title}
              onChange={(e) => update(i, { title: e.target.value })}
            />
            <input
              placeholder="description (optional)"
              value={d.description}
              onChange={(e) => update(i, { description: e.target.value })}
            />
            <button type="button" onClick={() => runPreview(i, d.sql)}>
              Preview
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => onChange(datasets.filter((_, idx) => idx !== i))}
            >
              Remove
            </button>
          </div>
          <Suspense fallback={<p className="loading">Loading editor…</p>}>
            <SqlField value={d.sql} onChange={(sql) => update(i, { sql })} schema={schema.data} />
          </Suspense>
          {previews[i] && (
            <div className="query-preview">
              <Preview result={{ columns: previews[i].columns, rows: previews[i].rows }} />
            </div>
          )}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...datasets, blank()])}>
        Add dataset
      </button>
    </fieldset>
  );
}
