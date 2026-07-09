import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";

describe("App", () => {
  // zustand reports its initial state under SSR (getServerSnapshot === initial),
  // so the server render always shows the login splash. The view switch itself is
  // a client-only concern (useSyncExternalStore live snapshot) verified manually
  // per the task's "Done when"; the ui store transitions are covered in ui.test.ts.
  it("renders the branded splash for the initial (login) view", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("GH Reporting");
  });
});
