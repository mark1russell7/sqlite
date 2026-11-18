// The synced transaction: FULL for its own commit, the earlier setting after it, and the rules of `transaction`.
// The power-cut test (`power/`) examines that the disk keeps the synced commit. These tests examine the setting.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { syncedTransaction, transaction } from "./transaction.ts";

let folder: string;
let db: DatabaseSync;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-synced-transaction-"));
  db = openDatabase(join(folder, "a.db"), { synchronous: "NORMAL" });
  db.exec("CREATE TABLE t (x INTEGER)");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // The test closed the connection
  }
  rmSync(folder, { recursive: true, force: true });
});

const count = (): number => (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
/** The value of `PRAGMA synchronous`: 0 OFF, 1 NORMAL, 2 FULL and 3 EXTRA. */
const synchronous = (): number => (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
const insert = (x: number): void => {
  db.prepare("INSERT INTO t VALUES (?)").run(x);
};

describe("syncedTransaction", () => {
  it("commits with FULL, sets NORMAL again, and gives the result of the work", () => {
    const during: number[] = [];
    const result = syncedTransaction(db, () => {
      during.push(synchronous());
      insert(1);
      insert(2);
      return "done";
    });
    expect(result).toBe("done");
    expect(during).toEqual([2]);
    expect(synchronous()).toBe(1);
    expect(count()).toBe(2);
    expect(db.isTransaction).toBe(false);
  });

  it("sets OFF again after its commit", () => {
    db.exec("PRAGMA synchronous = OFF");
    let during = -1;
    syncedTransaction(db, () => {
      during = synchronous();
      insert(1);
    });
    expect(during).toBe(2);
    expect(synchronous()).toBe(0);
  });

  it("keeps FULL and EXTRA as they are", () => {
    for (const [name, value] of [
      ["FULL", 2],
      ["EXTRA", 3],
    ] as const) {
      db.exec(`PRAGMA synchronous = ${name}`);
      let during = -1;
      syncedTransaction(db, () => {
        during = synchronous();
        insert(value);
      });
      expect(during).toBe(value);
      expect(synchronous()).toBe(value);
    }
    expect(count()).toBe(2);
  });

  it("rolls back after an error of the work, sets NORMAL again, and throws the same error", () => {
    const failure = new Error("the work failed");
    expect(() =>
      syncedTransaction(db, () => {
        insert(1);
        throw failure;
      }),
    ).toThrow(failure);
    expect(count()).toBe(0);
    expect(synchronous()).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it("refuses a work that gives a promise, and sets NORMAL again", () => {
    expect(() => syncedTransaction(db, () => Promise.resolve(insert(1)))).toThrow(TypeError);
    expect(count()).toBe(0);
    expect(synchronous()).toBe(1);
  });

  it("rolls back a dry run, and sets NORMAL again", () => {
    const seen = syncedTransaction(
      db,
      () => {
        insert(1);
        return count();
      },
      { commit: false },
    );
    expect(seen).toBe(1);
    expect(count()).toBe(0);
    expect(synchronous()).toBe(1);
  });

  it("throws in a transaction in progress, also with nested savepoint, and changes nothing", () => {
    transaction(db, () => {
      insert(1);
      for (const options of [{}, { nested: "savepoint" as const }]) {
        expect(() => syncedTransaction(db, () => insert(2), options)).toThrow("A synced transaction needs its own commit");
      }
      expect(synchronous()).toBe(1);
      expect(db.isTransaction).toBe(true);
    });
    expect(count()).toBe(1);
  });

  it("refuses a value of nested or commit that is not correct, and sets NORMAL again", () => {
    expect(() => syncedTransaction(db, () => insert(1), { nested: "join" as never })).toThrow(RangeError);
    expect(() => syncedTransaction(db, () => insert(1), { commit: "yes" as never })).toThrow(TypeError);
    expect(count()).toBe(0);
    expect(synchronous()).toBe(1);
  });

  it("throws the work error when a failed rollback keeps the transaction, and gives the restore error to onRollbackError", () => {
    // This connection refuses the ROLLBACK, so the transaction stays. SQLite then refuses the change of synchronous.
    const stuck = {
      exec: (sql: string): void => {
        if (sql === "ROLLBACK") throw new Error("the rollback failed");
        db.exec(sql);
      },
      prepare: (sql: string) => db.prepare(sql),
      get isTransaction() {
        return db.isTransaction;
      },
    };
    const work = new Error("the work failed");
    const later: unknown[] = [];
    expect(() =>
      syncedTransaction(
        stuck,
        () => {
          insert(1);
          throw work;
        },
        { onRollbackError: (error) => later.push(error) },
      ),
    ).toThrow(work);
    expect(later.map((error) => (error as Error).message)).toEqual(["the rollback failed", expect.stringMatching(/transaction/i)]);
    expect(db.isTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(count()).toBe(0);
    // The restore did not happen, so the connection keeps FULL. That setting syncs more, and loses no commit.
    expect(synchronous()).toBe(2);
  });

  it("throws the restore error after a commit, and keeps the commit", () => {
    const failing = {
      exec: (sql: string): void => {
        if (sql === "PRAGMA synchronous = 1") throw new Error("the restore failed");
        db.exec(sql);
      },
      prepare: (sql: string) => db.prepare(sql),
      get isTransaction() {
        return db.isTransaction;
      },
    };
    expect(() => syncedTransaction(failing, () => insert(1))).toThrow("the restore failed");
    expect(count()).toBe(1);
    expect(synchronous()).toBe(2);
  });
});
