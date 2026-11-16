/**
 * The guard that keeps the SQL of a connection on the file of the connection. SQL text can name other files. `ATTACH`
 * opens or makes a file at a path, and `VACUUM INTO` writes a copy to a path. Two pragmas set a folder for temporary files.
 * The guard refuses these statements through the authorizer of SQLite. Thus a host that checks the path of the database
 * also controls each file that the SQL of a caller writes.
 *
 * @packageDocumentation
 */

import type { DatabaseSync } from "node:sqlite";

/** The part of a `node:sqlite` connection that `confineToFile` uses. Node.js 24.10 and later have `setAuthorizer`. */
export interface ConfinableDatabase {
  readonly setAuthorizer?:
    | ((
        callback:
          | ((actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number)
          | null,
      ) => void)
    | undefined;
}

// The result codes and the action codes of an authorizer, from sqlite3.h. The values are a stable part of the C API.
const SQLITE_OK = 0;
const SQLITE_DENY = 1;
const SQLITE_PRAGMA = 19;
const SQLITE_ATTACH = 24;
const SQLITE_FUNCTION = 31;

/**
 * The file name of a temporary database. A plain `VACUUM` attaches one with `ATTACH ''`. SQLite puts it in the temporary
 * folder and deletes it at the close.
 */
const TEMPORARY_DATABASE = "";

/** The pragmas that set a folder for the files of SQLite. `temp_store_directory` sets it for each connection of the process. */
const FOLDER_PRAGMAS: ReadonlySet<string> = new Set(["temp_store_directory", "data_store_directory"]);

/** The functions that read a file. `load_extension` loads a library from a path. */
const FILE_FUNCTIONS: ReadonlySet<string> = new Set(["load_extension"]);

/**
 * This function gives the decision of the guard for one action of SQLite. SQLite gives the file name of an `ATTACH` and
 * the name of a pragma in `arg1`, and the name of a function in `arg2`. The file name is `null` when the SQL gives it as
 * an expression or a parameter.
 */
function decide(actionCode: number, arg1: string | null, arg2: string | null): number {
  if (actionCode === SQLITE_ATTACH) return arg1 === TEMPORARY_DATABASE ? SQLITE_OK : SQLITE_DENY;
  if (actionCode === SQLITE_PRAGMA && arg1 !== null && FOLDER_PRAGMAS.has(arg1.toLowerCase())) return SQLITE_DENY;
  if (actionCode === SQLITE_FUNCTION && arg2 !== null && FILE_FUNCTIONS.has(arg2.toLowerCase())) return SQLITE_DENY;
  return SQLITE_OK;
}

/** The error of `confineToFile` on a Node.js with no `setAuthorizer` in `node:sqlite`. Node.js 24.10 added it. */
export class ConfineUnavailableError extends Error {
  override readonly name = "ConfineUnavailableError";
  /** This value is a stable code for checks: `error.code === "CONFINE_UNAVAILABLE"`. */
  readonly code = "CONFINE_UNAVAILABLE";

  constructor() {
    super(
      `The node:sqlite of Node.js ${process.version} has no setAuthorizer, so the guard cannot keep the SQL of a connection on its file. Use Node.js 24.10 or later.`,
    );
  }
}

/**
 * This function keeps the SQL of a connection on the file of the connection. Use it when the SQL text comes from a caller,
 * and the host controls the path of the database.
 *
 * The function sets an authorizer. The authorizer refuses `ATTACH` of a file, `VACUUM INTO`, the pragmas
 * `temp_store_directory` and `data_store_directory`, and the function `load_extension`. Each other statement runs as
 * before.
 *
 * - SQLite asks the authorizer when it compiles a statement. A refused `ATTACH` or pragma throws with the code
 *   `SQLITE_AUTH`, and `sqliteFault` gives the kind `authorization`. `VACUUM INTO` throws when it runs, before it makes a
 *   file.
 * - A plain `VACUUM` works, and so does `clearDatabase`. A plain `VACUUM` attaches a temporary database with an empty
 *   name, and the guard lets this `ATTACH`.
 * - An `ATTACH ''` stays in the temporary folder of SQLite. But a caller can fill this folder with a large temporary
 *   database until the close. The guard does not limit the time or the size of the work of a caller. The host does.
 * - The guard also applies to the triggers and the views that a statement uses, because SQLite compiles them into the
 *   statement. A trigger runs with the authorizer of the connection that fires it. Thus confine each connection that runs
 *   the SQL of a caller.
 * - A connection has one authorizer. The guard replaces each earlier authorizer of the connection, and
 *   `db.setAuthorizer(null)` removes the guard.
 * - `snapshot` uses `VACUUM INTO`, so it needs a connection with no guard.
 *
 * @param db - The connection: a `DatabaseSync` of `node:sqlite`, or another value with the part `ConfinableDatabase`. A
 *   `DatabaseSync` of Node.js 24.10 or later has `setAuthorizer`. The `DatabaseSync` type of `@types/node` 22 has no
 *   `setAuthorizer`, and the parameter accepts it too.
 * @throws ConfineUnavailableError when the connection has no `setAuthorizer`. The SQL of the connection then stays without a
 *   guard, so do not run the SQL of a caller on it.
 */
export function confineToFile(db: DatabaseSync | ConfinableDatabase): void {
  // The `DatabaseSync` type of `@types/node` 22 has no member of `ConfinableDatabase`, so the type needs this cast. The
  // check below reads the method at run time. The cast goes when the package needs Node.js 24.10 or later.
  const connection = db as ConfinableDatabase;
  if (typeof connection.setAuthorizer !== "function") throw new ConfineUnavailableError();
  connection.setAuthorizer(decide);
}
