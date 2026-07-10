import { describe, expect, it, mock } from "bun:test";

// Mock the shared client BEFORE importing ./api so the typed client binds to these spies
// (TESTS.md §4: assert the api layer targets the right endpoints; live containers aren't mounted).
const get = mock(async () => [] as unknown);
const post = mock(async () => ({}) as unknown);
const put = mock(async () => ({}) as unknown);
const del = mock(async () => ({}) as unknown);
mock.module("../../lib/client", () => ({ api: { get, post, put, del } }));

const {
  listQueryDatasets,
  getQueryDataset,
  updateQueryDataset,
  deleteQueryDataset,
  previewQueryDataset,
} = await import("./api");

describe("query-datasets api client", () => {
  it("targets the right endpoints", async () => {
    await listQueryDatasets();
    expect(get).toHaveBeenCalledWith("/api/data/query-datasets");

    await getQueryDataset("spend-by-model");
    expect(get).toHaveBeenCalledWith("/api/data/query-datasets/spend-by-model");

    await updateQueryDataset("spend-by-model", { title: "Renamed" });
    expect(put).toHaveBeenCalledWith("/api/data/query-datasets/spend-by-model", {
      title: "Renamed",
    });

    await deleteQueryDataset("spend-by-model");
    expect(del).toHaveBeenCalledWith("/api/data/query-datasets/spend-by-model");

    await previewQueryDataset({ sql: "SELECT 1" });
    expect(post).toHaveBeenCalledWith("/api/data/query-datasets/preview", { sql: "SELECT 1" });
  });
});
