/**
 * Databases on one computer through `node:sqlite`: the connection with its pragmas, the migrations by schema version and
 * the write transaction. The package also has a typed append-only event log, the faults of SQLite and the recovery of a
 * broken file. The entry `@mark1russell7/sqlite/warning` has the filter of the experimental warning. The entry
 * `@mark1russell7/sqlite/portable` has the parts that operate on each connection with the type `SqlConnection`, also in a
 * browser.
 *
 * @packageDocumentation
 */
export type { SqlChanges, SqlConnection, SqlStatement, SqlValue } from "./connection.ts";
export { openDatabase, type OpenOptions, type Synchronous } from "./database.ts";
export {
  addMissingColumns,
  migrate,
  SCHEMA_VERSIONS_TABLE,
  schemaVersion,
  tableColumns,
  userVersion,
  type ColumnDefinitions,
  type MigrateOptions,
  type Migrated,
  type Migration,
  type Newer,
} from "./migrate.ts";
export { ensureProjection, type Projected, type ProjectionOptions } from "./projection.ts";
export { transaction, type Nested, type TransactionDatabase, type TransactionOptions } from "./transaction.ts";
export {
  BrokenLogError,
  EVENT_LOG_SCHEMA_VERSION,
  eventLog,
  type Accept,
  type Appended,
  type Equal,
  type EventLog,
  type EventLogOptions,
  type LogEntry,
  type LogRecord,
  type ReadOptions,
} from "./event-log.ts";
export { openEventLog, type EventLogFile, type EventLogFileOptions } from "./event-log-file.ts";
export {
  checkIntegrity,
  IntegrityError,
  openOrQuarantine,
  quarantine,
  salvageEventLog,
  snapshot,
  type Integrity,
  type IntegrityOptions,
  type Quarantined,
  type QuarantineOptions,
  type Recovered,
  type SalvageOptions,
  type Salvaged,
  type Snapshot,
} from "./recovery.ts";
export { SQLITE_FAULT_ACTIONS, sqliteFault, type SqliteFault, type SqliteFaultAction, type SqliteFaultKind } from "./faults.ts";
