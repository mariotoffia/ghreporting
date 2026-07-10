import { describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";

// Mock the shared client so importing the section (→ query-datasets/api) needs no live api.
mock.module("../../lib/client", () => ({
  api: { get: mock(async () => ({})), post: mock(), put: mock(), del: mock() },
}));

const { DatasetsSection } = await import("./DatasetsSection");

import type { DatasetFormFields } from "./panelForm";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const render = (datasets: DatasetFormFields[]) =>
  renderToString(
    <QueryClientProvider client={qc}>
      <DatasetsSection datasets={datasets} onChange={() => {}} />
    </QueryClientProvider>,
  );

describe("DatasetsSection", () => {
  it("renders an add button and the legend when empty", () => {
    const html = render([]);
    expect(html).toContain("Add dataset");
    expect(html).toContain("Datasets");
  });

  it("renders a row's id/title for each embedded dataset", () => {
    const html = render([
      { id: "spend-by-model", title: "Spend by model", description: "", sql: "SELECT 1" },
    ]);
    expect(html).toContain("spend-by-model");
    expect(html).toContain("Spend by model");
    expect(html).toContain("Remove");
  });
});
