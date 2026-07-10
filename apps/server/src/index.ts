import { buildApp } from "./app";
import { embedded } from "./embedded";
import { mountStatic } from "./static";

// The compiled binary ships the UI embedded; a non-empty manifest means we ARE the packaged
// app, so turn on packaged behaviors (the background scheduler) even when GHR_PACKAGED is
// unset. Must run before buildApp(), which reads the env into a frozen config. Explicit
// GHR_PACKAGED (0 or 1) still wins for anyone overriding it.
if (Object.keys(embedded).length > 0 && process.env.GHR_PACKAGED === undefined) {
  process.env.GHR_PACKAGED = "1";
}

const { app, kernel, ctx, roDb } = buildApp();
await kernel.start(app);
// Serve the embedded UI last — after kernel.start mounted /api/*, so the catch-all
// `*` route can't shadow them (Hono matches in registration order). No-op in dev,
// where the manifest is empty and Vite serves the UI.
mountStatic(app, embedded);

const server = Bun.serve({
  port: ctx.config.port,
  fetch: app.fetch,
  // Last-resort boundary: Hono's onError only fires for `Error` instances, so a
  // `throw "string"` in a handler escapes it. Return the JSON envelope (never a raw
  // stack page) and log the detail server-side.
  error(err) {
    ctx.log.error("uncaught", { err: String(err) });
    return Response.json(
      { error: { code: "internal", message: "internal error" } },
      { status: 500 },
    );
  },
});
ctx.log.info("server listening", { url: `http://localhost:${server.port}` });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; // a second signal must not run stop() twice / exit mid-cleanup
  shuttingDown = true;
  await kernel.stop();
  roDb?.close(); // the read-only query-dataset handle (ADR 0016), before the RW handle
  ctx.db.close(); // after services stop, so none use a dead handle; lets WAL checkpoint
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
