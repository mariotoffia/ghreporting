// Coarse relative-time label shared by the notification panel and the explorer's
// coverage line. `now` is injected (never read from the clock here) so callers
// stay deterministic and unit-testable.
export function relativeTime(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
