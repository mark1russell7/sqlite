/**
 * Databases on one computer through `node:sqlite`: the connection with its pragmas, the migrations by schema version and
 * the write transaction. The package also has a typed append-only event log, the faults of SQLite and the recovery of a
 * broken file. The entry `@mark1russell7/sqlite/warning` has the filter of the experimental warning. The entry
 * `@mark1russell7/sqlite/portable` has the parts that operate on each connection with the type `SqlConnection`, also in a
 * browser.
 *
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import type { SqlConnection } from "./connection.ts";
import type { Migration as AnyMigration } from "./migrate.ts";
import type { ProjectionOptions as AnyProjectionOptions } from "./projection.ts";

export type { SqlChanges, SqlConnection, SqlStatement, SqlValue } from "./connection.ts";
export { openDatabase, type OpenOptions, type Synchronous, type WalMode } from "./database.ts";
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
  type Newer,
} from "./migrate.ts";
export { ensureProjection, type Projected } from "./projection.ts";
export { readTransaction, transaction, type Nested, type ReadTransactionDatabase, type TransactionDatabase, type TransactionOptions } from "./transaction.ts";
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
export { SchemaError, type Parse, type StandardIssue, type StandardResult, type StandardSchema } from "./schema.ts";
export { wasmConnection, type WasmConnection, type WasmDatabase, type WasmModule, type WasmStatement } from "./wasm.ts";
export { checkpoint, type CheckpointDatabase, type CheckpointMode, type Checkpointed } from "./checkpoint.ts";
export { clearDatabase, type ClearOptions } from "./clear.ts";
export { type ConfinableDatabase, ConfineUnavailableError, confineToFile } from "./confine.ts";
export { eachStatement, type SourcedStatement, type StatementSource } from "./statements.ts";
export { sqlJsConnection, type SqlJsConnection, type SqlJsDatabase, type SqlJsStatement, type SqlJsValue } from "./sqljs.ts";
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
export {
  listRecoveries,
  openCheckedEventLog,
  type CheckedEventLog,
  type CheckedEventLogOptions,
  type RecoveryCause,
  type RecoveryEntry,
  type SalvageCounts,
} from "./checked-log.ts";
export { SQLITE_FAULT_ACTIONS, sqliteFault, type SqliteFault, type SqliteFaultAction, type SqliteFaultKind } from "./faults.ts";

/**
 * One step of a schema: SQL statements, or a function that changes the database. `D` is the type of the connection. In
 * this entry, the default is `DatabaseSync`.
 */
export type Migration<D extends SqlConnection = DatabaseSync> = AnyMigration<D>;

/** The options of `ensureProjection`. `D` is the type of the connection. In this entry, the default is `DatabaseSync`. */
export type ProjectionOptions<D extends SqlConnection = DatabaseSync> = AnyProjectionOptions<D>;
