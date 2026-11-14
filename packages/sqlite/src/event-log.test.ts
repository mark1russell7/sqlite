import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.ts";
import { BrokenLogError, EVENT_LOG_SCHEMA_VERSION, eventLog, openEventLog, type LogRecord } from "./event-log.ts";
import { migrate, SCHEMA_VERSIONS_TABLE, schemaVersion, userVersion } from "./migrate.ts";

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-event-log-"));
  file = join(folder, "log.db");
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

interface Note extends LogRecord {
  readonly text?: string;
}

const parse = (value: unknown): Note => value as Note;
const note = (id: string, text = id, type = "note"): Note => ({ id, at: "2026-11-08T12:00:00Z", type, text });
const acceptAll = (): undefined => undefined;
const ids = (events: Iterable<Note>): string[] => [...events].map((each) => each.id);

describe("openEventLog", () => {
  it("sets the schema version and the WAL mode", () => {
    openEventLog(file, parse).close();
    const db = new DatabaseSync(file);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: EVENT_LOG_SCHEMA_VERSION });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  });

  it("refuses a file from a newer version", () => {
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${EVENT_LOG_SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openEventLog(file, parse)).toThrow(new RegExp(`The log has the schema version ${EVENT_LOG_SCHEMA_VERSION + 1}.*newer version`));
  });

  it("opens a file of version 0.1.0 and keeps its events", () => {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE events (
       seq INTEGER PRIMARY KEY,
       id TEXT NOT NULL UNIQUE,
       at TEXT NOT NULL,
       type TEXT NOT NULL,
       body TEXT NOT NULL
     ) STRICT; PRAGMA user_version = 1`);
    db.prepare("INSERT INTO events (id, at, type, body) VALUES (?, ?, ?, ?)").run("a", "2026-11-08T12:00:00Z", "note", JSON.stringify(note("a")));
    db.close();
    const log = openEventLog(file, parse);
    expect(ids(log.read())).toEqual(["a"]);
    log.close();
    const again = new DatabaseSync(file);
    expect(userVersion(again)).toBe(EVENT_LOG_SCHEMA_VERSION);
    expect(again.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_type'").get()).toEqual({ name: "events_type" });
    again.close();
  });

  it("gives the same events after a reopen, in order", () => {
    const log = openEventLog(file, parse);
    expect(log.append(note("a"), acceptAll)).toEqual({ kind: "added", seq: 1 });
    expect(log.appendAll([note("b"), note("c")])).toEqual([
      { kind: "added", seq: 2 },
      { kind: "added", seq: 3 },
    ]);
    log.close();
    const again = openEventLog(file, parse);
    expect(ids(again.read())).toEqual(["a", "b", "c"]);
    expect(again.count()).toBe(3);
    expect(again.head()).toBe(3);
    again.close();
  });

  it("does not write a refused event, and gives its problem", () => {
    const log = openEventLog(file, parse);
    const refuseB = (event: Note): string | undefined => (event.id === "b" ? `no ${event.id}` : undefined);
    expect(log.append(note("b"), refuseB)).toEqual({ kind: "refused", problem: "no b" });
    expect(log.appendAll([note("a"), note("b"), note("c")], refuseB)).toEqual([
      { kind: "added", seq: 1 },
      { kind: "refused", problem: "no b" },
      { kind: "added", seq: 2 },
    ]);
    expect(ids(log.read())).toEqual(["a", "c"]);
    log.close();
  });

  it("names the position of an event that does not parse", () => {
    const log = openEventLog(file, parse);
    log.append({ id: "x", at: "2026-11-08T12:00:00Z", type: "bad" });
    log.close();
    const strict = openEventLog(file, (value) => {
      throw new Error(`not an event: ${JSON.stringify(value)}`);
    });
    expect(() => [...strict.read()]).toThrow(/position 1/);
    expect(() => strict.get("x")).toThrow(/position 1/);
    strict.close();
  });

  it("writes nothing of a batch when an accept fails, and then refuses each call", () => {
    const log = openEventLog(file, parse);
    const records = [1, 2, 3].map((n) => note(`r${n}`));
    expect(() =>
      log.appendAll(records, (record) => {
        if (record.id === "r3") throw new Error("a bug");
        return undefined;
      }),
    ).toThrow("a bug");
    expect(() => log.count()).toThrow(/broken/);
    expect(() => log.head()).toThrow(BrokenLogError);
    expect(() => log.get("r1")).toThrow(BrokenLogError);
    expect(() => [...log.read()]).toThrow(/broken/);
    expect(() => log.append(note("r4"), acceptAll)).toThrow(/broken/);
    log.close();
    const again = openEventLog(file, parse);
    expect(again.count()).toBe(0);
    again.close();
  });

  it("is usable again after recover, and recover of a log that is not broken does nothing", () => {
    const log = openEventLog(file, parse);
    log.recover();
    const record = note("r1");
    expect(() =>
      log.append(record, () => {
        throw new Error("a bug");
      }),
    ).toThrow("a bug");
    let error: unknown;
    try {
      log.count();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BrokenLogError);
    expect((error as BrokenLogError).stuck).toBe(false);
    expect((error as BrokenLogError).cause).toEqual(new Error("a bug"));
    log.recover();
    expect(log.count()).toBe(0);
    expect(log.append(record, acceptAll)).toEqual({ kind: "added", seq: 1 });
    expect(log.count()).toBe(1);
    log.close();
  });

  it("breaks on a failed insert after the accept, and recovers with no event of that write", () => {
    const log = openEventLog(file, parse);
    log.append(note("a"), acceptAll);
    // A second connection makes the insert of one event fail after its accept, as a full disk does
    const other = new DatabaseSync(file);
    other.exec("CREATE TRIGGER refuse BEFORE INSERT ON events WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const accepted: string[] = [];
    const track = (event: Note): undefined => {
      accepted.push(event.id);
      return undefined;
    };
    expect(() => log.appendAll([note("b"), note("bad")], track)).toThrow("disk full");
    expect(accepted).toEqual(["b", "bad"]);
    expect(() => log.count()).toThrow(/broken/);
    log.recover();
    expect(ids(log.read())).toEqual(["a"]);

    other.exec("DROP TRIGGER refuse");
    other.close();
    expect(log.append(note("b"), acceptAll)).toEqual({ kind: "added", seq: 2 });
    expect(log.count()).toBe(2);
    log.close();
  });

  it("is not broken when the write lock is not free at the start", () => {
    const log = openEventLog(file, parse);
    const other = new DatabaseSync(file);
    other.exec("BEGIN IMMEDIATE");
    expect(() => log.append(note("a"), acceptAll)).toThrow(/locked/);
    other.exec("ROLLBACK");
    other.close();
    expect(log.count()).toBe(0);
    expect(log.append(note("a"), acceptAll)).toEqual({ kind: "added", seq: 1 });
    log.close();
  });

  it("gives its options to the connection", () => {
    expect(() => openEventLog(file, parse, { busyTimeoutMs: -1 })).toThrow(RangeError);
    const log = openEventLog(file, parse, { wal: false });
    log.close();
    const db = new DatabaseSync(file);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    db.close();
  });

  it("works with no file", () => {
    const log = openEventLog(":memory:", parse);
    log.append(note("a"), acceptAll);
    expect(log.count()).toBe(1);
    log.close();
  });
});

describe("the log as a grow-only set", () => {
  it("changes nothing for a duplicate, and does not give it to accept", () => {
    const log = openEventLog(":memory:", parse);
    const accepted: string[] = [];
    const track = (event: Note): undefined => {
      accepted.push(event.id);
      return undefined;
    };
    expect(log.append(note("a"), track)).toEqual({ kind: "added", seq: 1 });
    expect(log.append(note("a"), track)).toEqual({ kind: "duplicate", seq: 1 });
    expect(log.appendAll([note("b"), note("a"), note("b")], track)).toEqual([
      { kind: "added", seq: 2 },
      { kind: "duplicate", seq: 1 },
      { kind: "duplicate", seq: 2 },
    ]);
    expect(accepted).toEqual(["a", "b"]);
    expect(log.count()).toBe(2);
    log.close();
  });

  it("reports a conflict, keeps the stored event, and stays usable", () => {
    const log = openEventLog(":memory:", parse);
    log.append(note("a", "first"));
    expect(log.append(note("a", "second"))).toEqual({ kind: "conflict", seq: 1, stored: note("a", "first") });
    expect(log.get("a")).toEqual({ seq: 1, event: note("a", "first") });
    expect(log.append(note("b"))).toEqual({ kind: "added", seq: 2 });
    log.close();
  });

  it("uses the equality of the caller", () => {
    const sameText = (stored: Note, event: Note): boolean => stored.text === event.text;
    const log = openEventLog(":memory:", parse, { equal: sameText });
    log.append(note("a", "x"));
    expect(log.append({ text: "x", type: "note", at: "2026-11-08T12:00:00Z", id: "a" })).toEqual({ kind: "duplicate", seq: 1 });
    expect(log.append(note("a", "y"))).toEqual({ kind: "conflict", seq: 1, stored: note("a", "x") });
    log.close();
  });

  it("compares the JSON text by default, so the order of the keys counts", () => {
    const log = openEventLog(":memory:", parse);
    log.append(note("a", "x"));
    const reordered: Note = { text: "x", type: "note", at: "2026-11-08T12:00:00Z", id: "a" };
    expect(log.append(reordered)).toMatchObject({ kind: "conflict", seq: 1 });
    log.close();
  });
});

describe("reads", () => {
  it("reads after a position, by type and with a limit", () => {
    const log = openEventLog(":memory:", parse);
    log.appendAll([note("a", "a", "report"), note("b", "b", "ack"), note("c", "c", "report"), note("d", "d", "delivery")]);
    expect([...log.entries({ after: 2 })].map((entry) => [entry.seq, entry.event.id])).toEqual([
      [3, "c"],
      [4, "d"],
    ]);
    expect(ids(log.read({ types: ["report"] }))).toEqual(["a", "c"]);
    expect(ids(log.read({ types: ["report", "delivery"], after: 1 }))).toEqual(["c", "d"]);
    expect(ids(log.read({ types: [] }))).toEqual([]);
    expect(ids(log.read({ limit: 2 }))).toEqual(["a", "b"]);
    expect(ids(log.read({ after: 4 }))).toEqual([]);
    log.close();
  });

  it("refuses a bad position or limit", () => {
    const log = openEventLog(":memory:", parse);
    expect(() => [...log.read({ after: -1 })]).toThrow(RangeError);
    expect(() => [...log.read({ after: 1.5 })]).toThrow(RangeError);
    expect(() => [...log.read({ limit: 0 })]).toThrow(RangeError);
    log.close();
  });

  it("gives an event by its id, and the head of the log", () => {
    const log = openEventLog(":memory:", parse);
    expect(log.head()).toBe(0);
    expect(log.get("a")).toBeUndefined();
    log.appendAll([note("a"), note("b")]);
    expect(log.get("b")).toEqual({ seq: 2, event: note("b") });
    expect(log.head()).toBe(2);
    log.close();
  });

  it("gives a new event to a reader that starts at the head", () => {
    const log = openEventLog(":memory:", parse);
    log.append(note("a"));
    const cursor = log.head();
    log.append(note("b"));
    expect(ids(log.read({ after: cursor }))).toEqual(["b"]);
    log.close();
  });
});

describe("eventLog", () => {
  it("keeps two logs and the tables of the app in one file, each with its own version", () => {
    const db = openDatabase(file);
    migrate(db, ["CREATE TABLE health (source TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT"], { part: "app" });
    const reports = eventLog(db, { parse, table: "reports" });
    const acks = eventLog(db, { parse, table: "acks" });
    reports.append(note("r1"));
    acks.append(note("k1"));
    acks.append(note("r1"));
    expect(ids(reports.read())).toEqual(["r1"]);
    expect(ids(acks.read())).toEqual(["k1", "r1"]);
    expect(schemaVersion(db, "event-log:reports")).toBe(EVENT_LOG_SCHEMA_VERSION);
    expect(schemaVersion(db, "event-log:acks")).toBe(EVENT_LOG_SCHEMA_VERSION);
    expect(schemaVersion(db, "app")).toBe(1);
    expect(userVersion(db)).toBe(0);
    db.close();

    const again = openDatabase(file);
    expect(ids(eventLog(again, { parse, table: "reports" }).read())).toEqual(["r1"]);
    again.close();
  });

  it("uses the table events by default, and does not close the connection", () => {
    const db = openDatabase(":memory:");
    const log = eventLog(db, { parse });
    log.append(note("a"));
    expect(db.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1 });
    expect("close" in log).toBe(false);
    expect(db.isOpen).toBe(true);
    db.close();
  });

  it("refuses a table name that is not a plain name", () => {
    const db = openDatabase(":memory:");
    for (const table of ["", "1a", "a b", "a;DROP", "sqlite_x", SCHEMA_VERSIONS_TABLE]) {
      expect(() => eventLog(db, { parse, table })).toThrow(RangeError);
    }
    db.close();
  });

  it("refuses a call in a transaction of the caller, and does not break", () => {
    const db = openDatabase(":memory:");
    const log = eventLog(db, { parse });
    db.exec("BEGIN");
    expect(() => log.append(note("a"))).toThrow(/within a transaction/);
    db.exec("ROLLBACK");
    expect(log.append(note("a"))).toEqual({ kind: "added", seq: 1 });
    db.close();
  });
});
