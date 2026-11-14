import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { migrate, schemaVersion, userVersion } from "./migrate.ts";
import { ensureProjection } from "./projection.ts";
import { transaction } from "./transaction.ts";

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  if (db.isOpen) db.close();
});

const objects = (): string[] =>
  (db.prepare("SELECT type || ' ' || name AS object FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { object: string }[]).map(
    (row) => row.object,
  );
const rows = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const SCHEMA_1 = "CREATE TABLE pages (url TEXT PRIMARY KEY, text TEXT NOT NULL); CREATE VIRTUAL TABLE pages_fts USING fts5 (text)";
const SCHEMA_2 = "CREATE TABLE pages (url TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT); CREATE VIRTUAL TABLE pages_fts USING fts5 (text)";

describe("ensureProjection", () => {
  it("makes the schema in a new file, and gives rebuilt", () => {
    expect(ensureProjection(db, SCHEMA_1, { version: 1 })).toEqual({ rebuilt: true, from: 0 });
    expect(userVersion(db)).toBe(1);
    expect(objects()).toContain("table pages");
  });

  it("keeps a file of the same version and its rows", () => {
    ensureProjection(db, SCHEMA_1, { version: 1 });
    db.exec("INSERT INTO pages VALUES ('a', 'one')");
    expect(ensureProjection(db, SCHEMA_1, { version: 1 })).toEqual({ rebuilt: false, from: 1 });
    expect(rows("pages")).toBe(1);
  });

  it("opens a file of an older or a newer version empty, with its virtual tables and views", () => {
    ensureProjection(db, SCHEMA_1, { version: 1 });
    db.exec("INSERT INTO pages VALUES ('a', 'one'); INSERT INTO pages_fts VALUES ('one'); CREATE VIEW recent AS SELECT url FROM pages");
    expect(ensureProjection(db, SCHEMA_2, { version: 2 })).toEqual({ rebuilt: true, from: 1 });
    expect(rows("pages")).toBe(0);
    expect(rows("pages_fts")).toBe(0);
    expect(objects()).not.toContain("view recent");
    expect(userVersion(db)).toBe(2);

    db.exec("INSERT INTO pages VALUES ('b', 'two', NULL)");
    expect(ensureProjection(db, SCHEMA_1, { version: 1 })).toEqual({ rebuilt: true, from: 2 });
    expect(rows("pages")).toBe(0);
    expect(userVersion(db)).toBe(1);
  });

  it("opens empty when the check of the file gives false", () => {
    ensureProjection(db, SCHEMA_1, { version: 1 });
    db.exec("INSERT INTO pages VALUES ('a', 'one')");
    const check = (conn: DatabaseSync): boolean => conn.prepare("SELECT 1 FROM sqlite_master WHERE name = 'meta'").get() !== undefined;
    expect(ensureProjection(db, `${SCHEMA_1}; CREATE TABLE meta (k TEXT)`, { version: 1, check })).toEqual({ rebuilt: true, from: 1 });
    expect(rows("pages")).toBe(0);
    expect(ensureProjection(db, SCHEMA_1, { version: 1, check })).toEqual({ rebuilt: false, from: 1 });
  });

  it("removes only the tables of a part, and keeps the tables and the version of the app", () => {
    migrate(db, ["CREATE TABLE notes (id TEXT PRIMARY KEY)"]);
    db.exec("INSERT INTO notes VALUES ('n1')");
    const options = { version: 1, part: "search", tables: ["pages", "pages_fts"] };
    expect(ensureProjection(db, SCHEMA_1, options)).toEqual({ rebuilt: true, from: 0 });
    db.exec("INSERT INTO pages VALUES ('a', 'one')");
    expect(ensureProjection(db, SCHEMA_2, { ...options, version: 2 })).toEqual({ rebuilt: true, from: 1 });
    expect(rows("pages")).toBe(0);
    expect(rows("notes")).toBe(1);
    expect(schemaVersion(db, "search")).toBe(2);
    expect(userVersion(db)).toBe(1);
  });

  it("is a savepoint in a transaction of the caller, and rolls back with it", () => {
    ensureProjection(db, SCHEMA_1, { version: 1 });
    db.exec("INSERT INTO pages VALUES ('a', 'one')");
    expect(() =>
      transaction(db, () => {
        expect(ensureProjection(db, SCHEMA_2, { version: 2 }).rebuilt).toBe(true);
        throw new Error("the caller fails");
      }),
    ).toThrow("the caller fails");
    expect(userVersion(db)).toBe(1);
    expect(rows("pages")).toBe(1);
  });

  it("rolls back a schema that fails, and keeps the old projection", () => {
    ensureProjection(db, SCHEMA_1, { version: 1 });
    db.exec("INSERT INTO pages VALUES ('a', 'one')");
    expect(() => ensureProjection(db, "CREATE TABLE pages (", { version: 2 })).toThrow();
    expect(userVersion(db)).toBe(1);
    expect(rows("pages")).toBe(1);
  });

  it("refuses a bad version, a part without tables and a bad table name", () => {
    expect(() => ensureProjection(db, SCHEMA_1, { version: 0 })).toThrow(RangeError);
    expect(() => ensureProjection(db, SCHEMA_1, { version: 1.5 })).toThrow(RangeError);
    expect(() => ensureProjection(db, SCHEMA_1, { version: 1, part: "search" })).toThrow(/needs the list of its tables/);
    expect(() => ensureProjection(db, SCHEMA_1, { version: 1, part: "search", tables: ["sqlite_master"] })).toThrow(RangeError);
    expect(objects()).toEqual([]);
  });
});
