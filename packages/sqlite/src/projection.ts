/**
 * The schema of a projection. A projection is a file or a part of a file that the app can make again from a different
 * source. An index and a cache are projections. A projection of a different schema version opens empty, and it does not
 * migrate.
 *
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { schemaVersion, setSchemaVersion, type Migration } from "./migrate.ts";
import { transaction } from "./transaction.ts";

/** The options of `ensureProjection`. */
export interface ProjectionOptions {
  /** This value is the schema version of the projection: a whole number of 1 or more. A change of the schema needs a new version. */
  readonly version: number;
  /**
   * This value is the name of a part of the file. The part keeps its version in the table `schema_versions`. Without a
   * part, the projection owns the whole file and its `user_version`.
   */
  readonly part?: string | undefined;
  /** This value lists the tables of the part. A part needs it, because a rebuild removes only these tables. */
  readonly tables?: readonly string[] | undefined;
  /** This function tells if a file of the correct version has the projection. When it gives false, the projection opens empty. */
  readonly check?: ((db: DatabaseSync) => boolean) | undefined;
}

/** The result of `ensureProjection`: true when the projection opened empty, and the version of the file before. */
export interface Projected {
  readonly rebuilt: boolean;
  readonly from: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** This function gives a name in double quotes for SQL. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** This function gives the names of the objects of the main schema that have one of the types of `pragma_table_list`. */
function objects(db: DatabaseSync, types: string): string[] {
  const sql = `SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN (${types}) AND substr(name, 1, 7) <> 'sqlite_'`;
  return (db.prepare(sql).all() as { name: string }[]).map((row) => row.name);
}

/** This function removes each view and each table of the file. It removes a virtual table before its shadow tables. */
function dropAll(db: DatabaseSync): void {
  for (const name of objects(db, "'view'")) db.exec(`DROP VIEW IF EXISTS ${quoted(name)}`);
  for (const name of objects(db, "'virtual'")) db.exec(`DROP TABLE IF EXISTS ${quoted(name)}`);
  for (const name of objects(db, "'table', 'shadow'")) db.exec(`DROP TABLE IF EXISTS ${quoted(name)}`);
}

/** This function reads a pragma that has the value 0 or 1. */
function flag(db: DatabaseSync, pragma: "foreign_keys" | "defer_foreign_keys"): boolean {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>;
  return row[pragma] === 1;
}

/**
 * This function removes the tables of the projection. When the connection enforces foreign keys, their checks wait for
 * the end of the transaction. Thus the order of the drops is free. After the drops, the old setting comes back.
 */
function drop(db: DatabaseSync, part: string | undefined, tables: readonly string[]): void {
  const defer = flag(db, "foreign_keys") && !flag(db, "defer_foreign_keys");
  if (defer) db.exec("PRAGMA defer_foreign_keys = ON");
  try {
    if (part === undefined) dropAll(db);
    else for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${quoted(table)}`);
  } finally {
    if (defer) db.exec("PRAGMA defer_foreign_keys = OFF");
  }
}

/**
 * This function makes the schema of a projection when the file does not have it, and gives true when the projection
 * opened empty.
 *
 * When the version of the file is equal to `version`, and `check` does not give false, the function changes nothing.
 * Otherwise it removes the tables of the projection, does `schema` and writes `version`. Then the app fills the projection
 * again from its source. A file of a newer version opens empty too. Thus two versions of an app on one file rebuild the
 * projection in turn.
 *
 * Without a part, the function removes each view and each table of the file. With a part, it removes only the tables of
 * `tables`. The work is one transaction. In a transaction in progress, the work is a savepoint of that transaction.
 *
 * When the connection enforces foreign keys, their checks wait for the end of the transaction. Thus the order of `tables`
 * is free. A row out of the projection that refers to a row of the projection stops the commit.
 *
 * @param db - The connection.
 * @param schema - The schema of the projection: SQL statements, or a function that makes the tables.
 * @param options - The version, the part and its tables, and the check of a file.
 */
export function ensureProjection(db: DatabaseSync, schema: Migration, options: ProjectionOptions): Projected {
  const { version, part, tables, check } = options;
  if (!Number.isInteger(version) || version < 1) throw new RangeError(`The version of a projection must be a whole number of 1 or more, not ${String(version)}.`);
  if (part !== undefined) {
    if (tables === undefined || tables.length === 0) throw new RangeError(`The part ${part} needs the list of its tables, because a rebuild removes only them.`);
    for (const table of tables) {
      if (!IDENTIFIER.test(table) || table.toLowerCase().startsWith("sqlite_")) {
        throw new RangeError(`The name of a table must be a name of letters, digits and underscores that does not start with sqlite_, not ${JSON.stringify(table)}.`);
      }
    }
  }
  return transaction(
    db,
    () => {
      const from = schemaVersion(db, part);
      if (from === version && check?.(db) !== false) return { rebuilt: false, from };
      drop(db, part, tables ?? []);
      if (typeof schema === "string") db.exec(schema);
      else schema(db);
      setSchemaVersion(db, part, version);
      return { rebuilt: true, from };
    },
    { nested: "savepoint" },
  );
}
