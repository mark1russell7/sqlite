import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAutocheckpoint } from "./checkpoint.ts";
import { openDatabase } from "./database.ts";
import type { LogRecord } from "./event-log.ts";
import { openEventLog } from "./event-log-file.ts";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-autocheckpoint-"));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

interface Note extends LogRecord {
  readonly text: string;
}

const parse = (value: unknown): Note => value as Note;
// One event of about 8 KiB fills two pages of 4 KiB.
const note = (index: number): Note => ({ id: `n${String(index)}`, at: "2026-11-08T12:00:00Z", type: "note", text: "x".repeat(8000) });
const pragma = (db: { prepare(sql: string): { get(): unknown } }): number => Number((db.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint);

describe("the automatic checkpoint", () => {
  it("keeps the default of SQLite, and sets the pages of the option", () => {
    const plain = openDatabase(join(folder, "plain.db"));
    expect(pragma(plain)).toBe(1000);
    plain.close();
    const off = openDatabase(join(folder, "off.db"), { autocheckpointPages: 0 });
    expect(pragma(off)).toBe(0);
    setAutocheckpoint(off, 250);
    expect(pragma(off)).toBe(250);
    off.close();
  });

  it("refuses pages that are not a whole number of 0 or more", () => {
    for (const pages of [-1, 1.5, Number.NaN]) {
      expect(() => openDatabase(join(folder, "bad.db"), { autocheckpointPages: pages })).toThrow(RangeError);
      const db = openDatabase(":memory:");
      expect(() => setAutocheckpoint(db, pages)).toThrow(RangeError);
      db.close();
    }
  });

  it("lets the log grow with the checkpoint off, and copies it at a call of checkpoint", () => {
    const file = join(folder, "log.db");
    const log = openEventLog(file, parse, { autocheckpointPages: 0 });
    // 600 events of two pages give more than the 1000 pages that start the default checkpoint.
    log.appendAll(Array.from({ length: 600 }, (_, index) => note(index)));
    const grown = log.checkpoint("PASSIVE");
    expect(grown.busy).toBe(false);
    expect(grown.log).toBeGreaterThan(1000);
    expect(grown.checkpointed).toBe(grown.log);
    log.setAutocheckpoint(1000);
    log.appendAll(Array.from({ length: 10 }, (_, index) => note(600 + index)));
    expect(log.checkpoint("TRUNCATE")).toEqual({ busy: false, log: 0, checkpointed: 0 });
    expect(log.count()).toBe(610);
    log.close();
    const again = openEventLog(file, parse);
    expect(again.count()).toBe(610);
    again.close();
  });

  it("keeps each commit at a close with the checkpoint off", () => {
    const file = join(folder, "kept.db");
    const log = openEventLog(file, parse, { autocheckpointPages: 0 });
    log.appendAll(Array.from({ length: 50 }, (_, index) => note(index)));
    log.close();
    const again = openEventLog(file, parse);
    expect(again.count()).toBe(50);
    again.close();
  });
});
