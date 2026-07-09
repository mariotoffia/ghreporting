// A dataset preview table (T6.4). Pure/presentational: columns render in
// meta.columns order, `stale` shows a "local data" hint. Explorer owns the query.
import { formatCell } from "./format";

export interface ResultSet {
  columns: { name: string; type: string; description: string }[];
  rows: unknown[][];
  stale?: boolean;
}

export function Preview({ result }: { result: ResultSet }) {
  return (
    <div className="preview">
      {result.stale && (
        <p className="preview-stale">Showing local data — last sync failed or is pending.</p>
      )}
      <table>
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.name} title={c.description}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no id; order is stable
            <tr key={i}>
              {result.columns.map((c, j) => (
                <td key={c.name}>{formatCell(r[j])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length === 0 && <p className="preview-empty">No rows in range.</p>}
    </div>
  );
}
