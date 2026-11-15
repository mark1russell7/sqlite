import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { eventLog, type EventLog, type LogRecord } from "./event-log.ts";
import { openEventLog } from "./event-log-file.ts";
import { sqliteFault } from "./faults.ts";
import { checkIntegrity, IntegrityError, openOrQuarantine, quarantine, salvageEventLog, snapshot } from "./recovery.ts";

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-recovery-"));
  file = join(folder, "log.db");
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

interface Padded extends LogRecord {
  readonly pad: string;
}

const parse = (value: unknown): Padded => value as Padded;
/** An event of about 950 bytes, so a page of 4096 bytes has about 4 events. */
const padded = (n: number): Padded => ({ id: `e${String(n)}`, at: "2026-11-14T00:00:00Z", type: n % 3 === 0 ? "report" : "ack", pad: String(n).padStart(900, "x") });
const COUNT = 300;
const PAGE = 4096;

/** This function writes a closed log file of `COUNT` events. The close moves the WAL into the file. */
function writeLog(path: string): void {
  const log = openEventLog(path, parse);
  log.appendAll(Array.from({ length: COUNT }, (_, n) => padded(n + 1)));
  log.close();
  expect(existsSync(`${path}-wal`)).toBe(false);
}

/** This function writes garbage over the page of the file that has the body of one event, and gives the page number. */
function breakPageOf(path: string, id: string): number {
  const bytes = readFileSync(path);
  const at = bytes.indexOf(`{"id":"${id}"`);
  expect(at).toBeGreaterThan(PAGE);
  const page = Math.floor(at / PAGE);
  bytes.fill(0xff, page * PAGE, (page + 1) * PAGE);
  writeFileSync(path, bytes);
  return page;
}

function junk(path: string): void {
  writeFileSync(path, "This text is not a database. ".repeat(200));
}

describe("checkIntegrity", () => {
  it("gives ok for a good file, and the problems of a broken page", () => {
    writeLog(file);
    const good = new DatabaseSync(file);
    expect(checkIntegrity(good)).toEqual({ ok: true, problems: [] });
    expect(checkIntegrity(good, { quick: true })).toEqual({ ok: true, problems: [] });
    good.close();

    breakPageOf(file, "e150");
    const broken = new DatabaseSync(file);
    for (const quick of [false, true]) {
      const result = checkIntegrity(broken, { quick });
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
    }
    expect(checkIntegrity(broken, { limit: 1 }).problems).toHaveLength(1);
    broken.close();
  });

  it("gives a problem, not an error, for a file that is not a database", () => {
    junk(file);
    const db = new DatabaseSync(file);
    expect(checkIntegrity(db)).toEqual({ ok: false, problems: ["file is not a database"] });
    db.close();
  });

  it("refuses a bad limit", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => checkIntegrity(db, { limit: 0 })).toThrow(RangeError);
    db.close();
  });
});

describe("IntegrityError", () => {
  it("is a corrupt fault that needs a quarantine", () => {
    const error = new IntegrityError(["a", "b", "c", "d"]);
    expect(sqliteFault(error)).toMatchObject({ kind: "corrupt", action: "quarantine", code: 11 });
    expect(error.message).toBe("The file failed its integrity check: a | b | c (and 1 more)");
    expect(error.problems).toEqual(["a", "b", "c", "d"]);
  });
});

describe("quarantine", () => {
  const now = new Date("2026-11-14T12:00:00.123Z");

  it("moves the file with its WAL and SHM files into a new folder", () => {
    for (const suffix of ["", "-wal", "-shm"]) writeFileSync(file + suffix, suffix || "main");
    const result = quarantine(file, { now });
    const target = join(folder, "log.db.broken-20261114T120000Z");
    expect(result).toEqual({
      folder: target,
      database: join(target, "log.db"),
      files: [join(target, "log.db-wal"), join(target, "log.db-shm"), join(target, "log.db")],
    });
    expect(readdirSync(folder)).toEqual(["log.db.broken-20261114T120000Z"]);
    expect(readFileSync(join(target, "log.db"), "utf8")).toBe("main");
  });

  it("gives a new folder name when the name is in use, and uses the folder of the option", () => {
    writeFileSync(file, "one");
    quarantine(file, { now });
    writeFileSync(file, "two");
    expect(quarantine(file, { now }).folder).toBe(join(folder, "log.db.broken-20261114T120000Z-2"));

    const elsewhere = join(folder, "quarantine");
    mkdirSync(elsewhere);
    writeFileSync(file, "three");
    expect(quarantine(file, { now, folder: elsewhere }).database).toBe(join(elsewhere, "log.db.broken-20261114T120000Z", "log.db"));
  });

  it("moves a WAL file without its main file", () => {
    writeFileSync(`${file}-wal`, "orphan");
    const result = quarantine(file, { now });
    expect(result.database).toBeUndefined();
    expect(result.files).toEqual([join(result.folder, "log.db-wal")]);
    expect(existsSync(`${file}-wal`)).toBe(false);
  });

  it("throws when there is no file, and makes no folder", () => {
    expect(() => quarantine(file, { now })).toThrow(/no database file/);
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe("openOrQuarantine", () => {
  it("opens a good file and moves nothing", () => {
    writeLog(file);
    const result = openOrQuarantine(file, (path) => openEventLog(path, parse));
    expect(result.quarantined).toBeUndefined();
    expect(result.fault).toBeUndefined();
    expect(result.value.count()).toBe(COUNT);
    result.value.close();
  });

  it("moves a file that is not a database, and opens an empty log", () => {
    junk(file);
    const result = openOrQuarantine(file, (path) => openEventLog(path, parse));
    expect(result.fault).toMatchObject({ kind: "not-a-database", action: "quarantine" });
    expect(result.quarantined?.database).toBeDefined();
    expect(result.value.count()).toBe(0);
    result.value.close();
    expect(readFileSync(result.quarantined?.database ?? "", "utf8")).toMatch(/^This text is not a database/);
  });

  it("moves a file that fails the integrity check in the open", () => {
    writeLog(file);
    breakPageOf(file, "e150");
    const open = (path: string): EventLog<Padded> & { db: DatabaseSync } => {
      const db = openDatabase(path);
      try {
        const integrity = checkIntegrity(db, { quick: true });
        if (!integrity.ok) throw new IntegrityError(integrity.problems);
        return { ...eventLog(db, { parse }), db };
      } catch (error) {
        db.close();
        throw error;
      }
    };
    const result = openOrQuarantine(file, open);
    expect(result.fault).toMatchObject({ kind: "corrupt", action: "quarantine" });
    expect(result.value.count()).toBe(0);
    result.value.db.close();
  });

  it("gives each other error to the caller, and moves nothing", () => {
    writeFileSync(file, "");
    expect(() =>
      openOrQuarantine(file, () => {
        throw new RangeError("a bug");
      }),
    ).toThrow(RangeError);
    expect(readdirSync(folder)).toEqual(["log.db"]);
  });
});

describe("salvageEventLog", () => {
  it("copies each event of a good log, and counts the duplicates", () => {
    writeLog(file);
    const target = openEventLog(":memory:", parse);
    target.append(padded(1));
    const result = salvageEventLog(file, target, { parse });
    expect(result).toEqual({ read: COUNT, added: COUNT - 1, duplicate: 1, conflict: 0, lost: 0, problems: [] });
    expect(target.count()).toBe(COUNT);
    target.close();
  });

  it("reads the events after a broken page, and counts the lost positions", () => {
    writeLog(file);
    breakPageOf(file, "e150");
    const target = openEventLog(":memory:", parse);
    const result = salvageEventLog(file, target, { parse });
    expect(result.added + result.lost).toBe(COUNT);
    expect(result.lost).toBeGreaterThan(0);
    expect(result.lost).toBeLessThan(10);
    expect(result.problems[0]).toMatch(/^The read in order stopped after the position \d+/);
    expect(result.problems[1]).toMatch(/^The positions? \d+( to \d+)? (is|are) not readable\.$/);
    for (const event of target.read()) expect(event).toEqual(padded(Number(event.id.slice(1))));
    expect(target.get("e300")).toBeDefined();
    expect(target.get("e150")).toBeUndefined();
    target.close();
  });

  it("finds the last position in the index when the last page is broken", () => {
    writeLog(file);
    breakPageOf(file, `e${String(COUNT)}`);
    const target = openEventLog(":memory:", parse);
    const result = salvageEventLog(file, target, { parse });
    expect(result.added + result.lost).toBe(COUNT);
    expect(result.lost).toBeGreaterThan(0);
    expect(result.problems.some((problem) => problem.includes("end of the log is not known"))).toBe(false);
    target.close();
  });

  it("counts an event that does not parse as lost", () => {
    writeLog(file);
    const target = openEventLog(":memory:", parse);
    const strict = (value: unknown): Padded => {
      if ((value as Padded).id === "e7") throw new Error("not an event");
      return value as Padded;
    };
    const result = salvageEventLog(file, target, { parse: strict });
    expect(result).toMatchObject({ read: COUNT - 1, added: COUNT - 1, lost: 1 });
    expect(result.problems).toEqual(["The event at the position 7 is not valid: not an event"]);
    target.close();
  });

  it("gives a problem for a file that is not a database, and refuses a bad table name", () => {
    junk(file);
    const target = openEventLog(":memory:", parse);
    const result = salvageEventLog(file, target, { parse });
    expect(result).toMatchObject({ read: 0, added: 0, lost: 0 });
    expect(result.problems).toHaveLength(1);
    expect(() => salvageEventLog(file, target, { parse, table: "a b" })).toThrow(RangeError);
    target.close();
  });

  it("does not change the broken file", () => {
    writeLog(file);
    breakPageOf(file, "e150");
    const before = readFileSync(file);
    const target = openEventLog(":memory:", parse);
    salvageEventLog(file, target, { parse });
    target.close();
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe("snapshot", () => {
  it("writes a copy of an open log, and replaces an older copy", () => {
    const log = openEventLog(file, parse);
    const db = new DatabaseSync(file);
    log.append(padded(1));
    const copy = join(folder, "copy.db");
    writeFileSync(copy, "an older copy");
    const result = snapshot(db, copy);
    log.append(padded(2));
    expect(result.path).toBe(copy);
    expect(result.bytes).toBeGreaterThan(0);
    const copied = openEventLog(copy, parse);
    expect(copied.count()).toBe(1);
    copied.close();
    expect(readdirSync(folder).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    db.close();
    log.close();
  });

  it("throws in a transaction, and leaves no temporary file", () => {
    const db = openDatabase(file);
    db.exec("CREATE TABLE t (v); BEGIN");
    expect(() => snapshot(db, join(folder, "copy.db"))).toThrow(/transaction/);
    db.exec("ROLLBACK");
    db.close();
    expect(readdirSync(folder).filter((name) => name.includes("copy"))).toEqual([]);
  });
});
