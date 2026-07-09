import type { AppEvent, EventBus, Logger } from "./ports";

export function createEventBus(log: Logger): EventBus {
  const listeners = new Map<AppEvent["type"], Set<(e: AppEvent) => void>>();
  return {
    emit(e) {
      // Snapshot the set: a listener may subscribe/unsubscribe during dispatch, and we
      // must neither skip nor double-deliver the in-flight event (matches EventEmitter).
      for (const fn of [...(listeners.get(e.type) ?? [])]) {
        try {
          fn(e);
        } catch (err) {
          log.error("bus listener failed", { type: e.type, err: String(err) });
        }
      }
    },
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      const anyFn = fn as (e: AppEvent) => void;
      set.add(anyFn);
      return () => set.delete(anyFn);
    },
  };
}
