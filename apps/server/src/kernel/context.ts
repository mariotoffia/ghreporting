// context.ts — ServiceContext with late-bound notify/secrets slots.
// notifications and credentials services bind themselves during their init.
import { SecretsLockedError } from "./errors";
import type { NotificationInput, SecretStore, ServiceContext } from "./ports";

export function createContext(base: Omit<ServiceContext, "notify" | "secrets">) {
  const slots = {
    notify: (n: NotificationInput) =>
      base.log.warn("notify before notifications init", { notification: n }),
    secrets: lockedSecretStore(),
  };
  const ctx: ServiceContext = {
    ...base,
    notify: (n) => slots.notify(n),
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
