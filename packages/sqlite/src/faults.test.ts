import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogRecord } from "./event-log.ts";
import { openEventLog } from "./event-log-file.ts";
import { sqliteFault } from "./faults.ts";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-faults-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** This function gives the error that a work throws. */
function errorOf(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("The work did not throw.");
}

describe("sqliteFault", () => {
  it("gives the kind and the action of real errors of node:sqlite", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('a')");
    expect(sqliteFault(errorOf(() => db.exec("SELEC 1")))).toMatchObject({ kind: "sql", action: "bug", code: 1, extendedCode: 1 });
    expect(sqliteFault(errorOf(() => db.exec("INSERT INTO t VALUES ('a')")))).toMatchObject({
      kind: "constraint",
      action: "bug",
      code: 19,
      extendedCode: 1555,
      message: "UNIQUE constraint failed: t.id",
    });
    db.close();
  });

  it("tells a busy file from a broken one", () => {
    const file = join(folder, "busy.db");
    const first = new DatabaseSync(file);
    first.exec("PRAGMA journal_mode = WAL; CREATE TABLE x (v)");
    first.exec("BEGIN IMMEDIATE");
    const second = new DatabaseSync(file);
    expect(sqliteFault(errorOf(() => second.exec("BEGIN IMMEDIATE")))).toMatchObject({ kind: "busy", action: "retry", code: 5 });
    first.exec("ROLLBACK");
    first.close();
    second.close();

    const junk = join(folder, "junk.db");
    writeFileSync(junk, "This text is not a database. ".repeat(200));
    const broken = new DatabaseSync(junk);
    expect(sqliteFault(errorOf(() => broken.exec("SELECT * FROM sqlite_master")))).toMatchObject({ kind: "not-a-database", action: "quarantine", code: 26 });
    broken.close();

    expect(sqliteFault(errorOf(() => new DatabaseSync(join(folder, "no", "such", "folder", "x.db"))))).toMatchObject({
      kind: "cannot-open",
      action: "operator",
      code: 14,
    });
  });

  it("finds the fault in the causes of the error of a broken log", () => {
    const file = join(folder, "log.db");
    const log = openEventLog(file, (value) => value as LogRecord);
    const other = new DatabaseSync(file);
    other.exec("CREATE TRIGGER refuse BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'no'); END");
    errorOf(() => log.append({ id: "a", at: "2026-11-14T00:00:00Z", type: "note" }));
    const fault = sqliteFault(errorOf(() => log.count()));
    expect(fault).toMatchObject({ kind: "constraint", action: "bug" });
    expect(fault?.error.message).toBe("no");
    other.close();
    log.close();
  });

  it("gives undefined for an error that is not of SQLite", () => {
    expect(sqliteFault(new Error("other"))).toBeUndefined();
    expect(sqliteFault("text")).toBeUndefined();
    expect(sqliteFault(undefined)).toBeUndefined();
    expect(sqliteFault(Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR" }))).toBeUndefined();
  });

  it("gives the kind other for an unknown code, and stops on a cycle of causes", () => {
    const unknown = Object.assign(new Error("new code"), { code: "ERR_SQLITE_ERROR", errcode: 99 });
    expect(sqliteFault(unknown)).toMatchObject({ kind: "other", action: "operator", code: 99 });
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(sqliteFault(a)).toBeUndefined();
  });
});
