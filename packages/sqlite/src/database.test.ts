import { accessSync, chmodSync, constants, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpoint } from "./checkpoint.ts";
import { openDatabase } from "./database.ts";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-database-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("sets WAL, the synchronous FULL and no busy timeout by default", () => {
    const db = openDatabase(join(folder, "a.db"));
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
    db.close();
  });

  it("sets the pragmas of the options", () => {
    const db = openDatabase(join(folder, "a.db"), { wal: false, synchronous: "NORMAL", busyTimeoutMs: 5000 });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    db.close();
  });

  it("makes the folder of the file only with makeFolder", () => {
    const path = join(folder, "x", "y", "a.db");
    expect(() => openDatabase(path)).toThrow();
    expect(existsSync(join(folder, "x"))).toBe(false);
    openDatabase(path, { makeFolder: true, folderMode: 0o700 }).close();
    expect(existsSync(path)).toBe(true);
  });

  it("refuses a bad synchronous or busy timeout before it opens the file", () => {
    const path = join(folder, "a.db");
    expect(() => openDatabase(path, { busyTimeoutMs: -1 })).toThrow(RangeError);
    expect(() => openDatabase(path, { busyTimeoutMs: 1.5 })).toThrow(RangeError);
    expect(() => openDatabase(path, { synchronous: "FULL; DROP TABLE x" as "FULL" })).toThrow(RangeError);
    expect(existsSync(path)).toBe(false);
  });

  it("opens a database with no file", () => {
    const db = openDatabase(":memory:", { makeFolder: true });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "memory" });
    db.close();
  });

  it("turns on foreign keys", () => {
    const db = openDatabase(":memory:");
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close();
  });
});

describe("openDatabase with readOnly", () => {
  it("reads the file, keeps its journal mode, and refuses each write", () => {
    const path = join(folder, "a.db");
    const writer = openDatabase(path, { wal: false });
    writer.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a')");
    writer.close();
    const db = openDatabase(path, { readOnly: true, busyTimeoutMs: 100 });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 100 });
    expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "a" }]);
    expect(() => db.exec("INSERT INTO t VALUES ('b')")).toThrow(/readonly/i);
    db.close();
  });

  it("reads a WAL file", () => {
    const path = join(folder, "a.db");
    const writer = openDatabase(path);
    writer.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a')");
    const db = openDatabase(path, { readOnly: true });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "a" }]);
    db.close();
    writer.close();
  });

  it("throws when the file is not there, and makes no file", () => {
    const path = join(folder, "missing.db");
    expect(() => openDatabase(path, { readOnly: true })).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("refuses wal: true, makeFolder: true and an unknown wal before it opens the file", () => {
    const path = join(folder, "x", "a.db");
    expect(() => openDatabase(path, { readOnly: true, wal: true })).toThrow(RangeError);
    expect(() => openDatabase(path, { readOnly: true, makeFolder: true })).toThrow(RangeError);
    expect(() => openDatabase(path, { wal: "always" as never, makeFolder: true })).toThrow(RangeError);
    expect(existsSync(join(folder, "x"))).toBe(false);
  });
});

describe("openDatabase with wal: when-writable", () => {
  it("sets WAL on a file that the process can write", () => {
    const db = openDatabase(join(folder, "a.db"), { wal: "when-writable" });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  });

  it("keeps the journal mode of a file that the process cannot write, where wal: true throws", () => {
    const path = join(folder, "a.db");
    const writer = openDatabase(path, { wal: false });
    writer.exec("CREATE TABLE t (v TEXT)");
    writer.close();
    chmodSync(path, 0o444);
    try {
      let writable = true;
      try {
        accessSync(path, constants.W_OK);
      } catch {
        writable = false;
      }
      // A process of the superuser can write each file, so then the open sets WAL
      const db = openDatabase(path, { wal: "when-writable" });
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: writable ? "wal" : "delete" });
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
      db.close();
      if (!writable) expect(() => openDatabase(path)).toThrow(/readonly/i);
    } finally {
      chmodSync(path, 0o644);
    }
  });
});

describe("checkpoint on a WAL file", () => {
  it("copies the log into the file, and TRUNCATE makes the log empty", () => {
    const path = join(folder, "a.db");
    const db = openDatabase(path);
    db.exec("CREATE TABLE t (v TEXT)");
    for (let i = 0; i < 20; i += 1) db.prepare("INSERT INTO t VALUES (?)").run(String(i));
    const passive = checkpoint(db);
    expect(passive.busy).toBe(false);
    expect(passive.log).toBeGreaterThan(0);
    expect(passive.checkpointed).toBe(passive.log);
    expect(checkpoint(db, "TRUNCATE")).toEqual({ busy: false, log: 0, checkpointed: 0 });
    expect(statSync(`${path}-wal`).size).toBe(0);
    db.close();
  });
});
