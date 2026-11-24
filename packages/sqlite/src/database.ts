/**
 * The connection to a database on one computer: a `DatabaseSync` of `node:sqlite` with the pragmas set.
 *
 * @packageDocumentation
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { checkPages } from "./checkpoint.ts";
import { NodeDatabase } from "./node-sqlite.ts";
import { probeTransaction } from "./probe.ts";

/** The values of the pragma `synchronous`. */
export type Synchronous = "OFF" | "NORMAL" | "FULL" | "EXTRA";

const SYNCHRONOUS: readonly Synchronous[] = ["OFF", "NORMAL", "FULL", "EXTRA"];

/** The values of the option `wal` of `openDatabase`. */
export type WalMode = boolean | "when-writable";

const WAL_MODES: readonly WalMode[] = [true, false, "when-writable"];

/** The options of `openDatabase`. Each default is the default of SQLite, but the journal is WAL by default. */
export interface OpenOptions {
  /**
   * This value turns on the write-ahead log (WAL). The default is true. Then readers do not stop a writer. A database
   * with no file keeps its journal in memory.
   *
   * - `true`: the open throws when it cannot set WAL, for example on a file that the process cannot write.
   * - `"when-writable"`: a file that the process cannot write keeps its journal mode. The connection reads it, and
   *   each write throws.
   * - `false`: the open does not change the journal mode.
   */
  readonly wal?: WalMode | undefined;
  /**
   * This value opens the file to read only. The default is false. The file must exist. The open does not change the
   * journal mode, and each write throws. Do not give `wal: true` or `makeFolder: true` with it.
   */
  readonly readOnly?: boolean | undefined;
  /**
   * This value is the pragma `synchronous`. The default is `FULL`: a commit is on the disk when the call ends. With WAL,
   * `NORMAL` can lose the last commits at a power cut, and the file stays good. On a connection with `NORMAL`,
   * `syncedTransaction` gives the sync of `FULL` to one commit.
   */
  readonly synchronous?: Synchronous | undefined;
  /**
   * This value is the time in milliseconds that a statement waits for the lock of a different connection. The default
   * is 0: then the statement fails at once with "database is locked".
   */
  readonly busyTimeoutMs?: number | undefined;
  /**
   * This value is the pragma `wal_autocheckpoint`: the number of pages in the log that starts a checkpoint at the end
   * of a commit. The default is the default of SQLite, 1000. The value 0 turns the automatic checkpoint off.
   * `setAutocheckpoint` changes it later.
   */
  readonly autocheckpointPages?: number | undefined;
  /** This value makes the folder of the file when the folder is not there. The default is false. */
  readonly makeFolder?: boolean | undefined;
  /** This value is the mode of the folders that `makeFolder` makes, for example `0o700`. */
  readonly folderMode?: number | undefined;
}

/** The primary result code of SQLite for a write to a database that the connection cannot write. */
const SQLITE_READONLY = 8;

/** This function tells if an error of `node:sqlite` is a write to a database that the connection cannot write. */
function isReadOnlyError(error: unknown): boolean {
  const { errcode, message } = (typeof error === "object" && error !== null ? error : {}) as { errcode?: unknown; message?: unknown };
  // An extended code (SQLITE_READONLY_*) keeps the primary code in its low 8 bits
  if (typeof errcode === "number") return (errcode & 0xff) === SQLITE_READONLY;
  return /readonly database/i.test(String(message));
}

/**
 * This function opens a database, and makes the file when it is not there. `:memory:` gives a database with no file.
 * With `readOnly`, the file must exist.
 *
 * The function sets the busy timeout first, because the change to WAL needs the lock of the file. When a pragma
 * fails, the function closes the connection and throws the error. A Node.js before 22.16 has no `isTransaction`. Then
 * the function adds it to the connection as a probe: a `BEGIN`, which SQLite refuses in a transaction. Foreign keys are on, because `node:sqlite` turns
 * them on for each connection.
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
  const autocheckpointPages = options.autocheckpointPages === undefined ? undefined : checkPages(options.autocheckpointPages);
  const wal = options.wal ?? true;
  if (!WAL_MODES.includes(wal)) {
    throw new RangeError(`The value of wal must be true, false or "when-writable", not ${String(wal)}.`);
  }
  const readOnly = options.readOnly === true;
  if (readOnly && (options.wal === true || options.makeFolder === true)) {
    throw new RangeError("A read-only open cannot change the journal mode or make a folder: do not give wal: true or makeFolder: true with readOnly.");
  }
  if (options.makeFolder === true && path !== ":memory:") {
    mkdirSync(dirname(path), options.folderMode === undefined ? { recursive: true } : { recursive: true, mode: options.folderMode });
  }
  const db = readOnly ? new NodeDatabase(path, { readOnly: true }) : new NodeDatabase(path);
  try {
    // The transactions of this package read isTransaction. Node.js 22.16 and 24.0 added it. An older Node.js gets a probe.
    if (typeof (db as { readonly isTransaction?: unknown }).isTransaction !== "boolean") {
      Object.defineProperty(db, "isTransaction", { configurable: true, get: () => probeTransaction(db) });
    }
    db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
    if (!readOnly && wal !== false) {
      try {
        db.exec("PRAGMA journal_mode = WAL");
      } catch (error) {
        if (wal === true || !isReadOnlyError(error)) throw error;
      }
    }
    db.exec(`PRAGMA synchronous = ${synchronous}`);
    if (autocheckpointPages !== undefined) db.exec(`PRAGMA wal_autocheckpoint = ${String(autocheckpointPages)}`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
