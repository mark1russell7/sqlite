/**
 * The part of the package that operates on each connection with the type `SqlConnection`: the migrations, the projections,
 * the write transaction and the event log. This entry imports no module of Node.js. Thus it operates in a browser too,
 * for example on SQLite in WebAssembly through a small adapter.
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
export { SchemaError, type Parse, type StandardIssue, type StandardResult, type StandardSchema } from "./schema.ts";
export { wasmConnection, type WasmConnection, type WasmDatabase, type WasmModule, type WasmStatement } from "./wasm.ts";
