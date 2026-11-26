import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRecoveries, openCheckedEventLog, openCheckedEventLogWith, type CheckedEventLog, type CheckedEventLogOptions } from "./checked-log.ts";
import type { LogRecord } from "./event-log.ts";
import { openEventLog } from "./event-log-file.ts";
import { sqliteFault } from "./faults.ts";
import { checkIntegrity, IntegrityError, quarantine } from "./recovery.ts";

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-checked-"));
  file = join(folder, "log.db");
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

interface Padded extends LogRecord {
  readonly pad: string;
}

const parse = (value: unknown): Padded => value as Padded;
/** An event of approximately 950 bytes, so a page of 4096 bytes has approximately 4 events. */
const padded = (n: number): Padded => ({ id: `e${String(n)}`, at: "2026-11-16T00:00:00Z", type: n % 3 === 0 ? "report" : "ack", pad: String(n).padStart(900, "x") });
const COUNT = 300;
const PAGE = 4096;
const now = new Date("2026-11-16T12:00:00Z");
const QUARANTINE = "log.db.broken-20261116T120000Z";
const options: CheckedEventLogOptions<Padded> = { quarantine: { now } };

/** This function writes a closed log file of `COUNT` events. The close moves the WAL into the file. */
function writeLog(path: string): void {
  const log = openEventLog(path, parse);
  log.appendAll(Array.from({ length: COUNT }, (_, n) => padded(n + 1)));
  log.close();
  expect(existsSync(`${path}-wal`)).toBe(false);
}

/** This function writes 0 over the page-type byte of the root page of the index `events_type`. The table stays readable. */
function breakIndexRoot(path: string): void {
  const db = new DatabaseSync(path);
  const { rootpage } = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'events_type'").get() as { rootpage: number };
  const { page_size: size } = db.prepare("PRAGMA page_size").get() as { page_size: number };
  db.close();
  const bytes = readFileSync(path);
  bytes[(rootpage - 1) * size] = 0;
  writeFileSync(path, bytes);
}

/** This function writes garbage over the page of the file that has the body of one event. */
function breakPageOf(path: string, id: string): void {
  const bytes = readFileSync(path);
  const at = bytes.indexOf(`{"id":"${id}"`);
  expect(at).toBeGreaterThan(PAGE);
  const page = Math.floor(at / PAGE);
  bytes.fill(0xff, page * PAGE, (page + 1) * PAGE);
  writeFileSync(path, bytes);
}

/** This function gives the ids of the events of a log, in their sequence. */
function idsOf(result: CheckedEventLog<Padded>): string[] {
  return [...result.log.read()].map((event) => event.id);
}

describe("openCheckedEventLog", () => {
  it("makes a new log when the path has no file, and checks nothing", () => {
    for (const path of [file, ":memory:"]) {
      const result = openCheckedEventLog(path, parse, options);
      expect(result.kind).toBe("created");
      result.log.append(padded(1));
      expect(result.log.count()).toBe(1);
      result.log.close();
    }
  });

  it("opens a good file after its quick check, and moves nothing", () => {
    writeLog(file);
    const result = openCheckedEventLog(file, parse, options);
    expect(result).toMatchObject({ kind: "opened", integrity: { ok: true, problems: [] } });
    expect(result.log.count()).toBe(COUNT);
    result.log.close();
    expect(readdirSync(folder)).toEqual(["log.db"]);
  });

  it("does no check with check: false, so a file with a broken index root opens as unchecked", () => {
    writeLog(file);
    breakIndexRoot(file);
    const result = openCheckedEventLog(file, parse, { ...options, check: false });
    expect(result.kind).toBe("unchecked");
    expect(result.log.count()).toBe(COUNT);
    result.log.close();
    expect(readdirSync(folder).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"))).toEqual(["log.db"]);
  });

  it("still recovers a file that is not a database with check: false", () => {
    writeFileSync(file, "This text is not a database. ".repeat(200));
    const result = openCheckedEventLog(file, parse, { ...options, check: false });
    if (result.kind !== "recovered") throw new Error(`The kind is ${result.kind}.`);
    expect(result.cause.kind === "fault" && result.cause.fault).toMatchObject({ kind: "not-a-database", action: "quarantine" });
    expect(result.log.count()).toBe(0);
    result.log.close();
  });

  it("makes a new log with check: false when the path has no file", () => {
    const result = openCheckedEventLog(file, parse, { ...options, check: false });
    expect(result.kind).toBe("created");
    result.log.close();
  });

  it("moves a file with a broken index root into quarantine, and keeps each event", () => {
    for (const check of [{ quick: true }, { quick: false }]) {
      writeLog(file);
      breakIndexRoot(file);
      const db = new DatabaseSync(file);
      for (const quick of [true, false]) expect(checkIntegrity(db, { quick }).ok).toBe(false);
      expect(db.prepare("SELECT count(*) AS n FROM events NOT INDEXED").get()).toEqual({ n: COUNT });
      db.close();
      const before = readFileSync(file);

      const result = openCheckedEventLog(file, parse, { ...options, check });
      if (result.kind !== "recovered") throw new Error(`The kind is ${result.kind}.`);
      expect(result.cause.kind).toBe("integrity");
      expect(result.salvage).toEqual({ kept: COUNT, lost: 0, problems: [] });
      expect(idsOf(result)).toEqual(Array.from({ length: COUNT }, (_, n) => `e${String(n + 1)}`));
      // The read-only salvage leaves an empty -wal and -shm. The move takes each file of the database, and the main file last.
      expect(result.quarantined).toMatchObject({ folder: join(folder, QUARANTINE), database: join(folder, QUARANTINE, "log.db") });
      expect(result.quarantined.files.at(-1)).toBe(join(folder, QUARANTINE, "log.db"));
      expect(result.quarantined.files.map((path) => basename(path)).sort()).toEqual(readdirSync(join(folder, QUARANTINE)).filter((name) => !name.endsWith(".json")).sort());
      expect(readFileSync(join(folder, QUARANTINE, "log.db")).equals(before)).toBe(true);

      result.log.append(padded(COUNT + 1));
      result.log.close();
      const fresh = new DatabaseSync(file);
      expect(checkIntegrity(fresh)).toEqual({ ok: true, problems: [] });
      fresh.close();
      expect(readdirSync(folder).sort()).toEqual(["log.db", QUARANTINE]);
      expect(readdirSync(join(folder, QUARANTINE)).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm")).sort()).toEqual(["log.db", "log.db.recovery.json"]);
      const record = JSON.parse(readFileSync(join(folder, QUARANTINE, "log.db.recovery.json"), "utf8")) as Record<string, unknown>;
      expect(record).toMatchObject({ format: "sqlite-recovery/1", kind: "recovered", salvage: { kept: COUNT, lost: 0 } });
      rmSync(folder, { recursive: true, force: true });
      folder = mkdtempSync(join(tmpdir(), "sqlite-checked-"));
      file = join(folder, "log.db");
    }
  });

  it("salvages the readable events around a broken page, and counts the lost positions", () => {
    writeLog(file);
    breakPageOf(file, "e150");
    const result = openCheckedEventLog(file, parse, options);
    if (result.kind !== "recovered") throw new Error(`The kind is ${result.kind}.`);
    expect(result.salvage.kept + result.salvage.lost).toBe(COUNT);
    expect(result.salvage.lost).toBeGreaterThan(0);
    expect(result.log.get("e150")).toBeUndefined();
    expect(result.log.get("e300")).toBeDefined();
    result.log.close();
  });

  it("moves a file that is not a database, and gives the fault of the open", () => {
    writeFileSync(file, "This text is not a database. ".repeat(200));
    const result = openCheckedEventLog(file, parse, options);
    if (result.kind !== "recovered") throw new Error(`The kind is ${result.kind}.`);
    expect(result.cause.kind === "fault" && result.cause.fault).toMatchObject({ kind: "not-a-database", action: "quarantine" });
    expect(result.salvage).toMatchObject({ kept: 0, lost: 0 });
    expect(result.salvage.problems).toHaveLength(1);
    expect(result.log.count()).toBe(0);
    result.log.close();
  });

  it("moves a WAL file with no database file, and salvages nothing", () => {
    writeFileSync(`${file}-wal`, "orphan");
    const result = openCheckedEventLog(file, parse, options);
    expect(result).toMatchObject({ kind: "orphan-journal", quarantined: { database: undefined, files: [join(folder, QUARANTINE, "log.db-wal")] } });
    expect(result.log.count()).toBe(0);
    result.log.close();
    expect(readFileSync(join(folder, QUARANTINE, "log.db-wal"), "utf8")).toBe("orphan");
  });

  it("gives a lock that is not free to the caller, and moves nothing", () => {
    writeLog(file);
    const holder = new DatabaseSync(file);
    holder.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE held (x INTEGER); INSERT INTO held VALUES (1);");
    try {
      let thrown: unknown;
      try {
        openCheckedEventLog(file, parse, options).log.close();
      } catch (error) {
        thrown = error;
      }
      expect(sqliteFault(thrown)?.action).toBe("retry");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(readdirSync(folder).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"))).toEqual(["log.db"]);
  });

  it("moves nothing with readOnly, and throws an IntegrityError", () => {
    writeLog(file);
    breakIndexRoot(file);
    expect(() => openCheckedEventLog(file, parse, { ...options, readOnly: true })).toThrow(IntegrityError);
    expect(readdirSync(folder).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"))).toEqual(["log.db"]);
  });

  it("removes a salvage file with no record, and opens the good file", () => {
    writeLog(file);
    writeFileSync(`${file}.salvage-tmp`, "a salvage that did not complete");
    const result = openCheckedEventLog(file, parse, options);
    expect(result.kind).toBe("opened");
    result.log.close();
    expect(readdirSync(folder)).toEqual(["log.db"]);
  });

  it("refuses a record of a format that it does not know", () => {
    writeLog(file);
    writeFileSync(`${file}.recovery.json`, JSON.stringify({ format: "sqlite-recovery/9" }));
    expect(() => openCheckedEventLog(file, parse, options)).toThrow(/format that this version does not know/);
  });
});

/** The state at the end of a recovery: the events of the log, and the files and bytes of the quarantine folder. */
interface End {
  readonly kind: CheckedEventLog<Padded>["kind"];
  readonly ids: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly entries: readonly string[];
}

/** This function gives the state at the end of a recovery, with the folder of the test as `<folder>`. */
function endOf(result: CheckedEventLog<Padded>): End {
  const ids = idsOf(result);
  result.log.close();
  const quarantine = join(folder, QUARANTINE);
  const files: Record<string, string> = {};
  for (const name of readdirSync(quarantine).sort()) {
    const bytes = readFileSync(join(quarantine, name));
    files[name] = name.endsWith(".json") ? bytes.toString("utf8").split(JSON.stringify(folder).slice(1, -1)).join("<folder>") : bytes.toString("base64");
  }
  return { kind: result.kind, ids, files, entries: readdirSync(folder).sort() };
}

class Stop extends Error {}

describe("a crash at each step of a recovery", () => {
  /** This function gives the names of the steps of a recovery of a copy of a template file, with no stop. */
  function stepsOf(template: (path: string) => void): { steps: string[]; end: End } {
    template(file);
    const steps: string[] = [];
    const end = endOf(openCheckedEventLogWith(file, parse, options, (step) => steps.push(step)));
    return { steps, end };
  }

  /**
   * This function stops a recovery at each step, opens the file again, and compares the end with the end of no stop. After
   * a stop at the last step, the next open gives `last`: "opened" when the recovery put a log at the path, "created" when not.
   */
  function eachStop(make: (path: string) => void, last: CheckedEventLog<Padded>["kind"]): void {
    const templateFolder = mkdtempSync(join(tmpdir(), "sqlite-template-"));
    try {
      make(join(templateFolder, "log.db"));
      const copy = (path: string): void => {
        for (const name of readdirSync(templateFolder)) copyFileSync(join(templateFolder, name), join(folder, name.replace("log.db", basename(path))));
      };
      const { steps, end } = stepsOf(copy);
      expect(steps.length).toBeGreaterThan(1);
      for (const [index, step] of steps.entries()) {
        rmSync(folder, { recursive: true, force: true });
        folder = mkdtempSync(join(tmpdir(), "sqlite-checked-"));
        file = join(folder, "log.db");
        copy(file);
        let calls = 0;
        expect(() =>
          openCheckedEventLogWith(file, parse, options, () => {
            if (calls++ === index) throw new Stop(step);
          }),
        ).toThrow(Stop);
        const again = endOf(openCheckedEventLog(file, parse, options));
        // A stop after the last step loses only the result: the next open finds a good file, or no file
        expect({ ...again, kind: end.kind }, `a stop after the step ${step}`).toEqual(end);
        if (step === steps.at(-1)) expect(again.kind).toBe(last);
        else expect(again.kind).toBe(end.kind);
      }
    } finally {
      rmSync(templateFolder, { recursive: true, force: true });
    }
  }

  it("ends with the same events and the same quarantine after a stop at each step of a salvage", () => {
    eachStop((path) => {
      writeLog(path);
      breakPageOf(path, "e150");
    }, "opened");
  });

  it("ends with the same quarantine after a stop at each step of the move of an orphan journal", () => {
    eachStop((path) => {
      writeFileSync(`${path}-wal`, "orphan");
      writeFileSync(`${path}-shm`, "orphan index");
    }, "created");
  });
});

describe("listRecoveries", () => {
  /** This function opens a broken log at a time, and closes it. */
  function recoverAt(iso: string): void {
    rmSync(file, { force: true });
    writeLog(file);
    breakIndexRoot(file);
    const result = openCheckedEventLog(file, parse, { quarantine: { now: new Date(iso) } });
    expect(result.kind).toBe("recovered");
    result.log.close();
  }

  it("gives no entry when the folder has no quarantine, or when the folder does not exist", () => {
    expect(listRecoveries(join(folder, "missing", "log.db"))).toEqual([]);
    writeLog(file);
    expect(listRecoveries(file)).toEqual([]);
  });

  it("gives each recovery in the sequence of its time, and then of its id", () => {
    writeFileSync(`${file}-wal`, "orphan");
    const orphan = openCheckedEventLog(file, parse, { quarantine: { now: new Date("2026-11-16T11:00:00Z") } });
    expect(orphan.kind).toBe("orphan-journal");
    orphan.log.close();
    // Two recoveries at one time get the folders QUARANTINE and QUARANTINE-2
    recoverAt("2026-11-16T12:00:00Z");
    recoverAt("2026-11-16T12:00:00Z");

    const entries = listRecoveries(file);
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["orphan-journal", "log.db.broken-20261116T110000Z"],
      ["recovered", QUARANTINE],
      ["recovered", `${QUARANTINE}-2`],
    ]);
    const [, first] = entries;
    expect(first).toEqual({
      kind: "recovered",
      id: QUARANTINE,
      folder: join(folder, QUARANTINE),
      at: "2026-11-16T12:00:00.000Z",
      cause: { kind: "integrity", integrity: expect.objectContaining({ ok: false }) as unknown },
      salvage: { kept: COUNT, lost: 0, problems: [] },
    });
  });

  it("gives a folder with no record, or with a record that does not parse, as no-read, after the entries with a time", () => {
    recoverAt("2026-11-16T12:00:00Z");
    // quarantine() writes no record
    quarantine(file, { now: new Date("2026-11-16T10:00:00Z") });
    mkdirSync(join(folder, "log.db.broken-bad-json"));
    writeFileSync(join(folder, "log.db.broken-bad-json", "log.db.recovery.json"), "{ not json");
    mkdirSync(join(folder, "log.db.broken-old-format"));
    writeFileSync(join(folder, "log.db.broken-old-format", "log.db.recovery.json"), JSON.stringify({ format: "sqlite-recovery/0", kind: "recovered" }));
    // A file with the name of a quarantine folder is not a quarantine
    writeFileSync(join(folder, "log.db.broken-file"), "not a folder");

    const entries = listRecoveries(file);
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["recovered", QUARANTINE],
      ["no-read", "log.db.broken-20261116T100000Z"],
      ["no-read", "log.db.broken-bad-json"],
      ["no-read", "log.db.broken-old-format"],
    ]);
    const problems = entries.flatMap((entry) => (entry.kind === "no-read" ? [entry.problem] : []));
    expect(problems[0]).toContain("has no record of a recovery");
    expect(problems[1]).toContain("is not valid JSON");
    expect(problems[2]).toContain("has a format that this version does not know");
  });

  it("does not give a recovery that is not complete, and gives it after the next open completes it", () => {
    writeLog(file);
    breakIndexRoot(file);
    expect(() =>
      openCheckedEventLogWith(file, parse, options, (step) => {
        if (step === "moved-main") throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(existsSync(`${file}.recovery.json`)).toBe(true);
    expect(existsSync(join(folder, QUARANTINE, "log.db"))).toBe(true);
    expect(listRecoveries(file)).toEqual([]);

    const again = openCheckedEventLog(file, parse, options);
    expect(again.kind).toBe("recovered");
    again.log.close();
    expect(listRecoveries(file).map((entry) => [entry.kind, entry.id])).toEqual([["recovered", QUARANTINE]]);
  });

  it("reads the quarantine folders in the folder of the option folder", () => {
    const elsewhere = join(folder, "quarantine");
    mkdirSync(elsewhere);
    writeLog(file);
    breakIndexRoot(file);
    const result = openCheckedEventLog(file, parse, { quarantine: { now, folder: elsewhere } });
    result.log.close();
    expect(listRecoveries(file)).toEqual([]);
    expect(listRecoveries(file, { folder: elsewhere }).map((entry) => [entry.kind, entry.folder])).toEqual([["recovered", join(elsewhere, QUARANTINE)]]);
  });
});
