import { buildApp } from "./app";
import { embedded } from "./embedded";
import { mountStatic } from "./static";

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
