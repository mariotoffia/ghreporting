// Typed client over the `reports` uService (/api/reports), built on the shared `api`
// singleton (lib/client) like every other feature. The designer and ReportView consume
// these with TanStack Query. Export is a browser download (attachment), so it is a plain
// link path, not a fetch.
import type { ReportDefinition } from "@ghreporting/domain";
import { api } from "../../lib/client";

/** TanStack Query key for the report list; mutations invalidate it. */
export const REPORTS_KEY = ["reports"] as const;

/** List/row shape without the definition body (GET /reports). */
export interface ReportSummary {
  id: string;
  name: string;
  description: string | null;
  updated_at: string;
}

/** Full row including the parsed definition (GET /reports/:id). */
export interface ReportFull extends ReportSummary {
  created_at: string;
  definition: ReportDefinition;
}

export interface ReportInput {
  name: string;
  description?: string | null;
  definition: ReportDefinition;
}

export const listReports = () => api.get<ReportSummary[]>("/api/reports");
export const getReport = (id: string) => api.get<ReportFull>(`/api/reports/${id}`);
export const createReport = (body: ReportInput) => api.post<ReportSummary>("/api/reports", body);
export const updateReport = (id: string, body: Partial<ReportInput>) =>
  api.put<ReportSummary>(`/api/reports/${id}`, body);
export const deleteReport = (id: string) =>
  api.del<{ id: string; deleted: boolean }>(`/api/reports/${id}`);
export const importReport = (envelope: unknown) =>
  api.post<ReportSummary>("/api/reports/import", { envelope });

/** The export endpoint answers an attachment; anchor to it so the browser downloads it. */
export const reportExportPath = (id: string) => `/api/reports/${id}/export`;
