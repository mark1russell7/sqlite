# Changelog of @mark1russell7/sqlite

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
