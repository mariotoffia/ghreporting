// The `reports` uService (DDD.md §3.7, UBIQUITOUS.md §Reporting, ADR 0014): persistence
// for Report Definitions — self-contained, parameterized JSON documents. Reports are
// DATA, not code: no Univer snapshot and no bindings rows (that is `workspace`); the
// definition is the only source of truth, and export/import moves it as a versioned
// envelope. The server NEVER executes a report — the browser GETs a definition, compiles
// it, and issues one data query per panel (frontend-orchestrated, ADR 0014).
import {
  ValidationError as DomainValidationError,
  parseExport,
  type QueryDatasetDef,
  type ReportDefinition,
  toExport,
  validateDefinition,
} from "@ghreporting/domain";
import type { Hono } from "hono";
import { NotFoundError, ValidationError } from "../../kernel/errors";
import { capBytes, jsonObject, nonEmpty } from "../../kernel/http";
import type { MicroService, ServiceContext } from "../../kernel/ports";
import seed from "./seed/copilot-spend.json";

/**
 * The slice of the data service's query-dataset lifecycle this service needs (ADR 0017). Declared
 * here (consumer-owned port) so `reports` depends on an interface, not on the `data` service — the
 * composition root injects the concrete (ARCHITECTURE.md §2). Structurally satisfied by the data
 * service's `QueryDatasetRegistry`.
 */
export interface DatasetProvisioner {
  provision(defs: QueryDatasetDef[]): void;
  sweep(referencedIds: Set<string>): void;
}

// Definitions are KB in practice; the cap is a runaway guard, not a real limit.
const MAX_DEFINITION_BYTES = 1024 * 1024; // 1 MiB
// Copilot Spend seeds under this stable id, so re-running init never duplicates it and a
// user-edited seed is preserved (idempotent).
const SEED_ID = "copilot-spend";

interface ReportRow {
  id: string;
  name: string;
  description: string | null;
  definition: string; // JSON ReportDefinition
  created_at: string;
  updated_at: string;
}

/**
 * Run a domain validate/parse and translate its zero-dependency `ValidationError` into the
 * kernel one, so the shared error envelope answers 400 (the domain package must not import
 * the kernel — ARCHITECTURE.md §2). Any non-validation throw propagates unchanged.
 */
function domainGuard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DomainValidationError) throw new ValidationError(e.message);
    throw e;
  }
}

/** Validate a definition, then serialize + size-cap it into its TEXT column. */
function serializeDefinition(definition: unknown): string {
  const def = domainGuard(() => validateDefinition(definition));
  return capBytes(JSON.stringify(def), MAX_DEFINITION_BYTES, "definition");
}

/** DB row → wire shape (definition parsed back to JSON). */
function toWire(row: ReportRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition: JSON.parse(row.definition) as unknown,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A safe attachment filename: "<name>.report.json", unsafe chars collapsed to "_". */
function exportFilename(name: string): string {
  const safe = name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "report";
  return `${safe}.report.json`;
}

/** Validate an optional description to `string | null` (reject a non-string instead of
 * lossily coercing it). Callers treat `undefined` as "field not sent" before calling. */
function toDescription(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") throw new ValidationError("description must be a string or null");
  return v;
}

/** The embedded query datasets of a stored definition JSON (empty when the field is absent). */
function datasetsOf(definitionJson: string): QueryDatasetDef[] {
  return (JSON.parse(definitionJson) as ReportDefinition).datasets ?? [];
}

export function createReportsService(opts: { datasets?: DatasetProvisioner } = {}): MicroService {
  let ctx: ServiceContext;
  const provisioner = opts.datasets;
  const db = () => ctx.db;
  const exists = (id: string): boolean =>
    db().query("SELECT 1 FROM reports WHERE id=?").get(id) != null;

  function insert(
    id: string,
    name: string,
    description: string | null,
    definition: string,
  ): string {
    const at = ctx.config.now().toISOString();
    db()
      .query(
        "INSERT INTO reports(id, name, description, definition, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
      )
      .run(id, name, description, definition, at, at);
    return at;
  }

  // --- Query-dataset provisioning (ADR 0017) ------------------------------------------------
  // Reports are the GC root set: a dataset survives iff some report embeds its id. `provision`
  // runs BEFORE the reports-table write (so a bad SQL fails the request with nothing half-applied);
  // `sweep` runs AFTER (so the just-written report's ids count as referenced).

  /** Every dataset id embedded by any stored report — the sweep's keep-set. Tolerant of a row
   *  with an unparseable definition (skip + log) so a single corrupt report can't throw out of a
   *  sweep — which on init would abort kernel startup (registry.ts), a boot-loop. */
  function allReferencedIds(): Set<string> {
    const ids = new Set<string>();
    for (const row of db().query("SELECT id, definition FROM reports").all() as {
      id: string;
      definition: string;
    }[]) {
      try {
        for (const d of datasetsOf(row.definition)) ids.add(d.id);
      } catch (e) {
        ctx.log.warn("skipping report with unparseable definition during sweep", {
          report: row.id,
          err: String(e),
        });
      }
    }
    return ids;
  }

  /** Provision one definition's datasets (throws 4xx on bad SQL / reserved id). No-op without a
   *  provisioner (e.g. a `:memory:` config with no read-only handle). */
  const provision = (definitionJson: string) => provisioner?.provision(datasetsOf(definitionJson));
  const sweep = () => provisioner?.sweep(allReferencedIds());

  /** Seed Copilot Spend once, under its stable id (idempotent across inits). */
  function seedOnInit(): void {
    if (exists(SEED_ID)) return;
    const definition = serializeDefinition(seed.definition);
    provision(definition); // provision before the row exists, so a bad seed fails loudly here
    insert(SEED_ID, seed.name, seed.description ?? null, definition);
  }

  /** On boot, make the registry match the reports table: (re)provision every report's datasets,
   *  then sweep orphans. Tolerant per-report — a single stale report must not brick startup. */
  function reconcileAllOnInit(): void {
    if (!provisioner) return;
    for (const row of db().query("SELECT id, definition FROM reports").all() as {
      id: string;
      definition: string;
    }[]) {
      try {
        provisioner.provision(datasetsOf(row.definition));
      } catch (e) {
        ctx.log.warn("report dataset provision failed on init", { report: row.id, err: String(e) });
      }
    }
    sweep();
  }

  return {
    name: "reports",
    init(c) {
      ctx = c;
      seedOnInit();
      reconcileAllOnInit();
    },
    // Routes are root-relative: the kernel mounts this sub-app at `/api/reports`
    // (registry.ts), so the collection is `/` and items are `/:id` — mirroring how `data`
    // owns `/datasets`. Naming them `/reports` here would double to `/api/reports/reports`.
    routes(app: Hono) {
      app.get("/", (c) =>
        c.json(
          db()
            .query("SELECT id, name, description, updated_at FROM reports ORDER BY updated_at DESC")
            .all(),
        ),
      );

      app.post("/", async (c) => {
        const body = await jsonObject(c.req);
        // Validate everything before the first write (no half-applied create).
        const name = nonEmpty(body.name, "name");
        const description = toDescription(body.description);
        const definition = serializeDefinition(body.definition);
        provision(definition); // before the write — a bad embedded SQL 4xxs, nothing half-applied
        const id = crypto.randomUUID();
        const at = insert(id, name, description, definition);
        sweep();
        return c.json({ id, name, description, updated_at: at });
      });

      app.get("/:id", (c) => {
        const id = c.req.param("id");
        const row = db().query("SELECT * FROM reports WHERE id=?").get(id) as ReportRow | null;
        if (!row) throw new NotFoundError(`report ${id}`);
        return c.json(toWire(row));
      });

      app.put("/:id", async (c) => {
        const id = c.req.param("id");
        // Body read first (the only await); the existence check + writes then run with no
        // yield between (bun:sqlite is sync), so a concurrent DELETE can't fabricate a 200.
        const body = await jsonObject(c.req);
        if (!exists(id)) throw new NotFoundError(`report ${id}`);
        // Validate BOTH provided fields before writing EITHER (no half-applied update).
        const name = body.name !== undefined ? nonEmpty(body.name, "name") : undefined;
        const description =
          body.description === undefined ? undefined : toDescription(body.description);
        const definition =
          body.definition !== undefined ? serializeDefinition(body.definition) : undefined;
        // Provision the new datasets before any write (a bad SQL 4xxs with nothing applied).
        if (definition !== undefined) provision(definition);
        const at = ctx.config.now().toISOString();
        if (name !== undefined) db().query("UPDATE reports SET name=?2 WHERE id=?1").run(id, name);
        if (description !== undefined) {
          db().query("UPDATE reports SET description=?2 WHERE id=?1").run(id, description);
        }
        if (definition !== undefined) {
          db().query("UPDATE reports SET definition=?2 WHERE id=?1").run(id, definition);
        }
        db().query("UPDATE reports SET updated_at=?2 WHERE id=?1").run(id, at);
        sweep(); // GC datasets this update orphaned (e.g. a dataset dropped from the definition)
        return c.json(toWire(db().query("SELECT * FROM reports WHERE id=?").get(id) as ReportRow));
      });

      app.delete("/:id", (c) => {
        const id = c.req.param("id");
        const { changes } = db().query("DELETE FROM reports WHERE id=?").run(id);
        if (changes === 0) throw new NotFoundError(`report ${id}`);
        sweep(); // GC datasets no surviving report references
        return c.json({ id, deleted: true });
      });

      app.get("/:id/export", (c) => {
        const id = c.req.param("id");
        const row = db().query("SELECT * FROM reports WHERE id=?").get(id) as ReportRow | null;
        if (!row) throw new NotFoundError(`report ${id}`);
        const envelope = toExport(
          row.name,
          row.description,
          JSON.parse(row.definition) as ReportDefinition,
        );
        c.header("Content-Disposition", `attachment; filename="${exportFilename(row.name)}"`);
        return c.json(envelope);
      });

      app.post("/import", async (c) => {
        const body = await jsonObject(c.req);
        const { name, description, definition } = domainGuard(() => parseExport(body.envelope));
        const serialized = capBytes(JSON.stringify(definition), MAX_DEFINITION_BYTES, "definition");
        provision(serialized); // an imported report provisions its embedded datasets (or 4xxs)
        const id = crypto.randomUUID(); // import always lands under a NEW id
        const at = insert(id, name, description, serialized);
        sweep();
        return c.json({ id, name, description, updated_at: at });
      });
    },
  };
}
