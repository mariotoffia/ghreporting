// Touch ID first-run + unlock screen (ADR 0007). A thin shell over flows.ts:
// query the auth status, render setup vs. login, and route to the app once the
// server reports unlocked. All ceremony logic lives in (tested) flows.ts.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/client";
import { useUi } from "../../state/ui";
import { type AuthStatus, login, nextScreen, register, runCeremony } from "./flows";

const STATUS_KEY = ["auth", "status"] as const;
const fetchStatus = () => api.get<AuthStatus>("/api/auth/status");

export function Login() {
  const qc = useQueryClient();
  const setView = useUi((s) => s.setView);
  const [error, setError] = useState<string | null>(null);
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: fetchStatus });
  const screen = status.data ? nextScreen(status.data) : null;

  // This browser already has a live session (fresh or just-verified) → into the app.
  useEffect(() => {
    if (screen === "app") setView("explorer");
  }, [screen, setView]);

  const ceremony = useMutation({
    mutationFn: (kind: "setup" | "login") =>
      runCeremony(() => (kind === "setup" ? register(api) : login(api))),
    onMutate: () => setError(null),
    onSuccess: async (completed) => {
      if (completed) await qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (status.isLoading || screen === "app") {
    return (
      <main className="login">
        <h1>GH Reporting</h1>
        <p>Checking this device…</p>
      </main>
    );
  }

  const isSetup = screen === "setup";
  return (
    <main className="login">
      <h1>GH Reporting</h1>
      <p>{isSetup ? "Set up Touch ID to secure your local workbench." : "Locked."}</p>
      <button
        type="button"
        disabled={ceremony.isPending}
        onClick={() => ceremony.mutate(isSetup ? "setup" : "login")}
      >
        {isSetup ? "Set up Touch ID" : "Unlock with Touch ID"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
