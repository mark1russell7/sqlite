/**
 * A typed append-only log of events in one SQLite file. The caller keeps a state, and the log keeps the file equal to it.
 *
 * @packageDocumentation
 */
import { openDatabase, type OpenOptions } from "./database.ts";
import { migrate, type Migration } from "./migrate.ts";
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

/** An open log. */
export interface EventLog<E extends LogRecord> {
  /** This function gives each event of the log, in the order of the log. */
  read(): Generator<E>;
  /** This function accepts the event first, and then writes it. A refused event is not written. */
  append<P>(event: E, accept: Accept<E, P>): P | undefined;
  /** This function does `append` for each event, in one transaction. It gives the problems of the refused events. */
  appendAll<P>(events: Iterable<E>, accept: Accept<E, P>): P[];
  /** This function gives the count of events in the log. */
  count(): number;
  /**
   * This function makes a broken log usable again. It throws when the rollback of the failed write did not end, and
   * then the log stays broken. After it, the caller replays the log, so its state is equal to the file again.
   */
  recover(): void;
  /** This function closes the file. */
  close(): void;
}

/** Each entry is one step of the schema of the log. */
const MIGRATIONS: readonly Migration[] = [
  `CREATE TABLE events (
     seq INTEGER PRIMARY KEY,
     id TEXT NOT NULL UNIQUE,
     at TEXT NOT NULL,
     type TEXT NOT NULL,
     body TEXT NOT NULL
   ) STRICT`,
];

/** The schema version that `openEventLog` writes: the `user_version` of a log file. */
export const EVENT_LOG_SCHEMA_VERSION: number = MIGRATIONS.length;

/**
 * This function opens a log, and makes the file when it is not there. `:memory:` gives a log with no file.
 *
 * The state of the caller and the file stay equal: `accept` comes before the write. A write or an `accept` can fail with an
 * error. Then the transaction rolls back, and the log is broken. Each later call throws until `recover`. The state of the
 * caller can keep the events of the failed write, so the caller replays the log after `recover`.
 *
 * The log owns the `user_version` of its file. A file of a newer schema version gives an error.
 *
 * @param path - The path of the file, or `:memory:`.
 * @param parse - The function that changes a stored JSON value into an event. It throws on a value that is not an event.
 * @param options - The pragmas of the connection. The defaults are the defaults of `openDatabase`.
 */
export function openEventLog<E extends LogRecord>(path: string, parse: (value: unknown) => E, options: OpenOptions = {}): EventLog<E> {
  const db = openDatabase(path, options);
  try {
    migrate(db, MIGRATIONS, { name: "log" });
  } catch (error) {
    db.close();
    throw error;
  }
  const insert = db.prepare("INSERT INTO events (id, at, type, body) VALUES (?, ?, ?, ?)");
  /** The error of a failed write. A broken log refuses each call until `recover`. */
  let broken: unknown;
  /** The error of a rollback that did not end. A log with this error cannot recover. */
  let stuck: unknown;
  const onRollbackError = (error: unknown): void => {
    stuck = error;
  };

  function guard(): void {
    if (broken !== undefined) throw new Error("The log is broken by an earlier error. Open it again and replay it.", { cause: broken });
  }

  function write<P>(event: E, accept: Accept<E, P>): P | undefined {
    const problem = accept(event);
    if (problem !== undefined) return problem;
    insert.run(event.id, event.at, event.type, JSON.stringify(event));
    return undefined;
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

  return {
    *read() {
      guard();
      for (const row of db.prepare("SELECT seq, body FROM events ORDER BY seq").iterate() as Iterable<{ seq: number; body: string }>) {
        try {
          yield parse(JSON.parse(row.body));
        } catch (error) {
          throw new Error(`The event at the position ${String(row.seq)} of the log is not valid.`, { cause: error });
        }
      }
    },
    append(event, accept) {
      return inTransaction(() => write(event, accept));
    },
    appendAll(events, accept) {
      return inTransaction(() => {
        const problems = [];
        for (const event of events) {
          const problem = write(event, accept);
          if (problem !== undefined) problems.push(problem);
        }
        return problems;
      });
    },
    count() {
      guard();
      return (db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
    },
    recover() {
      if (broken === undefined) return;
      if (stuck !== undefined || db.isTransaction) {
        throw new Error("The rollback of the failed write did not end. Open the log again and replay it.", { cause: stuck ?? broken });
      }
      broken = undefined;
    },
    close() {
      db.close();
    },
  };
}
