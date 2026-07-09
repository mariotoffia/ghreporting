import { describe, expect, it } from "bun:test";
import { recordingLogger } from "../../kernel/testutil";
import { createGitHubClient } from "./client";

type Call = { url: string; headers: Headers };

/** A fetch fake that pops queued responses and records every call. */
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const impl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    });
    const next = responses.shift();
    if (!next) throw new Error("fakeFetch: no responses left");
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(impl: typeof fetch, log = recordingLogger()) {
  return createGitHubClient({ tokenProvider: async () => "fake-token", fetchImpl: impl, log });
}

describe("createGitHubClient", () => {
  it("attaches the token from tokenProvider to every request and counts requests", async () => {
    const { impl, calls } = fakeFetch([json({ login: "acme" }), json({ login: "acme" })]);
    const gh = makeClient(impl);
    await gh.get("/orgs/{org}", { org: "acme" });
    await gh.get("/orgs/{org}", { org: "acme" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get("authorization")).toBe("token fake-token");
    expect(calls[0]?.url).toContain("/orgs/acme");
    expect(gh.requestCount()).toBe(2);
  });

  it("returns data + etag on 200", async () => {
    const { impl } = fakeFetch([json({ total: 1 }, { etag: 'W/"abc"' })]);
    const res = await makeClient(impl).get<{ total: number }>("/orgs/{org}/copilot/metrics", {
      org: "acme",
    });
    expect(res.status).toBe(200);
    if (res.status === 200) {
      expect(res.data.total).toBe(1);
      expect(res.etag).toBe('W/"abc"');
    }
  });

  it("sends if-none-match and maps 304 to { status: 304 }", async () => {
    const { impl, calls } = fakeFetch([new Response(null, { status: 304 })]);
    const res = await makeClient(impl).get("/orgs/{org}", { org: "acme" }, { etag: 'W/"abc"' });
    expect(res).toEqual({ status: 304 });
    expect(calls[0]?.headers.get("if-none-match")).toBe('W/"abc"');
  });

  it("rethrows non-304 errors", async () => {
    const { impl } = fakeFetch([json({ message: "Not Found" }, {}, 404)]);
    await expect(makeClient(impl).get("/orgs/{org}", { org: "nope" })).rejects.toThrow();
  });

  it("paginate follows link headers across two pages", async () => {
    const { impl, calls } = fakeFetch([
      json([{ id: 1 }, { id: 2 }], {
        link: '<https://api.github.com/orgs/acme/members?per_page=100&page=2>; rel="next"',
      }),
      json([{ id: 3 }]),
    ]);
    const pages: unknown[][] = [];
    for await (const page of makeClient(impl).paginate<{ id: number }>("/orgs/{org}/members", {
      org: "acme",
    })) {
      pages.push(page);
    }
    expect(pages).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
    expect(calls[0]?.url).toContain("per_page=100");
  });

  it("download fetches a signed URL without auth headers and counts the request", async () => {
    const { impl, calls } = fakeFetch([new Response('{"day":"2026-07-01"}\n')]);
    const gh = makeClient(impl);
    const text = await gh.download("https://signed.example.com/report-1.ndjson");
    expect(text).toContain("2026-07-01");
    expect(calls[0]?.url).toBe("https://signed.example.com/report-1.ndjson");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(gh.requestCount()).toBe(1);
  });

  it("download throws with the status on a non-ok response", async () => {
    const { impl } = fakeFetch([new Response("expired", { status: 403 })]);
    await expect(makeClient(impl).download("https://signed.example.com/x")).rejects.toThrow("403");
  });

  it("logs and retries once when rate limited", async () => {
    // reset in the PAST: the retry path is identical but octokit's throttle
    // sleeps until the reset time — a future value is a hidden real sleep
    const reset = String(Math.floor(Date.now() / 1000) - 10);
    const log = recordingLogger();
    const { impl, calls } = fakeFetch([
      json(
        { message: "API rate limit exceeded" },
        {
          "retry-after": "0",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": reset,
        },
        403,
      ),
      json({ ok: true }),
    ]);
    const res = await makeClient(impl, log).get<{ ok: boolean }>("/orgs/{org}", { org: "acme" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(log.lines.some((l) => l.level === "warn" && l.msg === "rate limited")).toBe(true);
  });
});
