# Changelog of @mark1russell7/sqlite

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
