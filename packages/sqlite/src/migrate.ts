/**
 * The migrations of a schema. The version of a file is the count of steps that it has. The file keeps the version in the
 * pragma `user_version`, or in the table `schema_versions` for each named part of the file.
 *
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./transaction.ts";

/**
 * One step of a schema: SQL statements, or a function that changes the database. A step operates in the transaction of
 * its migration, so it does not start a transaction.
 */
export type Migration = string | ((db: DatabaseSync) => void);

/** The table that keeps the version of each named part of a file. `migrate` makes it at the first step of a part. */
export const SCHEMA_VERSIONS_TABLE = "schema_versions";

/** The options of `migrate`. */
export interface MigrateOptions {
  /**
   * This value is the name of the database in the error for a newer file, for example `log`. The default is `database`,
   * or `part <part>` for a part.
   */
  readonly name?: string | undefined;
  /**
   * This value is the name of a part of the file, for example `event-log:events`. Each part has its own steps and its
   * own version in the table `schema_versions`. Thus a library and the app keep their tables in one file. Without a part,
   * the version is the `user_version` of the file.
   */
  readonly part?: string | undefined;
}

/** The versions of a file, or of a part of a file, before and after `migrate`. */
export interface Migrated {
  readonly from: number;
  readonly to: number;
}

/** This function gives the pragma `user_version` of a database. */
export function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/** This function throws when the name of a part is empty. */
function checkPart(part: string | undefined): void {
  if (part !== undefined && part.length === 0) throw new RangeError("The name of a part must not be empty.");
}

/**
 * This function gives the schema version of a database. Without a part, it is the `user_version` of the file. With a
 * part, it is the version of that part in the table `schema_versions`, and 0 when the file does not have the part.
 *
 * @param db - The connection.
 * @param part - The name of a part of the file.
 */
export function schemaVersion(db: DatabaseSync, part?: string): number {
  checkPart(part);
  if (part === undefined) return userVersion(db);
  const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(SCHEMA_VERSIONS_TABLE);
  if (table === undefined) return 0;
  const row = db.prepare(`SELECT version FROM ${SCHEMA_VERSIONS_TABLE} WHERE part = ?`).get(part) as { version: number } | undefined;
  return row?.version ?? 0;
}

/** This function writes the schema version of a database, or of a part of it. It operates in a transaction. */
function setSchemaVersion(db: DatabaseSync, part: string | undefined, version: number): void {
  if (part === undefined) {
    db.exec(`PRAGMA user_version = ${String(version)}`);
    return;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSIONS_TABLE} (part TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT`);
  db.prepare(`INSERT INTO ${SCHEMA_VERSIONS_TABLE} (part, version) VALUES (?, ?) ON CONFLICT (part) DO UPDATE SET version = excluded.version`).run(
    part,
    version,
  );
}

/**
 * This function does the steps that a database does not have, in order. The version of the file, or of its part, is the
 * count of steps that it has.
 *
 * Each step is one `BEGIN IMMEDIATE` transaction with its new version. A step that fails rolls back alone, and the steps
 * before it stay. In the transaction, the function reads the version again, so two processes can migrate one file at
 * the same time. A file with more steps than `migrations` is from a newer version of the app, and the function throws.
 *
 * @param db - The connection.
 * @param migrations - The steps of the schema. Do not change a step that a file can have: add a new step.
 * @param options - The part of the file, and the name of the database in the errors.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[], options: MigrateOptions = {}): Migrated {
  const part = options.part;
  checkPart(part);
  const name = options.name ?? (part === undefined ? "database" : `part ${part}`);
  const known = migrations.length;
  const refuseNewer = (version: number): void => {
    if (version > known) {
      throw new Error(`The ${name} has the schema version ${String(version)}, and this code knows only ${String(known)}. Use a newer version of the app.`);
    }
  };
  const from = schemaVersion(db, part);
  refuseNewer(from);
  let version = from;
  while (version < known) {
    version = transaction(db, () => {
      const current = schemaVersion(db, part);
      refuseNewer(current);
      if (current === known) return current;
      const step = migrations[current] as Migration;
      if (typeof step === "string") db.exec(step);
      else step(db);
      setSchemaVersion(db, part, current + 1);
      return current + 1;
    });
  }
  return { from, to: version };
}

/**
 * The columns that a table must have: the name of each column and its definition, for example `REAL` or
 * `TEXT NOT NULL DEFAULT ''`. A definition is SQL of the app. Do not make it from the input of a user.
 */
export type ColumnDefinitions = Readonly<Record<string, string>>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** This function throws when a name is not a plain SQL name, or when it starts with `sqlite_`. */
function checkIdentifier(what: string, name: string): void {
  if (!IDENTIFIER.test(name) || name.toLowerCase().startsWith("sqlite_")) {
    throw new RangeError(`${what} must be a name of letters, digits and underscores that does not start with sqlite_, not ${JSON.stringify(name)}.`);
  }
}

/**
 * This function gives the names of the columns of a table, in the order of the table. A table that does not exist gives an
 * empty list.
 *
 * @param db - The connection.
 * @param table - The name of the table.
 */
export function tableColumns(db: DatabaseSync, table: string): string[] {
  checkIdentifier("The name of a table", table);
  return (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((row) => row.name);
}

/**
 * This function adds each column that a table does not have, and gives the names of the added columns in their order.
 *
 * An older version of an app can have made the table with fewer columns. The first step of a schema can do
 * `CREATE TABLE IF NOT EXISTS` and then this function. Such a step adopts a file of each older version at `user_version` 0.
 *
 * The comparison of names ignores case, as SQLite does. `ALTER TABLE ADD COLUMN` sets the rules of a definition: for
 * example, a `NOT NULL` column needs a default when the table has rows. The function examines each name before it changes
 * the table.
 *
 * @param db - The connection.
 * @param table - The name of the table. The table must exist.
 * @param columns - The columns that the table must have.
 */
export function addMissingColumns(db: DatabaseSync, table: string, columns: ColumnDefinitions): string[] {
  const names = Object.keys(columns);
  for (const name of names) checkIdentifier("The name of a column", name);
  const present = new Set(tableColumns(db, table).map((name) => name.toLowerCase()));
  if (present.size === 0) throw new Error(`The table ${table} does not exist. Make the table before you add columns to it.`);
  const added: string[] = [];
  for (const name of names) {
    if (present.has(name.toLowerCase())) continue;
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${columns[name] as string}`);
    present.add(name.toLowerCase());
    added.push(name);
  }
  return added;
}
