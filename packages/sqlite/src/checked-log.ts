/**
 * The checked open of an event log. The function examines the file before the log uses it. A broken file goes into
 * quarantine, and a new file gets each readable event. Each step of the recovery can be done again, so a crash at a step
 * loses no event: the next open completes the recovery.
 *
 * @packageDocumentation
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.ts";
import type { LogRecord } from "./event-log.ts";
import { logFileOn, openEventLog, type EventLogFile, type EventLogFileOptions } from "./event-log-file.ts";
import { sqliteFault, type SqliteFault, type SqliteFaultAction, type SqliteFaultKind } from "./faults.ts";
import {
  checkIntegrity,
  COMPANIONS,
  IntegrityError,
  messageOf,
  quarantineFolder,
  salvageEventLog,
  syncFile,
  syncFolder,
  type Integrity,
  type IntegrityOptions,
  type Quarantined,
  type QuarantineOptions,
} from "./recovery.ts";
import type { Parse } from "./schema.ts";

/** The options of `openCheckedEventLog`: the options of `openEventLog`, the check and the quarantine. */
export interface CheckedEventLogOptions<E> extends EventLogFileOptions<E> {
  /** This value is the integrity check before the open. The default is `{ quick: true }`. */
  readonly check?: IntegrityOptions | undefined;
  /** These values are the folder of the quarantine and the time in its name. */
  readonly quarantine?: QuarantineOptions | undefined;
}

/**
 * The options of `openCheckedEventLog` with no integrity check before the open. The open still recovers a file with a
 * broken-file fault, and a file with no database file.
 */
export interface UncheckedEventLogOptions<E> extends Omit<CheckedEventLogOptions<E>, "check"> {
  /** This value turns off the integrity check before the open. `checkIntegrityInBackground` can do the check later. */
  readonly check: false;
}

/** The cause of a recovery: a check that found problems, or a fault of a broken file in the open or in the migrate. */
export type RecoveryCause = { readonly kind: "integrity"; readonly integrity: Integrity } | { readonly kind: "fault"; readonly fault: SqliteFault };

/** The counts of a salvage. A caller can send an alert when `lost` is more than 0. */
export interface SalvageCounts {
  /** This value is the count of events that the new log got from the broken file. */
  readonly kept: number;
  /** This value is the count of positions of the broken log that the salvage could not read or parse. */
  readonly lost: number;
  /** This value has the text of each problem of the salvage. A file that is not readable gives a problem and no count. */
  readonly problems: readonly string[];
}

/**
 * The result of `openCheckedEventLog`. The value of `kind` tells what the function found at the path:
 *
 * - `created`: no file, so the function made a new log.
 * - `opened`: a file that passed its check. `integrity` is the result of the check.
 * - `recovered`: a broken file. It is in quarantine, and the log is a new file with each event that the salvage kept.
 * - `orphan-journal`: a WAL, SHM or journal file with no database file. It is in quarantine, and the log is a new file.
 */
export type CheckedEventLog<E extends LogRecord> =
  | { readonly kind: "created"; readonly log: EventLogFile<E> }
  | { readonly kind: "opened"; readonly log: EventLogFile<E>; readonly integrity: Integrity }
  | {
      readonly kind: "recovered";
      readonly log: EventLogFile<E>;
      readonly cause: RecoveryCause;
      readonly quarantined: Quarantined;
      readonly salvage: SalvageCounts;
    }
  | { readonly kind: "orphan-journal"; readonly log: EventLogFile<E>; readonly quarantined: Quarantined };

/**
 * The result of `openCheckedEventLog` with `check: false`. The kind `unchecked` replaces the kind `opened`: a file that
 * opened with no fault, and with no integrity check.
 */
export type UncheckedEventLog<E extends LogRecord> = Exclude<CheckedEventLog<E>, { readonly kind: "opened" }> | { readonly kind: "unchecked"; readonly log: EventLogFile<E> };

/**
 * One recovery of `openCheckedEventLog`, from the record in its quarantine folder. The value of `kind` tells what the
 * record holds:
 *
 * - `recovered`: the recovery of a broken file, with its cause and the counts of its salvage.
 * - `orphan-journal`: the quarantine of a WAL, SHM or journal file with no database file.
 * - `no-read`: a folder with no record, or with a record that does not parse. `problem` tells why.
 *
 * `id` is the name of the quarantine folder. It stays the same when the data folder moves, so it is the stable id of
 * the recovery. `at` is the time of the recovery, and `folder` is the path of the folder at the read.
 */
export type RecoveryEntry =
  | { readonly kind: "recovered"; readonly id: string; readonly folder: string; readonly at: string; readonly cause: RecoveryCause; readonly salvage: SalvageCounts }
  | { readonly kind: "orphan-journal"; readonly id: string; readonly folder: string; readonly at: string }
  | { readonly kind: "no-read"; readonly id: string; readonly folder: string; readonly problem: string };

/** The format of the record of a recovery. */
const RECORD_FORMAT = "sqlite-recovery/1";

/** The cause of a recovery in its record: a fault has no error object. */
type StoredCause =
  | { readonly kind: "integrity"; readonly integrity: Integrity }
  | {
      readonly kind: "fault";
      readonly fault: { readonly kind: SqliteFaultKind; readonly action: SqliteFaultAction; readonly code: number; readonly extendedCode: number; readonly message: string };
    };

/** The record of a recovery. It marks a complete salvage, and it keeps the folder of the quarantine. */
type RecoveryRecord =
  | { readonly format: typeof RECORD_FORMAT; readonly kind: "recovered"; readonly folder: string; readonly at: string; readonly cause: StoredCause; readonly salvage: SalvageCounts }
  | { readonly format: typeof RECORD_FORMAT; readonly kind: "orphan-journal"; readonly folder: string; readonly at: string };

/** This function gives the path of the salvage file of a database file. */
const salvageOf = (path: string): string => `${path}.salvage-tmp`;
/** This function gives the path of the record of a recovery of a database file. */
const recordOf = (path: string): string => `${path}.recovery.json`;

/**
 * This function opens a log in its own file after an integrity check of the file. It recovers a broken file:
 *
 * 1. The salvage reads each readable event of the broken file into the file `<path>.salvage-tmp`.
 * 2. The record `<path>.recovery.json` marks the salvage complete. It keeps the cause, the counts and the quarantine folder.
 * 3. The broken file and its WAL, SHM and journal files move into the quarantine folder. The main file goes last.
 * 4. The salvage file takes the path, and the record moves into the quarantine folder.
 *
 * Each step can be done again. A crash before step 2 leaves the broken file at the path, and the next open starts again.
 * A crash after step 2 leaves the record, and the next open completes the steps 3 and 4.
 *
 * A broken-file fault, for example `corrupt` or `not-a-database`, starts the recovery. Each other error goes to the
 * caller and moves nothing, for example a lock that is not free. With `readOnly`, the function moves nothing: a check
 * that fails throws an `IntegrityError`, and a fault throws its error. Only one process at a time can recover a file.
 *
 * With `check: false`, the function does no integrity check, and an open with no fault gives the kind `unchecked`.
 * The open of a large file is then fast. `checkIntegrityInBackground` can do the check after the open.
 *
 * @param path - The path of the file, or `:memory:`.
 * @param parse - The parse of a stored JSON value into an event. It is a function or a validator of the Standard Schema.
 * @param options - The options of `openEventLog`, the check and the quarantine.
 */
export function openCheckedEventLog<E extends LogRecord>(path: string, parse: Parse<E>, options: UncheckedEventLogOptions<E>): UncheckedEventLog<E>;
export function openCheckedEventLog<E extends LogRecord>(path: string, parse: Parse<E>, options?: CheckedEventLogOptions<E>): CheckedEventLog<E>;
export function openCheckedEventLog<E extends LogRecord>(
  path: string,
  parse: Parse<E>,
  options: CheckedEventLogOptions<E> | UncheckedEventLogOptions<E> = {},
): CheckedEventLog<E> | UncheckedEventLog<E> {
  return openWith(path, parse, options, () => undefined);
}

/**
 * This function is `openCheckedEventLog` with a seam after each step of the recovery. A test throws in the seam to stop
 * the recovery at that step, as a crash does.
 *
 * @param seam - The function that gets the name of each step after the step.
 */
export function openCheckedEventLogWith<E extends LogRecord>(path: string, parse: Parse<E>, options: UncheckedEventLogOptions<E>, seam: (step: string) => void): UncheckedEventLog<E>;
export function openCheckedEventLogWith<E extends LogRecord>(path: string, parse: Parse<E>, options: CheckedEventLogOptions<E>, seam: (step: string) => void): CheckedEventLog<E>;
export function openCheckedEventLogWith<E extends LogRecord>(
  path: string,
  parse: Parse<E>,
  options: CheckedEventLogOptions<E> | UncheckedEventLogOptions<E>,
  seam: (step: string) => void,
): CheckedEventLog<E> | UncheckedEventLog<E> {
  return openWith(path, parse, options, seam);
}

/** This function is the body of `openCheckedEventLog` and `openCheckedEventLogWith`. It takes each kind of options. */
function openWith<E extends LogRecord>(
  path: string,
  parse: Parse<E>,
  options: CheckedEventLogOptions<E> | UncheckedEventLogOptions<E>,
  seam: (step: string) => void,
): CheckedEventLog<E> | UncheckedEventLog<E> {
  const { check = { quick: true }, quarantine: given = {}, ...logOptions } = options;
  if (path === ":memory:" || path === "") return { kind: "created", log: openEventLog(path, parse, logOptions) };
  // One time gives the name of the folder and the time of the record
  const where = { ...given, now: given.now ?? new Date() };
  const at = where.now.toISOString();
  const readOnly = logOptions.readOnly === true;
  if (existsSync(recordOf(path))) {
    if (readOnly) throw new Error(`The recovery of ${path} is not complete. An open without readOnly completes it.`);
    return finish(path, parse, logOptions, readRecord(recordOf(path)), seam);
  }
  // A salvage file with no record is from a salvage that did not complete
  if (!readOnly) removeSalvage(path);
  const present = COMPANIONS.filter((suffix) => existsSync(path + suffix));
  if (present.length === 0) return { kind: "created", log: openEventLog(path, parse, logOptions) };

  if (!present.includes("")) {
    if (readOnly) throw new IntegrityError([`The path ${path} has no database file, but it has ${present.map((suffix) => basename(path) + suffix).join(", ")}.`]);
    const record: RecoveryRecord = { format: RECORD_FORMAT, kind: "orphan-journal", folder: freeFolder(path, where), at };
    writeRecord(path, record);
    seam("recorded");
    return finish(path, parse, logOptions, record, seam);
  }

  const first = checkAndOpen(path, parse, logOptions, check);
  if (first.kind !== "broken") return first;
  if (readOnly) {
    if (first.cause.kind === "integrity") throw new IntegrityError(first.cause.integrity.problems);
    throw first.error;
  }

  // Step 1: the salvage. The broken file does not change, and the close of the new log moves its WAL into its file.
  const salvage = salvageOf(path);
  const target = openEventLog(salvage, parse, logOptions);
  let counts: SalvageCounts;
  try {
    const salvaged = salvageEventLog(path, target, { parse });
    counts = { kept: salvaged.added + salvaged.duplicate, lost: salvaged.lost + salvaged.conflict, problems: salvaged.problems };
    seam("salvaged");
  } finally {
    target.close();
  }
  if (existsSync(`${salvage}-wal`)) throw new Error(`The close of ${salvage} left its WAL file, so the salvage is not complete.`);
  rmSync(`${salvage}-shm`, { force: true });
  syncFile(salvage);

  // Step 2: the record marks the salvage complete
  const record: RecoveryRecord = { format: RECORD_FORMAT, kind: "recovered", folder: freeFolder(path, where), at, cause: storedCause(first.cause), salvage: counts };
  writeRecord(path, record);
  seam("recorded");
  const result = finish(path, parse, logOptions, record, seam);
  // The first open gives the fault with its error of SQLite. The record keeps no error object.
  return result.kind === "recovered" ? { ...result, cause: first.cause } : result;
}

/** The result of the first open: a log that passed its check, a log with no check, or the cause of a recovery. */
type FirstOpen<E extends LogRecord> =
  | { readonly kind: "opened"; readonly log: EventLogFile<E>; readonly integrity: Integrity }
  | { readonly kind: "unchecked"; readonly log: EventLogFile<E> }
  | { readonly kind: "broken"; readonly cause: RecoveryCause; readonly error: unknown };

/** This function opens the file, does the check, and makes the log on the same connection. With `false`, it does no check. */
function checkAndOpen<E extends LogRecord>(path: string, parse: Parse<E>, options: EventLogFileOptions<E>, check: IntegrityOptions | false): FirstOpen<E> {
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(path, options);
    if (check === false) {
      const owned = db;
      // From here, the log owns the connection. It closes the connection when it throws.
      db = undefined;
      return { kind: "unchecked", log: logFileOn(owned, parse, options.equal) };
    }
    const integrity = checkIntegrity(db, check);
    const owned = db;
    // From here, the log owns the connection, or this function closes it
    db = undefined;
    if (!integrity.ok) {
      owned.close();
      return { kind: "broken", cause: { kind: "integrity", integrity }, error: new IntegrityError(integrity.problems) };
    }
    return { kind: "opened", log: logFileOn(owned, parse, options.equal), integrity };
  } catch (error) {
    db?.close();
    const fault = sqliteFault(error);
    if (fault?.action !== "quarantine") throw error;
    return { kind: "broken", cause: { kind: "fault", fault }, error };
  }
}

/** This function does the steps 3 and 4 of a recovery from its record. Each step that is done already does nothing. */
function finish<E extends LogRecord>(path: string, parse: Parse<E>, options: EventLogFileOptions<E>, record: RecoveryRecord, seam: (step: string) => void): CheckedEventLog<E> {
  const salvage = salvageOf(path);
  // Without the salvage file, step 4 moved it to the path, so step 3 is complete
  if (record.kind === "orphan-journal" || existsSync(salvage)) moveInto(path, record.folder, seam);
  if (record.kind === "recovered") {
    if (existsSync(salvage)) {
      renameSync(salvage, path);
      syncFolder(dirname(path));
      seam("renamed");
    } else if (!existsSync(path)) {
      throw new Error(`The record ${recordOf(path)} tells of a salvage, but there is no salvage file and no file at ${path}.`);
    }
  }
  const quarantined = quarantinedIn(path, record.folder);
  renameSync(recordOf(path), join(record.folder, basename(recordOf(path))));
  syncFolder(dirname(path));
  syncFolder(record.folder);
  seam("filed");
  const log = openEventLog(path, parse, options);
  if (record.kind === "orphan-journal") return { kind: "orphan-journal", log, quarantined };
  return { kind: "recovered", log, cause: loadedCause(record.cause), quarantined, salvage: record.salvage };
}

/** This function moves each file of the database at a path into a folder. The main file goes last. */
function moveInto(path: string, folder: string, seam: (step: string) => void): void {
  try {
    mkdirSync(folder);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  }
  for (const suffix of COMPANIONS) {
    if (!existsSync(path + suffix)) continue;
    renameSync(path + suffix, join(folder, basename(path) + suffix));
    seam(`moved${suffix === "" ? "-main" : suffix}`);
  }
  syncFolder(folder);
  syncFolder(dirname(path));
}

/** This function gives the files of a database in its quarantine folder. */
function quarantinedIn(path: string, folder: string): Quarantined {
  const files = COMPANIONS.map((suffix) => join(folder, basename(path) + suffix)).filter((file) => existsSync(file));
  const database = join(folder, basename(path));
  return { folder, database: existsSync(database) ? database : undefined, files };
}

/** This function gives a quarantine folder that does not exist yet. Step 3 makes it. */
function freeFolder(path: string, options: QuarantineOptions): string {
  return quarantineFolder(path, options, (folder) => !existsSync(folder));
}

/** This function removes the salvage file of a salvage that did not complete, and a record that is not complete. */
function removeSalvage(path: string): void {
  for (const suffix of COMPANIONS) rmSync(salvageOf(path) + suffix, { force: true });
  rmSync(`${recordOf(path)}.tmp`, { force: true });
}

/** This function writes the record of a recovery. A rename makes the record complete in one step. */
function writeRecord(path: string, record: RecoveryRecord): void {
  const file = recordOf(path);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  syncFile(temporary);
  renameSync(temporary, file);
  syncFolder(dirname(path));
}

/** This function reads the record of a recovery, and refuses a record that it does not know. */
function readRecord(file: string): RecoveryRecord {
  const text = readFileSync(file, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`The recovery record ${file} is not valid JSON: ${messageOf(error)}`);
  }
  if (isRecoveryRecord(value)) return value;
  throw new Error(`The recovery record ${file} has a format that this version does not know.`);
}

/** This function tells if a value is an object, and not `null` or a list. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** This function tells if a parsed value has each field of a record of a recovery. */
function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (!isObject(value) || value["format"] !== RECORD_FORMAT || typeof value["folder"] !== "string" || typeof value["at"] !== "string") return false;
  if (value["kind"] === "orphan-journal") return true;
  if (value["kind"] !== "recovered") return false;
  const cause = value["cause"];
  const salvage = value["salvage"];
  const causeOk = isObject(cause) && ((cause["kind"] === "integrity" && isObject(cause["integrity"])) || (cause["kind"] === "fault" && isObject(cause["fault"])));
  return causeOk && isObject(salvage) && typeof salvage["kept"] === "number" && typeof salvage["lost"] === "number" && Array.isArray(salvage["problems"]);
}

/**
 * This function gives each recovery of `openCheckedEventLog` for a path, from the records in its quarantine folders. A
 * caller can report each recovery at each start, with `id` as the id of the report. In a grow-only log, a second
 * report of the same recovery changes nothing.
 *
 * - The function reads each folder `<name>.broken-*` next to the path, or in the folder of the option `folder`.
 * - The entries are in the sequence of `at`, and then of `id`. An entry of the kind `no-read` has no time, so it goes last.
 * - A folder with no record, or with a record that does not parse, gives an entry of the kind `no-read`.
 * - A recovery that is not complete has its record at `<path>.recovery.json`. Its folder is not in the list, because
 *   the next open completes the recovery first.
 * - A cause of the kind `fault` comes from the record. Its `error` is a new `Error` with the message of SQLite.
 *
 * @param path - The path of the database file.
 * @param options - The folder of the quarantine folders, when it is not the folder of the path.
 */
export function listRecoveries(path: string, options: Pick<QuarantineOptions, "folder"> = {}): readonly RecoveryEntry[] {
  const parent = options.folder ?? dirname(path);
  const name = basename(path);
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  const open = openRecoveryFolder(path);
  const entries: RecoveryEntry[] = [];
  for (const id of names) {
    if (!id.startsWith(`${name}.broken-`) || id === open) continue;
    const folder = join(parent, id);
    if (!statSync(folder).isDirectory()) continue;
    entries.push(entryOf(id, folder, join(folder, `${name}.recovery.json`)));
  }
  return entries.sort(byTimeAndId);
}

/** This function gives the name of the folder of a recovery that is not complete, or `undefined`. */
function openRecoveryFolder(path: string): string | undefined {
  if (!existsSync(recordOf(path))) return undefined;
  try {
    return basename(readRecord(recordOf(path)).folder);
  } catch {
    // The next open refuses this record. Until then, its folder has no record, so the list gives it as `no-read`.
    return undefined;
  }
}

/** This function gives the entry of one quarantine folder from its record. */
function entryOf(id: string, folder: string, file: string): RecoveryEntry {
  if (!existsSync(file)) return { kind: "no-read", id, folder, problem: `The folder ${folder} has no record of a recovery.` };
  let record: RecoveryRecord;
  try {
    record = readRecord(file);
  } catch (error) {
    return { kind: "no-read", id, folder, problem: messageOf(error) };
  }
  if (record.kind === "orphan-journal") return { kind: "orphan-journal", id, folder, at: record.at };
  return { kind: "recovered", id, folder, at: record.at, cause: loadedCause(record.cause), salvage: record.salvage };
}

/** This function orders two entries by their time, and then by their id. An entry with no time goes last. */
function byTimeAndId(a: RecoveryEntry, b: RecoveryEntry): number {
  const x = a.kind === "no-read" ? undefined : a.at;
  const y = b.kind === "no-read" ? undefined : b.at;
  if (x !== y) {
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return x < y ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** This function gives the cause of a recovery for its record. */
function storedCause(cause: RecoveryCause): StoredCause {
  if (cause.kind === "integrity") return cause;
  const { kind, action, code, extendedCode, message } = cause.fault;
  return { kind: "fault", fault: { kind, action, code, extendedCode, message } };
}

/** This function gives the cause of a recovery from its record. The error of a fault is a new `Error` with its message. */
function loadedCause(cause: StoredCause): RecoveryCause {
  if (cause.kind === "integrity") return cause;
  return { kind: "fault", fault: { ...cause.fault, error: new Error(cause.fault.message) } };
}
