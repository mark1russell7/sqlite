/**
 * The checkpoint of the write-ahead log (WAL): SQLite copies the pages of the log into the database file.
 *
 * @packageDocumentation
 */
import type { SqlConnection } from "./connection.ts";
import { isInTransaction } from "./probe.ts";

/** The modes of `PRAGMA wal_checkpoint`. `TRUNCATE` also makes the log file empty. */
export type CheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

const CHECKPOINT_MODES: readonly CheckpointMode[] = ["PASSIVE", "FULL", "RESTART", "TRUNCATE"];

/** The result of a checkpoint. A database that is not in WAL mode gives -1 for each count. */
export interface Checkpointed {
  /** This value is true when a different connection stopped the checkpoint before its end. */
  readonly busy: boolean;
  /** This value is the number of pages in the log. */
  readonly log: number;
  /** This value is the number of pages of the log that the checkpoint copied into the database file. */
  readonly checkpointed: number;
}

/** The part of a connection that `setAutocheckpoint` uses. */
export type AutocheckpointDatabase = Pick<SqlConnection, "exec">;

/**
 * This function sets the pragma `wal_autocheckpoint` of a connection. Its value is the number of pages in the log that
 * starts a checkpoint at the end of a commit. The default of SQLite is 1000. The value 0 turns the automatic checkpoint
 * off.
 *
 * Each commit with `synchronous` `FULL` syncs the log, thus the setting does not change what a crash keeps. With the
 * automatic checkpoint off, the log grows until a call of `checkpoint`. Turn it on again after a burst of large
 * commits, for example the first pass of a start.
 *
 * @param db - The connection.
 * @param pages - A whole number of pages, 0 or more.
 */
export function setAutocheckpoint(db: AutocheckpointDatabase, pages: number): void {
  db.exec(`PRAGMA wal_autocheckpoint = ${String(checkPages(pages))}`);
}

/** This function gives the number of pages of `wal_autocheckpoint`, or throws a `RangeError` for a bad value. */
export function checkPages(pages: number): number {
  if (!Number.isInteger(pages) || pages < 0) {
    throw new RangeError(`The pages of the automatic checkpoint must be a whole number of 0 or more, not ${String(pages)}.`);
  }
  return pages;
}

/** The part of a connection that a checkpoint uses. */
export type CheckpointDatabase = Pick<SqlConnection, "prepare" | "isTransaction">;

/**
 * This function does a checkpoint of the write-ahead log, and gives its result.
 *
 * Before a copy of the database file, use `TRUNCATE`: then the file has each commit, and the log is empty. When the
 * result has `busy`, a different connection had the file, and the file can lack the last commits. SQLite refuses a
 * checkpoint in a transaction, so the function throws there.
 *
 * @param db - The connection.
 * @param mode - The mode of `PRAGMA wal_checkpoint`. The default is `PASSIVE`: it does not wait for other connections.
 */
export function checkpoint(db: CheckpointDatabase, mode: CheckpointMode = "PASSIVE"): Checkpointed {
  if (!CHECKPOINT_MODES.includes(mode)) {
    throw new RangeError(`The checkpoint mode must be one of ${CHECKPOINT_MODES.join(", ")}, not ${String(mode)}.`);
  }
  if (isInTransaction(db)) throw new Error("A checkpoint cannot run in a transaction. Run it after the transaction.");
  const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as { busy?: unknown; log?: unknown; checkpointed?: unknown } | undefined;
  return { busy: Number(row?.busy ?? 0) !== 0, log: Number(row?.log ?? -1), checkpointed: Number(row?.checkpointed ?? -1) };
}
