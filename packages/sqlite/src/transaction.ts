/**
 * The write transaction: `BEGIN IMMEDIATE`, the work, and `COMMIT`, or a `ROLLBACK` after an error. In a transaction in
 * progress, a savepoint can take the place of the transaction.
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
  /**
   * This value tells what a call in a transaction in progress does. The default is `refuse`.
   *
   * - `refuse`: the call throws, because SQLite refuses a `BEGIN` in a transaction.
   * - `savepoint`: the work is a savepoint of the transaction in progress. An error rolls back only the writes of the work.
   */
  readonly nested?: Nested | undefined;
}

/** What a transaction does in a transaction in progress: refuse it, or use a savepoint. */
export type Nested = "refuse" | "savepoint";

const NESTED: readonly Nested[] = ["refuse", "savepoint"];

/** The number of the next savepoint. Each savepoint gets its own name. */
let nextSavepoint = 1;

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
 * With `nested: "savepoint"`, a call in a transaction uses a savepoint: the writes of the work become part of the
 * transaction in progress. An error of the work rolls back only those writes, and the function throws the error. The
 * transaction in progress continues.
 *
 * @param db - The connection.
 * @param work - The work. Its writes are part of the transaction.
 * @param options - The function that gets a failed rollback, and the behavior in a transaction in progress.
 */
export function transaction<T>(db: TransactionDatabase, work: () => T, options: TransactionOptions = {}): T {
  const nested = options.nested ?? "refuse";
  if (!NESTED.includes(nested)) throw new RangeError(`The value of nested must be one of ${NESTED.join(", ")}, not ${String(nested)}.`);
  if (nested === "savepoint" && db.isTransaction) return savepoint(db, work, options);
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

/** This function does the work in a savepoint of the transaction in progress. */
function savepoint<T>(db: TransactionDatabase, work: () => T, options: TransactionOptions): T {
  const name = `"sqlite_savepoint_${String(nextSavepoint++)}"`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = work();
    if (isThenable(result)) {
      throw new TypeError("The work of a transaction must be synchronous. The savepoint rolled back.");
    }
    if (!db.isTransaction) throw new Error("The work ended the transaction in progress, so its savepoint is gone.");
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try {
      // ROLLBACK TO keeps the savepoint, so a RELEASE must follow. Without the transaction, nothing is left to undo.
      if (db.isTransaction) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      }
    } catch (rollback) {
      options.onRollbackError?.(rollback);
    }
    throw error;
  }
}
