import { buildApp } from "./app";

const { app, kernel, ctx } = buildApp();
await kernel.start(app);

const server = Bun.serve({ port: ctx.config.port, fetch: app.fetch });
ctx.log.info("server listening", { url: `http://localhost:${server.port}` });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; // a second signal must not run stop() twice / exit mid-cleanup
  shuttingDown = true;
  await kernel.stop();
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
