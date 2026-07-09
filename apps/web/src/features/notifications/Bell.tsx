// The live notification bell: badge + level-colored dot, toggling the Panel.
// Owns the query + optimistic read/dismiss mutations; the pure Panel renders.
// SSE `notification.changed` invalidates NOTIFICATIONS_KEY (wired in App), so
// the badge updates without a reload.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/client";
import { badgeCount, type NotificationCard, worstLevel } from "./badge";
import { Panel } from "./Panel";
import { NOTIFICATIONS_KEY, notificationsQuery } from "./query";

type Stamp = { id: number; action: "read" | "dismiss" };

export function Bell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery(notificationsQuery);
  const list = data ?? [];
  const count = badgeCount(list);
  const level = worstLevel(list);

  const stamp = useMutation({
    mutationFn: ({ id, action }: Stamp) => api.post(`/api/notifications/${id}/${action}`),
    // Optimistic: reflect read/dismiss immediately, roll back on failure.
    onMutate: async ({ id, action }) => {
      await qc.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      const prev = qc.getQueryData<NotificationCard[]>(NOTIFICATIONS_KEY);
      qc.setQueryData<NotificationCard[]>(NOTIFICATIONS_KEY, (old) =>
        (old ?? [])
          .filter((n) => !(n.id === id && action === "dismiss"))
          .map((n) =>
            n.id === id && action === "read" ? { ...n, read_at: new Date().toISOString() } : n,
          ),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(NOTIFICATIONS_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  return (
    <div className="bell">
      <button
        type="button"
        className={`bell-btn bell-${level}`}
        aria-label={`Notifications, ${count} unread`}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">🔔</span>
        {count > 0 && <span className="bell-badge">{count}</span>}
      </button>
      {open && (
        <Panel
          list={list}
          now={Date.now()}
          onRead={(id) => stamp.mutate({ id, action: "read" })}
          onDismiss={(id) => stamp.mutate({ id, action: "dismiss" })}
        />
      )}
    </div>
  );
}
