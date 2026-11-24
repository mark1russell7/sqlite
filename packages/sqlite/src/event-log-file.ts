/**
 * A typed append-only log of events in its own file. The log owns the connection and the `user_version` of the file.
 *
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { checkpoint, setAutocheckpoint, type CheckpointMode, type Checkpointed } from "./checkpoint.ts";
import { openDatabase, type OpenOptions } from "./database.ts";
import { attach, DEFAULT_TABLE, logSteps, type Equal, type EventLog, type LogRecord } from "./event-log.ts";
import { migrate } from "./migrate.ts";
import { parseFunction, type Parse } from "./schema.ts";

/** A log that owns its connection: `openEventLog` gives it. */
export interface EventLogFile<E extends LogRecord> extends EventLog<E> {
  /** This function closes the connection of the log. */
  close(): void;
  /** This function does a checkpoint of the log file, and gives its result. The rules of `checkpoint` apply. */
  checkpoint(mode?: CheckpointMode): Checkpointed;
  /** This function sets the pragma `wal_autocheckpoint` of the connection of the log. The rules of `setAutocheckpoint` apply. */
  setAutocheckpoint(pages: number): void;
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
 * @param parse - The parse of a stored JSON value into an event. It is a function or a validator of the Standard Schema.
 * @param options - The pragmas of the connection, and the equality of events. The defaults are the defaults of `openDatabase`.
 */
export function openEventLog<E extends LogRecord>(path: string, parse: Parse<E>, options: EventLogFileOptions<E> = {}): EventLogFile<E> {
  return logFileOn(openDatabase(path, options), parse, options.equal);
}

/**
 * This function makes the log of `openEventLog` on an open connection. The log owns the connection. An error closes the
 * connection, and then the function throws the error.
 *
 * @param db - The connection of the file.
 * @param parse - The parse of a stored JSON value into an event.
 * @param equal - The equality of events.
 */
export function logFileOn<E extends LogRecord>(db: DatabaseSync, parse: Parse<E>, equal: Equal<E> | undefined): EventLogFile<E> {
  try {
    migrate(db, logSteps(DEFAULT_TABLE), { name: "log" });
    const log = attach(db, DEFAULT_TABLE, parseFunction(parse), equal, "refuse");
    return {
      ...log,
      close() {
        db.close();
      },
      checkpoint(mode?: CheckpointMode) {
        return checkpoint(db, mode);
      },
      setAutocheckpoint(pages: number) {
        setAutocheckpoint(db, pages);
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
