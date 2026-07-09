import type { Migration } from "../migrate";
import m0001 from "./0001_init";

/** All migrations, in apply order. New schema ⇒ new numbered module appended here. */
export const migrations: Migration[] = [m0001];
