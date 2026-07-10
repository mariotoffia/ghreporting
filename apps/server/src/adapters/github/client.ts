import { Octokit } from "octokit";
import type { Logger } from "../../kernel/ports";
import type { GitHubClient } from "../../services/data/ports";

export type { GitHubClient };

/**
 * The one GitHub door (ADR 0005): token per request (rotation-safe), octokit throttling +
 * retry, conditional requests (a 304 costs no rate-limit quota), and a request counter so
 * tests/live runs can enforce a budget (TESTS.md §3).
 *
 * Token fallback (ADR 0018): the user may hold two *complementary* credentials — a
 * fine-grained PAT that reads the enhanced billing platform but not Copilot, and a device-flow
 * token that reads Copilot but not billing. `tokens()` returns them in priority order; a
 * request that fails with 401/403 (no access) is retried with the next candidate, so each
 * endpoint uses whichever token can actually read it. The auth header is passed per request
 * (never shared mutable state), so concurrent syncs can't clobber each other's token.
 */
export function createGitHubClient(opts: {
  tokenProvider?: () => Promise<string>; // single token (back-compat; tests: async () => "fake")
  tokens?: () => Promise<string[]>; // ordered candidates, tried on 401/403 (preferred)
  fetchImpl?: typeof fetch; // fixture replay injects here (T11.1)
  log: Logger;
}): GitHubClient {
  let count = 0;
  const octokit = new Octokit({
    request: opts.fetchImpl ? { fetch: opts.fetchImpl } : undefined,
    throttle: {
      onRateLimit: (retryAfter: number, _o: unknown, _c: unknown, retryCount: number) => {
        opts.log.warn("rate limited", { retryAfter, retryCount });
        return retryCount < 1; // retry once, then give up loudly
      },
      onSecondaryRateLimit: (retryAfter: number) => {
        opts.log.warn("secondary rate limit", { retryAfter });
        return true;
      },
    },
  });
  octokit.hook.before("request", () => {
    count++; // one octokit request = one API call; auth rides the per-request headers below
  });

  // Ordered candidate tokens; a single tokenProvider becomes a one-element list.
  const candidates: () => Promise<string[]> =
    opts.tokens ??
    (opts.tokenProvider
      ? async () => [await (opts.tokenProvider as () => Promise<string>)()]
      : async () => []);

  const isAuthError = (e: unknown): boolean => {
    const s = (e as { status?: number }).status;
    return s === 401 || s === 403;
  };

  /**
   * Run `attempt` under each candidate token, moving to the next only on a 401/403, so
   * complementary tokens each cover the endpoints they can access. The last candidate's error
   * propagates. A permission failure surfaces on the FIRST request, before any data is yielded.
   */
  async function withTokens<T>(attempt: (authHeader: string) => Promise<T>): Promise<T> {
    const toks = await candidates();
    if (toks.length === 0) throw new Error("no GitHub credential configured");
    let lastErr: unknown;
    for (let i = 0; i < toks.length; i++) {
      try {
        return await attempt(`token ${toks[i]}`);
      } catch (e) {
        if (isAuthError(e) && i < toks.length - 1) {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw lastErr; // unreachable: the loop either returns or throws on the last candidate
  }

  return {
    async get(route, params, o) {
      return withTokens(async (authorization) => {
        try {
          const res = await octokit.request(`GET ${route}`, {
            ...params,
            headers: { authorization, ...(o?.etag ? { "if-none-match": o.etag } : {}) },
          });
          return { status: 200 as const, data: res.data, etag: res.headers.etag };
        } catch (e) {
          if ((e as { status?: number }).status === 304) return { status: 304 as const };
          throw e; // let withTokens decide whether to fall back
        }
      });
    },
    async *paginate(route, params) {
      const toks = await candidates();
      if (toks.length === 0) throw new Error("no GitHub credential configured");
      for (let i = 0; i < toks.length; i++) {
        try {
          for await (const page of octokit.paginate.iterator(`GET ${route}`, {
            per_page: 100,
            ...params,
            headers: { authorization: `token ${toks[i]}` },
          })) {
            yield page.data as never;
          }
          return; // completed with this token
        } catch (e) {
          // Auth failures hit the first page (before any yield), so switching tokens and
          // restarting can't duplicate already-yielded pages; rate-limit 403s are absorbed by
          // octokit's throttle, not surfaced here.
          if (isAuthError(e) && i < toks.length - 1) continue;
          throw e;
        }
      }
    },
    async download(url) {
      count++;
      const f = opts.fetchImpl ?? fetch;
      const res = await f(url); // deliberately no Authorization: signed URLs reject it
      if (!res.ok) {
        throw Object.assign(new Error(`download failed: ${res.status} ${url}`), {
          status: res.status,
        });
      }
      return res.text();
    },
    requestCount: () => count,
  };
}
