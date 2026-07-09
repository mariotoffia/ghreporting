// Pure helpers behind the notification bell (UBIQUITOUS.md §Notifications). Kept
// separate from the React components so the badge/level logic is unit-tested
// without a DOM.
export { relativeTime } from "../../lib/time";

/** One card as the list endpoint returns it (SELECT * from notifications). */
export interface NotificationCard {
  id: number;
  key: string;
  level: Level;
  title: string;
  body: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  dismissed_at: string | null;
}

export type Level = "info" | "warning" | "error";

/** Badge number: active (undismissed) cards the human has not yet read. */
export function badgeCount(list: NotificationCard[]): number {
  return list.filter((n) => n.dismissed_at === null && n.read_at === null).length;
}

const RANK: Record<Level, number> = { info: 0, warning: 1, error: 2 };

/** Highest severity in the list; drives the dot color. Empty → "info". */
export function worstLevel(list: NotificationCard[]): Level {
  let worst: Level = "info";
  for (const n of list) if (RANK[n.level] > RANK[worst]) worst = n.level;
  return worst;
}
