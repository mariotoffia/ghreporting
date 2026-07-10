// Settings → Credentials (T12.1, ADR 0018): one row per registered Credential Provider,
// driven entirely by what its describe() declares — a status badge, the title + help link,
// and either a secret-field form (flow: "fields", e.g. a pasted PAT) or a device sign-in
// (flow: "device", e.g. github-oauth). A new provider needs no UI code here. Server state via
// TanStack Query; secrets ride the request body only (never a query string or the query cache).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  CREDENTIALS_KEY,
  type CredentialEntry,
  deleteCredential,
  listCredentials,
  putCredential,
  validateCredential,
} from "./api";
import { DeviceFlow } from "./DeviceFlow";

export function CredentialsPanel() {
  const list = useQuery({ queryKey: CREDENTIALS_KEY, queryFn: listCredentials });
  return (
    <section className="settings">
      <header className="reports-head">
        <h2>Credentials</h2>
      </header>
      {list.isLoading && <p>Loading…</p>}
      {list.isError && <p className="form-error">Failed to load credentials.</p>}
      {list.data?.map((e) => (
        <CredentialRow key={e.id} entry={e} />
      ))}
    </section>
  );
}

/** Pure status pill: ok / expiring / invalid / not configured (status null). */
export function StatusBadge({ status }: { status: CredentialEntry["status"] }) {
  return (
    <span className={`cred-badge cred-${status ?? "unset"}`}>{status ?? "not configured"}</span>
  );
}

function CredentialRow({ entry }: { entry: CredentialEntry }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: CREDENTIALS_KEY });
  return (
    <div className="cred-row">
      <div className="cred-head">
        <StatusBadge status={entry.status} />
        <a className="cred-title" href={entry.describe.helpUrl} target="_blank" rel="noreferrer">
          {entry.describe.title}
        </a>
        {entry.status !== null && <RowActions id={entry.id} onChanged={refresh} />}
      </div>
      {entry.describe.flow === "device" ? (
        <DeviceFlow entry={entry} onChanged={refresh} />
      ) : (
        <SecretForm entry={entry} onChanged={refresh} />
      )}
    </div>
  );
}

/** Remove / Re-check, shown once a credential is configured. */
function RowActions({ id, onChanged }: { id: string; onChanged: () => void }) {
  const recheck = useMutation({ mutationFn: () => validateCredential(id), onSettled: onChanged });
  const remove = useMutation({ mutationFn: () => deleteCredential(id), onSettled: onChanged });
  return (
    <span className="row-actions">
      <button type="button" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
        Re-check
      </button>
      <button
        type="button"
        className="danger"
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
      >
        Remove
      </button>
    </span>
  );
}

/**
 * A secret-field form built from describe().fields. The server accepts one `secret`, so the
 * secret field's value is what we PUT; a `400 credential.invalid` surfaces its reason inline.
 */
export function SecretForm({
  entry,
  onChanged,
}: {
  entry: CredentialEntry;
  onChanged: () => void;
}) {
  const field = entry.describe.fields.find((f) => f.secret) ?? entry.describe.fields[0];
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(entry.statusDetail);
  const save = useMutation({
    mutationFn: () => putCredential(entry.id, value),
    onSuccess: () => {
      setError(null);
      setValue("");
      onChanged();
    },
    onError: (e: Error) => setError(e.message),
  });
  if (!field) return null;
  return (
    <form
      className="cred-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value !== "") save.mutate();
      }}
    >
      <label className="field">
        {field.label}
        <input
          type={field.secret ? "password" : "text"}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button type="submit" disabled={save.isPending || value === ""}>
        Save
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
