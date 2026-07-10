import { describe, expect, it, mock } from "bun:test";
import { renderToString } from "react-dom/server";

// Mock the shared client BEFORE importing ./api, so the typed client binds to these spies
// (TESTS.md §4: live-query containers aren't mounted — we assert the presentational table
// under SSR and verify the api layer targets the right endpoints).
const get = mock(async () => [] as unknown);
const post = mock(async () => ({}) as unknown);
const put = mock(async () => ({}) as unknown);
const del = mock(async () => ({}) as unknown);
mock.module("../../lib/client", () => ({ api: { get, post, put, del } }));

const { deleteReport, importReport, listReports, reportExportPath } = await import("./api");
const { ReportTable } = await import("./Designer");

const reports = [
  { id: "r1", name: "Copilot Spend", description: "monthly spend", updated_at: "2026-07-09" },
  { id: "r2", name: "Seat Usage", description: null, updated_at: "2026-07-08" },
];
const noop = () => {};

describe("ReportTable", () => {
  it("renders each report with row actions and an export link", () => {
    const html = renderToString(
      <ReportTable reports={reports} onOpen={noop} onEdit={noop} onDelete={noop} />,
    );
    expect(html).toContain("Copilot Spend");
    expect(html).toContain("Seat Usage");
    expect(html).toContain("monthly spend");
    expect(html).toContain("Delete");
    expect(html).toContain("Edit");
    // Export is a download anchor to the server attachment route.
    expect(html).toContain(`href="${reportExportPath("r1")}"`);
  });

  it("shows an empty state when there are no reports", () => {
    const html = renderToString(
      <ReportTable reports={[]} onOpen={noop} onEdit={noop} onDelete={noop} />,
    );
    expect(html).toContain("No reports yet");
  });
});

describe("reports api client", () => {
  it("targets the right endpoints", async () => {
    await listReports();
    expect(get).toHaveBeenCalledWith("/api/reports");
    await deleteReport("r1");
    expect(del).toHaveBeenCalledWith("/api/reports/r1");
    await importReport({ kind: "ghreporting.report" });
    expect(post).toHaveBeenCalledWith("/api/reports/import", {
      envelope: { kind: "ghreporting.report" },
    });
    expect(reportExportPath("r9")).toBe("/api/reports/r9/export");
  });
});
