// Typed fetch wrapper (ARCHITECTURE.md §7). Every call is cookie-authenticated
// (`credentials: "include"`); a 401 routes back to the login screen via the
// injected `onUnauthorized` seam, and the server's `{ error: { code, message } }`
// envelope surfaces as a structured `ApiError`.
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function makeApi(deps: { fetchImpl?: typeof fetch; onUnauthorized(): void }) {
  const f = deps.fetchImpl ?? fetch;
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await f(path, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) deps.onUnauthorized();
    if (!res.ok) {
      const env = (await res.json().catch(() => null)) as {
        error?: { code: string; message: string };
      } | null;
      throw new ApiError(
        env?.error?.code ?? "http",
        env?.error?.message ?? res.statusText,
        res.status,
      );
    }
    return (await res.json()) as T;
  }
  return {
    get: <T>(p: string) => request<T>("GET", p),
    post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
    put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
    del: <T>(p: string) => request<T>("DELETE", p),
  };
}

export type Api = ReturnType<typeof makeApi>;
