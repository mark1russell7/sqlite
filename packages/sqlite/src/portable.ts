/**
 * This entry has the part of the package that operates on each connection with the type `SqlConnection`. The part is
 * the migrations, the projections, the transactions, the checkpoint, the clear, the event log and the snapshot of a
 * fold. This entry imports no module of Node.js. Thus it operates in a browser too, for example on sql.js or SQLite in
 * WebAssembly through an adapter of the package.
 *
 * @packageDocumentation
 */
export type { SqlChanges, SqlConnection, SqlStatement, SqlValue } from "./connection.ts";
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
export {
  readTransaction,
  syncedTransaction,
  transaction,
  type Nested,
  type ReadTransactionDatabase,
  type SyncedTransactionDatabase,
  type TransactionDatabase,
  type TransactionOptions,
} from "./transaction.ts";
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
export { FOLD_SNAPSHOT_PART, FOLD_SNAPSHOT_SCHEMA_VERSION, foldSnapshot, type FoldKey, type FoldMark, type FoldRow, type FoldSnapshot, type MarkLog } from "./fold-snapshot.ts";
export { SchemaError, type Parse, type StandardIssue, type StandardResult, type StandardSchema } from "./schema.ts";
export { wasmConnection, type WasmConnection, type WasmDatabase, type WasmModule, type WasmStatement } from "./wasm.ts";
export { checkpoint, type CheckpointDatabase, type CheckpointMode, type Checkpointed } from "./checkpoint.ts";
export { clearDatabase, type ClearOptions } from "./clear.ts";
export { sqlJsConnection, type SqlJsConnection, type SqlJsDatabase, type SqlJsStatement, type SqlJsValue } from "./sqljs.ts";
