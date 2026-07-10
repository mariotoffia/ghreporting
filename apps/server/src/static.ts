import type { Hono } from "hono";

/**
 * Serve the embedded single-page UI from the compiled binary. Mount this *after*
 * the kernel has registered the `/api/*` routes (index.ts, post `kernel.start`):
 * Hono runs matching handlers in registration order, so a catch-all `*` placed
 * before the API routes would shadow every one of them.
 *
 * `embedded` maps a request path (`/index.html`, `/assets/…`) to the value of a
 * `with { type: "file" }` import — a virtual path into the binary that `Bun.file`
 * streams with the content-type inferred from the extension. An empty manifest is
 * dev mode (Vite owns the UI), so this becomes a no-op and API 404s stay JSON.
 *
 * The catch-all guards `/api/*` so an unknown API route still answers with the
 * shared JSON error envelope (app.notFound) instead of an HTML 200 — the SPA
 * fallback is for UI deep-links only.
 */
export function mountStatic(app: Hono, embedded: Record<string, string>): void {
  if (Object.keys(embedded).length === 0) return; // dev: Vite owns the UI
  app.get("*", (c) => {
    // Unknown /api/* GETs keep the JSON error envelope (app.notFound) — the SPA
    // fallback below is for UI routes only, never the API contract.
    if (c.req.path.startsWith("/api/")) return c.notFound();
    const path = c.req.path === "/" ? "/index.html" : c.req.path;
    const file = embedded[path] ?? embedded["/index.html"]; // SPA fallback
    if (!file) return c.notFound();
    return new Response(Bun.file(file)); // content-type inferred from extension
  });
}
