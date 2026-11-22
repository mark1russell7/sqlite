import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { eventLog, type EventLog, type LogRecord } from "./event-log.ts";
import { FOLD_SNAPSHOT_PART, FOLD_SNAPSHOT_SCHEMA_VERSION, foldSnapshot, type FoldMark, type FoldRow } from "./fold-snapshot.ts";
import { openFoldSnapshot } from "./fold-snapshot-file.ts";
import { schemaVersion, setSchemaVersion } from "./migrate.ts";

interface Note extends LogRecord {
  readonly name: string;
}

const parse = (value: unknown): Note => value as Note;
const KEY = { version: 3, key: "settings-a" };
const ROWS: readonly FoldRow[] = [
  { part: "time", value: "1700" },
  { part: "report", value: '{"id":"r1"}' },
  { part: "report", value: '{"id":"r2"}' },
];

/** This function closes the connection. It ignores the error of a connection that the test closed. */
function closeQuietly(db: { close(): void }): void {
  try {
    db.close();
  } catch {
    // The test closed the connection
  }
}

let db: DatabaseSync;
let logDb: DatabaseSync;
let log: EventLog<Note>;

beforeEach(() => {
  db = openDatabase(":memory:");
  logDb = openDatabase(":memory:");
  log = eventLog(logDb, { parse });
  for (const name of ["a", "b", "c"]) log.append({ id: `e-${name}`, at: "2026-11-21T00:00:00Z", type: "added", name });
});

afterEach(() => {
  closeQuietly(db);
  closeQuietly(logDb);
});

// The mark of the second event of the log.
const SECOND: FoldMark = { seq: 2, id: "e-b" };

// The mark and the rows of a read, or undefined.
const readAll = (store = foldSnapshot(db), key = KEY): { mark: FoldMark; rows: FoldRow[] } | undefined =>
  store.read(key, log, (mark, rows) => ({ mark, rows: [...rows] }));

describe("the snapshot of a fold", () => {
  it("gives the mark and the rows of the write, in their order", () => {
    const store = foldSnapshot(db);
    expect(store.write(KEY, SECOND, ROWS)).toBe(3);
    expect(readAll(store)).toEqual({ mark: SECOND, rows: ROWS });
  });

  it("reads the rows of a generator one at a time, and keeps them after a new connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "fold-snapshot-"));
    try {
      const path = join(dir, "state.sqlite");
      const first = openFoldSnapshot(path);
      function* rows(): Generator<FoldRow> {
        for (let at = 0; at < 1000; at += 1) yield { part: "item", value: String(at) };
      }
      expect(first.write(KEY, SECOND, rows())).toBe(1000);
      first.close();
      const second = openFoldSnapshot(path);
      try {
        expect(second.read(KEY, log, (mark, all) => ({ mark, values: [...all].map((row) => Number(row.value)) }))).toEqual({
          mark: SECOND,
          values: Array.from({ length: 1000 }, (_, at) => at),
        });
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives no snapshot for an empty file, a different version and a different key, with no call of the work", () => {
    const store = foldSnapshot(db);
    const calls: FoldMark[] = [];
    const work = (mark: FoldMark): number => calls.push(mark);
    expect(store.read(KEY, log, work)).toBeUndefined();
    store.write(KEY, SECOND, ROWS);
    expect(store.read({ ...KEY, version: 4 }, log, work)).toBeUndefined();
    expect(store.read({ ...KEY, key: "settings-b" }, log, work)).toBeUndefined();
    expect(calls).toEqual([]);
    expect(store.read(KEY, log, work)).toBe(1);
  });

  it("gives no snapshot when the log does not have the event of the mark at its position", () => {
    const store = foldSnapshot(db);
    // A log with no event of the mark: for example a different log, or a log that lost its last events.
    store.write(KEY, { seq: 2, id: "e-x" }, ROWS);
    expect(readAll(store)).toBeUndefined();
    // The event of the mark at a different position: for example the salvage of a log that lost an earlier event.
    store.write(KEY, { seq: 3, id: "e-b" }, ROWS);
    expect(readAll(store)).toBeUndefined();
    store.write(KEY, { seq: 3, id: "e-c" }, ROWS);
    expect(readAll(store)?.mark).toEqual({ seq: 3, id: "e-c" });
  });

  it("replaces the snapshot at each write, and keeps the old snapshot when the rows throw", () => {
    const store = foldSnapshot(db);
    store.write(KEY, SECOND, ROWS);
    const broken = function* (): Generator<FoldRow> {
      yield { part: "time", value: "1800" };
      throw new Error("no serialization");
    };
    expect(() => store.write(KEY, { seq: 3, id: "e-c" }, broken())).toThrow("no serialization");
    expect(readAll(store)).toEqual({ mark: SECOND, rows: ROWS });
    store.write({ ...KEY, key: "settings-b" }, { seq: 3, id: "e-c" }, [{ part: "time", value: "1900" }]);
    expect(readAll(store)).toBeUndefined();
    expect(readAll(store, { ...KEY, key: "settings-b" })).toEqual({ mark: { seq: 3, id: "e-c" }, rows: [{ part: "time", value: "1900" }] });
  });

  it("removes the snapshot at a clear", () => {
    const store = foldSnapshot(db);
    store.write(KEY, SECOND, ROWS);
    store.clear();
    expect(readAll(store)).toBeUndefined();
    expect(store.write(KEY, SECOND, [])).toBe(0);
    expect(readAll(store)).toEqual({ mark: SECOND, rows: [] });
  });

  it("refuses the rows after the work of the read", () => {
    const store = foldSnapshot(db);
    store.write(KEY, SECOND, ROWS);
    const kept = store.read(KEY, log, (_mark, rows) => rows);
    expect(kept).toBeDefined();
    expect(() => [...(kept ?? [])]).toThrow("valid only in the work of its read");
  });

  it("throws at the end of the rows when the file lost a row", () => {
    const store = foldSnapshot(db);
    store.write(KEY, SECOND, ROWS);
    db.exec("DELETE FROM fold_snapshot_rows WHERE n = 2");
    expect(() => readAll(store)).toThrow("The snapshot has 2 rows, but its write had 3 rows.");
  });

  it("refuses a version and a position that are not whole numbers of 1 or more", () => {
    const store = foldSnapshot(db);
    expect(() => store.write({ ...KEY, version: 0 }, SECOND, ROWS)).toThrow(RangeError);
    expect(() => store.write({ ...KEY, version: 1.5 }, SECOND, ROWS)).toThrow(RangeError);
    expect(() => store.write(KEY, { seq: 0, id: "e-a" }, ROWS)).toThrow(RangeError);
    expect(() => readAll(store, { ...KEY, version: -1 })).toThrow(RangeError);
  });

  it("is a projection: a file with a different version of the tables opens with no snapshot", () => {
    foldSnapshot(db).write(KEY, SECOND, ROWS);
    setSchemaVersion(db, FOLD_SNAPSHOT_PART, 99);
    const store = foldSnapshot(db);
    expect(schemaVersion(db, FOLD_SNAPSHOT_PART)).toBe(FOLD_SNAPSHOT_SCHEMA_VERSION);
    expect(readAll(store)).toBeUndefined();
  });

  it("shares a file with the log of the app", () => {
    const store = foldSnapshot(logDb);
    store.write(KEY, SECOND, ROWS);
    expect(readAll(store)).toEqual({ mark: SECOND, rows: ROWS });
    expect(log.count()).toBe(3);
  });
});

// The rows of a snapshot of `size` items.
const many = (size: number): FoldRow[] => Array.from({ length: size }, (_, index) => ({ part: "item[]", value: `{"n":${index}}` }));
// The count of the rows in the table of the snapshot, and in the table of a write in chunks.
const tableRows = (): number => Number((db.prepare("SELECT COUNT(*) AS n FROM fold_snapshot_rows").get() as { n: number }).n);
const nextRows = (): number => Number((db.prepare("SELECT COUNT(*) AS n FROM fold_snapshot_next").get() as { n: number }).n);

// The read and the write of 0.4, with the statements of src/fold-snapshot.ts at v0.4.1. Its read reads each row of the
// table of rows, and its write replaces the rows and the meta row in one transaction.
const read04 = (): { count: number; rows: FoldRow[] } | undefined => {
  const meta = db.prepare("SELECT version, key, seq, id, count FROM fold_snapshot WHERE one = 1").get() as { count: number } | undefined;
  if (meta === undefined) return undefined;
  const rows = db.prepare("SELECT part, value FROM fold_snapshot_rows ORDER BY n").all() as unknown as FoldRow[];
  return { count: Number(meta.count), rows: rows.map((row) => ({ part: row.part, value: row.value })) };
};
const write04 = (mark: FoldMark, rows: readonly FoldRow[]): void => {
  db.exec("BEGIN IMMEDIATE");
  db.exec("DELETE FROM fold_snapshot_rows");
  db.exec("DELETE FROM fold_snapshot");
  rows.forEach((row, index) => db.prepare("INSERT INTO fold_snapshot_rows (n, part, value) VALUES (?, ?, ?)").run(index + 1, row.part, row.value));
  db.prepare("INSERT INTO fold_snapshot (one, version, key, seq, id, count) VALUES (1, ?, ?, ?, ?, ?)").run(KEY.version, KEY.key, mark.seq, mark.id, rows.length);
  db.exec("COMMIT");
};
const THIRD: FoldMark = { seq: 3, id: "e-c" };

describe("the write of a snapshot in chunks", () => {
  it("gives the snapshot of a write in one transaction, and keeps no old row", async () => {
    const store = foldSnapshot(db);
    store.write(KEY, SECOND, ROWS);
    const rows = many(25);
    await expect(store.writeInChunks(KEY, THIRD, rows, { rows: 4 })).resolves.toBe(25);
    expect(readAll(store)).toEqual({ mark: THIRD, rows });
    expect(tableRows()).toBe(25);
    // A new connection reads the same snapshot.
    expect(readAll(foldSnapshot(db))).toEqual({ mark: THIRD, rows });
  });

  it("pauses after each transaction, and a read in a pause gives the old snapshot", async () => {
    const store = foldSnapshot(db);
    store.write(KEY, SECOND, ROWS);
    const seen: (FoldMark | undefined)[] = [];
    const pause = (): Promise<void> => {
      seen.push(readAll(store)?.mark);
      return Promise.resolve();
    };
    await store.writeInChunks(KEY, THIRD, many(10), { rows: 4, pause });
    // Three transactions of rows (4, 4 and 2 rows, and the third finds the end), and the removal of the old rows.
    expect(seen).toEqual([SECOND, SECOND, SECOND, THIRD]);
  });

  it("ends a transaction at the limit of characters, with one row at the least", async () => {
    const store = foldSnapshot(db);
    let pauses = 0;
    const rows = [{ part: "big", value: "x".repeat(50) }, ...many(3)];
    await store.writeInChunks(KEY, SECOND, rows, { chars: 10, pause: () => Promise.resolve(void (pauses += 1)) });
    expect(readAll(store)?.rows).toEqual(rows);
    // One row in each transaction, and the transaction that finds the end.
    expect(pauses).toBe(5);
  });

  it("lets the timers of the app operate in the write", async () => {
    const store = foldSnapshot(db);
    let rowsAtTimer = -1;
    setTimeout(() => {
      rowsAtTimer = nextRows();
    }, 0);
    await store.writeInChunks(KEY, SECOND, many(50), { rows: 10 });
    expect(rowsAtTimer).toBeGreaterThan(0);
    expect(rowsAtTimer).toBeLessThan(50);
  });

  it("keeps the old snapshot when the rows throw, and the next write removes the rows of the stopped write", async () => {
    const store = foldSnapshot(db);
    store.write(KEY, SECOND, ROWS);
    function* broken(): Generator<FoldRow> {
      yield* many(6);
      throw new Error("a broken state");
    }
    await expect(store.writeInChunks(KEY, THIRD, broken(), { rows: 4 })).rejects.toThrow("a broken state");
    expect(readAll(store)).toEqual({ mark: SECOND, rows: ROWS });
    // The first chunk of the stopped write stays in the table of the next rows until the next write.
    expect(tableRows()).toBe(3);
    expect(nextRows()).toBe(4);
    await store.writeInChunks(KEY, THIRD, many(2));
    expect(tableRows()).toBe(2);
    expect(nextRows()).toBe(0);
  });

  it("does a checkpoint after each transaction, thus the log file keeps the pages of one transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fold-snapshot-"));
    try {
      // The highest size of the log file at the pauses of one write of 20 transactions of about 100 KB each.
      const largestLog = async (name: string, options: { checkpoint?: boolean }): Promise<number> => {
        const path = join(dir, `${name}.sqlite`);
        const file = openDatabase(path);
        try {
          // No automatic checkpoint: only the checkpoints of the write copy pages.
          file.exec("PRAGMA wal_autocheckpoint = 0");
          const store = foldSnapshot(file);
          let largest = 0;
          const pause = (): Promise<void> => {
            largest = Math.max(largest, statSync(`${path}-wal`).size);
            return Promise.resolve();
          };
          const rows = Array.from({ length: 1000 }, (_, n) => ({ part: `p${n}`, value: "v".repeat(2000) }));
          await store.writeInChunks(KEY, SECOND, rows, { rows: 50, pause, ...options });
          expect(readAll(store, KEY)?.rows).toHaveLength(1000);
          return largest;
        } finally {
          file.close();
        }
      };
      const each = await largestLog("each", {});
      const none = await largestLog("none", { checkpoint: false });
      // One transaction writes about 100 KB of pages. Without the checkpoints, the log keeps each of the 2 MB.
      expect(each).toBeLessThan(400_000);
      expect(none).toBeGreaterThan(2_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives one whole snapshot to a read in each pause of a write, before and after the swap of the tables", async () => {
    const store = foldSnapshot(db);
    store.write(KEY, SECOND, ROWS);
    // A read in a pause uses the statements of the store. After the swap, SQLite prepares them again on the new tables.
    const seen: { mark: FoldMark; rows: FoldRow[] }[] = [];
    const pause = (): Promise<void> => {
      const read = readAll(store);
      if (read !== undefined) seen.push(read);
      return Promise.resolve();
    };
    await store.writeInChunks(KEY, THIRD, many(10), { rows: 4, pause });
    expect(seen.length).toBeGreaterThan(3);
    for (const each of seen) expect(each).toEqual(each.mark.seq === SECOND.seq ? { mark: SECOND, rows: ROWS } : { mark: THIRD, rows: many(10) });
    expect(seen[0]?.mark).toEqual(SECOND);
    expect(seen.at(-1)?.mark).toEqual(THIRD);
  });

  it("keeps the tables of 0.4, thus each version reads the snapshot of the other", async () => {
    // A file of 0.4: version 1, the meta row and the rows, and no table of the next rows.
    db.exec(`
      CREATE TABLE fold_snapshot (one INTEGER PRIMARY KEY CHECK (one = 1), version INTEGER NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE fold_snapshot_rows (n INTEGER PRIMARY KEY, part TEXT NOT NULL, value TEXT NOT NULL);
    `);
    setSchemaVersion(db, FOLD_SNAPSHOT_PART, 1);
    write04(SECOND, ROWS);
    const store = foldSnapshot(db);
    expect(schemaVersion(db, FOLD_SNAPSHOT_PART)).toBe(1);
    expect(readAll(store)).toEqual({ mark: SECOND, rows: ROWS });
    // In each pause of a write in chunks, the read of 0.4 gives one whole snapshot: the old one or the new one.
    const seen: ({ count: number; rows: FoldRow[] } | undefined)[] = [];
    const pause = (): Promise<void> => {
      seen.push(read04());
      return Promise.resolve();
    };
    await store.writeInChunks(KEY, THIRD, many(10), { rows: 4, pause });
    expect(seen[0]).toEqual({ count: 3, rows: ROWS });
    expect(seen.at(-1)).toEqual({ count: 10, rows: many(10) });
    for (const each of seen) expect(each?.rows).toHaveLength(each?.count ?? -1);
    // After a stopped write, the read of 0.4 gives the last whole snapshot.
    function* broken(): Generator<FoldRow> {
      yield* many(6);
      throw new Error("a broken state");
    }
    await expect(store.writeInChunks(KEY, SECOND, broken(), { rows: 4 })).rejects.toThrow("a broken state");
    expect(read04()).toEqual({ count: 10, rows: many(10) });
    // This version reads a write of 0.4. Its next write in chunks first removes the rows of the stopped write.
    write04(SECOND, ROWS);
    expect(readAll(store)).toEqual({ mark: SECOND, rows: ROWS });
    await store.writeInChunks(KEY, THIRD, many(5), { rows: 2 });
    expect(readAll(store)).toEqual({ mark: THIRD, rows: many(5) });
    expect(nextRows()).toBe(0);
  });

  it("stops at a clear before the change of the meta row, and refuses a second write in the write", async () => {
    const store = foldSnapshot(db);
    store.write(KEY, SECOND, ROWS);
    let pauses = 0;
    const pause = async (): Promise<void> => {
      pauses += 1;
      if (pauses === 1) {
        expect(() => store.write(KEY, THIRD, ROWS)).toThrow("A write in chunks of the snapshot is in progress.");
        await expect(store.writeInChunks(KEY, THIRD, ROWS)).rejects.toThrow("A write in chunks of the snapshot is in progress.");
        store.clear();
      }
    };
    await expect(store.writeInChunks(KEY, THIRD, many(10), { rows: 4, pause })).rejects.toThrow("A clear of the snapshot stopped the write.");
    expect(readAll(store)).toBeUndefined();
    expect(tableRows()).toBe(0);
    expect(nextRows()).toBe(0);
    // The stopped write frees the snapshot for the next write.
    await expect(store.writeInChunks(KEY, THIRD, ROWS)).resolves.toBe(3);
  });

  it("refuses a chunk that is not a whole number of 1 or more rows, or that has no characters", async () => {
    const store = foldSnapshot(db);
    await expect(store.writeInChunks(KEY, SECOND, ROWS, { rows: 0 })).rejects.toThrow(RangeError);
    await expect(store.writeInChunks(KEY, SECOND, ROWS, { rows: 1.5 })).rejects.toThrow(RangeError);
    await expect(store.writeInChunks(KEY, SECOND, ROWS, { chars: 0 })).rejects.toThrow(RangeError);
    await expect(store.writeInChunks(KEY, { seq: 0, id: "e-a" }, ROWS)).rejects.toThrow(RangeError);
    // A refused write leaves no write in progress.
    expect(store.write(KEY, SECOND, ROWS)).toBe(3);
  });
});
