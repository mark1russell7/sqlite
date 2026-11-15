// The adapter of SQLite in WebAssembly, on the real driver: the members of a connection, and each part of the portable entry.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  eventLog,
  ensureProjection,
  migrate,
  readTransaction,
  schemaVersion,
  tableColumns,
  addMissingColumns,
  transaction,
  userVersion,
  wasmConnection,
  type LogRecord,
  type WasmConnection,
  type WasmDatabase,
  type WasmModule,
} from "./portable.ts";

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

interface Fact extends LogRecord {
  readonly value: number;
}

const parse = (value: unknown): Fact => value as Fact;
const fact = (id: number, value = id * 7): Fact => ({ id: `e${String(id)}`, at: "2026-11-15T00:00:00Z", type: id % 2 === 0 ? "report" : "ack", value });
const facts = fc.array(fc.integer({ min: 0, max: 12 }).map((id) => fact(id)), { maxLength: 30 });

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

describe("the portable entry on SQLite in WebAssembly", () => {
  it("migrates by user_version and by part, and adds the missing columns", () => {
    withDb((db) => {
      expect(migrate(db, ["CREATE TABLE app (x INTEGER)", (d) => d.prepare("INSERT INTO app VALUES (?)").run(1)])).toEqual({ from: 0, to: 2 });
      expect(migrate(db, ["CREATE TABLE app (x INTEGER)", "SELECT 1"])).toEqual({ from: 2, to: 2 });
      expect(migrate(db, ["CREATE TABLE lib (y TEXT)"], { part: "lib" })).toEqual({ from: 0, to: 1 });
      expect(userVersion(db)).toBe(2);
      expect(schemaVersion(db, "lib")).toBe(1);
      expect(addMissingColumns(db, "app", { z: "TEXT" })).toEqual(["z"]);
      expect(tableColumns(db, "app")).toEqual(["x", "z"]);
      expect(() => migrate(db, ["SELECT 1"])).toThrow(/schema version 2/);
      expect(migrate(db, ["SELECT 1"], { newer: "keep" })).toEqual({ from: 2, to: 2 });
    });
  });

  it("rolls back a step that fails, and keeps the steps before it", () => {
    withDb((db) => {
      expect(() => migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (x); SELECT * FROM missing"])).toThrow(/missing/);
      expect(userVersion(db)).toBe(1);
      expect(tableColumns(db, "b")).toEqual([]);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("rebuilds a projection at a new version", () => {
    withDb((db) => {
      const options = { part: "idx", tables: ["idx"] } as const;
      expect(ensureProjection(db, "CREATE TABLE idx (k TEXT)", { ...options, version: 1 })).toEqual({ rebuilt: true, from: 0 });
      db.prepare("INSERT INTO idx VALUES (?)").run("old");
      expect(ensureProjection(db, "CREATE TABLE idx (k TEXT)", { ...options, version: 1 })).toEqual({ rebuilt: false, from: 1 });
      expect(ensureProjection(db, "CREATE TABLE idx (k TEXT, n INTEGER)", { ...options, version: 2 })).toEqual({ rebuilt: true, from: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM idx").get()).toEqual({ n: 0 });
      expect(tableColumns(db, "idx")).toEqual(["k", "n"]);
    });
  });

  it("nests a transaction as a savepoint, and rolls back only the inner work", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (v TEXT)");
      const insert = db.prepare("INSERT INTO t VALUES (?)");
      transaction(db, () => {
        insert.run("outer");
        expect(() =>
          transaction(
            db,
            () => {
              insert.run("inner");
              throw new Error("stop");
            },
            { nested: "savepoint" },
          ),
        ).toThrow("stop");
      });
      expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "outer" }]);
      expect(db.isTransaction).toBe(false);
    });
  });

  it("reads in a read transaction, refuses a write there, and restores query_only", () => {
    withDb((db) => {
      db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a')");
      expect(readTransaction(db, () => db.prepare("SELECT v FROM t").all())).toEqual([{ v: "a" }]);
      expect(() => readTransaction(db, () => db.prepare("INSERT INTO t VALUES (?)").run("b"))).toThrow(/readonly/i);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("PRAGMA query_only").get()).toEqual({ query_only: 0 });
      db.prepare("INSERT INTO t VALUES (?)").run("c");
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
    });
  });

  it("keeps a log: added, duplicate, conflict and refused", () => {
    withDb((db) => {
      const log = eventLog(db, { parse });
      expect(log.append(fact(1))).toEqual({ kind: "added", seq: 1 });
      expect(log.append(fact(1))).toEqual({ kind: "duplicate", seq: 1 });
      expect(log.append(fact(1, 0))).toEqual({ kind: "conflict", seq: 1, stored: fact(1) });
      expect(log.append(fact(2), () => "no")).toEqual({ kind: "refused", problem: "no" });
      expect(log.appendAll([fact(2), fact(3), fact(2)]).map((result) => result.kind)).toEqual(["added", "added", "duplicate"]);
      expect([...log.read({ after: 1, types: ["report"] })]).toEqual([fact(2)]);
      expect([...log.entries({ limit: 1 })]).toEqual([{ seq: 1, event: fact(1) }]);
      expect(log.get("e3")).toEqual({ seq: 3, event: fact(3) });
      expect(log.head()).toBe(3);
      expect(log.count()).toBe(3);
    });
  });

  it("follows the join laws of a grow-only set", () => {
    /** This function gives the set of the events that the batches leave in a new log. */
    const setOf = (...batches: readonly (readonly Fact[])[]): string[] =>
      withDb((db) => {
        const log = eventLog(db, { parse });
        for (const batch of batches) log.appendAll(batch);
        return [...log.read()].map((event) => JSON.stringify(event)).sort();
      });
    fc.assert(
      fc.property(facts, facts, facts, (a, b, c) => {
        expect(setOf(a, a)).toEqual(setOf(a));
        expect(setOf(a, b)).toEqual(setOf(b, a));
        expect(setOf(a, b, c)).toEqual(setOf(c, b, a));
        expect(setOf(a, b, c)).toEqual([...new Set([...a, ...b, ...c].map((event) => JSON.stringify(event)))].sort());
      }),
      { numRuns: 40 },
    );
  });
});
