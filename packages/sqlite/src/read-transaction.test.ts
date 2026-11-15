// The read transaction on a file in WAL mode: one snapshot, no write lock, no writes, and the rules of `transaction`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { readTransaction, transaction } from "./transaction.ts";

/** This function closes the connection. It ignores the error of a connection that the test closed. */
function closeQuietly(db: { close(): void }): void {
  try {
    db.close();
  } catch {
    // The test closed the connection
  }
}

let folder: string;
let reader: DatabaseSync;
/** The second connection. Its busy timeout is 0, so a wait for a lock is an error at once. */
let writer: DatabaseSync;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-read-transaction-"));
  reader = openDatabase(join(folder, "a.db"));
  reader.exec("CREATE TABLE t (x INTEGER)");
  reader.exec("INSERT INTO t VALUES (1)");
  writer = openDatabase(join(folder, "a.db"), { busyTimeoutMs: 0 });
});

afterEach(() => {
  // Node.js before 22.15 has no isOpen. A second close() throws, and the hook ignores that error.
  for (const db of [reader, writer]) closeQuietly(db);
  rmSync(folder, { recursive: true, force: true });
});

const count = (db: DatabaseSync): number => (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
const queryOnly = (db: DatabaseSync): number => (db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only;
const insert = (db: DatabaseSync, x: number): void => {
  db.prepare("INSERT INTO t VALUES (?)").run(x);
};

describe("readTransaction", () => {
  it("does not stop a writer on a second connection, and reads one snapshot", () => {
    const seen = readTransaction(reader, () => {
      const before = count(reader);
      insert(writer, 2);
      return [before, count(reader), count(writer)];
    });
    expect(seen).toEqual([1, 1, 2]);
    expect(count(reader)).toBe(2);
  });

  it("starts the snapshot at the call, before the first read of the work", () => {
    const seen = readTransaction(reader, () => {
      insert(writer, 2);
      return count(reader);
    });
    expect(seen).toBe(1);
  });

  it("is a fair contrast: the write transaction stops the same writer", () => {
    transaction(reader, () => {
      expect(() => {
        insert(writer, 2);
      }).toThrow(/locked|busy/i);
    });
    expect(count(writer)).toBe(1);
  });

  it("refuses a write in the work, and the connection writes again after it", () => {
    expect(() =>
      readTransaction(reader, () => {
        insert(reader, 2);
      }),
    ).toThrow(/readonly/i);
    expect(reader.isTransaction).toBe(false);
    expect(queryOnly(reader)).toBe(0);
    insert(reader, 3);
    expect(count(reader)).toBe(2);
  });

  it("rolls back and throws the error of the work, and gives the result of the work", () => {
    expect(() =>
      readTransaction(reader, () => {
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(reader.isTransaction).toBe(false);
    expect(queryOnly(reader)).toBe(0);
    expect(readTransaction(reader, () => count(reader) * 10)).toBe(10);
  });

  it("refuses a work that gives a promise", () => {
    expect(() => readTransaction(reader, () => Promise.resolve(1))).toThrow(/must be synchronous/);
    expect(reader.isTransaction).toBe(false);
  });

  it("keeps query_only on when the connection had it on", () => {
    reader.exec("PRAGMA query_only = ON");
    readTransaction(reader, () => count(reader));
    expect(queryOnly(reader)).toBe(1);
  });

  it("refuses a call in a transaction by default, and uses a savepoint with nested savepoint", () => {
    transaction(reader, () => {
      insert(reader, 2);
      expect(() => readTransaction(reader, () => count(reader))).toThrow(/within a transaction/);
      expect(readTransaction(reader, () => count(reader), { nested: "savepoint" })).toBe(2);
      expect(() => readTransaction(reader, () => insert(reader, 3), { nested: "savepoint" })).toThrow(/readonly/i);
      insert(reader, 4);
    });
    expect(count(reader)).toBe(3);
    expect(queryOnly(reader)).toBe(0);
  });

  it("refuses a write transaction in the work", () => {
    expect(() => readTransaction(reader, () => transaction(reader, () => insert(reader, 2), { nested: "savepoint" }))).toThrow(/readonly/i);
    expect(count(reader)).toBe(1);
  });
});
