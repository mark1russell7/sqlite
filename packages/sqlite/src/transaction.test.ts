import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { transaction, type TransactionDatabase } from "./transaction.ts";

let folder: string;
let db: DatabaseSync;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-transaction-"));
  db = openDatabase(join(folder, "a.db"));
  db.exec("CREATE TABLE t (x INTEGER)");
});

afterEach(() => {
  if (db.isOpen) db.close();
  rmSync(folder, { recursive: true, force: true });
});

const count = (): number => (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;

describe("transaction", () => {
  it("commits the work and gives its result", () => {
    const result = transaction(db, () => {
      db.exec("INSERT INTO t VALUES (1), (2)");
      return "done";
    });
    expect(result).toBe("done");
    expect(db.isTransaction).toBe(false);
    expect(count()).toBe(2);
  });

  it("rolls back after an error of the work, and throws the same error", () => {
    const failure = new Error("a bug");
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        throw failure;
      }),
    ).toThrow(failure);
    expect(db.isTransaction).toBe(false);
    expect(count()).toBe(0);
  });

  it("takes the write lock at the start, so the work does not start when a different writer has it", () => {
    const other = new DatabaseSync(join(folder, "a.db"));
    other.exec("BEGIN IMMEDIATE");
    let started = false;
    expect(() =>
      transaction(db, () => {
        started = true;
      }),
    ).toThrow(/locked/);
    expect(started).toBe(false);
    other.exec("ROLLBACK");
    other.close();
  });

  it("refuses a work that gives a promise, and rolls back", () => {
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        return Promise.resolve();
      }),
    ).toThrow(/synchronous/);
    expect(count()).toBe(0);
  });

  it("throws in a transaction, because SQLite refuses a nested BEGIN", () => {
    expect(() => transaction(db, () => transaction(db, () => 1))).toThrow(/within a transaction/);
    expect(db.isTransaction).toBe(false);
  });

  it("gives a failed rollback to onRollbackError, and throws the error of the work", () => {
    const statements: string[] = [];
    const fake: TransactionDatabase = {
      exec(sql: string) {
        statements.push(sql);
        if (sql === "ROLLBACK") throw new Error("rollback failed");
      },
      isTransaction: true,
    };
    const rollbackErrors: unknown[] = [];
    expect(() =>
      transaction(
        fake,
        () => {
          throw new Error("a bug");
        },
        { onRollbackError: (error) => rollbackErrors.push(error) },
      ),
    ).toThrow("a bug");
    expect(statements).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    expect(rollbackErrors).toEqual([new Error("rollback failed")]);
  });
});
