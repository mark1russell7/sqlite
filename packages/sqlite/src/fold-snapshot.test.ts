import { mkdtempSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { eventLog, type EventLog, type LogRecord } from "./event-log.ts";
import { FOLD_SNAPSHOT_PART, foldSnapshot, type FoldMark, type FoldRow } from "./fold-snapshot.ts";
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
    expect(schemaVersion(db, FOLD_SNAPSHOT_PART)).toBe(1);
    expect(readAll(store)).toBeUndefined();
  });

  it("shares a file with the log of the app", () => {
    const store = foldSnapshot(logDb);
    store.write(KEY, SECOND, ROWS);
    expect(readAll(store)).toEqual({ mark: SECOND, rows: ROWS });
    expect(log.count()).toBe(3);
  });
});
