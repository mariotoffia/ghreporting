import { describe, expect, it, mock } from "bun:test";
import { renderToString } from "react-dom/server";

// Mock the shared client before importing the component's api module (TESTS.md §4).
mock.module("../../lib/client", () => ({
  api: { get: mock(async () => []), post: mock(), put: mock(), del: mock() },
}));

const { QueryDatasetTable } = await import("./Editor");

const datasets = [
  {
    id: "spend-by-model",
    title: "Spend by model",
    description: "monthly",
    updated_at: "2026-07-10",
  },
  { id: "seats", title: "Seats", description: null, updated_at: "2026-07-09" },
];
const noop = () => {};

describe("QueryDatasetTable", () => {
  it("renders each query dataset with edit and delete actions", () => {
    const html = renderToString(
      <QueryDatasetTable datasets={datasets} onEdit={noop} onDelete={noop} />,
    );
    expect(html).toContain("Spend by model");
    expect(html).toContain("Seats");
    expect(html).toContain("monthly");
    expect(html).toContain("Edit");
    expect(html).toContain("Delete");
  });

  it("shows an empty state when there are none", () => {
    const html = renderToString(<QueryDatasetTable datasets={[]} onEdit={noop} onDelete={noop} />);
    expect(html).toContain("No query datasets yet");
  });
});
