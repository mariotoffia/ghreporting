// context.ts — ServiceContext with late-bound notify/secrets slots.
// notifications and credentials services bind themselves during their init.
import { SecretsLockedError } from "./errors";
import type { NotificationInput, SecretStore, ServiceContext } from "./ports";

export function createContext(base: Omit<ServiceContext, "notify" | "resolve" | "secrets">) {
  const slots = {
    notify: (n: NotificationInput) =>
      base.log.warn("notify before notifications init", { notification: n }),
    resolve: (key: string) => base.log.warn("resolve before notifications init", { key }),
    secrets: lockedSecretStore(),
  };
  const ctx: ServiceContext = {
    ...base,
    notify: (n) => slots.notify(n),
    resolve: (key) => slots.resolve(key),
    secrets: {
      get: (a) => slots.secrets.get(a),
      set: (a, s) => slots.secrets.set(a, s),
      delete: (a) => slots.secrets.delete(a),
    },
  };
  return {
    ctx,
    bindNotify(fn: (n: NotificationInput) => void) {
      slots.notify = fn;
    },
    bindResolve(fn: (key: string) => void) {
      slots.resolve = fn;
    },
    bindSecrets(store: SecretStore) {
      slots.secrets = store;
    },
  };
}

function lockedSecretStore(): SecretStore {
  const locked = async (): Promise<never> => {
    throw new SecretsLockedError();
  };
  return { get: locked, set: locked, delete: locked };
}
