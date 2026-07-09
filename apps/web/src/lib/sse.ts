// EventSource client (ARCHITECTURE.md §7). One stream carries every event the
// notifications uService fans out (card changes + sync progress, matching its
// STREAMED list); the browser handles auto-reconnect natively. App wires the
// `onEvent` callback to TanStack Query invalidations.
const STREAM_URL = "/api/notifications/stream";

// The `event:` field names on the wire — must match the server's broadcast types.
const TYPES = ["notification.changed", "sync.started", "sync.completed", "sync.failed"] as const;

export function startSse(onEvent: (type: string, data: unknown) => void): () => void {
  const es = new EventSource(STREAM_URL, { withCredentials: true });
  const listeners = TYPES.map((type) => {
    const handler = (e: MessageEvent) => {
      let data: unknown = e.data;
      try {
        data = JSON.parse(e.data);
      } catch {
        // non-JSON payload (never expected from our hub): pass the raw string
      }
      onEvent(type, data);
    };
    es.addEventListener(type, handler);
    return { type, handler };
  });
  return () => {
    for (const { type, handler } of listeners) es.removeEventListener(type, handler);
    es.close();
  };
}
