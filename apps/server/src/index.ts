import { buildApp } from "./app";

const { app, kernel, ctx } = buildApp();
await kernel.start(app);

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
  ctx.db.close(); // after services stop, so none use a dead handle; lets WAL checkpoint
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
