// The notification panel: a pure list of cards with read/dismiss actions. Kept
// presentational (all data + handlers arrive as props) so it renders under
// renderToString in tests and Bell owns the query/mutation wiring.
import { type Level, type NotificationCard, relativeTime } from "./badge";

const ICON: Record<Level, string> = { info: "ℹ️", warning: "⚠️", error: "⛔" };

export interface PanelProps {
  list: NotificationCard[];
  now: number;
  onRead(id: number): void;
  onDismiss(id: number): void;
}

export function Panel({ list, now, onRead, onDismiss }: PanelProps) {
  if (list.length === 0) {
    return (
      <div className="notif-panel">
        <p className="notif-empty">Nothing needs attention.</p>
      </div>
    );
  }
  return (
    <div className="notif-panel">
      <ul>
        {list.map((n) => (
          <li key={n.id} className={`notif notif-${n.level}${n.read_at ? " notif-read" : ""}`}>
            <span className="notif-icon" aria-hidden="true">
              {ICON[n.level]}
            </span>
            <div className="notif-text">
              <strong>{n.title}</strong>
              {n.body && <p>{n.body}</p>}
              <time dateTime={n.updated_at}>{relativeTime(n.updated_at, now)}</time>
            </div>
            <div className="notif-actions">
              {!n.read_at && (
                <button type="button" onClick={() => onRead(n.id)}>
                  Mark read
                </button>
              )}
              <button type="button" onClick={() => onDismiss(n.id)}>
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
