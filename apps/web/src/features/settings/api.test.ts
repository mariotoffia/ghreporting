import { describe, expect, it, mock } from "bun:test";

// Mock the shared client BEFORE importing ./api so the typed client binds to these spies
// (TESTS.md §4: assert the api layer targets the right endpoints; live routes aren't mounted).
const get = mock(async () => [] as unknown);
const post = mock(async () => ({}) as unknown);
const put = mock(async () => ({}) as unknown);
const del = mock(async () => ({}) as unknown);
mock.module("../../lib/client", () => ({ api: { get, post, put, del } }));

const {
  listCredentials,
  putCredential,
  deleteCredential,
  validateCredential,
  startDevice,
  pollDevice,
} = await import("./api");

describe("settings/credentials api client", () => {
  it("targets the right endpoints and rides secrets in the body only", async () => {
    await listCredentials();
    expect(get).toHaveBeenCalledWith("/api/credentials");

    await putCredential("github-pat:default", "ghp_secret");
    // The secret rides the body only — the path (first arg) never carries it.
    expect(put).toHaveBeenCalledWith("/api/credentials/github-pat:default", {
      secret: "ghp_secret",
    });

    await deleteCredential("github-pat:default");
    expect(del).toHaveBeenCalledWith("/api/credentials/github-pat:default");

    await validateCredential("github-pat:default");
    expect(post).toHaveBeenCalledWith("/api/credentials/github-pat:default/validate");

    await startDevice("github-oauth:default");
    expect(post).toHaveBeenCalledWith("/api/credentials/github-oauth:default/device/start");

    await pollDevice("github-oauth:default");
    expect(post).toHaveBeenCalledWith("/api/credentials/github-oauth:default/device/poll");
  });
});
