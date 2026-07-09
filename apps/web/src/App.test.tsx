import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import { App } from "./App";

describe("App", () => {
  it("renders the shell heading", () => {
    expect(renderToString(<App />)).toContain("GH Reporting");
  });
});
