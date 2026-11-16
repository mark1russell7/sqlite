import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDatabase } from "./clear.ts";
import { type ConfinableDatabase, ConfineUnavailableError, confineToFile } from "./confine.ts";
import { openDatabase, type OpenOptions } from "./database.ts";
import { sqliteFault } from "./faults.ts";

// The codes of sqlite3.h. Node.js 22 has no `constants.SQLITE_ATTACH`, so the tests keep their own copy.
const OK = 0;
const DENY = 1;
const PRAGMA = 19;
const ATTACH = 24;
const FUNCTION = 31;
/** The last action code of SQLite 3.53: `SQLITE_RECURSIVE`. */
const LAST_ACTION = 33;

type Decide = (actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number;

/** Node.js 24.10 and later have `setAuthorizer`. Each leg of CI tests the side of its own Node.js. */
const HAS_AUTHORIZER = typeof (nodeSqlite.DatabaseSync.prototype as ConfinableDatabase).setAuthorizer === "function";

/** This function gives the authorizer that `confineToFile` sets on a fake connection. */
function authorizerOfGuard(): Decide {
  const set: (Decide | null)[] = [];
  confineToFile({ setAuthorizer: (callback) => set.push(callback) });
  expect(set).toHaveLength(1);
  const decide = set[0];
  if (decide === null || decide === undefined) throw new Error("confineToFile set no authorizer");
  return decide;
}

/** This function writes a text as a string literal of SQL. */
const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** This function runs a statement that must throw, and gives its error. */
function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("The statement ran, but the guard must refuse it");
}

describe("the authorizer of confineToFile", () => {
  it("refuses ATTACH of a file, also by an expression or a parameter, and lets a temporary database", () => {
    const decide = authorizerOfGuard();
    expect(decide(ATTACH, "/tmp/b.db", null, null, null)).toBe(DENY);
    expect(decide(ATTACH, ":memory:", null, null, null)).toBe(DENY);
    expect(decide(ATTACH, null, null, null, null)).toBe(DENY);
    expect(decide(ATTACH, "", null, null, null)).toBe(OK);
  });

  it("refuses the pragmas that set a folder, in each case", () => {
    const decide = authorizerOfGuard();
    for (const name of ["temp_store_directory", "TEMP_STORE_DIRECTORY", "data_store_directory", "Data_Store_Directory"]) {
      expect(decide(PRAGMA, name, "/tmp", null, null), name).toBe(DENY);
      expect(decide(PRAGMA, name, null, "main", null), name).toBe(DENY);
    }
    expect(decide(PRAGMA, "user_version", "7", null, null)).toBe(OK);
    expect(decide(PRAGMA, "temp_store", "MEMORY", null, null)).toBe(OK);
    expect(decide(PRAGMA, "journal_mode", null, "main", null)).toBe(OK);
  });

  it("refuses load_extension and lets each other function", () => {
    const decide = authorizerOfGuard();
    expect(decide(FUNCTION, null, "load_extension", null, null)).toBe(DENY);
    expect(decide(FUNCTION, null, "LOAD_EXTENSION", null, null)).toBe(DENY);
    expect(decide(FUNCTION, null, "lower", null, null)).toBe(OK);
    expect(decide(FUNCTION, null, "json_extract", null, null)).toBe(OK);
  });

  it("lets each other action", () => {
    const decide = authorizerOfGuard();
    for (let code = 0; code <= LAST_ACTION; code++) {
      if (code === ATTACH || code === PRAGMA || code === FUNCTION) continue;
      expect(decide(code, "t", "x", "main", null), String(code)).toBe(OK);
    }
  });

  it("throws ConfineUnavailableError when the connection has no setAuthorizer", () => {
    expect(() => confineToFile({})).toThrow(ConfineUnavailableError);
    const error = refusal(() => confineToFile({ setAuthorizer: undefined }));
    expect(error).toBeInstanceOf(ConfineUnavailableError);
    expect(error).toMatchObject({ name: "ConfineUnavailableError", code: "CONFINE_UNAVAILABLE" });
    expect((error as Error).message).toMatch(/Node\.js 24\.10 or later/);
  });
});

describe.runIf(!HAS_AUTHORIZER)("confineToFile on a Node.js before 24.10", () => {
  it("throws, so the caller runs no SQL without the guard", () => {
    const db = new nodeSqlite.DatabaseSync(":memory:");
    try {
      expect(() => confineToFile(db)).toThrow(ConfineUnavailableError);
    } finally {
      db.close();
    }
  });
});

describe.runIf(HAS_AUTHORIZER)("a confined connection", () => {
  let folder: string;
  let out: string;
  let file: string;
  const open: nodeSqlite.DatabaseSync[] = [];

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "sqlite-confine-"));
    out = join(folder, "out");
    mkdirSync(out);
    file = join(folder, "app.db");
    const setup = openDatabase(file, { wal: false });
    setup.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('a')");
    setup.close();
  });

  afterEach(() => {
    for (const db of open.splice(0)) db.close();
    rmSync(folder, { recursive: true, force: true });
  });

  /** This function opens the file of the test. The file keeps its journal mode. */
  function connect(options: OpenOptions = {}): nodeSqlite.DatabaseSync {
    const db = openDatabase(file, { wal: false, ...options });
    open.push(db);
    return db;
  }

  function confined(options: OpenOptions = {}): nodeSqlite.DatabaseSync {
    const db = connect(options);
    confineToFile(db);
    return db;
  }

  /** This function gives the names of the files in the folder of the test and in its folder `out`. */
  function files(): string[] {
    return [...readdirSync(folder), ...readdirSync(out).map((name) => `out/${name}`)].sort();
  }

  it("uses the codes of node:sqlite", () => {
    const codes = nodeSqlite.constants;
    expect([codes.SQLITE_OK, codes.SQLITE_DENY, codes.SQLITE_PRAGMA, codes.SQLITE_ATTACH, codes.SQLITE_FUNCTION]).toEqual([
      OK,
      DENY,
      PRAGMA,
      ATTACH,
      FUNCTION,
    ]);
  });

  it("refuses each form of ATTACH, and makes no file", () => {
    const db = confined();
    const before = files();
    const target = join(out, "b.db");
    const forms = [
      `ATTACH ${quote(target)} AS b`,
      `attach database ${quote(target)} as b`,
      `AtTaCh /* a comment */ DATABASE ${quote(target)} AS "b c"`,
      `ATTACH\n${quote(join(out, "it's a copy.db"))}\nAS b`,
      `ATTACH ${quote(out)} || '/joined.db' AS b`,
      `ATTACH ${quote(`file:${target}?mode=rwc`)} AS b`,
      "ATTACH ':memory:' AS m",
      `SELECT 1; ATTACH ${quote(target)} AS b`,
    ];
    for (const sql of forms) {
      expect(sqliteFault(refusal(() => db.exec(sql)))?.kind, sql).toBe("authorization");
    }
    expect(sqliteFault(refusal(() => db.prepare("ATTACH ? AS b").run(target)))?.kind).toBe("authorization");
    expect(files()).toEqual(before);
  });

  it("refuses each form of VACUUM INTO before it makes a file, also on a read-only connection", () => {
    const forms = [
      `VACUUM INTO ${quote(join(out, "c.db"))}`,
      `vacuum main into ${quote(join(out, "c.db"))}`,
      `VaCuUm /* a comment */ InTo ${quote(join(out, "it's a copy.db"))}`,
      `VACUUM\nINTO\n${quote(join(out, "c.db"))}`,
    ];
    for (const readOnly of [false, true]) {
      const db = confined({ readOnly });
      const before = files();
      for (const sql of forms) {
        expect(() => db.exec(sql), `${sql} (readOnly: ${String(readOnly)})`).toThrow();
      }
      expect(() => db.prepare("VACUUM INTO ?").run(join(out, "d.db"))).toThrow();
      expect(files()).toEqual(before);
    }
  });

  it("refuses the pragmas that set a folder, in each spelling", () => {
    const db = confined();
    const forms = [
      `PRAGMA temp_store_directory = ${quote(out)}`,
      `pragma TEMP_STORE_DIRECTORY = ${quote(out)}`,
      `PRAGMA main.temp_store_directory = ${quote(out)}`,
      `PRAGMA temp_store_directory(${quote(out)})`,
      "PRAGMA temp_store_directory",
      `PRAGMA data_store_directory = ${quote(out)}`,
      `PRAGMA /* a comment */ Data_Store_Directory = ${quote(out)}`,
    ];
    for (const sql of forms) {
      expect(sqliteFault(refusal(() => db.exec(sql)))?.kind, sql).toBe("authorization");
    }
  });

  it("refuses load_extension when SQLite compiles the statement", () => {
    const sql = `SELECT load_extension(${quote(join(out, "lib"))})`;
    expect(() => confined().prepare(sql)).toThrow(/not authorized/);
    // Without the guard, the statement compiles, and node:sqlite refuses the load only when it runs.
    expect(() => connect().prepare(sql)).not.toThrow();
  });

  it("has no ATTACH, VACUUM or PRAGMA in a trigger or a CTE: SQLite refuses the syntax on each connection", () => {
    const target = quote(join(out, "b.db"));
    const forms = [
      `CREATE TRIGGER t_attach AFTER INSERT ON t BEGIN ATTACH ${target} AS b; END`,
      `CREATE TRIGGER t_vacuum AFTER INSERT ON t BEGIN VACUUM INTO ${target}; END`,
      `CREATE TRIGGER t_pragma AFTER INSERT ON t BEGIN PRAGMA temp_store_directory = ${quote(out)}; END`,
      `WITH c AS (SELECT 1) ATTACH ${target} AS b`,
      `WITH c AS (SELECT 1) VACUUM INTO ${target}`,
    ];
    const before = files();
    for (const db of [connect(), confined()]) {
      for (const sql of forms) {
        expect(() => db.exec(sql), sql).toThrow(/syntax error/);
      }
    }
    expect(files()).toEqual(before);
  });

  it("refuses the insert that fires a trigger with load_extension, on the confined connection", () => {
    const db = confined();
    db.exec(`CREATE TRIGGER t_load AFTER INSERT ON t BEGIN SELECT load_extension(${quote(join(out, "lib"))}); END`);
    const insert = "INSERT INTO t VALUES ('b')";
    expect(() => db.prepare(insert)).toThrow();
    // A connection with no guard also fails, because node:sqlite turns off the load of extensions.
    expect(() => connect().prepare(insert).run()).toThrow();
    expect(db.prepare("SELECT x FROM t").all()).toEqual([{ x: "a" }]);
    expect(files().filter((name) => name.startsWith("out/"))).toEqual([]);
  });

  it("runs the statements on the file of the connection as before", () => {
    const db = confined();
    db.exec(`
      CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT);
      CREATE INDEX u_name ON u (name);
      CREATE VIEW u_upper AS SELECT upper(name) AS name FROM u;
      CREATE TABLE audit (name TEXT);
      CREATE TRIGGER u_audit AFTER INSERT ON u BEGIN INSERT INTO audit VALUES (new.name); END;
    `);
    db.prepare("INSERT INTO u (name) VALUES (?)").run("ada");
    db.exec("BEGIN; INSERT INTO u (name) VALUES ('bob'); SAVEPOINT s; UPDATE u SET name = 'cy' WHERE name = 'bob'; RELEASE s; COMMIT");
    expect(db.prepare("SELECT name FROM u_upper ORDER BY name").all()).toEqual([{ name: "ADA" }, { name: "CY" }]);
    expect(db.prepare("SELECT name FROM audit ORDER BY rowid").all()).toEqual([{ name: "ada" }, { name: "bob" }]);
    expect(db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT json_group_array(i) AS a FROM n").get()).toEqual({
      a: "[1,2,3]",
    });
    db.exec("PRAGMA user_version = 7; PRAGMA temp_store = MEMORY");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.exec("DELETE FROM u WHERE name = 'cy'; VACUUM");
    expect(db.prepare("SELECT name FROM u").all()).toEqual([{ name: "ada" }]);
  });

  it("lets the temporary database of a plain VACUUM, so clearDatabase works", () => {
    const db = confined();
    expect(clearDatabase(db)).toEqual(["t"]);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()).toEqual({ n: 0 });
  });

  it("stops at setAuthorizer(null), because a connection has one authorizer", () => {
    const db = confined();
    db.setAuthorizer(null);
    db.exec(`ATTACH ${quote(join(out, "b.db"))} AS b`);
    expect(existsSync(join(out, "b.db"))).toBe(true);
  });
});
