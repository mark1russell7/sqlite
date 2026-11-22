# @mark1russell7/sqlite

Databases on one computer through `node:sqlite`. The package has the connection with its pragmas, the migrations by schema version and the write transaction. It also has a typed append-only event log, the faults of SQLite and the recovery of a broken file. It has no dependencies.

The entry `@mark1russell7/sqlite/portable` operates on other drivers of SQLite too, also on SQLite in WebAssembly in a browser. The [site](https://mark1russell7.github.io/sqlite/) has a live demo of the event log.

```sh
npm install @mark1russell7/sqlite
```

The package needs Node.js 22.13 or later: the first Node.js with `node:sqlite` and no flag. CI runs the tests on Node.js 22.13.

## The connection

`openDatabase` opens a `DatabaseSync` and sets its pragmas. It sets the busy timeout first, because the change to WAL needs the lock of the file.

```ts
import { openDatabase } from "@mark1russell7/sqlite";

const db = openDatabase("data/app.db", { synchronous: "NORMAL", busyTimeoutMs: 5000, makeFolder: true });
```

| Option | Default | What it sets |
| --- | --- | --- |
| `wal` | `true` | The write-ahead log. Then readers do not stop a writer. With `"when-writable"`, a file that the process cannot write keeps its journal mode. |
| `readOnly` | `false` | The connection reads the file and cannot write it. The file must exist. The journal mode does not change. |
| `synchronous` | `FULL` | The pragma `synchronous`. With WAL, `NORMAL` loses the commits after the last checkpoint at a power cut. The file stays good. See [What a power cut keeps](#what-a-power-cut-keeps). For the commits that must stay, refer to [Synced transactions](#synced-transactions). |
| `busyTimeoutMs` | `0` | The time that a statement waits for the lock of a different connection. With `0`, the statement fails at once. |
| `makeFolder` | `false` | The function makes the folder of the file. `folderMode` sets the mode of the new folders. |

Each default other than `wal` is the default of SQLite. Foreign keys are on, because `node:sqlite` turns them on for each connection.

A tool that only reads the file of a different app opens it with `readOnly`. The open does not change the file:

```ts
const db = openDatabase("catalog.db", { readOnly: true, busyTimeoutMs: 5000 });
```

- `readOnly` with `wal: true` or `makeFolder: true` is an error, because both change the disk.
- With `wal: "when-writable"`, the open sets WAL when it can. On a file that the process cannot write, the connection reads the file, and each write throws.

### What a power cut keeps

A power cut loses each write that is not synced to the disk. The test `power/power.test.ts` measures which commits each `synchronous` setting keeps. It operates in CI on LazyFS. This file system keeps each write in a cache until an fsync, and the test clears the cache after it stops the writer. Each commit of the writer adds 10 events to an event log.

| Journal | `synchronous` | The writer | Commits before the cut | Commits kept |
| --- | --- | --- | --- | --- |
| WAL | `FULL` | a cut after the commit 6 | 6 | 6 |
| WAL | `EXTRA` | a cut after the commit 6 | 6 | 6 |
| WAL | `FULL` | a commit each 20 ms, a cut at 1.5 s | 66 | 66 |
| WAL | `NORMAL` | no checkpoint | 6 | 0 |
| WAL | `NORMAL` | a checkpoint each 4 commits | 10 | 8 |
| WAL | `NORMAL` | a checkpoint each 25 commits, a cut at 1.5 s | 65 | 50 |
| WAL | `NORMAL` | a `syncedTransaction` each 4 commits | 10 | 8 |
| WAL | `NORMAL` | a `syncedTransaction` each 25 commits, a cut at 1.5 s | 65 | 50 |
| WAL | `NORMAL` | the writer closes the database before the cut | 12 | 12 |
| WAL | `OFF` | a checkpoint each 4 commits | 10 | 0 |
| delete | `FULL` | a cut after the commit 6 | 6 | 6 |
| delete | `NORMAL` | a cut after the commit 6 | 6 | 6 |

- `FULL` and `EXTRA` keep each commit. A commit is on the disk when its transaction ends.
- With WAL, `NORMAL` keeps the commits up to the last checkpoint, and loses each commit after it. The function `checkpoint` and the close of the last connection make a checkpoint.
- By default, SQLite also makes a checkpoint when the WAL file has 1,000 pages.
- `OFF` keeps no commit, also after a checkpoint, because it makes no fsync.
- On a connection with `NORMAL`, a commit of `syncedTransaction` syncs the WAL file. The disk keeps that commit and each commit before it.
- With the journal `delete`, `NORMAL` kept each commit in this test. The documentation of SQLite tells of a small risk to the file on an old file system.
- In each case the file opens, and `PRAGMA integrity_check` gives `ok`. No case keeps a part of a transaction.

### The SQL of a caller

A host that runs the SQL text of a caller controls the path of the database. But SQL text can name other files:

- `ATTACH` opens or makes a file at a path.
- `VACUUM INTO` writes a copy of the database to a path, also on a `readOnly` connection.
- The pragmas `temp_store_directory` and `data_store_directory` set a folder for the files of SQLite. The first one applies to each connection of the process.

`confineToFile` keeps the SQL of a connection on its file. It refuses these statements and the function `load_extension`:

```ts
import { confineToFile, openDatabase } from "@mark1russell7/sqlite";

const db = openDatabase(checkedPath, { wal: false, busyTimeoutMs: 5000 });
confineToFile(db);
const rows = db.prepare(sqlOfTheCaller).all();
```

- SQLite asks the guard when it compiles a statement. The guard sees the statement after the parse, so comments, case and quotes do not change the result.
- A refused `ATTACH` or pragma throws, and `sqliteFault` gives the kind `authorization`. A refused `VACUUM INTO` throws before it makes a file.
- A plain `VACUUM` and `clearDatabase` work. A plain `VACUUM` attaches a temporary database with an empty name, and the guard lets it.
- An `ATTACH ''` stays in the temporary folder of SQLite. But a caller can fill this folder with a large temporary database until the close.
- The guard does not limit the time or the size of the work of a caller. The host does.
- A trigger runs with the guard of the connection that fires it. Confine each connection that runs the SQL of a caller.
- A connection has one authorizer. The guard replaces an earlier authorizer, and `db.setAuthorizer(null)` removes the guard.
- `snapshot` uses `VACUUM INTO`, so it needs a connection with no guard.
- The guard needs `setAuthorizer` of Node.js 24.10 or later. On an earlier Node.js, `confineToFile` throws a `ConfineUnavailableError` (`code: "CONFINE_UNAVAILABLE"`). Then do not run the SQL of a caller.
- The parameter takes a `DatabaseSync` of each version of `@types/node`. The `DatabaseSync` type of `@types/node` 22 has no `setAuthorizer`, and the check at run time decides.

### The statements of a text

The function `prepare` of `node:sqlite` compiles only the first statement of a text. It ignores the rest with no error. `eachStatement` gives each statement of the text in turn:

```ts
import { eachStatement } from "@mark1russell7/sqlite";

for (const statement of eachStatement(db, "CREATE TABLE t (x); INSERT INTO t VALUES (1); SELECT x FROM t")) {
  console.log(statement.all());
}
```

- Run each statement before you ask for the next one. The next statement compiles against the database after that run.
- When a statement does not compile, the iteration throws. Each earlier statement that ran stays done. Run the text in a transaction to get all or nothing.
- SQLite finds the end of each statement. Thus a `;` in a string, a quoted name, a comment or the body of a trigger does not end a statement.
- The function skips the spaces, the comments and the empty statements between two statements. A block comment with no end goes to the end of the text, as in SQLite.
- On a connection with `confineToFile`, the guard refuses a statement when it compiles. The statements before it stay done.

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
- With `newer: "keep"`, the function does no step on a newer file and keeps its version. Use it only when each step adds tables or columns.
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
- In a transaction in progress, the checks of the remaining work of that transaction wait for its commit too.
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
- With `commit: false`, the function rolls back after the work and gives the result of the work. This is a dry run: the work sees its writes, and the file does not keep them.

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

### Read transactions

`readTransaction` does the work in one read transaction, and gives the result of the work. Each read of the work sees one snapshot of the file:

```ts
import { readTransaction } from "@mark1russell7/sqlite";

const matrix = readTransaction(db, () => {
  const ids = db.prepare("SELECT id FROM vectors").all();
  const rows = db.prepare("SELECT id, value FROM vectors").all();
  return { ids, rows };
});
```

- The snapshot starts at the call. A write of a different connection after the call is not in the snapshot.
- The transaction does not take the write lock. In WAL mode, a writer on a different connection does not wait for it.
- The work cannot write. `PRAGMA query_only` is on during the work, and the function sets the earlier value again at the end.
- The rules of `transaction` apply: the rollback after an error, the synchronous work, `nested` and `onRollbackError`.
- Keep the work short. A checkpoint cannot pass an open snapshot, so the WAL file grows.

### Synced transactions

`syncedTransaction` does the work in one write transaction whose commit is on the disk when the function ends. Use it on a connection with `NORMAL` for the few writes that must stay after a power cut:

```ts
import { openDatabase, syncedTransaction } from "@mark1russell7/sqlite";

const db = openDatabase("data/app.db", { synchronous: "NORMAL" });

// Most writes keep the low cost of NORMAL. The grant of a lease must stay after a crash of the system.
syncedTransaction(db, () => {
  db.prepare("UPDATE leases SET state = ? WHERE id = ?").run("granted", id);
});
```

- The function sets `synchronous` to `FULL` for its commit, and sets the earlier value again at the end. It also does this after an error.
- In WAL mode, `FULL` syncs the WAL file at the commit. Thus the disk also keeps each earlier commit of the connection.
- A connection with `FULL` or `EXTRA` needs no change, and the function does not change its setting.
- A call in a transaction in progress throws, also with `nested: "savepoint"`. The commit of that transaction is not the commit of this work.
- The rules of `transaction` apply: the rollback after an error, the synchronous work, `onRollbackError` and the dry run with `commit: false`.
- Each synced commit costs one fsync of the WAL file. Measure the time of the synced writes on the computers of the app.

## The checkpoint

`checkpoint` copies the pages of the WAL file into the database file, and gives the counts of `PRAGMA wal_checkpoint`. Before a copy of the database file, use `TRUNCATE`:

```ts
import { checkpoint } from "@mark1russell7/sqlite";

const { busy } = checkpoint(db, "TRUNCATE");
if (busy) throw new Error("A different connection has the file. The copy can lack the last commits.");
copyFileSync("app.db", "backup/app.db");
```

- The modes are `PASSIVE` (the default), `FULL`, `RESTART` and `TRUNCATE`. `TRUNCATE` also makes the WAL file empty.
- `busy` is true when a different connection stopped the checkpoint before its end.
- A database that is not in WAL mode gives `-1` for each count.
- SQLite refuses a checkpoint in a transaction, so the function throws there.

## The clear of a database

A cache that makes its tables again for a new schema uses `clearDatabase`. The function drops each view and each table, and sets `user_version` to 0:

```ts
import { clearDatabase, migrate } from "@mark1russell7/sqlite";

if (storedFormat(db) !== FORMAT) clearDatabase(db);
migrate(db, steps);
```

- The indexes and the triggers go with their tables. The tables of SQLite itself stay.
- Foreign keys are off during the drop, so the order of the tables has no effect. The function sets the earlier value again.
- The drop is one transaction. After it, `VACUUM` makes the file small again. Give `vacuum: false` to skip it.
- The function gives the names of the dropped views and tables. In a transaction, it throws.
- Do not clear a file that keeps the only copy of its data. A clear is for a cache that a different source can fill again.

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
- `counts()` gives the count of events of each type. It reads the index of the types, not the bodies. A caller that reads only some types counts the other events with it.
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

#### A schema as the parse

The `parse` of a log is a function that throws on a value that is not an event, or a validator of the [Standard Schema](https://standardschema.dev). A schema of zod 4, Valibot or ArkType is such a validator.

```ts
import { z } from "zod";

const Report = z.object({ id: z.string(), at: z.string(), type: z.literal("report"), level: z.number().default(0) });
const reports = eventLog(db, { parse: Report, table: "reports" }); // EventLog<z.output<typeof Report>>
```

- The log gets the output type of the schema. A read gives the output of the schema, so a default fills a field that older events do not have.
- When the schema refuses a stored value, the read throws. The `cause` of the error is a `SchemaError` with the vendor and each problem.
- The log reads synchronously. A schema that validates asynchronously gives an error.
- `openEventLog` and `salvageEventLog` take a validator too. The package does not depend on a validator.
- `openEventLog` opens a log in its own file, with the table `events`. That log owns the `user_version` of its file.

### A failed write

- A failed write or `accept` rolls back and breaks the log. Each later call throws a `BrokenLogError` until `recover`.
- After `recover`, the caller replays the log, because its state can have the events of the failed write.
- `recover` throws when the rollback did not end. Then the error has `stuck: true`. Open the log again.
- A lock that is not free at the start does not break the log. The call throws, and nothing changes.

### The snapshot of a fold

An app folds the events of its log into a state at each start. Thus the work of a start grows with the age of the log. A snapshot keeps the state at one position of the log. The next start reads the snapshot, and it folds only the events after that position.

```ts
import { openEventLog, openFoldSnapshot } from "@mark1russell7/sqlite";

const log = openEventLog("app.sqlite", parse);
const snapshot = openFoldSnapshot("app.snapshot.sqlite");
const key = { version: 1, key: settingsHash };

// The start: the state of the snapshot, or an empty state.
let after = 0;
let state = snapshot.read(key, log, (mark, rows) => {
  after = mark.seq;
  return stateOf(rows);
}) ?? emptyState;
for (const entry of log.entries({ after })) state = fold(state, entry.event);

// Later: the state up to the last event of the fold.
snapshot.write(key, { seq: last.seq, id: last.event.id }, rowsOf(state));

// A large state: many short transactions, with a turn of the event loop between two of them.
await snapshot.writeInChunks(key, { seq: last.seq, id: last.event.id }, rowsOf(state), { rows: 1000, chars: 1_000_000 });
```

- The rows are pairs of a part name and a text. `write` reads them one at a time, thus the app does not make one large text of the state.
- `write` replaces the snapshot in one transaction. When the rows throw, the old snapshot stays.
- `writeInChunks` replaces the snapshot in many short transactions, with a pause between two of them. Thus a large snapshot does not stop the event loop for the time of the whole write.
- `writeInChunks` puts the new rows in a second table. One short transaction then swaps the two tables and changes the meta row. A read before the swap gives the old snapshot.
- The rows of `writeInChunks` must come from a value that does not change in the write, because the write reads them over all its pauses.
- `writeInChunks` does a `PASSIVE` checkpoint after each transaction. Thus each checkpoint copies one transaction, and no commit copies the pages of many. The option `checkpoint: false` turns it off.
- A stopped write leaves its rows in the second table, and the old snapshot stays. The next write removes them.
- The table of the snapshot has only the rows of the snapshot. Thus 0.4 reads a snapshot of `writeInChunks`, and `writeInChunks` reads a snapshot of 0.4.
- `read` gives `undefined` for a different `version` or `key`. Change the version at each change of the fold or of its rows.
- `read` also gives `undefined` when the log has no event with the id of the mark at its position. A different log, or a log that lost events, then gets a full fold.
- A snapshot is correct only for an append-only log. After a salvage of the log, use a new key or `clear`.
- The rows are valid only in the work of `read`, in one read transaction. When the count of the rows is not the count of the write, the read throws.
- A snapshot is a projection, in the part `fold-snapshot` of its file. A file of a different version of its tables opens with no snapshot.
- `openFoldSnapshot` gives a snapshot in its own file. A broken snapshot file then does not change the log. `foldSnapshot` gives a snapshot on a connection, also in the portable entry.

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
| `openCheckedEventLog(path, parse)` | It opens a log after a check of its file. It recovers a broken file in steps that a crash does not break. |
| `listRecoveries(path)` | It gives each recovery of `openCheckedEventLog` from the records in the quarantine folders. |

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

### The checked open of a log

`openCheckedEventLog` opens a log in its own file after an integrity check. It moves a broken file into quarantine, and a new file gets each readable event.

```ts
import { openCheckedEventLog } from "@mark1russell7/sqlite";

const opened = openCheckedEventLog("data/events.db", parse, { busyTimeoutMs: 5000 });
if (opened.kind === "recovered" && opened.salvage.lost > 0) report(opened.cause, opened.quarantined.folder, opened.salvage);
const { log } = opened;
```

| `kind` | What the function found | The other fields |
| --- | --- | --- |
| `created` | No file. The log is a new file. | None |
| `opened` | A file that passed its check. | `integrity` |
| `recovered` | A broken file. It is in quarantine, and the new file has each event that the salvage kept. | `cause`, `quarantined`, `salvage: { kept, lost, problems }` |
| `orphan-journal` | A WAL, SHM or journal file with no database file. It is in quarantine, and the log is a new file. | `quarantined` |

The recovery has four steps, and each step can be done again:

1. The salvage reads each readable event of the broken file into the file `<path>.salvage-tmp`.
2. The record `<path>.recovery.json` marks the salvage complete. It keeps the cause, the counts and the quarantine folder.
3. The broken file and its WAL, SHM and journal files move into the quarantine folder. The main file goes last.
4. The salvage file takes the path, and the record moves into the quarantine folder.

- A crash before step 2 leaves the broken file at the path. The next open starts the recovery again.
- A crash after step 2 leaves the record. The next open completes the steps 3 and 4 with the same folder and the same counts.
- The option `check` sets the check. The default is `{ quick: true }`, and `{ quick: false }` does the full `integrity_check`.
- A failed check and the fault kinds `corrupt` and `not-a-database` start a recovery. Each other error goes to the caller, for example a lock that is not free.
- With `readOnly`, the function moves nothing. A failed check throws an `IntegrityError`, and a fault throws its error.
- The function closes each connection before each rename, because Windows does not rename an open file.
- The read-only salvage can leave an empty WAL and SHM file next to the broken file. These files also go into quarantine.
- After a crash, the `cause` of a fault comes from the record. Its `error` is a new `Error` with the message of SQLite.
- Only one process at a time can recover a file.

`listRecoveries(path)` gives each recovery from the records in the quarantine folders. A caller can report each recovery at each start:

```ts
import { listRecoveries } from "@mark1russell7/sqlite";

for (const entry of listRecoveries("data/events.db")) {
  if (entry.kind === "no-read") report(entry.problem);
  else log.append({ id: `recovered:${entry.id}`, at: entry.at, type: entry.kind, lost: entry.kind === "recovered" ? entry.salvage.lost : 0 });
}
```

- `id` is the name of the quarantine folder. It stays the same when the data folder moves, so a report with this id is the same report at each start.
- Make the report only from the fields that do not change, for example `id`, `at` and the counts. The log gives a conflict for one id with a different body.
- A stop after the open and before the report of the caller does not lose the report. The next start reports it.
- The entries are in the sequence of `at`, and then of `id`. The option `folder` reads the quarantine folders of a different folder.
- A folder with no record, or with a record that does not parse, gives an entry of the kind `no-read` with its `problem`. These entries go last.
- A recovery that is not complete is not in the list. The next open completes it, and then the list has it.

## The portable entry

The entry `@mark1russell7/sqlite/portable` has the migrations, the projections, the transactions, the checkpoint, the clear, the event log and the snapshot of a fold. It imports no module of Node.js. Thus it operates in a browser too.

These functions take a `SqlConnection`: the part of a connection that the package uses. It has `exec`, `prepare` and `isTransaction`. Its statements have `get`, `all`, `run` and `iterate`. `DatabaseSync` of `node:sqlite` has these members. For a different driver, write a small adapter.

```ts
import { eventLog, migrate, type SqlConnection } from "@mark1russell7/sqlite/portable";

const db: SqlConnection = adapter(driver);
migrate(db, steps);
const log = eventLog(db, { parse });
```

- An adapter gives each row as an object with one field for each column. `get` gives `undefined` when the result has no rows.
- `run` gives a `SqlChanges`: the number of changed rows and the id of the last added row.
- `isTransaction` is true from `BEGIN` to the end of the transaction. A driver without it can use `sqlite3_get_autocommit`, which gives 0 in a transaction.
- `Migration<D>` and `ProjectionOptions<D>` take the type of the connection. Thus each step gets the full connection of the driver. In this entry, the default is `SqlConnection`. In the main entry, the default is `DatabaseSync`.
- `openEventLog`, the faults and the recovery stay in the main entry, because they need Node.js.
- A test of the package follows each import of the entry, also each `import type`. It fails when the entry gets to a module out of the package. Thus a browser app needs no `@types/node`.

### SQLite in WebAssembly

`wasmConnection` is the adapter for [`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm). Its types are structural, so this package does not depend on that package.

```ts
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { eventLog, migrate, wasmConnection } from "@mark1russell7/sqlite/portable";

const sqlite3 = await sqlite3InitModule();
const db = wasmConnection(sqlite3, new sqlite3.oo1.DB(":memory:", "c"));
migrate(db, steps);
const log = eventLog(db, { parse });
db.close();
```

- The connection keeps one compiled statement for each SQL text. `close` finalizes each statement, and then closes the database.
- Each call reads the full result and then resets its statement. Thus `iterate` gives an array, not a stream.
- The tests of the package run the migrations, the projections, the transaction and the event log on the real driver.
- With Vite, exclude `@sqlite.org/sqlite-wasm` from `optimizeDeps`, as the README of that package tells.

### sql.js

`sqlJsConnection` is the adapter for [`sql.js`](https://www.npmjs.com/package/sql.js). Its types are structural, so this package does not depend on that package.

```ts
import initSqlJs from "sql.js";
import { migrate, sqlJsConnection } from "@mark1russell7/sqlite/portable";

const SQL = await initSqlJs();
const db = sqlJsConnection(new SQL.Database(bytes));
migrate(db, steps);
db.close();
```

- sql.js keeps the database in memory. To keep the changes, the app writes the bytes of `export()` to a file.
- sql.js gives each integer as a JavaScript number. A `bigint` parameter must be a safe integer, else the call throws a `RangeError`.
- sql.js has no call for the state of the transaction. Thus `isTransaction` starts a `BEGIN`. SQLite refuses it in a transaction, and else a `ROLLBACK` ends it at once.
- Each call compiles its statement and frees it after the call. An `export()` of sql.js frees each statement of the database, so the connection keeps none. A statement from `prepare` operates after a save.
- `iterate` gives an array, as in `wasmConnection`. `close` closes the database.
- The tests of the package run one suite of the portable entry on `node:sqlite`, SQLite in WebAssembly and sql.js.

## The experimental warning

Node.js 22 writes "SQLite is an experimental feature" to the standard error at the first load of `node:sqlite`. The entry `@mark1russell7/sqlite/warning` removes only that warning. The entry does not import `node:sqlite`.

```ts
import { quietSqliteWarning } from "@mark1russell7/sqlite/warning";

quietSqliteWarning();
const { openDatabase } = await import("@mark1russell7/sqlite");
```

A static import of `node:sqlite` loads before the code of the module. Thus import the database code after the filter, with `import()`. The function gives a function that removes the filter.
