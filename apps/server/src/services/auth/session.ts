// Session: in-memory server token behind an HttpOnly cookie; dies with the
// process by design (ADR 0007 — restarting the app costs one Touch ID tap).
export function createSessionStore(now: () => Date, idleMs = 12 * 3_600_000) {
  const sessions = new Map<string, { lastSeen: number }>();
  return {
    create(): string {
      const token = crypto.randomUUID();
      sessions.set(token, { lastSeen: now().getTime() });
      return token;
    },
    /** Validates and slides the idle window. False = missing or idle-expired. */
    touch(token: string): boolean {
      const s = sessions.get(token);
      if (!s || now().getTime() - s.lastSeen > idleMs) {
        sessions.delete(token);
        return false;
      }
      s.lastSeen = now().getTime();
      return true;
    },
    destroy(token: string) {
      sessions.delete(token);
    },
    clear() {
      sessions.clear();
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
