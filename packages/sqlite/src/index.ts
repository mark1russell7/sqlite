/**
 * Databases on one computer through `node:sqlite`: the connection with its pragmas, the migrations by schema version and
 * the write transaction. The package also has a typed append-only event log and the faults of SQLite. The entry
 * `@mark1russell7/sqlite/warning` has the filter of the experimental warning.
 *
 * @packageDocumentation
 */
export { openDatabase, type OpenOptions, type Synchronous } from "./database.ts";
export { migrate, SCHEMA_VERSIONS_TABLE, schemaVersion, userVersion, type MigrateOptions, type Migrated, type Migration } from "./migrate.ts";
export { transaction, type TransactionDatabase, type TransactionOptions } from "./transaction.ts";
export {
  BrokenLogError,
  EVENT_LOG_SCHEMA_VERSION,
  eventLog,
  openEventLog,
  type Accept,
  type Appended,
  type Equal,
  type EventLog,
  type EventLogFile,
  type EventLogFileOptions,
  type EventLogOptions,
  type LogEntry,
  type LogRecord,
  type ReadOptions,
} from "./event-log.ts";
export { SQLITE_FAULT_ACTIONS, sqliteFault, type SqliteFault, type SqliteFaultAction, type SqliteFaultKind } from "./faults.ts";
