/**
 * A typed append-only log of events in its own file. The log owns the connection and the `user_version` of the file.
 *
 * @packageDocumentation
 */
import { openDatabase, type OpenOptions } from "./database.ts";
import { attach, DEFAULT_TABLE, logSteps, type Equal, type EventLog, type LogRecord } from "./event-log.ts";
import { migrate } from "./migrate.ts";

/** A log that owns its connection: `openEventLog` gives it. */
export interface EventLogFile<E extends LogRecord> extends EventLog<E> {
  /** This function closes the connection of the log. */
  close(): void;
}

/** The options of `openEventLog`: the options of the connection, and the equality of events. */
export interface EventLogFileOptions<E> extends OpenOptions {
  /** This function tells if a new event is equal to the stored event with its id. The default compares the JSON text. */
  readonly equal?: Equal<E> | undefined;
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
    const log = attach(db, DEFAULT_TABLE, parse, options.equal, "refuse");
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
