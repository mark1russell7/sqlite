/**
 * The migrations of a schema by the pragma `user_version`: the version of a file is the count of steps that it has.
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

/** The options of `migrate`. */
export interface MigrateOptions {
  /** This value is the name of the database in the error for a newer file, for example `log`. The default is `database`. */
  readonly name?: string | undefined;
}

/** The versions of a file before and after `migrate`. */
export interface Migrated {
  readonly from: number;
  readonly to: number;
}

/** This function gives the pragma `user_version` of a database. */
export function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * This function does the steps that a database does not have, in order. The `user_version` of the file is the count of
 * steps that it has.
 *
 * Each step is one `BEGIN IMMEDIATE` transaction with its new `user_version`. A step that fails rolls back alone, and
 * the steps before it stay. In the transaction, the function reads the version again, so two processes can migrate
 * one file at the same time. A file with more steps than `migrations` is from a newer version of the app, and the
 * function throws.
 *
 * @param db - The connection.
 * @param migrations - The steps of the schema. Do not change a step that a file can have: add a new step.
 * @param options - The name of the database in the errors.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[], options: MigrateOptions = {}): Migrated {
  const name = options.name ?? "database";
  const known = migrations.length;
  const refuseNewer = (version: number): void => {
    if (version > known) {
      throw new Error(`The ${name} has the schema version ${String(version)}, and this code knows only ${String(known)}. Use a newer version of the app.`);
    }
  };
  const from = userVersion(db);
  refuseNewer(from);
  let version = from;
  while (version < known) {
    version = transaction(db, () => {
      const current = userVersion(db);
      refuseNewer(current);
      if (current === known) return current;
      const step = migrations[current] as Migration;
      if (typeof step === "string") db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${String(current + 1)}`);
      return current + 1;
    });
  }
  return { from, to: version };
}
