/**
 * The recovery of a broken file. This module has the integrity check and the quarantine of a file with its WAL and SHM
 * files. It also has the salvage of the readable events of a log and a snapshot of an open database.
 *
 * @packageDocumentation
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { checkTable, type EventLog, type LogRecord } from "./event-log.ts";
import { sqliteFault, type SqliteFault } from "./faults.ts";
import { NodeDatabase } from "./node-sqlite.ts";
import { parseFunction, type Parse } from "./schema.ts";

/** The result of an integrity check. `problems` has the text of each problem that SQLite found. */
export interface Integrity {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** The options of `checkIntegrity`. */
export interface IntegrityOptions {
  /** This value selects `PRAGMA quick_check`. It is faster, but it does not compare the indexes with their tables. The default is `false`. */
  readonly quick?: boolean | undefined;
  /** This value is the highest count of problems that the check gives. The default is 100. */
  readonly limit?: number | undefined;
}

/**
 * The error of a file that failed its integrity check. Its result code is `SQLITE_CORRUPT`, so `sqliteFault` gives the
 * kind `corrupt` and the action `quarantine`.
 */
export class IntegrityError extends Error {
  override readonly name = "IntegrityError";
  readonly code = "ERR_SQLITE_ERROR";
  readonly errcode = 11;
  readonly errstr = "database disk image is malformed";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The file failed its integrity check: ${problems.slice(0, 3).join(" | ")}${problems.length > 3 ? ` (and ${String(problems.length - 3)} more)` : ""}`);
    this.problems = problems;
  }
}

/** This function gives the message of an error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** This function tells if an error is a fault of a broken file. */
function isBrokenFile(error: unknown): boolean {
  return sqliteFault(error)?.action === "quarantine";
}

/**
 * This function does the integrity check of SQLite on a connection. A file that is not a database gives a problem, not
 * an error. A different error, for example a lock that is not free, goes to the caller.
 *
 * @param db - The connection.
 * @param options - The kind of check and the highest count of problems.
 */
export function checkIntegrity(db: DatabaseSync, options: IntegrityOptions = {}): Integrity {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`The limit of problems must be a whole number of 1 or more, not ${String(limit)}.`);
  const pragma = options.quick === true ? "quick_check" : "integrity_check";
  try {
    const rows = db.prepare(`PRAGMA ${pragma}(${String(limit)})`).all() as Record<string, unknown>[];
    const problems = rows.map((row) => String(Object.values(row)[0])).filter((text) => text !== "ok");
    return { ok: problems.length === 0, problems };
  } catch (error) {
    if (!isBrokenFile(error)) throw error;
    return { ok: false, problems: [messageOf(error)] };
  }
}

/** The options of `quarantine`. */
export interface QuarantineOptions {
  /** This value is the folder of the quarantine folders. It must be on the volume of the file. The default is the folder of the file. */
  readonly folder?: string | undefined;
  /** This value is the time in the name of the quarantine folder. The default is the time of the call. */
  readonly now?: Date | undefined;
}

/** The result of a quarantine. */
export interface Quarantined {
  /** This value is the new folder that has the files. */
  readonly folder: string;
  /** This value is the new path of the database file, or `undefined` when only its WAL, SHM or journal file was there. */
  readonly database: string | undefined;
  /** This value is the new path of each file that moved. */
  readonly files: readonly string[];
}

/** The files of a database, in the order of the move: the main file goes last. */
const COMPANIONS = ["-wal", "-shm", "-journal", ""] as const;

/**
 * This function moves a database file and its WAL, SHM and journal files into a new folder `<name>.broken-<time>`. Then a
 * new open of the path makes an empty file, and the broken files stay for a salvage.
 *
 * Close each connection to the file first. The WAL file moves before the main file: a WAL file without its main file
 * must not go into a new file. The function throws when the path has none of the files.
 *
 * @param path - The path of the database file.
 * @param options - The folder of the quarantine and the time in its name.
 */
export function quarantine(path: string, options: QuarantineOptions = {}): Quarantined {
  const present = COMPANIONS.filter((suffix) => existsSync(path + suffix));
  if (present.length === 0) throw new Error(`There is no database file at ${path}.`);
  const stamp = (options.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  const parent = options.folder ?? dirname(path);
  const name = `${basename(path)}.broken-${stamp}`;
  let folder = join(parent, name);
  for (let n = 2; ; n++) {
    try {
      mkdirSync(folder);
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      folder = join(parent, `${name}-${String(n)}`);
    }
  }
  const files: string[] = [];
  try {
    for (const suffix of present) {
      const target = join(folder, basename(path) + suffix);
      renameSync(path + suffix, target);
      files.push(target);
    }
  } finally {
    if (files.length === 0) rmdirSync(folder);
  }
  return { folder, database: present.includes("") ? join(folder, basename(path)) : undefined, files };
}

/** The result of `openOrQuarantine`. `quarantined` and `fault` are there only when the first open found a broken file. */
export interface Recovered<T> {
  readonly value: T;
  readonly quarantined: Quarantined | undefined;
  readonly fault: SqliteFault | undefined;
}

/**
 * This function opens a file with `open`. A broken file makes the open fail. Then the function moves the file into
 * quarantine and opens the path again, so the app starts with an empty file.
 *
 * `open` must close its connection when it throws. An `IntegrityError` from `open` also starts the quarantine. Each
 * other error goes to the caller, and the second open does not catch its errors.
 *
 * @param path - The path of the database file.
 * @param open - The function that opens the file, for example `openEventLog` with its arguments.
 * @param options - The options of the quarantine.
 */
export function openOrQuarantine<T>(path: string, open: (path: string) => T, options: QuarantineOptions = {}): Recovered<T> {
  try {
    return { value: open(path), quarantined: undefined, fault: undefined };
  } catch (error) {
    const fault = sqliteFault(error);
    if (fault?.action !== "quarantine") throw error;
    const quarantined = quarantine(path, options);
    return { value: open(path), quarantined, fault };
  }
}

/** The options of `salvageEventLog`. */
export interface SalvageOptions<E> {
  /**
   * This value changes a stored JSON value into an event. It is a function that throws on a value that is not an event,
   * or a validator of the Standard Schema. A schema of zod 4 is such a validator. The salvage uses it on each readable event.
   */
  readonly parse: Parse<E>;
  /** This value is the table of the log in the broken file. The default is `events`. */
  readonly table?: string | undefined;
}

/** The result of a salvage. */
export interface Salvaged {
  /** This value is the count of events that the salvage read and parsed. */
  readonly read: number;
  /** These values are the counts of the results of the append of the read events to the new log. */
  readonly added: number;
  readonly duplicate: number;
  readonly conflict: number;
  /** This value is the count of positions of the broken log that the salvage could not read or parse. */
  readonly lost: number;
  /** This value has the text of each problem, for the report of the recovery. */
  readonly problems: readonly string[];
}

/** The count of events in one transaction of the salvage. */
const BATCH = 500;
/** When the end of a broken log is not known, the salvage stops after this count of positions with no event. */
const GAP = 1000;

/**
 * This function reads the readable events of a log in a broken file, and appends them to a different log. The broken
 * file does not change: the function opens it read-only.
 *
 * The function first reads the log in order. When the read stops at a broken page, it reads each later position alone,
 * up to the last position. When the last position is not readable, it stops after 1000 positions with no event.
 *
 * @param source - The path of the broken file, for example `database` of the result of `quarantine`.
 * @param target - The new log.
 * @param options - The parse of the events and the table of the log.
 */
export function salvageEventLog<E extends LogRecord>(source: string, target: EventLog<E>, options: SalvageOptions<E>): Salvaged {
  const table = options.table ?? "events";
  checkTable(table);
  const counts = { read: 0, added: 0, duplicate: 0, conflict: 0, lost: 0 };
  const problems: string[] = [];
  let pending: E[] = [];
  const parse = parseFunction(options.parse);
  const flush = (): void => {
    for (const result of target.appendAll(pending)) {
      if (result.kind === "added") counts.added++;
      else if (result.kind === "duplicate") counts.duplicate++;
      else if (result.kind === "conflict") counts.conflict++;
    }
    pending = [];
  };
  const take = (seq: number, body: string): void => {
    try {
      pending.push(parse(JSON.parse(body)));
      counts.read++;
    } catch (error) {
      counts.lost++;
      problems.push(`The event at the position ${String(seq)} is not valid: ${messageOf(error)}`);
    }
    if (pending.length >= BATCH) flush();
  };
  /** The positions that failed and did not come back yet: the first and the last. */
  let failedFrom = 0;
  let failedTo = 0;
  const noteFailures = (): void => {
    if (failedFrom === 0) return;
    counts.lost += failedTo - failedFrom + 1;
    problems.push(failedFrom === failedTo ? `The position ${String(failedFrom)} is not readable.` : `The positions ${String(failedFrom)} to ${String(failedTo)} are not readable.`);
    failedFrom = 0;
  };

  let db: DatabaseSync | undefined;
  try {
    db = new NodeDatabase(source, { readOnly: true });
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
  } catch (error) {
    db?.close();
    if (!isBrokenFile(error)) throw error;
    return { ...counts, problems: [`The file is not readable: ${messageOf(error)}`] };
  }
  try {
    let last = 0;
    let complete = false;
    try {
      for (const row of db.prepare(`SELECT seq, body FROM ${table} ORDER BY seq`).iterate() as Iterable<{ seq: number; body: string }>) {
        take(row.seq, row.body);
        last = row.seq;
      }
      complete = true;
    } catch (error) {
      if (!isBrokenFile(error)) throw error;
      problems.push(`The read in order stopped after the position ${String(last)}: ${messageOf(error)}`);
    }
    if (!complete) {
      const high = highestPosition(db, table);
      if (high === undefined) problems.push(`The last position is not readable. The salvage stops after ${String(GAP)} positions with no event.`);
      let probe;
      try {
        probe = db.prepare(`SELECT body FROM ${table} WHERE seq = ?`);
      } catch (error) {
        if (!isBrokenFile(error)) throw error;
        problems.push(`The table is not readable: ${messageOf(error)}`);
      }
      let misses = 0;
      for (let seq = last + 1; probe !== undefined && (high === undefined ? misses < GAP : seq <= high); seq++) {
        try {
          const row = probe.get(seq) as { body: string } | undefined;
          if (row === undefined) {
            misses++;
            continue;
          }
          noteFailures();
          misses = 0;
          take(seq, row.body);
        } catch (error) {
          if (!isBrokenFile(error)) throw error;
          misses++;
          if (failedFrom === 0) failedFrom = seq;
          failedTo = seq;
        }
      }
      if (high !== undefined) noteFailures();
      else if (failedFrom !== 0) problems.push(`The positions from ${String(failedFrom)} are not readable, and the end of the log is not known.`);
    }
    flush();
  } finally {
    db.close();
  }
  return { ...counts, problems };
}

/** This function gives the last position of a broken log from its table or from its index on the type, or `undefined`. */
function highestPosition(db: DatabaseSync, table: string): number | undefined {
  for (const sql of [`SELECT max(seq) AS high FROM ${table}`, `SELECT max(seq) AS high FROM ${table} INDEXED BY ${table}_type`]) {
    try {
      const high = (db.prepare(sql).get() as { high: number | null }).high;
      if (high !== null) return high;
    } catch (error) {
      if (!isBrokenFile(error) && sqliteFault(error)?.kind !== "sql") throw error;
    }
  }
  return undefined;
}

/** The result of `snapshot`. */
export interface Snapshot {
  readonly path: string;
  readonly bytes: number;
}

/**
 * This function writes a copy of an open database to a file with `VACUUM INTO`. The copy is one consistent state, and
 * writers can continue during the copy. The function writes a temporary file first, and then it replaces the file at the
 * path. Thus a reader of the path sees the old copy or the new copy.
 *
 * Do not use the function in a transaction. The copy has no WAL file, and its pages are compact.
 *
 * @param db - The connection of the database.
 * @param path - The path of the copy. A file at the path gets the new copy.
 */
export function snapshot(db: DatabaseSync, path: string): Snapshot {
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    db.prepare("VACUUM INTO ?").run(temporary);
    const fd = openSync(temporary, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  if (process.platform !== "win32") {
    // POSIX: a sync of the folder keeps the rename after a power cut. Windows has no sync of a folder.
    const fd = openSync(dirname(path), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return { path, bytes: statSync(path).size };
}
