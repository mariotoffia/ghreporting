import { Octokit } from "octokit";
import type { Logger } from "../../kernel/ports";
import type { GitHubClient } from "../../services/data/ports";

export type { GitHubClient };

/**
 * The one GitHub door (ADR 0005): token per request (rotation-safe), octokit
 * throttling + retry, conditional requests (a 304 costs no rate-limit quota),
 * and a request counter so tests/live runs can enforce a budget (TESTS.md §3).
 */
export function createGitHubClient(opts: {
  tokenProvider: () => Promise<string>; // credentials service (T3.4); tests: async () => "fake"
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
  octokit.hook.before("request", async (o) => {
    // token per request → rotation-safe
    count++;
    o.headers.authorization = `token ${await opts.tokenProvider()}`;
  });
  return {
    async get(route, params, o) {
      try {
        const res = await octokit.request(`GET ${route}`, {
          ...params,
          headers: o?.etag ? { "if-none-match": o.etag } : undefined,
        });
        return { status: 200, data: res.data, etag: res.headers.etag };
      } catch (e) {
        if (typeof e === "object" && e !== null && (e as { status?: number }).status === 304) {
          return { status: 304 }; // 304 costs no rate-limit quota
        }
        throw e;
      }
    },
    async *paginate(route, params) {
      for await (const page of octokit.paginate.iterator(`GET ${route}`, {
        per_page: 100,
        ...params,
      })) {
        yield page.data as never;
      }
    },
    requestCount: () => count,
  };
}
