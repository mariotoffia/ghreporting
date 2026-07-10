// The app shell (ARCHITECTURE.md §7): a TanStack Query provider, a three-view
// switch driven by the ui store, and the SSE bridge that turns server events into
// query invalidations. Heavy views (Explorer, later Univer) load via React.lazy so
// the login screen stays light (ADR 0008).
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComponentType, lazy, Suspense, useEffect } from "react";
import { Bell } from "./features/notifications/Bell";
import { NOTIFICATIONS_KEY, notificationsQuery } from "./features/notifications/query";
import { startSse } from "./lib/sse";
import { useUi, type View } from "./state/ui";

const Login = lazy(() => import("./features/login/Login").then((m) => ({ default: m.Login })));
const Explorer = lazy(() =>
  import("./features/explorer/Explorer").then((m) => ({ default: m.Explorer })),
);
// Univer is heavy — the Workbench (SheetHost) loads only when its tab is opened (ADR 0008).
const Workbench = lazy(() =>
  import("./features/sheets/Workbench").then((m) => ({ default: m.Workbench })),
);
const Reports = lazy(() =>
  import("./features/reports/Reports").then((m) => ({ default: m.Reports })),
);
const QueryDatasets = lazy(() =>
  import("./features/query-datasets/Editor").then((m) => ({ default: m.Editor })),
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

const EXPLORER_TAB = { view: "explorer", label: "Explorer", component: Explorer } as const;
const TABS: { view: Exclude<View, "login">; label: string; component: ComponentType }[] = [
  EXPLORER_TAB,
  { view: "workbench", label: "Workbench", component: Workbench },
  { view: "reports", label: "Reports", component: Reports },
  { view: "query-datasets", label: "Query datasets", component: QueryDatasets },
];

/** Bridges the single SSE stream to query invalidations for the whole app. */
function SseBridge() {
  const qc = useQueryClient();
  useEffect(
    () =>
      startSse((type) =>
        qc.invalidateQueries({
          queryKey: type === "notification.changed" ? NOTIFICATIONS_KEY : ["datasets"],
        }),
      ),
    [qc],
  );
  return null;
}

function Splash() {
  return (
    <main className="splash">
      <h1>GH Reporting</h1>
      <p>Loading…</p>
    </main>
  );
}

function Shell() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const notes = useQuery(notificationsQuery);
  const errors = (notes.data ?? []).filter((n) => n.level === "error" && n.read_at === null);
  const Active = (TABS.find((t) => t.view === view) ?? EXPLORER_TAB).component;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">GH Reporting</span>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.view}
              type="button"
              className={view === t.view ? "tab active" : "tab"}
              onClick={() => setView(t.view)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <Bell />
      </header>
      {errors.length > 0 && (
        <div className="banner banner-error" role="alert">
          {errors.length === 1 ? errors[0]?.title : `${errors.length} problems need attention`}
        </div>
      )}
      <Suspense fallback={<p className="loading">Loading…</p>}>
        <Active />
      </Suspense>
      <SseBridge />
    </div>
  );
}

function Root() {
  const view = useUi((s) => s.view);
  if (view === "login") {
    return (
      <Suspense fallback={<Splash />}>
        <Login />
      </Suspense>
    );
  }
  return <Shell />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  );
}
