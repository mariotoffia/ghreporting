import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8787);
const server = Bun.serve({ port, fetch: createApp().fetch });
console.log(`ghreporting server listening on http://localhost:${server.port}`);
