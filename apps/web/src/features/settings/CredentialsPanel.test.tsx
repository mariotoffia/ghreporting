// StatusBadge renders via renderToString (the default, ADR 0015). SecretForm needs a DOM to
// run its submit + mutation, so this suite registers happy-dom like BoundChart's — the one
// other interactive suite. The api module is mocked, so no real network fires.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToString } from "react-dom/server";
import type { CredentialEntry } from "./api";

// Register once per process — another DOM suite (BoundChart) may already have (bun shares
// globals across files); a second GlobalRegistrator.register() throws.
if (typeof (globalThis as { document?: unknown }).document === "undefined") {
  GlobalRegistrator.register();
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock the shared client (like the query-datasets suites) — not ./api, so api.test.ts keeps
// the real module. SecretForm's putCredential funnels through api.put, so we assert on that.
const put = mock(async () => ({ id: "github-pat:default", status: "ok" }));
mock.module("../../lib/client", () => ({
  api: {
    get: mock(async () => []),
    post: mock(async () => ({})),
    put,
    del: mock(async () => ({})),
  },
}));

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { StatusBadge, SecretForm } = await import("./CredentialsPanel");

const patEntry: CredentialEntry = {
  id: "github-pat:default",
  type: "github-pat",
  status: null,
  expiresAt: null,
  statusDetail: null,
  describe: {
    type: "github-pat",
    title: "GitHub Personal Access Token",
    helpUrl: "https://github.com/settings/tokens",
    flow: "fields",
    fields: [{ key: "token", label: "Personal access token", secret: true }],
    requiredScopes: ["read:org"],
  },
};

/** Set a controlled input's value through React's tracked setter, then fire `input`. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("StatusBadge", () => {
  it("labels each state, and 'not configured' for a null status", () => {
    expect(renderToString(<StatusBadge status="ok" />)).toContain("ok");
    expect(renderToString(<StatusBadge status="invalid" />)).toContain("invalid");
    expect(renderToString(<StatusBadge status={null} />)).toContain("not configured");
  });
});

// biome-ignore lint/suspicious/noExplicitAny: react-dom Root type isn't worth importing here
let root: any;
let container: HTMLElement;

beforeEach(() => {
  put.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

function mount(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client: qc }, node));
  });
}

describe("SecretForm", () => {
  it("renders one password input from describe().fields", () => {
    mount(<SecretForm entry={patEntry} onChanged={() => {}} />);
    const input = container.querySelector("input");
    expect(input?.getAttribute("type")).toBe("password");
  });

  it("submitting PUTs the typed secret", async () => {
    mount(<SecretForm entry={patEntry} onChanged={() => {}} />);
    const input = container.querySelector("input") as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      typeInto(input, "ghp_typed_value");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(put).toHaveBeenCalledWith("/api/credentials/github-pat:default", {
      secret: "ghp_typed_value",
    });
  });

  it("shows the server's reason when the secret is rejected", async () => {
    put.mockImplementationOnce(async () => {
      throw new Error("token rejected (401)");
    });
    mount(<SecretForm entry={patEntry} onChanged={() => {}} />);
    const input = container.querySelector("input") as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      typeInto(input, "ghp_bad");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).toContain("token rejected (401)");
  });
});
