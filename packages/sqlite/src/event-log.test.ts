import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENT_LOG_SCHEMA_VERSION, openEventLog, type LogRecord } from "./event-log.ts";

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
const note = (id: string, text = id): Note => ({ id, at: "2026-11-08T12:00:00Z", type: "note", text });
const acceptAll = (): undefined => undefined;

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
    expect(() => openEventLog(file, parse)).toThrow(/The log has the schema version 2.*newer version/);
  });

  it("gives the same events after a reopen, in order", () => {
    const log = openEventLog(file, parse);
    expect(log.append(note("a"), acceptAll)).toBeUndefined();
    expect(log.appendAll([note("b"), note("c")], acceptAll)).toEqual([]);
    log.close();
    const again = openEventLog(file, parse);
    expect([...again.read()].map((each) => each.id)).toEqual(["a", "b", "c"]);
    expect(again.count()).toBe(3);
    again.close();
  });

  it("does not write a refused event, and gives its problem", () => {
    const log = openEventLog(file, parse);
    const refuseB = (event: Note): string | undefined => (event.id === "b" ? `no ${event.id}` : undefined);
    expect(log.append(note("b"), refuseB)).toBe("no b");
    expect(log.appendAll([note("a"), note("b"), note("c")], refuseB)).toEqual(["no b"]);
    expect([...log.read()].map((each) => each.id)).toEqual(["a", "c"]);
    log.close();
  });

  it("names the position of an event that does not parse", () => {
    const log = openEventLog(file, parse);
    log.append({ id: "x", at: "2026-11-08T12:00:00Z", type: "bad" }, acceptAll);
    log.close();
    const strict = openEventLog(file, (value) => {
      throw new Error(`not an event: ${JSON.stringify(value)}`);
    });
    expect(() => [...strict.read()]).toThrow(/position 1/);
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
    expect(() => log.count()).toThrow(/broken/);
    log.recover();
    expect(log.count()).toBe(0);
    expect(log.append(record, acceptAll)).toBeUndefined();
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
    expect([...log.read()].map((each) => each.id)).toEqual(["a"]);

    other.exec("DROP TRIGGER refuse");
    other.close();
    expect(log.append(note("b"), acceptAll)).toBeUndefined();
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
    expect(log.append(note("a"), acceptAll)).toBeUndefined();
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
