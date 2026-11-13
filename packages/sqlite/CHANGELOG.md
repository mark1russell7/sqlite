# Changelog of @mark1russell7/sqlite

## 0.1.0

The first version. The code of the event log comes from the app pairrank (`packages/store/src/log.ts`).

- `openDatabase` opens a connection with WAL, the pragma `synchronous` and a busy timeout.
- `migrate` and `userVersion` do the steps of a schema by `user_version`.
- `transaction` does a work in one `BEGIN IMMEDIATE` transaction.
- `openEventLog` opens a typed append-only event log, with `recover` after a failed write.
- The entry `./warning` removes the experimental warning of `node:sqlite`.

Runtime dependencies: none.
