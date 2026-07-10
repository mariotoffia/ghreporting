// Dataset explorer (T6.4): discover datasets, read coverage, sync, preview.
// The catalog + config queries are server state; org text and expand/preview are
// local UI state. SSE sync.* events invalidate ["datasets"] (wired in App), so a
// running sync flips the coverage line live.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../../lib/client";
import { useUi } from "../../state/ui";
import { type CatalogEntry, coverageForOrg, formatCoverage, lastNDays } from "./format";
import { Preview, type ResultSet } from "./Preview";

const DATASETS_KEY = ["datasets"] as const;
const fetchCatalog = () => api.get<CatalogEntry[]>("/api/data/datasets");

export function Explorer() {
  const qc = useQueryClient();
  const requestInsert = useUi((s) => s.requestInsert);
  const insertPending = useUi((s) => s.pendingInsert !== null);
  const catalog = useQuery({ queryKey: DATASETS_KEY, queryFn: fetchCatalog });
  const config = useQuery({
    queryKey: ["data", "config"],
    queryFn: () => api.get<{ org: string | null }>("/api/data/config"),
  });

  // Seed the org input from the server default exactly once; after that it is
  // freely editable (including cleared) — no fallback that would fight the user.
  const [org, setOrg] = useState("");
  const seeded = useRef(false);
  useEffect(() => {
    if (!seeded.current && config.data) {
      setOrg(config.data.org ?? "");
      seeded.current = true;
    }
  }, [config.data]);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ dataset: string; result: ResultSet } | null>(null);
  const trimmedOrg = org.trim();
  // A real window so date-ranged datasets (metrics, billing, premium-requests) actually fill —
  // syncing with no range fetches only today. 180 days ≈ the reports' 6-month default.
  const range = lastNDays(new Date(), 180);

  // Persist the org server-side so it survives restarts (Explorer prefill) and gives the
  // background scheduler a scope. Saved on blur — no need to re-enter it every session.
  const persistOrg = useMutation({
    mutationFn: (o: string) => api.put("/api/data/config", { org: o }),
  });

  const sync = useMutation({
    // force: an explicit click re-fetches even a range that already looks covered (e.g. one
    // that previously synced 0 rows behind a permission 404) — otherwise nothing happens.
    mutationFn: (dataset: string) =>
      api.post("/api/data/sync", { dataset, org: trimmedOrg, range, force: true }),
    onSettled: () => qc.invalidateQueries({ queryKey: DATASETS_KEY }),
  });

  // Sync every dataset for the current org, sequentially (octokit throttles anyway). One
  // dataset's failure (e.g. a 403 where an org policy is off) must not abort the rest, so
  // each is caught; per-row coverage/errors refresh from the single invalidation at the end.
  const syncAll = useMutation({
    mutationFn: async () => {
      // Skip readonly query datasets — they're computed from SQL, syncing them is a no-op.
      for (const d of (catalog.data ?? []).filter((x) => !x.readonly)) {
        await api
          .post("/api/data/sync", { dataset: d.id, org: trimmedOrg, range, force: true })
          .catch(() => {});
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: DATASETS_KEY }),
  });

  const runPreview = useMutation({
    mutationFn: (dataset: string) =>
      api.post<ResultSet>("/api/data/query", {
        dataset,
        q: { org: trimmedOrg, range: lastNDays(new Date(), 30), limit: 50 },
        sync: false,
      }),
    onSuccess: (result, dataset) => setPreview({ dataset, result }),
  });

  // Only blank the view when the *initial* load failed. ["datasets"] is refetched
  // on every sync.* SSE event, so a transient background-refetch error must not
  // discard the table we already have — surface it as a non-blocking notice while
  // the last-known catalog (and per-row coverage errors) stay visible.
  if (catalog.isLoading) return <p className="explorer">Loading catalog…</p>;
  if (catalog.error && !catalog.data) {
    return <p className="explorer error">Failed to load the dataset catalog.</p>;
  }

  const now = Date.now();
  const rows = catalog.data ?? [];
  return (
    <section className="explorer">
      <div className="explorer-controls">
        <label className="explorer-org">
          Org
          <input
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            onBlur={() => persistOrg.mutate(trimmedOrg)}
            placeholder="your-github-org"
          />
        </label>
        <button
          type="button"
          disabled={!trimmedOrg || syncAll.isPending || sync.isPending}
          onClick={() => {
            persistOrg.mutate(trimmedOrg);
            syncAll.mutate();
          }}
        >
          {syncAll.isPending ? "Syncing all…" : "Sync all"}
        </button>
      </div>
      {catalog.error && (
        <p className="explorer error" role="alert">
          Couldn’t refresh the catalog — showing the last known state.
        </p>
      )}
      <table className="catalog">
        <thead>
          <tr>
            <th>Dataset</th>
            <th>Scope</th>
            <th>Coverage</th>
            <th aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const syncing = sync.isPending && sync.variables === d.id;
            return (
              <Fragment key={d.id}>
                <tr>
                  <td>
                    <button
                      type="button"
                      className="link"
                      aria-expanded={expanded === d.id}
                      onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                    >
                      {d.title}
                    </button>
                    <p className="muted">{d.description}</p>
                  </td>
                  <td>{d.scope}</td>
                  <td>
                    {d.readonly
                      ? "computed on query"
                      : syncing
                        ? "syncing…"
                        : formatCoverage(coverageForOrg(d.coverage, trimmedOrg), now)}
                  </td>
                  <td className="actions">
                    {/* Query datasets are derived SQL — no GitHub sync to run. */}
                    {!d.readonly && (
                      <button
                        type="button"
                        disabled={!trimmedOrg || sync.isPending}
                        onClick={() => sync.mutate(d.id)}
                      >
                        Sync now
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!trimmedOrg || runPreview.isPending}
                      onClick={() => runPreview.mutate(d.id)}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      // Disabled while an insert is already pending — the handoff slot
                      // holds one request; a second click would drop the first.
                      disabled={!trimmedOrg || insertPending}
                      onClick={() =>
                        requestInsert({
                          dataset: d.id,
                          query: { org: trimmedOrg, range: lastNDays(new Date(), 30) },
                        })
                      }
                    >
                      Insert into sheet
                    </button>
                  </td>
                </tr>
                {expanded === d.id && (
                  <tr className="columns">
                    <td colSpan={4}>
                      <ul>
                        {d.columns.map((c) => (
                          <li key={c.name}>
                            <code>{c.name}</code> <em>{c.type}</em> — {c.description}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
                {preview?.dataset === d.id && (
                  <tr className="preview-row">
                    <td colSpan={4}>
                      <Preview result={preview.result} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
