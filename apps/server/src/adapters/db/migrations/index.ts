import type { Migration } from "../migrate";
import m0001 from "./0001_init";
import m0002 from "./0002_org_people";
import m0003 from "./0003_copilot_seats";

/** All migrations, in apply order. New schema ⇒ new numbered module appended here. */
export const migrations: Migration[] = [m0001, m0002, m0003];
