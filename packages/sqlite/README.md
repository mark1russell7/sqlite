# @mark1russell7/sqlite

Databases on one computer through `node:sqlite`. The package has the connection with its pragmas, the migrations by schema version and the write transaction. It also has a typed append-only event log, the faults of SQLite and the recovery of a broken file. It has no dependencies.

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

### A version for each part of a file

A library and the app can keep their tables in one file. Each part then has its own list of steps and its own version. The option `part` names the part.

```ts
import { migrate, schemaVersion } from "@mark1russell7/sqlite";

migrate(db, appSteps, { part: "app" });
schemaVersion(db, "app"); // the count of steps of the part app
```

- The versions of the parts are in the table `schema_versions`. The `user_version` of the file does not change.
- A migration without `part` uses the `user_version`, as before.
- The option `name` sets the name of the database in the error of a newer file.

### Adopt the file of an older app

An older version of an app can have made its tables without migrations. Its file has tables and the `user_version` 0. The first step of the schema then adopts each such file. It makes the tables that are not there, and adds the columns that an older version did not have:

```ts
import { addMissingColumns, migrate, type Migration } from "@mark1russell7/sqlite";

const steps: Migration[] = [
  (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, state TEXT NOT NULL, peak_mb REAL, usage TEXT)");
    addMissingColumns(db, "leases", { peak_mb: "REAL", usage: "TEXT" });
  },
  "ALTER TABLE leases ADD COLUMN exit_code INTEGER",
];
migrate(db, steps); // a new file and an old file get the same columns
```

- `addMissingColumns` gives the names of the columns that it added. The comparison of names ignores case.
- `tableColumns` gives the columns of a table in their order, and an empty list when the table is not there.
- A column definition is SQL of the app. `ALTER TABLE` sets its rules. A `NOT NULL` column needs a default when the table has rows.
- After the first step, each change of the schema is a new step.

### Projections

A projection is a file or a part of a file that the app can make again from a different source. An index and a cache are projections. A projection does not migrate. A file of a different version opens empty, and the app fills it again:

```ts
import { ensureProjection } from "@mark1russell7/sqlite";

const { rebuilt } = ensureProjection(db, "CREATE TABLE pages (url TEXT PRIMARY KEY, text TEXT NOT NULL)", { version: 3 });
if (rebuilt) reindex(db);
```

- A file of a newer version opens empty too. Thus two versions of an app on one file rebuild the projection in turn.
- Without a part, the projection owns the whole file and its `user_version`. A rebuild removes each view and each table of the file.
- With `part` and `tables`, a rebuild removes only those tables. The version of the part is in the table `schema_versions`.
- The option `check` tells if a file of the correct version has the projection. When it gives false, the projection opens empty.
- The work is one transaction. In a transaction in progress, the work is a savepoint of that transaction.
- With `foreign_keys` on, the checks of the foreign keys wait for the end of the transaction. Thus the order of `tables` is free.
- A row out of the projection that refers to a row of the projection stops the commit, because a rebuild removes that row.

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
- With `nested: "savepoint"`, a call in a transaction is a savepoint of that transaction. Out of a transaction, the call is a plain transaction.
- `onRollbackError` gets the error of a rollback that did not end.

A savepoint lets a store join the transaction of its caller. An error of the work rolls back only the writes of the work, and the transaction of the caller continues:

```ts
transaction(db, () => {
  db.prepare("INSERT INTO notes VALUES (?, ?)").run("n2", "second");
  try {
    transaction(db, () => importNotes(db), { nested: "savepoint" });
  } catch (error) {
    report(error); // the import rolled back, and the note n2 stays
  }
});
```

## The event log

The event log is a typed append-only list of events, and a grow-only set: an event that the log has already changes nothing. Thus two copies that exchange their events get the same set, in each order of arrival.

```ts
import { openEventLog, type LogRecord } from "@mark1russell7/sqlite";

interface Added extends LogRecord {
  readonly type: "added";
  readonly name: string;
}

const names = new Set<string>();
const accept = (event: Added): string | undefined => {
  if (names.has(event.name)) return "the name is in use";
  names.add(event.name);
  return undefined;
};

const log = openEventLog("data/events.db", (value) => value as Added);
for (const event of log.read()) accept(event);
log.append({ id: "e1", at: new Date().toISOString(), type: "added", name: "a" }, accept); // { kind: "added", seq: 1 }
log.append({ id: "e1", at: "2026-11-14T00:00:00Z", type: "added", name: "b" }); // { kind: "conflict", seq: 1, stored: ... }
```

`append` gives one result, and `appendAll` gives one result for each event, in one transaction:

| Result | When | What changes |
| --- | --- | --- |
| `added` | The log does not have the id, and `accept` accepts the event. | The log writes the event at the position `seq`. |
| `duplicate` | The log has an equal event with the same id. | Nothing. `accept` does not get the event. |
| `conflict` | The log has a different event with the same id. | Nothing. The result has the stored event. |
| `refused` | `accept` gives a problem. | Nothing. The result has the problem. |

- The default equality compares the JSON text of the two events. The option `equal` sets a different equality.
- Give each event an id from its content, for example a hash. Then a second report of the same fact is a duplicate.
- `accept` is optional. It gets only an event with a new id, before the write. Then the state of the caller and the file stay equal.

### Reads

- `read()` gives the events in the order of the log. `entries()` gives each event with its position `seq`.
- The option `after` gives only the events after a position. `types` gives only the events of some types. `limit` sets the highest count.
- `head()` gives the position of the last event. A read with `after: head` later gives only the new events.
- `get(id)` gives the event with an id and its position.

### A log in the file of the app

`eventLog` opens a log in a table of a connection of the caller. The app keeps its own tables in the same file, and one file can have many logs.

```ts
import { eventLog, migrate, openDatabase } from "@mark1russell7/sqlite";

const db = openDatabase("data/app.db", { busyTimeoutMs: 5000 });
migrate(db, appSteps, { part: "app" });
const reports = eventLog(db, { parse: parseReport, table: "reports" });
```

- The log keeps its version in the part `event-log:<table>`. `EVENT_LOG_SCHEMA_VERSION` is the version that it writes.
- The log does not close the connection. A call of the log in a transaction of the caller throws.
- With `nested: "savepoint"`, a call of the log joins the transaction of the caller. Then the app writes its tables and the events in one transaction. When that transaction rolls back, the events roll back too.
- `openEventLog` opens a log in its own file, with the table `events`. That log owns the `user_version` of its file.

### A failed write

- A failed write or `accept` rolls back and breaks the log. Each later call throws a `BrokenLogError` until `recover`.
- After `recover`, the caller replays the log, because its state can have the events of the failed write.
- `recover` throws when the rollback did not end. Then the error has `stuck: true`. Open the log again.
- A lock that is not free at the start does not break the log. The call throws, and nothing changes.

## The faults of SQLite

`sqliteFault` gives the kind of an error of SQLite and the action that it needs. The function reads the result code, not the text of the message.

```ts
import { sqliteFault } from "@mark1russell7/sqlite";

try {
  log.append(event);
} catch (error) {
  const fault = sqliteFault(error);
  if (fault?.action === "retry") schedule(event);
  else throw error;
}
```

| Action | Kinds | What to do |
| --- | --- | --- |
| `retry` | `busy`, `locked`, `aborted`, `interrupted`, `protocol`, `schema` | Do the work again later. |
| `quarantine` | `corrupt`, `not-a-database` | Move the file away. Make the data again from its source or from a copy. |
| `operator` | `full`, `io`, `read-only`, `cannot-open`, `permission`, `no-memory`, `no-lfs`, `other` | Tell a person: the computer needs more disk space, an access, a path or memory. |
| `bug` | `sql`, `constraint`, `mismatch`, `misuse`, `range`, `too-big`, `not-found`, `internal`, `authorization` | Correct the program. The same work fails again. |

- The function reads the error and then its chain of causes. Thus it finds the fault in a `BrokenLogError`.
- It gives `undefined` for an error that is not of SQLite.
- `SQLITE_FAULT_ACTIONS` is the table of the action of each kind.

## The recovery of a broken file

A power cut, a bad disk or a copy of an open file can break a file. These functions find a broken file, move it away and keep its data.

| Function | What it does |
| --- | --- |
| `checkIntegrity(db, { quick, limit })` | It does `PRAGMA integrity_check` or `quick_check`, and gives `{ ok, problems }`. A file that is not a database gives a problem, not an error. |
| `quarantine(path)` | It moves the file and its WAL, SHM and journal files into a new folder `<name>.broken-<time>`. |
| `openOrQuarantine(path, open)` | It opens the file. When the file is broken, it moves the file into quarantine and opens an empty file. |
| `salvageEventLog(source, log, { parse })` | It reads the readable events of a broken log, and appends them to a new log. |
| `snapshot(db, path)` | It writes a consistent copy of an open database with `VACUUM INTO`, and then replaces the file at the path. |

```ts
import { checkIntegrity, eventLog, IntegrityError, openDatabase, openOrQuarantine, salvageEventLog } from "@mark1russell7/sqlite";

const open = (path: string) => {
  const db = openDatabase(path, { busyTimeoutMs: 5000 });
  try {
    const integrity = checkIntegrity(db, { quick: true });
    if (!integrity.ok) throw new IntegrityError(integrity.problems);
    return { db, log: eventLog(db, { parse }) };
  } catch (error) {
    db.close();
    throw error;
  }
};

const { value, quarantined } = openOrQuarantine("data/app.db", open);
if (quarantined?.database !== undefined) {
  const salvaged = salvageEventLog(quarantined.database, value.log, { parse });
  report(salvaged.added, salvaged.lost, salvaged.problems);
}
```

- Close each connection to a file before its quarantine. The WAL file moves before the main file, so a new file does not get the old WAL.
- `openOrQuarantine` starts the quarantine only for the kinds `corrupt` and `not-a-database`. An `IntegrityError` has the kind `corrupt`.
- `open` must close its connection when it throws. Each other error goes to the caller.
- `salvageEventLog` opens the broken file read-only. After a broken page, it reads each later position alone, and counts the lost positions.
- `snapshot` does not stop the writers. Use it for a backup or for a copy to a different computer.

## The experimental warning

Node.js 22 writes "SQLite is an experimental feature" to the standard error at the first load of `node:sqlite`. The entry `@mark1russell7/sqlite/warning` removes only that warning. The entry does not import `node:sqlite`.

```ts
import { quietSqliteWarning } from "@mark1russell7/sqlite/warning";

quietSqliteWarning();
const { openDatabase } = await import("@mark1russell7/sqlite");
```

A static import of `node:sqlite` loads before the code of the module. Thus import the database code after the filter, with `import()`. The function gives a function that removes the filter.
