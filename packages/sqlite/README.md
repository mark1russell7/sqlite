# @mark1russell7/sqlite

Databases on one computer through `node:sqlite`. The package has the connection with its pragmas, the migrations by `user_version`, the write transaction and a typed append-only event log. It has no dependencies.

```sh
npm install @mark1russell7/sqlite
```

The package needs Node.js 22.16 or later.

## The connection

`openDatabase` opens a `DatabaseSync` and sets its pragmas. It sets the busy timeout first, because the change to WAL needs the lock of the file.

```ts
import { openDatabase } from "@mark1russell7/sqlite";

const db = openDatabase("data/app.db", { synchronous: "NORMAL", busyTimeoutMs: 5000, makeFolder: true });
```

| Option | Default | What it sets |
| --- | --- | --- |
| `wal` | `true` | The write-ahead log. Then readers do not stop a writer. |
| `synchronous` | `FULL` | The pragma `synchronous`. With WAL, `NORMAL` can lose the last commits at a power cut. The file stays good. |
| `busyTimeoutMs` | `0` | The time that a statement waits for the lock of a different connection. With `0`, the statement fails at once. |
| `makeFolder` | `false` | The function makes the folder of the file. `folderMode` sets the mode of the new folders. |

Each default other than `wal` is the default of SQLite.

## Migrations

`migrate` does the steps that a file does not have. The `user_version` of the file is the count of steps that it has. A step is SQL text or a function.

```ts
import { migrate, type Migration } from "@mark1russell7/sqlite";

const steps: Migration[] = [
  "CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT",
  (db) => db.exec("CREATE INDEX notes_text ON notes (text)"),
];
migrate(db, steps); // { from: 0, to: 2 }
```

- Each step is one transaction with its new `user_version`. A step that fails rolls back alone.
- The function reads the version again in each transaction, so two processes can migrate one file at the same time.
- A file with more steps than the list is from a newer version of the app, and the function throws.
- Do not change a step that a file can have. Add a new step.

## Transactions

`transaction` does the work in one `BEGIN IMMEDIATE` transaction and gives the result of the work. The write lock comes at the start, so a different writer cannot cause a failure in the middle of the work.

```ts
import { transaction } from "@mark1russell7/sqlite";

const added = transaction(db, () => {
  db.prepare("INSERT INTO notes VALUES (?, ?)").run("n1", "first");
  return 1;
});
```

- When the work or the commit throws, the function rolls back and throws the same error.
- The work is synchronous. A work that gives a promise is an error.
- A call in a transaction throws, because SQLite refuses a nested `BEGIN`.
- `onRollbackError` gets the error of a rollback that did not end.

## The event log

`openEventLog` opens a typed append-only log of events in one file. The caller keeps a state, and `accept` changes it before the write. Thus the state and the file stay equal.

```ts
import { openEventLog, type LogRecord } from "@mark1russell7/sqlite";

interface Added extends LogRecord {
  readonly type: "added";
  readonly name: string;
}

const names = new Set<string>();
const accept = (event: Added): string | undefined => {
  if (names.has(event.name)) return "duplicate";
  names.add(event.name);
  return undefined;
};

const log = openEventLog("data/events.db", (value) => value as Added);
for (const event of log.read()) accept(event);
log.append({ id: "e1", at: new Date().toISOString(), type: "added", name: "a" }, accept);
```

- `append` and `appendAll` give the problems of the refused events. A refused event is not written.
- A failed write or `accept` rolls back and breaks the log. Each later call throws until `recover`. Then the caller replays the log.
- `recover` throws when the rollback did not end. Then open the log again.
- The log owns the `user_version` of its file. `EVENT_LOG_SCHEMA_VERSION` is the version that it writes.
- The third argument has the options of `openDatabase`.

## The experimental warning

Node.js 22 writes "SQLite is an experimental feature" to the standard error at the first load of `node:sqlite`. The entry `@mark1russell7/sqlite/warning` removes only that warning. The entry does not import `node:sqlite`.

```ts
import { quietSqliteWarning } from "@mark1russell7/sqlite/warning";

quietSqliteWarning();
const { openDatabase } = await import("@mark1russell7/sqlite");
```

A static import of `node:sqlite` loads before the code of the module. Thus import the database code after the filter, with `import()`. The function gives a function that removes the filter.
