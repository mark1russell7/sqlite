import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { migrate, userVersion, type Migration } from "./migrate.ts";

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
