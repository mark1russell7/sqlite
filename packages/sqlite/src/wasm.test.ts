// The adapter of SQLite in WebAssembly, on the real driver: the members of a connection, and each part of the portable entry.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { describePortable } from "./conformance.ts";
import { wasmConnection, type WasmConnection, type WasmDatabase, type WasmModule } from "./portable.ts";

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

let sqlite3: Sqlite3;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

/** This function opens a new connection to a database in memory. */
function open(): WasmConnection {
  return wasmConnection(sqlite3, new sqlite3.oo1.DB(":memory:", "c"));
}

/** This function runs the work on a new connection, and closes the connection after it. */
function withDb<T>(work: (db: WasmConnection) => T): T {
  const db = open();
  try {
    return work(db);
  } finally {
    db.close();
  }
}

describe("the members of a connection", () => {
  it("gives the first row, each row, and undefined when there is no row", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT)");
      expect(db.prepare("SELECT v FROM t").get()).toBeUndefined();
      const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
      expect(insert.run("a")).toEqual({ changes: 1, lastInsertRowid: 1n });
      expect(insert.run("b")).toEqual({ changes: 1, lastInsertRowid: 2n });
      expect(db.prepare("SELECT k, v FROM t ORDER BY k").get()).toEqual({ k: 1, v: "a" });
      expect(db.prepare("SELECT k, v FROM t ORDER BY k").all()).toEqual([
        { k: 1, v: "a" },
        { k: 2, v: "b" },
      ]);
      expect([...db.prepare("SELECT v FROM t WHERE k > ?").iterate(1)]).toEqual([{ v: "b" }]);
      expect(db.prepare("UPDATE t SET v = ?").run("c").changes).toBe(2);
    });
  });

  it("binds each type of value, and clears the bindings after each call", () => {
    withDb((db) => {
      const echo = db.prepare("SELECT ? AS value");
      expect(echo.get(null)).toEqual({ value: null });
      expect(echo.get(1.5)).toEqual({ value: 1.5 });
      expect(echo.get(2n ** 60n)).toEqual({ value: 2n ** 60n });
      expect(echo.get("text")).toEqual({ value: "text" });
      expect(echo.get(new Uint8Array([1, 2]))).toEqual({ value: new Uint8Array([1, 2]) });
      expect(echo.get()).toEqual({ value: null });
    });
  });

  it("tells if a transaction is open", () => {
    withDb((db) => {
      expect(db.isTransaction).toBe(false);
      db.exec("BEGIN");
      expect(db.isTransaction).toBe(true);
      db.exec("COMMIT");
      expect(db.isTransaction).toBe(false);
    });
  });

  it("compiles each SQL text one time, and finalizes each statement at close", () => {
    const real = new sqlite3.oo1.DB(":memory:", "c");
    let compiled = 0;
    let finalized = 0;
    const counted: WasmDatabase = {
      get pointer() {
        return real.pointer;
      },
      exec: (sql) => real.exec(sql),
      prepare: (sql) => {
        compiled += 1;
        const statement = real.prepare(sql);
        return {
          bind: (values) => statement.bind(values),
          step: () => statement.step(),
          get: (row) => statement.get(row),
          reset: (clear) => statement.reset(clear),
          finalize: () => {
            finalized += 1;
            return statement.finalize();
          },
        };
      },
      changes: () => real.changes(),
      close: () => real.close(),
    };
    const db = wasmConnection(sqlite3, counted);
    for (let round = 0; round < 3; round += 1) {
      db.prepare("SELECT 1 AS one").get();
      db.prepare("SELECT 2 AS two").all();
    }
    expect(compiled).toBe(2);
    db.close();
    expect(finalized).toBe(2);
    expect(real.isOpen()).toBe(false);
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

  it("accepts the real module of the driver as a WasmModule", () => {
    const module: WasmModule = sqlite3;
    expect(typeof module.capi.sqlite3_get_autocommit).toBe("function");
  });
});

describePortable("SQLite in WebAssembly", open);
