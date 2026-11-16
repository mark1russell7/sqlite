import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConfinableDatabase, confineToFile } from "./confine.ts";
import { openDatabase } from "./database.ts";
import { sqliteFault } from "./faults.ts";
import { eachStatement, type SourcedStatement, type StatementSource } from "./statements.ts";

const HAS_AUTHORIZER = typeof (nodeSqlite.DatabaseSync.prototype as ConfinableDatabase).setAuthorizer === "function";

type Connection = ReturnType<typeof openDatabase>;

let db: Connection;
let prepared: string[];
let source: StatementSource<nodeSqlite.StatementSync>;

beforeEach(() => {
  db = openDatabase(":memory:", { wal: false });
  prepared = [];
  source = {
    prepare: (sql) => {
      prepared.push(sql);
      return db.prepare(sql);
    },
  };
});

afterEach(() => {
  db.close();
});

/** This function runs each statement of a text in order, and gives the text and the rows of each statement. */
function runAll(sql: string): { texts: string[]; rows: unknown[][] } {
  const texts: string[] = [];
  const rows: unknown[][] = [];
  for (const statement of eachStatement(source, sql)) {
    texts.push(statement.sourceSQL);
    rows.push(statement.all());
  }
  return { texts, rows };
}

/** This function gives the error of a call, or fails the test when the call does not throw. */
function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("The call did not throw");
}

/** This function gives the next statement of an iteration, or fails the test when the iteration ended. */
function nextStatement<S>(iterator: Iterator<S, void, undefined>): S {
  const step = iterator.next();
  if (step.done === true) throw new Error("The iteration ended");
  return step.value;
}

describe("eachStatement", () => {
  it("compiles each statement after the run of the statement before it", () => {
    const { texts, rows } = runAll("CREATE TABLE t (x); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); SELECT x FROM t ORDER BY x");
    expect(texts).toEqual(["CREATE TABLE t (x);", "INSERT INTO t VALUES (1);", "INSERT INTO t VALUES (2);", "SELECT x FROM t ORDER BY x"]);
    expect(rows.at(-1)).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it("does not end a statement at a ; in a string or a quoted name", () => {
    const { texts, rows } = runAll("SELECT 'a;b' AS \"c;d\", 1 AS [e;f], 2 AS `g;h`; SELECT 2 AS two");
    expect(texts).toHaveLength(2);
    expect(rows).toEqual([[{ "c;d": "a;b", "e;f": 1, "g;h": 2 }], [{ two: 2 }]]);
  });

  it("does not read -- or /* in a string or a quoted name as a comment", () => {
    const { rows } = runAll("SELECT '-- x;' AS a, '/* y;' AS \"/* z; --\"; SELECT 3 AS b");
    expect(rows).toEqual([[{ a: "-- x;", "/* z; --": "/* y;" }], [{ b: 3 }]]);
  });

  it("skips the comments and the empty statements between two statements", () => {
    const { texts, rows } = runAll("SELECT 1 AS a; -- x; y\n/* z; w */ ;; \t SELECT 2 AS b");
    expect(texts).toEqual(["SELECT 1 AS a;", "SELECT 2 AS b"]);
    expect(rows).toEqual([[{ a: 1 }], [{ b: 2 }]]);
    expect(prepared).toHaveLength(2);
  });

  it("ends at a line comment with no line feed at the end of the text", () => {
    const { texts } = runAll("SELECT 1 AS a; -- x");
    expect(texts).toEqual(["SELECT 1 AS a;"]);
    expect(prepared).toHaveLength(1);
  });

  it("reads a block comment with no end to the end of the text, as SQLite does", () => {
    expect(runAll("SELECT 1 AS a; /* x; SELECT 2").rows).toEqual([[{ a: 1 }]]);
    expect(prepared).toHaveLength(1);
    prepared = [];
    expect(runAll("SELECT 1 AS a /* open").texts).toEqual(["SELECT 1 AS a /* open"]);
    expect(prepared).toHaveLength(1);
  });

  it("reads a text with CRLF line ends", () => {
    const { texts, rows } = runAll("CREATE TABLE t (x);\r\n-- a note\r\nINSERT INTO t VALUES (1);\r\nSELECT x FROM t;\r\n");
    expect(texts).toEqual(["CREATE TABLE t (x);", "INSERT INTO t VALUES (1);", "SELECT x FROM t;"]);
    expect(rows.at(-1)).toEqual([{ x: 1 }]);
  });

  it("keeps the body of a trigger in one statement", () => {
    const { texts, rows } = runAll(
      "CREATE TABLE t (x); CREATE TABLE u (y); " +
        "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO u VALUES (';'); INSERT INTO u VALUES ('b'); END; " +
        "INSERT INTO t VALUES (1); SELECT y FROM u ORDER BY rowid",
    );
    expect(texts).toHaveLength(5);
    expect(texts[2]).toBe("CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO u VALUES (';'); INSERT INTO u VALUES ('b'); END;");
    expect(rows.at(-1)).toEqual([{ y: ";" }, { y: "b" }]);
  });

  it("gives the statements of a text in other scripts than Latin", () => {
    expect(runAll("SELECT 'é;ü' AS a; SELECT '日本;語' AS b").rows).toEqual([[{ a: "é;ü" }], [{ b: "日本;語" }]]);
  });

  it("gives no statement for a text with no statement, and does not call prepare", () => {
    for (const sql of ["", "   ", ";", " ;; \n", "-- c", "/* c */", "/* open", "\r\n;\r\n"]) {
      expect(runAll(sql).texts, JSON.stringify(sql)).toEqual([]);
    }
    expect(prepared).toEqual([]);
  });

  it("gives the error of prepare for a vertical tab, because SQLite does not read it as a space", () => {
    expect(String(errorOf(() => runAll("\vSELECT 1")))).toMatch(/unrecognized token/);
  });

  it("throws at a statement that does not compile, and the earlier statements stay done", () => {
    db.exec("CREATE TABLE t (x)");
    const iterator = eachStatement(source, "INSERT INTO t VALUES (1); SELEC 2; INSERT INTO t VALUES (3)");
    nextStatement(iterator).run();
    expect(String(errorOf(() => iterator.next()))).toMatch(/syntax error/);
    expect(db.prepare("SELECT x FROM t").all()).toEqual([{ x: 1 }]);
    expect(prepared).toHaveLength(2);
  });

  it("throws when the text of a statement is not the start of the remaining text", () => {
    const other: StatementSource<SourcedStatement> = { prepare: () => ({ sourceSQL: "SELECT 2;" }) };
    const empty: StatementSource<SourcedStatement> = { prepare: () => ({ sourceSQL: "" }) };
    for (const fake of [other, empty]) {
      expect(String(errorOf(() => [...eachStatement(fake, "SELECT 1; SELECT 2")]))).toMatch(/cannot find the next statement/);
    }
  });
});

describe.runIf(HAS_AUTHORIZER)("eachStatement on a confined connection", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "sqlite-statements-"));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("refuses an ATTACH in the second statement, and the first statement stays done", () => {
    const file = openDatabase(join(folder, "app.db"), { wal: false });
    try {
      file.exec("CREATE TABLE t (x)");
      confineToFile(file);
      const target = join(folder, "b.db").replaceAll("'", "''");
      const iterator = eachStatement(file, `INSERT INTO t VALUES (1); ATTACH '${target}' AS b; INSERT INTO t VALUES (2)`);
      nextStatement(iterator).run();
      expect(sqliteFault(errorOf(() => iterator.next()))?.kind).toBe("authorization");
      expect(file.prepare("SELECT x FROM t").all()).toEqual([{ x: 1 }]);
      expect(existsSync(join(folder, "b.db"))).toBe(false);
    } finally {
      file.close();
    }
  });
});
