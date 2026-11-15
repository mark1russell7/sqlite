// The adapter of sql.js, on the real driver: the members of a connection, and each part of the portable entry.
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { describePortable } from "./conformance.ts";
import { sqlJsConnection, type SqlJsConnection, type SqlJsDatabase } from "./portable.ts";

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

/** This function opens a new connection to a database in memory. */
function open(): SqlJsConnection {
  return sqlJsConnection(new SQL.Database());
}

/** This function runs the work on a new connection, and closes the connection after it. */
function withDb<T>(work: (db: SqlJsConnection) => T): T {
  const db = open();
  try {
    return work(db);
  } finally {
    db.close();
  }
}

describe("the members of a connection of sql.js", () => {
  it("gives the first row, each row, the changes and the last row id", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT)");
      expect(db.prepare("SELECT v FROM t").get()).toBeUndefined();
      const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
      expect(insert.run("a")).toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(insert.run("b")).toEqual({ changes: 1, lastInsertRowid: 2 });
      expect(db.prepare("SELECT k, v FROM t ORDER BY k").get()).toEqual({ k: 1, v: "a" });
      expect(db.prepare("SELECT k, v FROM t ORDER BY k").all()).toEqual([
        { k: 1, v: "a" },
        { k: 2, v: "b" },
      ]);
      expect([...db.prepare("SELECT v FROM t WHERE k > ?").iterate(1)]).toEqual([{ v: "b" }]);
      expect(db.prepare("UPDATE t SET v = ?").run("c")).toEqual({ changes: 2, lastInsertRowid: 2 });
    });
  });

  it("binds each type of value, and clears the bindings after each call", () => {
    withDb((db) => {
      const echo = db.prepare("SELECT ? AS value");
      expect(echo.get(null)).toEqual({ value: null });
      expect(echo.get(1.5)).toEqual({ value: 1.5 });
      expect(echo.get(2n ** 52n)).toEqual({ value: 2 ** 52 });
      expect(echo.get("text")).toEqual({ value: "text" });
      expect(echo.get(new Uint8Array([1, 2]))).toEqual({ value: new Uint8Array([1, 2]) });
      expect(echo.get()).toEqual({ value: null });
    });
  });

  it("refuses a bigint that is not a safe integer, and the statement stays usable", () => {
    withDb((db) => {
      const echo = db.prepare("SELECT ? AS value");
      expect(() => echo.get(2n ** 60n)).toThrow(RangeError);
      expect(echo.get(7n)).toEqual({ value: 7 });
    });
  });

  it("tells if a transaction is open, and the check changes nothing", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (v TEXT)");
      expect(db.isTransaction).toBe(false);
      db.exec("BEGIN");
      db.prepare("INSERT INTO t VALUES (?)").run("a");
      expect(db.isTransaction).toBe(true);
      expect(db.isTransaction).toBe(true);
      db.exec("COMMIT");
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "a" }]);
    });
  });

  it("compiles a statement for each call, and frees it after the call", () => {
    const real = new SQL.Database();
    let compiled = 0;
    let freed = 0;
    let closed = false;
    const counted: SqlJsDatabase = {
      exec: (sql) => real.exec(sql),
      prepare: (sql) => {
        compiled += 1;
        const statement = real.prepare(sql);
        return {
          bind: (values) => statement.bind(values),
          step: () => statement.step(),
          getAsObject: () => statement.getAsObject(),
          free: () => {
            freed += 1;
            return statement.free();
          },
        };
      },
      getRowsModified: () => real.getRowsModified(),
      close: () => {
        closed = true;
        real.close();
      },
    };
    const db = sqlJsConnection(counted);
    const one = db.prepare("SELECT 1 AS one");
    const two = db.prepare("SELECT 2 AS two");
    // prepare compiles each SQL text one time, so a bad text throws there
    expect(compiled).toBe(2);
    expect(() => db.prepare("SELECT FROM")).toThrow();
    for (let round = 0; round < 3; round += 1) {
      expect(one.get()).toEqual({ one: 1 });
      expect(two.all()).toEqual([{ two: 2 }]);
    }
    expect(compiled).toBe(9);
    expect(freed).toBe(compiled - 1);
    db.close();
    expect(closed).toBe(true);
  });

  it("keeps each statement usable after an export: sql.js frees its statements there", () => {
    const real = new SQL.Database();
    const db = sqlJsConnection(real);
    try {
      db.exec("CREATE TABLE t (v TEXT)");
      const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
      const count = db.prepare("SELECT count(*) AS n FROM t");
      insert.run("a");
      real.export();
      expect(insert.run("b")).toEqual({ changes: 1, lastInsertRowid: 2 });
      expect(count.get()).toEqual({ n: 2 });
      real.export();
      expect(count.get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  it("keeps a statement usable after an error in a step", () => {
    withDb((db) => {
      db.exec("CREATE TABLE u (k TEXT PRIMARY KEY)");
      const insert = db.prepare("INSERT INTO u VALUES (?)");
      insert.run("a");
      expect(() => insert.run("a")).toThrow(/UNIQUE/);
      expect(insert.run("b").changes).toBe(1);
    });
  });

  it("accepts the real database of the driver as a SqlJsDatabase", () => {
    const real = new SQL.Database();
    const database: SqlJsDatabase = real;
    expect(typeof database.getRowsModified).toBe("function");
    real.close();
  });
});

describePortable("sql.js", open);
