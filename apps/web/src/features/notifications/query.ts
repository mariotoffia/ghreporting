// Shared TanStack Query descriptor for the active notification list. Both the Bell
// and the shell's error banner read this one key so an SSE `notification.changed`
// invalidation updates them together (App wires the invalidation).
import { api } from "../../lib/client";
import type { NotificationCard } from "./badge";

export const NOTIFICATIONS_KEY = ["notifications"] as const;

export const notificationsQuery = {
  queryKey: NOTIFICATIONS_KEY,
  queryFn: () => api.get<NotificationCard[]>("/api/notifications?state=active"),
};
