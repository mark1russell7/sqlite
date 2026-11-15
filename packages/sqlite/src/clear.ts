/**
 * The clear of a database: each view and each table goes, for a cache that makes its tables again for a new schema.
 *
 * @packageDocumentation
 */
import type { SqlConnection } from "./connection.ts";
import { isInTransaction } from "./probe.ts";
import { transaction } from "./transaction.ts";

/** The options of `clearDatabase`. */
export interface ClearOptions {
  /** This value makes the file small again after the drop (`VACUUM`). The default is true. */
  readonly vacuum?: boolean | undefined;
}

/** The name of an object of the schema, in the quotes of SQL. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * This function drops each view and each table of the database, and sets `user_version` to 0. The indexes and the
 * triggers go with their tables and views. The tables of SQLite itself (`sqlite_*`) stay. Then `migrate` makes each
 * step again.
 *
 * Foreign keys are off during the drop, so the order of the tables has no effect. The function sets the earlier value
 * again at the end. The drop is one transaction. SQLite refuses a change of the pragma `foreign_keys` and `VACUUM` in a
 * transaction, so the function throws there.
 *
 * @param db - The connection.
 * @param options - The vacuum after the drop.
 * @returns The names of the dropped views and tables, in the order of the drop.
 */
export function clearDatabase(db: SqlConnection, options: ClearOptions = {}): string[] {
  if (isInTransaction(db)) throw new Error("The clear of a database cannot run in a transaction. Run it after the transaction.");
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown } | undefined;
  const foreignKeys = Number(row?.foreign_keys ?? 0) !== 0;
  const objects = db
    .prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('view', 'table') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
    .all() as { type: string; name: string }[];
  // A view can name a table, so the views go first
  const order = [...objects.filter((o) => o.type === "view"), ...objects.filter((o) => o.type === "table")];
  if (foreignKeys) db.exec("PRAGMA foreign_keys = OFF");
  try {
    transaction(db, () => {
      for (const o of order) db.exec(`DROP ${o.type === "view" ? "VIEW" : "TABLE"} IF EXISTS ${quoted(o.name)}`);
      db.exec("PRAGMA user_version = 0");
    });
  } finally {
    if (foreignKeys) db.exec("PRAGMA foreign_keys = ON");
  }
  if (options.vacuum ?? true) db.exec("VACUUM");
  return order.map((o) => o.name);
}
