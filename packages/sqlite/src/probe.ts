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
