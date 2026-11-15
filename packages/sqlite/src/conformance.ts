// The one suite of the portable entry for each adapter: node:sqlite, SQLite in WebAssembly and sql.js. A test file of an
// adapter calls `describePortable`. This file is not a test file, so vitest does not run it alone.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addMissingColumns,
  checkpoint,
  clearDatabase,
  ensureProjection,
  eventLog,
  migrate,
  readTransaction,
  schemaVersion,
  tableColumns,
  transaction,
  userVersion,
  type LogRecord,
  type SqlConnection,
} from "./portable.ts";
import { isInTransaction } from "./probe.ts";

/** A connection of an adapter that the suite can close. */
export interface ClosableConnection extends SqlConnection {
  close(): void;
}

interface Fact extends LogRecord {
  readonly value: number;
}

const parse = (value: unknown): Fact => value as Fact;
const fact = (id: number, value = id * 7): Fact => ({ id: `e${String(id)}`, at: "2026-11-15T00:00:00Z", type: id % 2 === 0 ? "report" : "ack", value });
const facts = fc.array(fc.integer({ min: 0, max: 12 }).map((id) => fact(id)), { maxLength: 30 });

/**
 * This function declares the tests of the portable entry on the connections of one adapter.
 *
 * @param name - The name of the adapter.
 * @param open - The function that opens a new connection to a database in memory.
 */
export function describePortable(name: string, open: () => ClosableConnection): void {
  /** This function does the work on a new connection, and closes the connection after it. */
  function withDb<T>(work: (db: ClosableConnection) => T): T {
    const db = open();
    try {
      return work(db);
    } finally {
      db.close();
    }
  }

  describe(`the portable entry on ${name}`, () => {
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
        expect(isInTransaction(db)).toBe(false);
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
        expect(isInTransaction(db)).toBe(false);
      });
    });

    it("runs a dry run: the work sees its writes, and the database does not keep them", () => {
      withDb((db) => {
        db.exec("CREATE TABLE t (v TEXT)");
        const insert = db.prepare("INSERT INTO t VALUES (?)");
        const count = (): unknown => db.prepare("SELECT count(*) AS n FROM t").get();
        expect(
          transaction(
            db,
            () => {
              insert.run("trial");
              return count();
            },
            { commit: false },
          ),
        ).toEqual({ n: 1 });
        expect(count()).toEqual({ n: 0 });
        expect(isInTransaction(db)).toBe(false);
        transaction(db, () => {
          insert.run("kept");
          expect(transaction(db, () => insert.run("trial").changes, { nested: "savepoint", commit: false })).toBe(1);
          expect(count()).toEqual({ n: 1 });
        });
        expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "kept" }]);
      });
    });

    it("reads in a read transaction, refuses a write there, and restores query_only", () => {
      withDb((db) => {
        db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a')");
        expect(readTransaction(db, () => db.prepare("SELECT v FROM t").all())).toEqual([{ v: "a" }]);
        expect(() => readTransaction(db, () => db.prepare("INSERT INTO t VALUES (?)").run("b"))).toThrow(/readonly/i);
        expect(isInTransaction(db)).toBe(false);
        expect(db.prepare("PRAGMA query_only").get()).toEqual({ query_only: 0 });
        db.prepare("INSERT INTO t VALUES (?)").run("c");
        expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
      });
    });

    it("clears each view and table, and migrates again from version 0", () => {
      withDb((db) => {
        const steps = [
          "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (p INTEGER REFERENCES parent(id))",
          "CREATE INDEX child_p ON child (p); CREATE VIEW both_rows AS SELECT * FROM parent JOIN child ON child.p = parent.id",
          "CREATE TRIGGER parent_gone AFTER DELETE ON parent BEGIN DELETE FROM child WHERE p = old.id; END",
        ];
        migrate(db, steps);
        migrate(db, ["CREATE TABLE lib (y TEXT)"], { part: "lib" });
        db.exec("INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1)");
        const before = db.prepare("PRAGMA foreign_keys").get();
        // The views go first, and then the tables, each in the order of the names
        expect(clearDatabase(db)).toEqual(["both_rows", "child", "lib", "parent", "schema_versions"]);
        expect(db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all()).toEqual([]);
        expect(userVersion(db)).toBe(0);
        expect(db.prepare("PRAGMA foreign_keys").get()).toEqual(before);
        expect(migrate(db, steps)).toEqual({ from: 0, to: 3 });
        expect(clearDatabase(db, { vacuum: false })).toEqual(["both_rows", "child", "parent"]);
      });
    });

    it("refuses a clear and a checkpoint in a transaction", () => {
      withDb((db) => {
        db.exec("CREATE TABLE t (v TEXT)");
        transaction(db, () => {
          expect(() => clearDatabase(db)).toThrow(/in a transaction/);
          expect(() => checkpoint(db)).toThrow(/in a transaction/);
        });
        expect(tableColumns(db, "t")).toEqual(["v"]);
      });
    });

    it("gives -1 for the checkpoint of a database that is not in WAL mode, and refuses an unknown mode", () => {
      withDb((db) => {
        expect(checkpoint(db, "TRUNCATE")).toEqual({ busy: false, log: -1, checkpointed: -1 });
        expect(() => checkpoint(db, "SOON" as never)).toThrow(RangeError);
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
}
