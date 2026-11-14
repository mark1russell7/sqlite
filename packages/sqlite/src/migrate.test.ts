import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { addMissingColumns, migrate, SCHEMA_VERSIONS_TABLE, schemaVersion, tableColumns, userVersion, type Migration } from "./migrate.ts";

let folder: string;
let file: string;
const open: DatabaseSync[] = [];

function connect(): DatabaseSync {
  const db = openDatabase(file);
  open.push(db);
  return db;
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-migrate-"));
  file = join(folder, "a.db");
});

afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  rmSync(folder, { recursive: true, force: true });
});

const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);

const steps: Migration[] = ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y INTEGER)"];

describe("migrate", () => {
  it("does each step, and sets the user_version to the count of steps", () => {
    const db = connect();
    expect(migrate(db, steps)).toEqual({ from: 0, to: 2 });
    expect(userVersion(db)).toBe(2);
    expect(tables(db)).toEqual(["a", "b"]);
  });

  it("does only the new steps of a file", () => {
    const db = connect();
    migrate(db, steps.slice(0, 1));
    const seen: number[] = [];
    const third: Migration = (each) => {
      seen.push(userVersion(each));
      each.exec("CREATE TABLE c (z INTEGER)");
    };
    expect(migrate(db, [...steps, third])).toEqual({ from: 1, to: 3 });
    expect(seen).toEqual([2]);
    expect(tables(db)).toEqual(["a", "b", "c"]);
    expect(migrate(db, [...steps, third])).toEqual({ from: 3, to: 3 });
  });

  it("refuses a file from a newer version, with the name of the database", () => {
    const db = connect();
    migrate(db, steps);
    expect(() => migrate(db, steps.slice(0, 1))).toThrow("The database has the schema version 2, and this code knows only 1. Use a newer version of the app.");
    expect(() => migrate(db, [], { name: "log" })).toThrow(/^The log has the schema version 2/);
  });

  it("rolls back only the step that fails", () => {
    const db = connect();
    const bad: Migration[] = [steps[0] as Migration, "CREATE TABLE b (y INTEGER); INSERT INTO nothing VALUES (1)"];
    expect(() => migrate(db, bad)).toThrow(/nothing/);
    expect(userVersion(db)).toBe(1);
    expect(tables(db)).toEqual(["a"]);
    expect(db.isTransaction).toBe(false);
  });

  it("reads the version again in the transaction, so a step does not run twice when two connections migrate", () => {
    const first = connect();
    const second = connect();
    let raced = false;
    // Just before the BEGIN of the second connection, the first connection does all the steps.
    const racing = new Proxy(second, {
      get(target, key) {
        if (key === "exec") {
          return (sql: string): void => {
            if (sql === "BEGIN IMMEDIATE" && !raced) {
              raced = true;
              migrate(first, steps);
            }
            target.exec(sql);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect(migrate(racing, steps)).toEqual({ from: 0, to: 2 });
    expect(raced).toBe(true);
    expect(tables(second)).toEqual(["a", "b"]);
  });
});

describe("migrate with parts", () => {
  const other: Migration[] = ["CREATE TABLE c (z INTEGER)"];

  it("keeps a version for each part, and does not change the user_version", () => {
    const db = connect();
    expect(schemaVersion(db, "app")).toBe(0);
    expect(migrate(db, steps, { part: "app" })).toEqual({ from: 0, to: 2 });
    expect(migrate(db, other, { part: "lib" })).toEqual({ from: 0, to: 1 });
    expect(schemaVersion(db, "app")).toBe(2);
    expect(schemaVersion(db, "lib")).toBe(1);
    expect(schemaVersion(db)).toBe(0);
    expect(userVersion(db)).toBe(0);
    expect(tables(db)).toEqual(["a", "b", "c", SCHEMA_VERSIONS_TABLE]);
  });

  it("keeps the parts apart from the user_version of the file", () => {
    const db = connect();
    migrate(db, other);
    expect(migrate(db, steps, { part: "app" })).toEqual({ from: 0, to: 2 });
    expect(userVersion(db)).toBe(1);
    expect(migrate(db, steps, { part: "app" })).toEqual({ from: 2, to: 2 });
  });

  it("refuses a part from a newer version, with the name of the part", () => {
    const db = connect();
    migrate(db, steps, { part: "app" });
    expect(() => migrate(db, other, { part: "app" })).toThrow("The part app has the schema version 2, and this code knows only 1. Use a newer version of the app.");
    expect(() => migrate(db, other, { part: "app", name: "store" })).toThrow(/^The store has the schema version 2/);
  });

  it("rolls back the version of a part with its step", () => {
    const db = connect();
    expect(() => migrate(db, ["CREATE TABLE a (x INTEGER); INSERT INTO nothing VALUES (1)"], { part: "app" })).toThrow(/nothing/);
    expect(schemaVersion(db, "app")).toBe(0);
    expect(tables(db)).toEqual([]);
  });

  it("refuses an empty part name", () => {
    const db = connect();
    expect(() => migrate(db, steps, { part: "" })).toThrow(RangeError);
    expect(() => schemaVersion(db, "")).toThrow(RangeError);
  });
});

describe("tableColumns", () => {
  it("gives the columns of a table in their order, and an empty list for no table", () => {
    const db = connect();
    db.exec("CREATE TABLE t (b TEXT, a INTEGER)");
    expect(tableColumns(db, "t")).toEqual(["b", "a"]);
    expect(tableColumns(db, "missing")).toEqual([]);
  });

  it("refuses a name that is not a plain SQL name", () => {
    const db = connect();
    for (const name of ["a b", "t); DROP TABLE t; --", "sqlite_master", ""]) expect(() => tableColumns(db, name)).toThrow(RangeError);
  });
});

describe("addMissingColumns", () => {
  it("adds only the missing columns, and gives their names", () => {
    const db = connect();
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, Peak_MB REAL)");
    db.exec("INSERT INTO t VALUES ('a', 1.5)");
    expect(addMissingColumns(db, "t", { peak_mb: "REAL", usage: "TEXT", runs: "INTEGER NOT NULL DEFAULT 0" })).toEqual(["usage", "runs"]);
    expect(tableColumns(db, "t")).toEqual(["id", "Peak_MB", "usage", "runs"]);
    expect(db.prepare("SELECT * FROM t").get()).toEqual({ id: "a", Peak_MB: 1.5, usage: null, runs: 0 });
    expect(addMissingColumns(db, "t", { usage: "TEXT", runs: "INTEGER NOT NULL DEFAULT 0" })).toEqual([]);
  });

  it("throws for a table that does not exist", () => {
    const db = connect();
    expect(() => addMissingColumns(db, "missing", { a: "TEXT" })).toThrow(/does not exist/);
  });

  it("examines each column name before it changes the table", () => {
    const db = connect();
    db.exec("CREATE TABLE t (id TEXT)");
    expect(() => addMissingColumns(db, "t", { good: "TEXT", "bad name": "TEXT" })).toThrow(RangeError);
    expect(tableColumns(db, "t")).toEqual(["id"]);
  });

  it("gives the error of SQLite for a definition that ALTER TABLE refuses", () => {
    const db = connect();
    db.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a')");
    expect(() => addMissingColumns(db, "t", { must: "TEXT NOT NULL" })).toThrow(/NOT NULL/);
    expect(tableColumns(db, "t")).toEqual(["id"]);
  });
});

describe("the adoption of a file of an older app", () => {
  /** The first step of the schema: it makes a new file, and it adopts a file of each older version. */
  const baseline: Migration = (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, state TEXT NOT NULL, peak_mb REAL, usage TEXT)");
    addMissingColumns(db, "leases", { peak_mb: "REAL", usage: "TEXT" });
    db.exec("CREATE INDEX IF NOT EXISTS leases_state ON leases (state)");
  };
  const steps: readonly Migration[] = [baseline, "ALTER TABLE leases ADD COLUMN exit_code INTEGER"];

  it("keeps the rows of a file at user_version 0, and gives it the columns of each later version", () => {
    const old = connect();
    old.exec("CREATE TABLE leases (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
    old.exec("INSERT INTO leases VALUES ('l1', 'ended')");
    old.close();

    const db = connect();
    expect(migrate(db, steps)).toEqual({ from: 0, to: 2 });
    expect(tableColumns(db, "leases")).toEqual(["id", "state", "peak_mb", "usage", "exit_code"]);
    expect(db.prepare("SELECT id, state FROM leases").all()).toEqual([{ id: "l1", state: "ended" }]);
  });

  it("adopts a file of a middle version, and gives a new file the same columns", () => {
    const old = connect();
    old.exec("CREATE TABLE leases (id TEXT PRIMARY KEY, state TEXT NOT NULL, peak_mb REAL)");
    expect(migrate(old, steps)).toEqual({ from: 0, to: 2 });
    expect(tableColumns(old, "leases")).toEqual(["id", "state", "peak_mb", "usage", "exit_code"]);

    const fresh = openDatabase(":memory:");
    open.push(fresh);
    migrate(fresh, steps);
    expect(tableColumns(fresh, "leases")).toEqual(tableColumns(old, "leases"));
  });
});
