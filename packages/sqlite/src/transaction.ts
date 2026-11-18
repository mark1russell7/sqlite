/**
 * The write transaction: `BEGIN IMMEDIATE`, the work, and `COMMIT`, or a `ROLLBACK` after an error. In a transaction in
 * progress, a savepoint can take the place of the transaction. The read transaction reads one snapshot of the file,
 * and it does not take the write lock.
 *
 * @packageDocumentation
 */
import type { SqlConnection } from "./connection.ts";
import { isInTransaction } from "./probe.ts";

/** The part of a connection that a transaction uses. A test can give a fake. */
export type TransactionDatabase = Pick<SqlConnection, "exec" | "isTransaction">;

/** The part of a connection that a read transaction uses. */
export type ReadTransactionDatabase = Pick<SqlConnection, "exec" | "prepare" | "isTransaction">;

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
  /**
   * This value tells if the work commits. The default is true. With false, the transaction rolls back after the work
   * and gives the result of the work: a dry run. The work sees its writes, and the file does not keep them.
   */
  readonly commit?: boolean | undefined;
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
 * With `commit: false`, the function rolls back after the work and gives the result of the work: a dry run.
 *
 * @param db - The connection.
 * @param work - The work. Its writes are part of the transaction.
 * @param options - The function that gets a failed rollback, the behavior in a transaction in progress, and the dry run.
 */
export function transaction<T>(db: TransactionDatabase, work: () => T, options: TransactionOptions = {}): T {
  return run(db, "BEGIN IMMEDIATE", work, options);
}

/**
 * This function does the work in one read transaction on one snapshot of the file, and gives the result of the work.
 *
 * The transaction starts with `BEGIN DEFERRED` and a read, so the snapshot starts at the call. Each read of the work
 * sees the file as it was then. The transaction does not take the write lock. In WAL mode, a writer on a different
 * connection does not wait for it. The work cannot write: `PRAGMA query_only` is on during the work. The function sets
 * the earlier value again at the end.
 *
 * The rules of `transaction` apply: the commit, the rollback after an error, the synchronous work and `nested`. Keep
 * the work short. While the snapshot is open, a checkpoint cannot pass it, so the WAL file grows.
 *
 * @param db - The connection.
 * @param work - The work. It only reads.
 * @param options - The function that gets a failed rollback, and the behavior in a transaction in progress.
 */
export function readTransaction<T>(db: ReadTransactionDatabase, work: () => T, options: TransactionOptions = {}): T {
  const row = db.prepare("PRAGMA query_only").get() as { readonly query_only?: number | bigint } | undefined;
  const readOnly = Number(row?.query_only ?? 0) !== 0;
  if (!readOnly) db.exec("PRAGMA query_only = ON");
  try {
    return run(
      db,
      "BEGIN DEFERRED",
      () => {
        // A deferred transaction gets its snapshot at its first read. This read starts the snapshot at the call.
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
        return work();
      },
      options,
    );
  } finally {
    if (!readOnly) db.exec("PRAGMA query_only = OFF");
  }
}

/** The part of a connection that a synced transaction uses. */
export type SyncedTransactionDatabase = Pick<SqlConnection, "exec" | "prepare" | "isTransaction">;

/**
 * This function does the work in one write transaction whose commit is on the disk when the function ends. It gives the
 * result of the work.
 *
 * In WAL mode with `synchronous` NORMAL, a commit does not sync the WAL file. A power cut or a crash of the system can
 * lose the commits after the last checkpoint, and the file stays good. This function sets `synchronous` FULL for its
 * commit, and sets the earlier value again at the end. Thus a connection keeps the low cost of NORMAL for most writes,
 * and syncs only the writes that must stay. The sync of the WAL file also keeps each earlier commit of the file.
 *
 * A connection with FULL or EXTRA needs no change. The rules of `transaction` apply: the commit, the rollback after an
 * error, the synchronous work and the dry run. A call in a transaction in progress throws, also with `nested:
 * "savepoint"`. The commit of the transaction in progress is not the commit of this work.
 *
 * @param db - The connection.
 * @param work - The work. Its writes are part of the transaction.
 * @param options - The function that gets a failed rollback, and the dry run.
 */
export function syncedTransaction<T>(db: SyncedTransactionDatabase, work: () => T, options: TransactionOptions = {}): T {
  if (isInTransaction(db)) throw new Error("A synced transaction needs its own commit, so it cannot start in a transaction in progress.");
  const row = db.prepare("PRAGMA synchronous").get() as { readonly synchronous?: number | bigint } | undefined;
  // The values are 0 OFF, 1 NORMAL, 2 FULL and 3 EXTRA.
  const earlier = Number(row?.synchronous ?? FULL);
  if (earlier >= FULL) return run(db, "BEGIN IMMEDIATE", work, options);
  db.exec(`PRAGMA synchronous = ${String(FULL)}`);
  try {
    return run(db, "BEGIN IMMEDIATE", work, options);
  } finally {
    db.exec(`PRAGMA synchronous = ${String(earlier)}`);
  }
}

/** The value of `PRAGMA synchronous` for FULL. */
const FULL = 2;

/** This function does the work after a `BEGIN`, or in a savepoint of the transaction in progress. */
function run<T>(db: TransactionDatabase, begin: string, work: () => T, options: TransactionOptions): T {
  const nested = options.nested ?? "refuse";
  if (!NESTED.includes(nested)) throw new RangeError(`The value of nested must be one of ${NESTED.join(", ")}, not ${String(nested)}.`);
  const commit = options.commit ?? true;
  if (typeof commit !== "boolean") throw new TypeError(`The value of commit must be true or false, not ${String(commit)}.`);
  if (nested === "savepoint" && isInTransaction(db)) return savepoint(db, work, commit, options);
  db.exec(begin);
  try {
    const result = work();
    if (isThenable(result)) {
      throw new TypeError("The work of a transaction must be synchronous. The transaction rolled back.");
    }
    db.exec(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    try {
      if (isInTransaction(db)) db.exec("ROLLBACK");
    } catch (rollback) {
      options.onRollbackError?.(rollback);
    }
    throw error;
  }
}

/** This function does the work in a savepoint of the transaction in progress. */
function savepoint<T>(db: TransactionDatabase, work: () => T, commit: boolean, options: TransactionOptions): T {
  const name = `"sqlite_savepoint_${String(nextSavepoint++)}"`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = work();
    if (isThenable(result)) {
      throw new TypeError("The work of a transaction must be synchronous. The savepoint rolled back.");
    }
    if (!isInTransaction(db)) throw new Error("The work ended the transaction in progress, so its savepoint is gone.");
    if (!commit) db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try {
      // ROLLBACK TO keeps the savepoint, so a RELEASE must follow. Without the transaction, nothing is left to undo.
      if (isInTransaction(db)) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      }
    } catch (rollback) {
      options.onRollbackError?.(rollback);
    }
    throw error;
  }
}
