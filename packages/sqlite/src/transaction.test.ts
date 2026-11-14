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

describe("transaction with nested: savepoint", () => {
  const savepoint = { nested: "savepoint" } as const;
  const insert = (x: number): void => {
    db.prepare("INSERT INTO t VALUES (?)").run(x);
  };
  const values = (): number[] => (db.prepare("SELECT x FROM t ORDER BY x").all() as { x: number }[]).map((row) => row.x);

  it("is a plain transaction when no transaction is in progress", () => {
    expect(transaction(db, () => (insert(1), "done"), savepoint)).toBe("done");
    expect(db.isTransaction).toBe(false);
    expect(values()).toEqual([1]);
  });

  it("joins the transaction in progress, and commits with it", () => {
    transaction(db, () => {
      insert(1);
      expect(transaction(db, () => (insert(2), 2), savepoint)).toBe(2);
      expect(db.isTransaction).toBe(true);
      insert(3);
    });
    expect(values()).toEqual([1, 2, 3]);
  });

  it("rolls back only the writes of a failed work, and the transaction in progress continues", () => {
    const failure = new Error("a bug");
    transaction(db, () => {
      insert(1);
      expect(() =>
        transaction(
          db,
          () => {
            insert(2);
            throw failure;
          },
          savepoint,
        ),
      ).toThrow(failure);
      expect(db.isTransaction).toBe(true);
      insert(3);
    });
    expect(values()).toEqual([1, 3]);
  });

  it("loses its writes when the transaction in progress rolls back", () => {
    expect(() =>
      transaction(db, () => {
        transaction(db, () => insert(1), savepoint);
        throw new Error("the outer work fails");
      }),
    ).toThrow("the outer work fails");
    expect(values()).toEqual([]);
  });

  it("nests to more levels, and each failed level rolls back alone", () => {
    transaction(db, () => {
      transaction(
        db,
        () => {
          insert(1);
          expect(() =>
            transaction(
              db,
              () => {
                insert(2);
                transaction(db, () => insert(3), savepoint);
                throw new Error("level 3");
              },
              savepoint,
            ),
          ).toThrow("level 3");
          insert(4);
        },
        savepoint,
      );
    });
    expect(values()).toEqual([1, 4]);
  });

  it("joins a transaction that the caller began with BEGIN", () => {
    db.exec("BEGIN");
    transaction(db, () => insert(1), savepoint);
    expect(db.isTransaction).toBe(true);
    db.exec("COMMIT");
    expect(values()).toEqual([1]);
  });

  it("refuses a work that gives a promise, and rolls back the savepoint", () => {
    transaction(db, () => {
      insert(1);
      expect(() => transaction(db, () => (insert(2), Promise.resolve()), savepoint)).toThrow(/synchronous/);
    });
    expect(values()).toEqual([1]);
  });

  it("throws when the work ends the transaction in progress", () => {
    db.exec("BEGIN");
    expect(() => transaction(db, () => db.exec("COMMIT"), savepoint)).toThrow(/ended the transaction/);
    expect(db.isTransaction).toBe(false);
  });

  it("refuses an unknown value of nested", () => {
    expect(() => transaction(db, () => 1, { nested: "join" as never })).toThrow(RangeError);
  });

  it("gives a failed rollback of a savepoint to onRollbackError", () => {
    const statements: string[] = [];
    const fake: TransactionDatabase = {
      exec(sql: string) {
        statements.push(sql);
        if (sql.startsWith("ROLLBACK TO")) throw new Error("rollback failed");
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
        { nested: "savepoint", onRollbackError: (error) => rollbackErrors.push(error) },
      ),
    ).toThrow("a bug");
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^SAVEPOINT "sqlite_savepoint_\d+"$/);
    expect(statements[1]).toBe(statements[0]?.replace("SAVEPOINT", "ROLLBACK TO"));
    expect(rollbackErrors).toEqual([new Error("rollback failed")]);
  });
});
