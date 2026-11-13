/**
 * The connection to a database on one computer: a `DatabaseSync` of `node:sqlite` with the pragmas set.
 *
 * @packageDocumentation
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The values of the pragma `synchronous`. */
export type Synchronous = "OFF" | "NORMAL" | "FULL" | "EXTRA";

const SYNCHRONOUS: readonly Synchronous[] = ["OFF", "NORMAL", "FULL", "EXTRA"];

/** The options of `openDatabase`. Each default is the default of SQLite, but the journal is WAL by default. */
export interface OpenOptions {
  /**
   * This value turns on the write-ahead log (WAL). The default is true. Then readers do not stop a writer. A database
   * with no file keeps its journal in memory.
   */
  readonly wal?: boolean | undefined;
  /**
   * This value is the pragma `synchronous`. The default is `FULL`: a commit is on the disk when the call ends. With WAL,
   * `NORMAL` can lose the last commits at a power cut, and the file stays good.
   */
  readonly synchronous?: Synchronous | undefined;
  /**
   * This value is the time in milliseconds that a statement waits for the lock of a different connection. The default
   * is 0: then the statement fails at once with "database is locked".
   */
  readonly busyTimeoutMs?: number | undefined;
  /** This value makes the folder of the file when the folder is not there. The default is false. */
  readonly makeFolder?: boolean | undefined;
  /** This value is the mode of the folders that `makeFolder` makes, for example `0o700`. */
  readonly folderMode?: number | undefined;
}

/**
 * This function opens a database, and makes the file when it is not there. `:memory:` gives a database with no file.
 *
 * The function sets the busy timeout first, because the change to WAL needs the lock of the file. When a pragma
 * fails, the function closes the connection and throws the error.
 *
 * @param path - The path of the file, or `:memory:`.
 * @param options - The pragmas and the folder.
 */
export function openDatabase(path: string, options: OpenOptions = {}): DatabaseSync {
  const synchronous = options.synchronous ?? "FULL";
  if (!SYNCHRONOUS.includes(synchronous)) {
    throw new RangeError(`The value of synchronous must be one of ${SYNCHRONOUS.join(", ")}, not ${String(synchronous)}.`);
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 0;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(`The busy timeout must be a whole number of milliseconds of 0 or more, not ${String(busyTimeoutMs)}.`);
  }
  if (options.makeFolder === true && path !== ":memory:") {
    mkdirSync(dirname(path), options.folderMode === undefined ? { recursive: true } : { recursive: true, mode: options.folderMode });
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
    if (options.wal ?? true) db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA synchronous = ${synchronous}`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
