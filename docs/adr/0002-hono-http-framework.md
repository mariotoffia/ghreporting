# 0002 — Hono as the HTTP framework

Status: accepted

## Context

The uService kernel needs route mounting, middleware (session gate, error mapping), and
SSE streaming on top of `Bun.serve`. Raw `fetch` handlers would work but re-invent
routing and middleware composition.

## Decision

Use **Hono**. It is Web-standard (`Request`/`Response`), tiny, actively maintained,
runs unchanged inside `bun build --compile`, and its `app.request()` lets tests hit
routes in-process without opening a port. Each uService mounts its routes under
`/api/<name>` on the shared app.

## Consequences

- Kernel `MicroService.routes?(app: Hono, ctx)` is typed against Hono — acceptable
  coupling, isolated to the routes layer.
- Middleware chain (session gate, `onError` → `{error: {code, message}}` JSON) is
  declared once in `app.ts`.
- SSE uses Hono's streaming helpers over a plain `ReadableStream`.

## Rejected alternatives

- **Elysia:** excellent Bun-native performance, but Hono's portability and larger
  ecosystem win for a tool whose bottleneck is GitHub's API, not local HTTP.
- **Raw `Bun.serve` routing:** ~100 lines of hand-rolled router/middleware for zero
  gain — exactly the code Hono already is.
