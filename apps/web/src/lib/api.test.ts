import { describe, expect, it, mock } from "bun:test";
import { ApiError, makeApi } from "./api";

/** Build a fetch stub returning one scripted Response, recording the call. */
function stubFetch(res: Response) {
  return mock(async (_path: string, _init?: RequestInit) => res) as unknown as typeof fetch & {
    mock: { calls: [string, RequestInit?][] };
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("makeApi", () => {
  it("returns parsed JSON on success and sends credentials", async () => {
    const fetchImpl = stubFetch(json({ ok: true }));
    const api = makeApi({ fetchImpl, onUnauthorized: () => {} });
    const out = await api.get<{ ok: boolean }>("/api/health");
    expect(out).toEqual({ ok: true });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("GET");
  });

  it("serializes a JSON body with content-type on POST", async () => {
    const fetchImpl = stubFetch(json({ id: 1 }));
    const api = makeApi({ fetchImpl, onUnauthorized: () => {} });
    await api.post("/api/x", { a: 1 });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("maps the error envelope to an ApiError carrying its code", async () => {
    const fetchImpl = stubFetch(json({ error: { code: "validation", message: "bad" } }, 400));
    const api = makeApi({ fetchImpl, onUnauthorized: () => {} });
    const err = (await api.get("/api/x").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("validation");
    expect(err.message).toBe("bad");
    expect(err.status).toBe(400);
  });

  it("falls back to http/statusText when the body is not an envelope", async () => {
    const fetchImpl = stubFetch(new Response("nope", { status: 500, statusText: "Server Error" }));
    const api = makeApi({ fetchImpl, onUnauthorized: () => {} });
    const err = (await api.get("/api/x").catch((e) => e)) as ApiError;
    expect(err.code).toBe("http");
    expect(err.status).toBe(500);
  });

  it("calls onUnauthorized on a 401 before throwing", async () => {
    const onUnauthorized = mock(() => {});
    const fetchImpl = stubFetch(json({ error: { code: "unauthorized", message: "login" } }, 401));
    const api = makeApi({ fetchImpl, onUnauthorized });
    await api.get("/api/x").catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
