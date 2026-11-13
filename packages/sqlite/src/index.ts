/**
 * Databases on one computer through `node:sqlite`: the connection with its pragmas, the migrations by `user_version`,
 * the write transaction and a typed append-only event log. The entry `@mark1russell7/sqlite/warning` has the filter of
 * the experimental warning.
 *
 * @packageDocumentation
 */
export { openDatabase, type OpenOptions, type Synchronous } from "./database.ts";
export { migrate, userVersion, type MigrateOptions, type Migrated, type Migration } from "./migrate.ts";
export { transaction, type TransactionDatabase, type TransactionOptions } from "./transaction.ts";
export { EVENT_LOG_SCHEMA_VERSION, openEventLog, type Accept, type EventLog, type LogRecord } from "./event-log.ts";
