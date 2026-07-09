import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createSseHub } from "./sse";
import { nullLogger } from "./testutil";

const decoder = new TextDecoder();
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

afterEach(async () => {
  // Cancelling triggers onAbort → clients.delete, so counts don't drift between tests.
  // (The 25s keepalive timer keeps ticking until bun force-exits — it does not block.)
  await Promise.all(readers.splice(0).map((r) => r.cancel().catch(() => {})));
});

/** Read chunks until `needle` appears in the accumulated text (bounded, no sleeps). */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
): Promise<string> {
  let buf = "";
  for (let i = 0; i < 50; i++) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value);
    if (buf.includes(needle) || done) return buf;
  }
  return buf;
}

describe("createSseHub", () => {
  it("broadcasts an event to every connected client", async () => {
    const hub = createSseHub(nullLogger());
    const app = new Hono();
    app.get("/stream", hub.handler());

    const res1 = await app.request("/stream");
    const res2 = await app.request("/stream");
    expect(hub.clientCount()).toBe(2);

    hub.broadcast("notification.changed", { id: 7 });

    const r1 = res1.body?.getReader();
    const r2 = res2.body?.getReader();
    if (!r1 || !r2) throw new Error("no stream body");
    readers.push(r1, r2);

    const buf1 = await readUntil(r1, "event: notification.changed");
    const buf2 = await readUntil(r2, "event: notification.changed");
    expect(buf1).toContain('data: {"id":7}');
    expect(buf2).toContain('data: {"id":7}');
  });

  it("emits a keepalive ping to a new client", async () => {
    const hub = createSseHub(nullLogger());
    const app = new Hono();
    app.get("/stream", hub.handler());
    const res = await app.request("/stream");
    const r = res.body?.getReader();
    if (!r) throw new Error("no stream body");
    readers.push(r);
    expect(await readUntil(r, "event: ping")).toContain("event: ping");
  });

  it("drops a client on disconnect and later broadcasts do not throw", async () => {
    const hub = createSseHub(nullLogger());
    const app = new Hono();
    app.get("/stream", hub.handler());

    const res1 = await app.request("/stream");
    const res2 = await app.request("/stream");
    expect(hub.clientCount()).toBe(2);

    const r1 = res1.body?.getReader();
    const r2 = res2.body?.getReader();
    if (!r1 || !r2) throw new Error("no stream body");
    readers.push(r2);

    await r1.cancel(); // client 1 disconnects
    expect(hub.clientCount()).toBe(1);

    expect(() => hub.broadcast("auth.unlocked", {})).not.toThrow();
    expect(hub.clientCount()).toBe(1);
  });

  it("reports zero clients before anyone connects", () => {
    expect(createSseHub(nullLogger()).clientCount()).toBe(0);
  });
});
