// Dataset connector: copilot-seats — who holds a Copilot seat right now.
// Endpoint: GET /orgs/{org}/copilot/billing/seats (paginated `seats[]`).
// Auth: classic PAT `manage_billing:copilot` or `read:org`
// (fine-grained: "GitHub Copilot Business" or "Administration", read).
// Snapshot dataset: a seat is current state, not a day fact — replaced
// wholesale per sync into copilot_seats.
import { upsertOrg, upsertUser } from "../../../adapters/db/dims";
import type { DatasetConnector } from "../ports";
import { filterSql, snapshotCoverage } from "./util";

const TTL_HOURS = 24;

interface GhSeat {
  assignee: { id: number; login: string } | null;
  created_at?: string | null;
  last_activity_at?: string | null;
  last_activity_editor?: string | null;
  plan_type?: string | null;
  pending_cancellation_date?: string | null;
}

const COLUMNS = [
  { name: "user_login", type: "string", description: "Seat holder's GitHub login" },
  { name: "created_at", type: "date", description: "When the seat was assigned" },
  { name: "last_activity_at", type: "date", description: "Last Copilot activity" },
  { name: "last_activity_editor", type: "string", description: "Editor of the last activity" },
  { name: "plan_type", type: "string", description: "business | enterprise | unknown" },
  {
    name: "pending_cancellation_date",
    type: "date",
    description: "Seat ends on this date, if set",
  },
] as const;

export function copilotSeatsConnector(now: () => Date): DatasetConnector {
  return {
    meta: {
      id: "copilot-seats",
      title: "Copilot seats",
      description:
        "Current Copilot seat assignments in the organization: who has a seat, when they last used it and in which editor, and any pending cancellation.",
      columns: [...COLUMNS],
      scope: "org-user",
      freshnessTtlHours: TTL_HOURS,
    },

    coverage(db, q) {
      return snapshotCoverage(db, "copilot-seats", q, TTL_HOURS, now());
    },

    async *fetch(gap, gh) {
      const org = await gh.get<{ id: number; login: string; name?: string | null }>("/orgs/{org}", {
        org: gap.scope,
      });
      if (org.status !== 200) return;
      const rows: Record<string, unknown>[] = [
        { kind: "org", id: org.data.id, login: org.data.login, name: org.data.name ?? null },
      ];
      for await (const page of gh.paginate<GhSeat>("/orgs/{org}/copilot/billing/seats", {
        org: gap.scope,
      })) {
        for (const s of page) {
          if (!s.assignee) continue; // seat with no assignee carries no reportable user
          rows.push({
            kind: "seat",
            user_id: s.assignee.id,
            user_login: s.assignee.login,
            created_at: s.created_at ?? null,
            last_activity_at: s.last_activity_at ?? null,
            last_activity_editor: s.last_activity_editor ?? null,
            plan_type: s.plan_type ?? null,
            pending_cancellation_date: s.pending_cancellation_date ?? null,
          });
        }
      }
      yield rows; // one batch: seats are replaced wholesale
    },

    upsert(db, rows) {
      const org = rows.find((r) => r.kind === "org") as
        | { id: number; login: string; name: string | null }
        | undefined;
      if (!org) return;
      const orgId = upsertOrg(db, org);
      db.query("DELETE FROM copilot_seats WHERE org_id=?1").run(orgId);
      const insert = db.query(
        `INSERT INTO copilot_seats(org_id, user_id, created_at, last_activity_at,
           last_activity_editor, plan_type, pending_cancellation_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      );
      for (const r of rows) {
        if (r.kind !== "seat") continue;
        const userId = upsertUser(db, { id: r.user_id as number, login: r.user_login as string });
        insert.run(
          orgId,
          userId,
          (r.created_at as string) ?? null,
          (r.last_activity_at as string) ?? null,
          (r.last_activity_editor as string) ?? null,
          (r.plan_type as string) ?? null,
          (r.pending_cancellation_date as string) ?? null,
        );
      }
    },

    select(db, q) {
      const f = filterSql(
        {
          user_login: "u.login",
          plan_type: "s.plan_type",
          last_activity_editor: "s.last_activity_editor",
        },
        q.filter,
      );
      const rows = db
        .query(
          `SELECT u.login AS user_login, s.created_at, s.last_activity_at,
                  s.last_activity_editor, s.plan_type, s.pending_cancellation_date
           FROM copilot_seats s
           JOIN orgs o ON o.id = s.org_id
           JOIN users u ON u.id = s.user_id
           WHERE o.login = ?${f.sql}
           ORDER BY u.login
           LIMIT ?`,
        )
        .values(q.org, ...f.params, q.limit ?? -1);
      return { columns: [...COLUMNS], rows };
    },
  };
}
