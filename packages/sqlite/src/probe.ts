/**
 * The probe of a transaction in progress, for a driver that has no call for this state. The module imports no module of
 * Node.js, so the entry `/portable` can use it.
 *
 * @packageDocumentation
 */

/** The part of a connection that the probe uses. */
export interface ExecConnection {
  exec(sql: string): unknown;
}

/**
 * This function tells if the connection is in a transaction. It starts a `BEGIN`, and SQLite refuses a `BEGIN` in a
 * transaction. Out of a transaction, a `ROLLBACK` ends the `BEGIN`. A deferred `BEGIN` takes no lock, so the probe
 * does not wait for a different connection.
 *
 * @param db - The connection.
 */
export function probeTransaction(db: ExecConnection): boolean {
  try {
    db.exec("BEGIN");
  } catch (error) {
    if (/within a transaction/i.test(String((error as { message?: unknown } | null)?.message))) return true;
    throw error;
  }
  db.exec("ROLLBACK");
  return false;
}

/** The part of a connection that `isInTransaction` uses: the getter, else `exec`, else `prepare`. */
export interface StateConnection {
  readonly isTransaction?: unknown;
  exec?(sql: string): unknown;
  prepare?(sql: string): { run(): unknown };
}

/**
 * This function tells if the connection is in a transaction. It reads the getter `isTransaction`. A connection of
 * Node.js before 22.16 has no getter. Then the function uses the probe, with `exec` or with a prepared statement.
 *
 * @param db - The connection.
 */
export function isInTransaction(db: StateConnection): boolean {
  const state = db.isTransaction;
  if (typeof state === "boolean") return state;
  if (typeof db.exec === "function") return probeTransaction(db as ExecConnection);
  if (typeof db.prepare === "function") {
    const connection = db as Required<Pick<StateConnection, "prepare">>;
    return probeTransaction({ exec: (sql) => connection.prepare(sql).run() });
  }
  throw new TypeError("The connection has no isTransaction, no exec and no prepare, so its transaction state is not known.");
}
