# Changelog of @mark1russell7/sqlite

## 0.7.0

This version adds the control of the automatic checkpoint. A burst of large commits, for example the first pass of a start, can stop the automatic checkpoint and do one checkpoint at its end.

- The new option `autocheckpointPages` of `openDatabase`, `openEventLog` and `openCheckedEventLog` sets the pragma `wal_autocheckpoint`. The default keeps the default of SQLite, 1000 pages. The value 0 turns the automatic checkpoint off.
- `setAutocheckpoint` changes the pragma on an open connection, also in the portable entry.
- A log file has two new members: `checkpoint(mode)` and `setAutocheckpoint(pages)`. The log owns its connection, thus these members are the only access to the checkpoint of its file.
- With `synchronous` `FULL`, each commit syncs the WAL file. Thus the setting does not change what a crash keeps.
- `EventLogFile` has new members. Code that makes its own object of the interface type also makes them. Thus the version is a MINOR change before 1.0.0.

Runtime dependencies: none.

## 0.6.0

This version keeps the tables of the snapshot at version 1, the version of 0.4. A start after an update from 0.4 reads its snapshot. A start after a return to 0.4 reads the snapshot of this version.

- In 0.5.0, the tables had version 2. Thus the first open after an update from 0.4 removed the snapshot, and the next start folded the whole log. A return to 0.4 removed the snapshot again.
- `writeInChunks` puts its rows in a second table, `fold_snapshot_next`. One short transaction renames the two tables and changes the meta row. Then the write removes the old rows in chunks.
- The table of the rows has only the rows of the snapshot, also after a stopped write. Thus the read of 0.4 gives one whole snapshot at each moment.
- The open makes the second table when a file of 0.4 does not have it. A file of 0.5.0 opens with no snapshot, and the app writes it again.
- `writeInChunks` does a `PASSIVE` checkpoint after each transaction, before the pause. The new option `checkpoint` (default true) turns it off. On a disk of 5.5 MB/s, the automatic checkpoint in one commit of a chunk stopped the event loop for 1.8 s. Each checkpoint of one chunk copies the pages of that chunk only.
- The value of `FOLD_SNAPSHOT_SCHEMA_VERSION` changes from 2 to 1, and a file of 0.5.0 loses its snapshot. Thus the version is a MINOR change before 1.0.0.

Runtime dependencies: none.

## 0.5.0

This version adds `writeInChunks` to `FoldSnapshot`. It replaces a large snapshot in many short transactions, with a pause between two of them. Thus the write does not stop the event loop for the time of the whole write.

- The new rows go next to the rows of the old snapshot. One short transaction changes the meta row to them. Then the write removes the old rows in chunks.
- A read in the write gives the old snapshot. When the rows throw or a transaction fails, the old snapshot stays. The next write removes the orphan rows.
- A `clear` before the change of the meta row stops the write. A second write in the write is an error.
- The tables of the snapshot have version 2: the meta row keeps the position of the first row. A file of version 1 opens with no snapshot, and the app writes it again.
- `FoldSnapshot` has a new member. Code that makes its own object of the interface type also makes `writeInChunks`. Thus the version is a MINOR change before 1.0.0.

Runtime dependencies: none.

## 0.4.1

This version adds the snapshot of a fold. An app that folds its log at each start keeps its state at one position of the log. The next start reads the snapshot, and it folds only the events after that position.

- `openFoldSnapshot` opens a snapshot in its own file. `foldSnapshot` gives a snapshot on a connection, also in the portable entry.
- `write` replaces the snapshot in one transaction, and it reads the rows one at a time. `read` gives the rows in one read transaction.
- `read` gives no snapshot for a different version or key, or when the log does not have the event of the mark at its position.
- The change adds exports only. Thus the version is a PATCH change before 1.0.0.

Runtime dependencies: none.

## 0.4.0

This version adds `counts()` to `EventLog`. It gives the count of events of each type, from the index of the types, with no read of the bodies.

- A caller that reads only some types of a large log can count the events of the other types, and parse none of them.
- `EventLog` has a new member. Code that makes its own object of the interface type also makes `counts`. Thus the version is a MINOR change before 1.0.0.

Runtime dependencies: none.

## 0.3.12

This version fixes the error that `readTransaction` and `syncedTransaction` throw after a failed work. The API is the same.

- Each function sets a pragma again at the end: `query_only` or `synchronous`. Before this version, an error of that restore hid the error of the work.
- After an error of the work, the work error stays the error of the function, and `onRollbackError` gets the error of the restore. For example, SQLite refuses a change of `synchronous` in a transaction that a failed rollback did not end.
- After a work with no error, an error of the restore is still the error of the function. The commit stays, and the connection keeps the setting of the work.

Runtime dependencies: none.

## 0.3.11

This version changes only doc comments. The code and the API are the same as in 0.3.10.

- Each field of `Integrity` (`ok`, `problems`) and of `Snapshot` (`path`, `bytes`) has a doc comment.
- A generator of procedures reads these comments. They become the descriptions of the output fields of the tools `sqlite.checkIntegrity` and `sqlite.snapshot`.

Runtime dependencies: none.

## 0.3.10

This version adds the synced transaction. The change is backward compatible.

- `syncedTransaction(db, work, options)` does the work in one `BEGIN IMMEDIATE` transaction whose commit is on the disk when the function ends.
- On a connection with `NORMAL`, it sets `synchronous` to `FULL` for its commit, and sets the earlier value again at the end. A connection with `FULL` or `EXTRA` does not change.
- A call in a transaction in progress throws. The rules of `transaction` apply to the rollback, the synchronous work and the dry run.
- The type `SyncedTransactionDatabase` is the part of a connection that the function uses.
- The power-cut test has two new cases. With `NORMAL`, the disk keeps each commit up to the last synced transaction.

Runtime dependencies: none.

## 0.3.9

This version changes only the README. The code and the API are the same as in 0.3.8.

- The README has the section "What a power cut keeps". It gives the commits that each journal and `synchronous` setting kept in a power-cut test on LazyFS.
- `FULL` and `EXTRA` kept each commit. With WAL, `NORMAL` kept the commits up to the last checkpoint. `OFF` kept no commit.
- The row `synchronous` of the options table links to the section.

Runtime dependencies: none.

## 0.3.8

This version corrects the read of `salvageEventLog` on Node.js 22.13. The change is backward compatible.

- On Node.js 22.13, a garbage collection during the read of the broken log can finalize the statement of the read.
- Then the salvage stops with the error `ERR_INVALID_STATE`, and `openCheckedEventLog` cannot recover the file.
- The salvage reads the broken log in pages of 500 rows with `all()`. It does not use `iterate()`.
- A test does a garbage collection after each 1000 events of a salvage of 50000 events. With the old read, it fails on Node.js 22.13.1.

Runtime dependencies: none.

## 0.3.7

This version adds the checked open of an event log. The change is backward compatible.

- `openCheckedEventLog(path, parse, options)` opens a log in its own file after an integrity check. The default check is `quick_check`.
- The result is a tagged union with the kinds `created`, `opened`, `recovered` and `orphan-journal`. Its type is `CheckedEventLog`.
- A broken file goes into quarantine, and a new file gets each readable event. The field `salvage` has the counts `kept` and `lost`.
- A WAL, SHM or journal file with no database file goes into quarantine. The function does not put that WAL into a new file.
- Each step of the recovery can be done again. The record `<path>.recovery.json` keeps the quarantine folder and the counts across a crash.
- A test stops the recovery after each step and opens the file again. The events and the quarantine are the same as after a recovery with no stop.
- `listRecoveries(path)` gives each recovery from the records in the quarantine folders, in the sequence of `at` and then of `id`.
- The `id` of an entry is the name of its quarantine folder. A caller can report each recovery at each start with this id, and a grow-only log keeps one report.
- A folder with no record, or with a record that does not parse, gives an entry of the kind `no-read`. A recovery that is not complete is not in the list.
- The types `CheckedEventLogOptions`, `RecoveryCause`, `RecoveryEntry` and `SalvageCounts` are new.

Runtime dependencies: none.

## 0.3.6

This version corrects the parameter type of `confineToFile`. The change is backward compatible.

- `confineToFile` takes a `DatabaseSync` of each version of `@types/node`. Before, TypeScript refused the `DatabaseSync` of `@types/node` 22 with the error TS2559. That type has no `setAuthorizer`, so it had no member in common with `ConfinableDatabase`.
- The parameter type is `DatabaseSync | ConfinableDatabase`. Each call that compiled before still compiles. The check at run time does not change.
- The typecheck of the package also examines the source and a type test with `@types/node` 22 (`tsconfig.node22.json`). The type test gives a `DatabaseSync` of that version to each public function that takes a connection.

Runtime dependencies: none.

## 0.3.5

This version adds a guard for the SQL text of a caller, and a function that gives each statement of a text. The change is backward compatible.

- `confineToFile(db)` keeps the SQL of a `node:sqlite` connection on its file. It refuses `ATTACH` of a file, `VACUUM INTO`, the pragmas `temp_store_directory` and `data_store_directory`, and the function `load_extension`.
- Each other statement runs as before. A plain `VACUUM` and `clearDatabase` also work.
- The guard does not limit the time or the size of the work of a caller. An `ATTACH ''` can fill the temporary folder until the close. The host sets these limits.
- The guard is the authorizer of SQLite, so it sees the statement after the parse. Comments, case and quotes do not change the result.
- The guard needs `setAuthorizer` of Node.js 24.10 or later. On an earlier Node.js, `confineToFile` throws the new `ConfineUnavailableError` (`code: "CONFINE_UNAVAILABLE"`). The package still runs on Node.js 22.13.
- The type `ConfinableDatabase` is the part of a connection that the guard uses.
- `eachStatement(db, sql)` gives each statement of a SQL text in order. The function `prepare` of `node:sqlite` compiles only the first statement, and it ignores the rest with no error.
- `eachStatement` compiles the next statement after the run of the statement before it. Thus a script can make a table and then write to it.
- The types `SourcedStatement` and `StatementSource` are the parts of a statement and a connection that `eachStatement` uses.

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
