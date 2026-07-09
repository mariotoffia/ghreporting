import { beforeEach, describe, expect, it } from "bun:test";
import { useUi } from "./ui";

describe("ui store", () => {
  beforeEach(() => useUi.setState({ view: "login" }));

  it("starts on the login view", () => {
    expect(useUi.getState().view).toBe("login");
  });

  it("setView switches between the three views", () => {
    useUi.getState().setView("explorer");
    expect(useUi.getState().view).toBe("explorer");
    useUi.getState().setView("workbench");
    expect(useUi.getState().view).toBe("workbench");
  });
});
