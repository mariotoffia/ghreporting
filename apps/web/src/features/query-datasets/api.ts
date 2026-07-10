// Typed client over the query-dataset routes of the `data` uService (/api/data/query-datasets,
// ADR 0016), built on the shared `api` singleton like every other feature. The editor consumes
// these with TanStack Query. A query dataset is a stored read-only SELECT; the report designer's
// dataset picker (fed by /api/data/datasets) lists it automatically — no designer change.
import { api } from "../../lib/client";

/** A derived column, matching the server ColumnMeta (data uService ports). */
export interface ColumnMeta {
  name: string;
  type: "string" | "number" | "date";
  description: string;
}

/** TanStack Query key for the query-dataset list; mutations invalidate it (and the catalog). */
export const QUERY_DATASETS_KEY = ["query-datasets"] as const;
/** The dataset catalog key, invalidated so a new/edited query dataset shows in pickers at once. */
export const DATASETS_KEY = ["datasets"] as const;

/** List/row shape (GET /query-datasets) — no sql/columns. */
export interface QueryDatasetSummary {
  id: string;
  title: string;
  description: string | null;
  updated_at: string;
}

/** Full row incl. the SQL and parsed derived columns (GET /query-datasets/:id). */
export interface QueryDatasetFull extends QueryDatasetSummary {
  created_at: string;
  sql: string;
  columns: ColumnMeta[];
}

/** Create body (id is user-supplied kebab-case and immutable once created). */
export interface QueryDatasetInput {
  id: string;
  title: string;
  description?: string | null;
  sql: string;
}

/** POST /query-datasets/preview response: derived columns + sample rows. */
export interface PreviewResult {
  columns: ColumnMeta[];
  rows: unknown[][];
}

export const listQueryDatasets = () => api.get<QueryDatasetSummary[]>("/api/data/query-datasets");
export const getQueryDataset = (id: string) =>
  api.get<QueryDatasetFull>(`/api/data/query-datasets/${id}`);
/** Optional org/range the editor sends so the server infers column types from real rows. */
export interface DeriveContext {
  org?: string;
  range?: { from: string; to: string };
}

export const createQueryDataset = (body: QueryDatasetInput & DeriveContext) =>
  api.post<QueryDatasetSummary>("/api/data/query-datasets", body);
export const updateQueryDataset = (
  id: string,
  body: Partial<Omit<QueryDatasetInput, "id">> & DeriveContext,
) => api.put<QueryDatasetSummary>(`/api/data/query-datasets/${id}`, body);
export const deleteQueryDataset = (id: string) =>
  api.del<{ id: string; deleted: boolean }>(`/api/data/query-datasets/${id}`);
export const previewQueryDataset = (body: {
  sql: string;
  org?: string;
  range?: { from: string; to: string };
}) => api.post<PreviewResult>("/api/data/query-datasets/preview", body);

/** Table → column names, powering the SQL editor's schema-aware autocomplete. */
export const getSchema = () => api.get<Record<string, string[]>>("/api/data/schema");
