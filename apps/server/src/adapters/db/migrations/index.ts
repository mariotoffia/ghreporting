import type { Migration } from "../migrate";
import m0001 from "./0001_init";
import m0002 from "./0002_org_people";
import m0003 from "./0003_copilot_seats";
import m0004 from "./0004_reports";
import m0006 from "./0006_query_datasets";
import m0007 from "./0007_app_config";

/** All migrations, in apply order. New schema ⇒ new numbered module appended here.
 *  0005 (spend_views, T9.1) is intentionally not yet landed — gaps in the numbering are
 *  fine, the runner applies whatever is in this array in order. */
export const migrations: Migration[] = [m0001, m0002, m0003, m0004, m0006, m0007];
