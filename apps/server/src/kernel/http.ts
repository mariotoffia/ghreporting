// Shared HTTP write-guards for every uService that accepts a JSON write body (workspace,
// reports, …). Lifted here (out of workspace/service.ts) so the "normalize malformed
// input to a 400, never a 500" discipline is enforced identically everywhere. Depends
// only on the kernel error types — no framework coupling.
import { ValidationError } from "./errors";

/** Reject a missing/blank string field the same way everywhere. */
export function nonEmpty(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new ValidationError(`${field} is required`);
  return v;
}

/**
 * Parse a request body as a JSON object. `c.req.json()` accepts a bare `null`, a JSON
 * array, or a primitive without rejecting — reading fields off those would throw a raw
 * TypeError (a 500). Normalize to a 400 here so every write route is safe.
 */
export async function jsonObject(req: {
  json(): Promise<unknown>;
}): Promise<Record<string, unknown>> {
  const parsed = await req.json().catch(() => {
    throw new ValidationError("body must be JSON");
  });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Enforce a UTF-8 byte cap on a serialized document — a runaway guard so one oversized
 * write can't wedge the single local SQLite file. Returns the string when within the cap;
 * throws ValidationError past it. `label` names the field for the 400 message.
 */
export function capBytes(s: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(s, "utf8") > maxBytes) {
    const mib = maxBytes / (1024 * 1024);
    const limit = Number.isInteger(mib) ? `${mib} MiB` : `${maxBytes} bytes`;
    throw new ValidationError(`${label} exceeds the ${limit} limit`);
  }
  return s;
}
