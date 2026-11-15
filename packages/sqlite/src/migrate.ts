/**
 * The migrations of a schema. The version of a file is the count of steps that it has. The file keeps the version in the
 * pragma `user_version`, or in the table `schema_versions` for each named part of the file.
 *
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import type { SqlConnection } from "./connection.ts";
import { transaction } from "./transaction.ts";

/**
 * One step of a schema: SQL statements, or a function that changes the database. A step operates in the transaction of
 * its migration, so it does not start a transaction. `D` is the type of the connection. The default is `DatabaseSync`.
 */
export type Migration<D extends SqlConnection = DatabaseSync> = string | ((db: D) => void);

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
  /**
   * This value tells what a file or a part of a newer schema version does. The default is `throw`.
   *
   * - `throw`: the function throws, because the steps of the newer version are not known.
   * - `keep`: the function does no step and keeps the version. Use it only when each step adds tables or columns, so an
   *   older app can work on a newer file.
   */
  readonly newer?: Newer | undefined;
}

/** What `migrate` does with a file of a newer schema version: throw, or keep the file as it is. */
export type Newer = "throw" | "keep";

const NEWER: readonly Newer[] = ["throw", "keep"];

/** The versions of a file, or of a part of a file, before and after `migrate`. */
export interface Migrated {
  readonly from: number;
  readonly to: number;
}

/** This function gives the pragma `user_version` of a database. */
export function userVersion(db: SqlConnection): number {
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
export function schemaVersion(db: SqlConnection, part?: string): number {
  checkPart(part);
  if (part === undefined) return userVersion(db);
  const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(SCHEMA_VERSIONS_TABLE);
  if (table === undefined) return 0;
  const row = db.prepare(`SELECT version FROM ${SCHEMA_VERSIONS_TABLE} WHERE part = ?`).get(part) as { version: number } | undefined;
  return row?.version ?? 0;
}

/** This function writes the schema version of a database, or of a part of it. It operates in a transaction. */
export function setSchemaVersion(db: SqlConnection, part: string | undefined, version: number): void {
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
 * the same time. A file with more steps than `migrations` is from a newer version of the app. Then the function throws,
 * or with `newer: "keep"` it does no step.
 *
 * @param db - The connection.
 * @param migrations - The steps of the schema. Do not change a step that a file can have: add a new step.
 * @param options - The part of the file, the name of the database in the errors, and the behavior with a newer file.
 */
export function migrate<D extends SqlConnection>(db: D, migrations: readonly Migration<D>[], options: MigrateOptions = {}): Migrated {
  const part = options.part;
  checkPart(part);
  const name = options.name ?? (part === undefined ? "database" : `part ${part}`);
  const newer = options.newer ?? "throw";
  if (!NEWER.includes(newer)) throw new RangeError(`The value of newer must be one of ${NEWER.join(", ")}, not ${String(newer)}.`);
  const known = migrations.length;
  /** This function tells if a version is newer than the steps, and throws for such a version unless `newer` is `keep`. */
  const isNewer = (version: number): boolean => {
    if (version <= known) return false;
    if (newer === "keep") return true;
    throw new Error(`The ${name} has the schema version ${String(version)}, and this code knows only ${String(known)}. Use a newer version of the app.`);
  };
  const from = schemaVersion(db, part);
  if (isNewer(from)) return { from, to: from };
  let version = from;
  while (version < known) {
    version = transaction(db, () => {
      const current = schemaVersion(db, part);
      if (isNewer(current) || current === known) return current;
      const step = migrations[current] as Migration<D>;
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
export function tableColumns(db: SqlConnection, table: string): string[] {
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
export function addMissingColumns(db: SqlConnection, table: string, columns: ColumnDefinitions): string[] {
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
