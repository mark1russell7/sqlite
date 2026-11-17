# The moves to this package

This page lists the public code that opens SQLite outside this package. Each row has a decision: move, keep or not SQLite. The item SQ-24 of the [roadmap](ROADMAP.md) owns this page.

## The method

- The catalog of codeatlas (the run of 2026-11-15) lists each import of a SQLite driver in each public repository. The catalog does not have the forks.
- The drivers are `node:sqlite`, `sql.js`, `better-sqlite3`, `sqlite3`, libSQL and the WebAssembly builds of SQLite. No public code imports `better-sqlite3` or `sqlite3`.
- A search of each repository with a hit finds the direct opens, the pragmas, the migrations and the waits for a lock.

## The rows

| Row | Code | What it does | Decision |
| --- | --- | --- | --- |
| M1 | `@procedures/sqlite` (client): `sqlite.query`, `sqlite.execute`, `sqlite.tables`, `sqlite.schema`, `sqlite.transaction`, `logs.store` and `logs.query` | Each call reads the whole file into `sql.js` through `@mark1russell7/docker-sqlite`. A call that writes then writes the whole file back. | Move. The procedures open the file through the engines of the package, as its storage does since SQ-21. The engine keeps the journal mode of each file. |
| M2 | `@procedures/sqlite` (client): `sqlite.backup` | It copies the whole file through `sql.js`, runs `VACUUM` and `PRAGMA integrity_check` on the copy, and renames the copy. | Move. `snapshot` and `checkIntegrity` of this package do these steps on one connection, and the copy also has the rows of the WAL file. |
| M3 | `@procedures/sqlite` (client): `sqlite.migrate` | It applies a folder of numbered SQL files. It records each file with its checksum in the table `schema_migrations`. | Keep the record table. It is the contract of the procedure with the files of its users. The connection moves with M1. |
| M4 | `@mark1russell7/docker-sqlite`: `migrate`, `query` and the entry `/pure` | It has its own migrations with the table `_migrations`, savepoints and a tokenizer of SQL, and query functions over `sql.js`. | Move. `migrate` and `sqlJsConnection` of the entry `/portable` do this work. After M1, only the demo of its site uses these functions. |
| M5 | `@mark1russell7/docker-sqlite`: `createConnection` and `withConnection` | It saves the whole file of `sql.js` with a temporary file, a flush and a rename. It has a queue for each file. | Keep at this time. It is the store of the engine `sql.js` of `@procedures/sqlite` 0.60 and earlier, on Node.js 22.0 to 22.12. Since 0.3.2, it refuses a file in WAL mode that has a `-wal` or `-shm` file. |
| M6 | `@procedures/ios-backup` (client) | It opens `Manifest.db` and the message database of an iOS backup with `new DatabaseSync` and `readOnly`. | Move. `openDatabase` with `readOnly` takes the class `Database` of Node.js 26.11 first, so it gives no warning DEP0210. |
| M7 | A desktop app: the copy of its old log | It writes a copy of its log with `VACUUM INTO` on a connection of `new DatabaseSync` with `readOnly`. | Move. `snapshot` of this package uses the same `VACUUM INTO`, flushes the copy and renames it. It gives no warning DEP0210. |
| K1 | `alerts`, `codeatlas`, `polite-crawler`, `headroom` and the store of the desktop app | They import `DatabaseSync` or `StatementSync` only as a type. They open, migrate and write through this package. | Done. They use this package. |
| K2 | `@procedures/sqlite` (client): its engines | Since 0.61.0, it has only the engine `node`. This engine opens a file with `openDatabase` of this package. Before 0.61.0, it loaded `sql.js` when `node:sqlite` was not available. | Keep. SQ-21 keeps the choice of the engine in the package. |
| K3 | The tests of the packages above | A test opens a file with `new DatabaseSync` and reads what the code under test wrote. | Keep. A test reads the file outside the code that it tests. |
| N1 | The client monorepo: 20 doc comments | The word `synchronous` in these comments is about code that does not wait. | Not SQLite. |

## The state of each move

This section gives the state on 2026-11-16.

| Row | State | Pull request |
| --- | --- | --- |
| M1 | Done. `@procedures/sqlite` 0.61.0 is on npm since 2026-11-16. Its procedures open each file with `openDatabase` of this package. It removes the engine `sql.js` and needs Node.js 22.13 or later. | [client #637](https://github.com/mark1russell7/client/pull/637) |
| M2 | Done, in the pull request of M1. `sqlite.backup` writes the copy with `snapshot` and examines it with `checkIntegrity`. | [client #637](https://github.com/mark1russell7/client/pull/637) |
| M3 | Kept. Its connection moved with M1 in 0.61.0. | [client #637](https://github.com/mark1russell7/client/pull/637) |
| M4 | Done. docker-sqlite 0.3.3 is on npm since 2026-11-16. Each function has a `@deprecated` tag with its replacement, and the README has a table. It gives no warning at run time. M1 is done, so the owner decides on the archive of the repository. | [docker-sqlite #72](https://github.com/mark1russell7/docker-sqlite/pull/72) |
| M5 | Done. docker-sqlite 0.3.2 refuses a file in WAL mode that has a `-wal` or `-shm` file. It is on npm since 2026-11-16. `@procedures/sqlite` 0.61.0 does not use docker-sqlite. | [docker-sqlite #71](https://github.com/mark1russell7/docker-sqlite/pull/71) |
| M6 | Done. `@procedures/ios-backup` 0.60.1 is on npm since 2026-11-16. It opens each file with `openDatabase` and `readOnly`. | [client #632](https://github.com/mark1russell7/client/pull/632) |
| M7 | Done on 2026-11-15. The desktop app copies its old log with `snapshot`. | In the repository of the app |

## The fault of a whole-file save next to a WAL file

On 2026-11-15, a test of `@mark1russell7/docker-sqlite` 0.3.1 examined a file in WAL mode. A different connection of `node:sqlite` held the file open.

1. The writer put one row in the main file and one row only in the WAL file.
2. A read of `withConnection` gave only the row of the main file.
3. A write of `withConnection` added a row and saved the whole file with no error.
4. The writer and a new connection did not see the row of step 3. `PRAGMA integrity_check` gave `ok`.

Thus `sqlite.query` of `@procedures/sqlite` 0.60 and earlier reads old data from such a file, and `sqlite.execute` loses its write with no error. M1 removes the fault: 0.61.0 opens each file with `node:sqlite`, which reads the WAL file. Since docker-sqlite 0.3.2 (M5), `withConnection` and `createConnection` refuse such a file.
