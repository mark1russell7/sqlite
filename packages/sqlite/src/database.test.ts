import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
