/**
 * A typed append-only log of events in SQLite. The log is a grow-only set of events with an order: an event that the log
 * has already changes nothing. The caller keeps a state, and the log keeps the file equal to it.
 *
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, type OpenOptions } from "./database.ts";
import { migrate, SCHEMA_VERSIONS_TABLE, type Migration } from "./migrate.ts";
import { transaction } from "./transaction.ts";

/** The fields that the log reads from each event. The log keeps the full event as JSON. */
export interface LogRecord {
  readonly id: string;
  readonly at: string;
  readonly type: string;
}

/**
 * This function accepts an event into the state of the caller, or refuses it. It gives a problem when it refuses the
 * event, and then it must not change the state.
 */
export type Accept<E, P> = (event: E) => P | undefined;

/** This function tells if a new event is equal to the stored event with the same id. */
export type Equal<E> = (stored: E, event: E) => boolean;

/**
 * The result of the append of one event.
 *
 * - `added`: the log did not have the id, `accept` accepted the event, and the log wrote it at the position `seq`.
 * - `duplicate`: the log has an equal event at the position `seq`. Nothing changed, and `accept` did not get the event.
 * - `conflict`: the log has a different event with the same id at the position `seq`. Nothing changed.
 * - `refused`: `accept` refused the event with the problem `problem`. Nothing changed.
 */
export type Appended<E, P> =
  | { readonly kind: "added"; readonly seq: number }
  | { readonly kind: "duplicate"; readonly seq: number }
  | { readonly kind: "conflict"; readonly seq: number; readonly stored: E }
  | { readonly kind: "refused"; readonly problem: P };

/** One event of a log and its position. The first position is 1, and each new event gets a higher position. */
export interface LogEntry<E> {
  readonly seq: number;
  readonly event: E;
}

/** The options of a read of a log. */
export interface ReadOptions {
  /** This value is a position. The read gives only the events after it. The default is 0, so the read starts at the first event. */
  readonly after?: number | undefined;
  /** This value is a list of types. The read gives only the events of these types. The default is each type. */
  readonly types?: readonly string[] | undefined;
  /** This value is the highest count of events that the read gives. The default is no limit. */
  readonly limit?: number | undefined;
}

/** An open log. */
export interface EventLog<E extends LogRecord> {
  /** This function gives the events of the log, in the order of the log. */
  read(options?: ReadOptions): Generator<E>;
  /** This function gives the events of the log with their positions, in the order of the log. */
  entries(options?: ReadOptions): Generator<LogEntry<E>>;
  /** This function gives the event with an id and its position, or `undefined` when the log does not have the id. */
  get(id: string): LogEntry<E> | undefined;
  /** This function gives the position of the last event, or 0 for an empty log. A read after it gives only new events. */
  head(): number;
  /**
   * This function appends one event. An event that the log has already changes nothing. `accept` gets only an event with
   * a new id, before the write. The default `accept` accepts each event.
   */
  append<P = never>(event: E, accept?: Accept<E, P>): Appended<E, P>;
  /** This function does `append` for each event, in one transaction, and gives the result of each event in order. */
  appendAll<P = never>(events: Iterable<E>, accept?: Accept<E, P>): Appended<E, P>[];
  /** This function gives the count of events in the log. */
  count(): number;
  /**
   * This function makes a broken log usable again. It throws a `BrokenLogError` when the rollback of the failed write did
   * not end, and then the log stays broken. After it, the caller replays the log, so its state is equal to the file again.
   */
  recover(): void;
}

/** A log that owns its connection: `openEventLog` gives it. */
export interface EventLogFile<E extends LogRecord> extends EventLog<E> {
  /** This function closes the connection of the log. */
  close(): void;
}

/** The error of a call to a broken log. `stuck` is true when the rollback of the failed write did not end. */
export class BrokenLogError extends Error {
  override readonly name = "BrokenLogError";
  readonly stuck: boolean;

  constructor(message: string, stuck: boolean, cause: unknown) {
    super(message, { cause });
    this.stuck = stuck;
  }
}

/** The options of `eventLog`. */
export interface EventLogOptions<E> {
  /** This function changes a stored JSON value into an event. It throws on a value that is not an event. */
  readonly parse: (value: unknown) => E;
  /** This value is the name of the table of the log. The default is `events`. A file can have many logs in different tables. */
  readonly table?: string | undefined;
  /** This function tells if a new event is equal to the stored event with its id. The default compares the JSON text. */
  readonly equal?: Equal<E> | undefined;
}

/** The options of `openEventLog`: the options of the connection, and the equality of events. */
export interface EventLogFileOptions<E> extends OpenOptions {
  /** This function tells if a new event is equal to the stored event with its id. The default compares the JSON text. */
  readonly equal?: Equal<E> | undefined;
}

/** The steps of the schema of a log in a table. Do not change a step: add a new step. */
function logSteps(table: string): readonly Migration[] {
  return [
    `CREATE TABLE ${table} (
       seq INTEGER PRIMARY KEY,
       id TEXT NOT NULL UNIQUE,
       at TEXT NOT NULL,
       type TEXT NOT NULL,
       body TEXT NOT NULL
     ) STRICT`,
    `CREATE INDEX ${table}_type ON ${table} (type, seq)`,
  ];
}

/** The schema version of a log: the `user_version` of a file of `openEventLog`, or the version of the part `event-log:<table>`. */
export const EVENT_LOG_SCHEMA_VERSION: number = logSteps("events").length;

/** The default name of the table of a log. */
const DEFAULT_TABLE = "events";

/** This function throws when a name cannot be the table of a log. The salvage of a log uses it too. */
export function checkTable(table: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || table.toLowerCase().startsWith("sqlite_") || table === SCHEMA_VERSIONS_TABLE) {
    throw new RangeError(`The table of a log must be a name of letters, digits and underscores, and not ${SCHEMA_VERSIONS_TABLE} or sqlite_*, not ${JSON.stringify(table)}.`);
  }
}

/** This function throws when a value is not a whole number at or above a lowest value. */
function checkWhole(what: string, value: number, lowest: number): void {
  if (!Number.isInteger(value) || value < lowest) throw new RangeError(`${what} must be a whole number of ${String(lowest)} or more, not ${String(value)}.`);
}

/**
 * This function opens a log in a table of a connection of the caller. The log does not close the connection.
 *
 * The log keeps its schema version in the part `event-log:<table>` of the file (refer to `migrate`). Thus the app keeps its own
 * tables and its own steps in the same file. A call of the log in a transaction of the caller throws, and the log does not break.
 *
 * The state of the caller and the file stay equal: `accept` comes before the write. A write or an `accept` can fail with an
 * error. Then the transaction rolls back, and the log is broken. Each later call throws a `BrokenLogError` until `recover`.
 * The state of the caller can keep the events of the failed write, so the caller replays the log after `recover`.
 *
 * @param db - The connection. Set its pragmas with `openDatabase`.
 * @param options - The parse of the events, the table and the equality of events.
 */
export function eventLog<E extends LogRecord>(db: DatabaseSync, options: EventLogOptions<E>): EventLog<E> {
  const table = options.table ?? DEFAULT_TABLE;
  checkTable(table);
  migrate(db, logSteps(table), { part: `event-log:${table}`, name: `log ${table}` });
  return attach(db, table, options.parse, options.equal);
}

/**
 * This function opens a log in its own file, and makes the file when it is not there. `:memory:` gives a log with no file.
 *
 * The log owns the connection and the `user_version` of its file, and its table is `events`. A file of a newer schema
 * version gives an error. The rules of `eventLog` apply.
 *
 * @param path - The path of the file, or `:memory:`.
 * @param parse - The function that changes a stored JSON value into an event. It throws on a value that is not an event.
 * @param options - The pragmas of the connection, and the equality of events. The defaults are the defaults of `openDatabase`.
 */
export function openEventLog<E extends LogRecord>(path: string, parse: (value: unknown) => E, options: EventLogFileOptions<E> = {}): EventLogFile<E> {
  const db = openDatabase(path, options);
  try {
    migrate(db, logSteps(DEFAULT_TABLE), { name: "log" });
    const log = attach(db, DEFAULT_TABLE, parse, options.equal);
    return {
      ...log,
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** This function makes the log object on a table with a current schema. */
function attach<E extends LogRecord>(db: DatabaseSync, table: string, parse: (value: unknown) => E, equal: Equal<E> | undefined): EventLog<E> {
  const insert = db.prepare(`INSERT INTO ${table} (id, at, type, body) VALUES (?, ?, ?, ?)`);
  const byId = db.prepare(`SELECT seq, body FROM ${table} WHERE id = ?`);
  const readSql = `SELECT seq, body FROM ${table} WHERE seq > ? AND (? IS NULL OR type IN (SELECT value FROM json_each(?))) ORDER BY seq LIMIT ?`;
  /** The error of a failed write. A broken log refuses each call until `recover`. */
  let broken: unknown;
  /** The error of a rollback that did not end. A log with this error cannot recover. */
  let stuck: unknown;
  const onRollbackError = (error: unknown): void => {
    stuck = error;
  };

  function guard(): void {
    if (broken !== undefined) throw new BrokenLogError("The log is broken by an earlier error. Open it again and replay it.", stuck !== undefined, broken);
  }

  function decode(row: { seq: number; body: string }): E {
    try {
      return parse(JSON.parse(row.body));
    } catch (error) {
      throw new Error(`The event at the position ${String(row.seq)} of the log is not valid.`, { cause: error });
    }
  }

  function write<P>(event: E, accept: Accept<E, P> | undefined): Appended<E, P> {
    const body = JSON.stringify(event);
    const row = byId.get(event.id) as { seq: number; body: string } | undefined;
    if (row !== undefined) {
      if (equal === undefined && row.body === body) return { kind: "duplicate", seq: row.seq };
      const stored = decode(row);
      if (equal?.(stored, event) === true) return { kind: "duplicate", seq: row.seq };
      return { kind: "conflict", seq: row.seq, stored };
    }
    const problem = accept?.(event);
    if (problem !== undefined) return { kind: "refused", problem };
    const result = insert.run(event.id, event.at, event.type, body);
    return { kind: "added", seq: Number(result.lastInsertRowid) };
  }

  /** This function does the work in one transaction. A failure after the `BEGIN` breaks the log. */
  function inTransaction<T>(work: () => T): T {
    guard();
    let began = false;
    try {
      return transaction(
        db,
        () => {
          began = true;
          return work();
        },
        { onRollbackError },
      );
    } catch (error) {
      if (began) broken = error;
      throw error;
    }
  }

  function* entries(options: ReadOptions = {}): Generator<LogEntry<E>> {
    guard();
    const after = options.after ?? 0;
    checkWhole("The position after", after, 0);
    if (options.limit !== undefined) checkWhole("The limit of a read", options.limit, 1);
    const types = options.types === undefined ? null : JSON.stringify(options.types);
    const rows = db.prepare(readSql).iterate(after, types, types, options.limit ?? -1) as Iterable<{ seq: number; body: string }>;
    for (const row of rows) yield { seq: row.seq, event: decode(row) };
  }

  return {
    *read(options) {
      for (const entry of entries(options)) yield entry.event;
    },
    entries,
    get(id) {
      guard();
      const row = byId.get(id) as { seq: number; body: string } | undefined;
      return row === undefined ? undefined : { seq: row.seq, event: decode(row) };
    },
    head() {
      guard();
      return (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS head FROM ${table}`).get() as { head: number }).head;
    },
    append(event, accept) {
      return inTransaction(() => write(event, accept));
    },
    appendAll(events, accept) {
      return inTransaction(() => {
        const results = [];
        for (const event of events) results.push(write(event, accept));
        return results;
      });
    },
    count() {
      guard();
      return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    },
    recover() {
      if (broken === undefined) return;
      if (stuck !== undefined || db.isTransaction) {
        throw new BrokenLogError("The rollback of the failed write did not end. Open the log again and replay it.", true, stuck ?? broken);
      }
      broken = undefined;
    },
  };
}
