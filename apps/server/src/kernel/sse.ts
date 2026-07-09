import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Logger } from "./ports";

interface SseClient {
  write(event: string, data: string): Promise<void>;
  alive: boolean;
}

export function createSseHub(log: Logger) {
  const clients = new Set<SseClient>();
  return {
    /** Mount as: app.get("/stream", hub.handler()) */
    handler() {
      return (c: Context) =>
        streamSSE(c, async (stream) => {
          const client: SseClient = {
            alive: true,
            write: (event, data) => stream.writeSSE({ event, data }),
          };
          clients.add(client);
          stream.onAbort(() => {
            client.alive = false;
            clients.delete(client);
            log.info("sse client left", { clients: clients.size });
          });
          while (client.alive) {
            // keepalive ping every 25 s
            await stream.writeSSE({ event: "ping", data: "" });
            await stream.sleep(25_000);
          }
        });
    },
    broadcast(event: string, data: unknown) {
      const payload = JSON.stringify(data);
      for (const cl of clients) {
        cl.write(event, payload).catch(() => {
          cl.alive = false;
          clients.delete(cl);
        });
      }
    },
    clientCount: () => clients.size,
  };
}
