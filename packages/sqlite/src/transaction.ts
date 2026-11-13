/**
 * The write transaction: `BEGIN IMMEDIATE`, the work, and `COMMIT`, or a `ROLLBACK` after an error.
 *
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";

/** The part of a connection that a transaction uses. A test can give a fake. */
export type TransactionDatabase = Pick<DatabaseSync, "exec" | "isTransaction">;

/** The options of `transaction`. */
export interface TransactionOptions {
  /**
   * This function gets the error of a rollback that did not end. Then the connection can stay in the transaction, and
   * each later `BEGIN` throws. The work error stays the error that `transaction` throws.
   */
  readonly onRollbackError?: ((error: unknown) => void) | undefined;
}

/** This function tells if a value is a promise or a different thenable. */
function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * This function does the work in one write transaction, and gives the result of the work.
 *
 * `BEGIN IMMEDIATE` takes the write lock at the start, so a different writer cannot cause a failure in the middle of
 * the work. The busy timeout of the connection sets the wait for that lock. When the work or the commit throws, the
 * function rolls back and throws the same error. The work is synchronous: a work that gives a promise is an error.
 * A call in a transaction throws, because SQLite refuses a `BEGIN` there.
 *
 * @param db - The connection.
 * @param work - The work. Its writes are part of the transaction.
 * @param options - The function that gets a failed rollback.
 */
export function transaction<T>(db: TransactionDatabase, work: () => T, options: TransactionOptions = {}): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    if (isThenable(result)) {
      throw new TypeError("The work of a transaction must be synchronous. The transaction rolled back.");
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch (rollback) {
      options.onRollbackError?.(rollback);
    }
    throw error;
  }
}
