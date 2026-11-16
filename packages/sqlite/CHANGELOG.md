# Changelog of @mark1russell7/sqlite

## 0.3.5

This version adds a guard for the SQL text of a caller. The change is backward compatible.

- `confineToFile(db)` keeps the SQL of a `node:sqlite` connection on its file. It refuses `ATTACH` of a file, `VACUUM INTO`, the pragmas `temp_store_directory` and `data_store_directory`, and the function `load_extension`.
- Each other statement runs as before. A plain `VACUUM` and `clearDatabase` also work.
- The guard is the authorizer of SQLite, so it sees the statement after the parse. Comments, case and quotes do not change the result.
- The guard needs `setAuthorizer` of Node.js 24.10 or later. On an earlier Node.js, `confineToFile` throws the new `ConfineUnavailableError` (`code: "CONFINE_UNAVAILABLE"`). The package still runs on Node.js 22.13.
- The type `ConfinableDatabase` is the part of a connection that the guard uses.

Runtime dependencies: none.

## 0.3.4

This version runs on Node.js 22.13 or later, and the adapter of sql.js operates after a save. The change is backward compatible.

- The `engines` field asks for Node.js 22.13, not 22.16. CI runs the tests on Node.js 22.13 in a second job.
- `transaction`, `readTransaction`, `checkpoint`, `clearDatabase` and `eventLog` read the transaction state through one function. A connection with no `isTransaction` gets the probe. Before, a connection from `new DatabaseSync()` on Node.js 22.13 to 22.15 had no state, so a failed work stayed in its transaction.
- `eventLog` and `salvageEventLog` keep a reference to the statement of a read. Before, Node.js 22.13 finalized that statement during some reads ("statement has been finalized").
- `sqlJsConnection` compiles a statement for each call and frees it after the call. Before, it kept one statement for each SQL text, and an `export()` of sql.js frees each statement. So each call after the first save threw "Statement closed". The type `SqlJsStatement` has no `reset`, because the adapter does not use it. A `Statement` of sql.js still matches the type.
- The tests do not use `isOpen` or FTS5, because Node.js 22.13 has neither.

Runtime dependencies: none.

## 0.3.3

This version adds the parts that the SQLite stores of other packages keep as local copies. The change is backward compatible.

- `openDatabase` takes `readOnly`: the connection reads an existing file and does not change it. The option `wal` also takes `"when-writable"`: a file that the process cannot write keeps its journal mode. The type `WalMode` is new.
- `transaction` takes `commit: false`: a dry run. The function rolls back after the work and gives the result of the work. This also applies to a savepoint.
- `checkpoint` runs `PRAGMA wal_checkpoint` and gives its counts. The types `CheckpointMode`, `Checkpointed` and `CheckpointDatabase` are new.
- `clearDatabase` drops each view and each table, and sets `user_version` to 0, for a cache that makes its tables again. The type `ClearOptions` is new.
- `sqlJsConnection` gives a `SqlConnection` over a database of sql.js. The types `SqlJsDatabase`, `SqlJsStatement`, `SqlJsValue` and `SqlJsConnection` are structural, so the package has no new dependency.
- Both entries export the new functions and types. `WalMode` is only in the main entry.
- `openDatabase` and `salvageEventLog` use the class `Database` of `node:sqlite` when it is there. Node.js 26.11 renamed `DatabaseSync` to `Database`, and the old name gives a deprecation warning (DEP0210).
- A Node.js before 22.16 has no `isTransaction`. Then `openDatabase` adds it to the connection as a probe: a `BEGIN`, which SQLite refuses in a transaction. `sqlJsConnection` uses the same probe. The `engines` field does not change.
- One suite of tests runs the portable entry on `node:sqlite`, SQLite in WebAssembly and sql.js.

Runtime dependencies: none.

## 0.3.2

This version adds the read transaction. The change is backward compatible.

- `readTransaction` does a work on one snapshot of the file. It does not take the write lock, so a writer on a different connection does not wait.
- The work cannot write: `PRAGMA query_only` is on during the work. The function sets the earlier value again at the end.
- The commit, the rollback, the synchronous work and the option `nested` are the same as in `transaction`.
- The type `ReadTransactionDatabase` is new. Both entries export the function and the type.

Runtime dependencies: none.

## 0.3.1

This version lets a log take a validator of the Standard Schema as its parse. The change is backward compatible.

- The `parse` of `eventLog`, `openEventLog` and `salvageEventLog` is a function or a validator of the Standard Schema, for example a schema of zod 4. The log gets the output type of the schema.
- When the schema refuses a stored value, the read throws, and its `cause` is the new `SchemaError` with each problem. A schema that validates asynchronously gives an error.
- The types `Parse`, `StandardSchema`, `StandardResult` and `StandardIssue` are new. They copy the part of the specification that the log uses, so the package does not depend on a validator.

Runtime dependencies: none.

## 0.3.0

This version adds the adapter of SQLite in WebAssembly, and removes `node:sqlite` from the types of the entry `/portable`. The change of a default type breaks the entry `/portable`. The main entry does not change.

- `wasmConnection` gives a `SqlConnection` over a database of `@sqlite.org/sqlite-wasm`. The types `WasmModule`, `WasmDatabase`, `WasmStatement` and `WasmConnection` are structural, so the package has no new dependency.
- In the entry `/portable`, the default type of `Migration` and `ProjectionOptions` is `SqlConnection`, not `DatabaseSync`. Thus a browser app needs no `@types/node`. Give the type of the connection, for example `Migration<WasmConnection>`, when a step uses more members.
- In the main entry, the default stays `DatabaseSync`.
- The test of the entry `/portable` also follows each `import type`. A new test runs each part of the entry on the real driver of SQLite in WebAssembly.

Runtime dependencies: none.

## 0.2.6

This version adds the entry `@mark1russell7/sqlite/portable`. The change is backward compatible.

- The new entry has the migrations, the projections, the write transaction and the event log. It imports no module of Node.js, so it operates in a browser too.
- The types `SqlConnection`, `SqlStatement`, `SqlValue` and `SqlChanges` are new. They are the part of a connection that the package uses.
- `migrate`, `schemaVersion`, `userVersion`, `tableColumns`, `addMissingColumns`, `ensureProjection`, `eventLog` and `transaction` take a `SqlConnection`. `DatabaseSync` has its members, so each earlier call stays correct.
- `Migration` and `ProjectionOptions` take the type of the connection as a parameter. The default is `DatabaseSync`.
- A test follows the imports of the new entry, and fails when its JavaScript gets to a module out of the package.

Runtime dependencies: none.

## 0.2.5

This version lets an older app work on a newer file. The change is backward compatible.

- The option `newer` of `migrate` tells what a file or a part of a newer schema version does. The default `throw` keeps the old behavior.
- With `newer: "keep"`, `migrate` does no step on a newer file and gives `{ from, to: from }`. Two versions of an app can share one file when each step only adds tables or columns.
- The type `Newer` is new.

Runtime dependencies: none.

## 0.2.4

This version adds projections. The change is backward compatible.

- `ensureProjection` makes the schema of a projection, for example an index or a cache. A file of a different version opens empty, and the app fills it again.
- Without a part, the projection owns the whole file. With a part, a rebuild removes only the tables of the part.
- The option `check` tells if a file of the correct version has the projection.
- With `foreign_keys` on, a rebuild sets `defer_foreign_keys`, and the checks of the foreign keys wait for the commit. Thus the order of the tables is free.
- The types `Projected` and `ProjectionOptions` are new.

Runtime dependencies: none.

## 0.2.3

This version adds the adoption of the file of an older app. The change is backward compatible.

- `addMissingColumns` adds each column that a table does not have, and gives the names of the added columns.
- `tableColumns` gives the columns of a table in their order.
- The type `ColumnDefinitions` is new.
- The README has a recipe: a first step with `CREATE TABLE IF NOT EXISTS` and `addMissingColumns` adopts a file at `user_version` 0.

Runtime dependencies: none.

## 0.2.2

This version adds savepoints. The change is backward compatible.

- `transaction` has the option `nested`. With `savepoint`, a call in a transaction is a savepoint of that transaction. An error rolls back only the writes of the work. The default `refuse` keeps the old behavior.
- `eventLog` has the option `nested`. With `savepoint`, the app writes its tables and the events of the log in one transaction.
- The type `Nested` is new.

Runtime dependencies: none.

## 0.2.1

This version adds the recovery of a broken file. The change is backward compatible.

- `checkIntegrity` does the integrity check of SQLite and gives the problems. `IntegrityError` has the kind `corrupt` for `sqliteFault`.
- `quarantine` moves a file and its WAL, SHM and journal files into a new folder.
- `openOrQuarantine` opens a file, and moves a broken file into quarantine before a second open.
- `salvageEventLog` reads the readable events of a broken log into a new log, and counts the lost positions.
- `snapshot` writes a consistent copy of an open database with `VACUUM INTO`.

Runtime dependencies: none.

## 0.2.0

This version makes the event log a grow-only set, for the merge of copies of one log. The change of the results of `append` and `appendAll` breaks old callers.

- `append` gives one result: `added`, `duplicate`, `conflict` or `refused`. `appendAll` gives one result for each event. Before, they gave only the problems.
- An event with an id that the log has does not throw and does not break the log. An equal event is a duplicate, and a different event is a conflict.
- The argument `accept` is optional. It gets only an event with a new id.
- The new option `equal` sets the equality of two events. The default compares the JSON text.
- `entries`, `get` and `head` are new, and `read` has the options `after`, `types` and `limit`.
- `eventLog` opens a log in a table of a connection of the caller. Its version is in the part `event-log:<table>`.
- A broken log throws a `BrokenLogError`. Its field `stuck` tells if the rollback did not end.
- `EVENT_LOG_SCHEMA_VERSION` is 2: the second step adds an index on the type. A file of 0.1.0 gets the step at the next open.
- `migrate` has the option `part`: each part of a file has its own version in the table `schema_versions`. `schemaVersion` reads it.
- `sqliteFault` gives the kind of an error of SQLite and the action that it needs: `retry`, `quarantine`, `operator` or `bug`.

Runtime dependencies: none.

## 0.1.0

The first version. The code of the event log comes from the app pairrank (`packages/store/src/log.ts`).

- `openDatabase` opens a connection with WAL, the pragma `synchronous` and a busy timeout.
- `migrate` and `userVersion` do the steps of a schema by `user_version`.
- `transaction` does a work in one `BEGIN IMMEDIATE` transaction.
- `openEventLog` opens a typed append-only event log, with `recover` after a failed write.
- The entry `./warning` removes the experimental warning of `node:sqlite`.

Runtime dependencies: none.
