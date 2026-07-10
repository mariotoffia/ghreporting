// "Connect GitHub" device-flow sign-in (T12.3, ADR 0018): start the ceremony, show the
// user code + verification link, and poll to completion — no token ever typed. The poll loop
// is a pure function (runDeviceSignIn) with injected sleep/now, so tests drive it with neither
// a real timer nor a real network (TESTS.md §2 anti-flake). The React component wires the pure
// loop to real timers + the api, and cancels on unmount.
import { useEffect, useRef, useState } from "react";
import { type CredentialEntry, type DeviceStart, pollDevice, startDevice } from "./api";

type PollResult = { pending: true } | { status: "ok" | "expiring" | "invalid" };

/**
 * Poll until the code is authorized or expires. Injected `sleep`, `now`, `poll` keep it pure.
 * `cancelled()` lets the caller stop early (component unmount). Returns the outcome; never throws
 * for a pending code — only a real api error propagates.
 */
export async function runDeviceSignIn(opts: {
  start: DeviceStart;
  poll: () => Promise<PollResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  cancelled?: () => boolean;
}): Promise<{ status: "ok" | "expiring" | "invalid" } | { expired: true } | { cancelled: true }> {
  const deadline = opts.now() + opts.start.expiresIn * 1000;
  // ponytail: fixed interval. The server folds slow_down into "pending", so the UI can't see
  // it; GitHub's `interval` is already its minimum, so polling at it avoids slow_down in practice.
  while (opts.now() < deadline) {
    await opts.sleep(opts.start.interval * 1000);
    if (opts.cancelled?.()) return { cancelled: true };
    const r = await opts.poll();
    if (!("pending" in r)) return { status: r.status };
  }
  return { expired: true };
}

type Phase =
  | { k: "idle" }
  | { k: "starting" }
  | { k: "waiting"; code: string; uri: string }
  | { k: "expired" }
  | { k: "error"; msg: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The server 410s a poll once the code expires (its deadline fires before the client's, since
 * startDevice adds a round-trip), so a real expiry arrives as this ApiError — not the loop's
 * own `{ expired: true }`. Both map to the "code expired" state.
 */
export function isExpiredError(e: unknown): boolean {
  return (e as { code?: string })?.code === "credential.device_expired";
}

export function DeviceFlow({
  entry,
  onChanged,
}: {
  entry: CredentialEntry;
  onChanged: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const cancelled = useRef(false);
  // Unmount stops the loop: the next poll tick sees cancelled and returns without touching state.
  useEffect(() => {
    return () => {
      cancelled.current = true;
    };
  }, []);

  async function connect() {
    cancelled.current = false;
    setPhase({ k: "starting" });
    try {
      const start = await startDevice(entry.id);
      setPhase({ k: "waiting", code: start.userCode, uri: start.verificationUri });
      const result = await runDeviceSignIn({
        start,
        poll: () => pollDevice(entry.id),
        sleep,
        now: () => Date.now(),
        cancelled: () => cancelled.current,
      });
      if (cancelled.current) return;
      if ("status" in result) {
        onChanged(); // badge refreshes to configured
        setPhase({ k: "idle" });
      } else if ("expired" in result) {
        setPhase({ k: "expired" });
      }
    } catch (e) {
      if (cancelled.current) return;
      if (isExpiredError(e)) setPhase({ k: "expired" });
      else setPhase({ k: "error", msg: (e as Error).message });
    }
  }

  const label = entry.status === null ? "Connect GitHub" : "Reconnect";
  return (
    <div className="device-flow">
      {phase.k === "waiting" ? (
        <div className="device-waiting">
          <p>
            Enter this code at{" "}
            <a href={phase.uri} target="_blank" rel="noreferrer">
              {phase.uri}
            </a>
            :
          </p>
          <p className="device-code">{phase.code}</p>
          <p className="device-spinner">Waiting for authorization…</p>
        </div>
      ) : (
        <>
          <button type="button" onClick={connect} disabled={phase.k === "starting"}>
            {phase.k === "starting" ? "Starting…" : label}
          </button>
          {phase.k === "expired" && (
            <p className="form-error" role="alert">
              Code expired — try again.
            </p>
          )}
          {phase.k === "error" && (
            <p className="form-error" role="alert">
              {phase.msg}
            </p>
          )}
        </>
      )}
    </div>
  );
}
