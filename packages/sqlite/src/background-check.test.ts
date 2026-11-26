import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkIntegrityInBackground, checkIntegrityInBackgroundWith } from "./background-check.ts";
import type { LogRecord } from "./event-log.ts";
import { openEventLog } from "./event-log-file.ts";
import { checkIntegrity } from "./recovery.ts";

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-background-"));
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
const PAGE = 4096;

/** This function writes a closed log file of 300 events. */
function writeLog(path: string): void {
  const log = openEventLog(path, parse);
  log.appendAll(Array.from({ length: 300 }, (_, n) => padded(n + 1)));
  log.close();
}

/** This function writes garbage over the pages of the file that have the bodies of some events. */
function breakPages(path: string, ids: readonly string[]): void {
  const bytes = readFileSync(path);
  for (const id of ids) {
    const at = bytes.indexOf(`{"id":"${id}"`);
    expect(at).toBeGreaterThan(PAGE);
    const page = Math.floor(at / PAGE);
    bytes.fill(0xff, page * PAGE, (page + 1) * PAGE);
  }
  writeFileSync(path, bytes);
}

/** This function gives the result of `checkIntegrity` on a new connection to a file. */
function checkHere(path: string, quick: boolean): ReturnType<typeof checkIntegrity> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return checkIntegrity(db, { quick });
  } finally {
    db.close();
  }
}

/** This function gives a promise of the exit code of a worker. */
const exitOf = (worker: Worker): Promise<number> => new Promise((resolve) => worker.once("exit", resolve));

describe("checkIntegrityInBackground", () => {
  it("passes a good file with the quick check and with the full check", async () => {
    writeLog(file);
    await expect(checkIntegrityInBackground(file, { quick: true })).resolves.toEqual({ ok: true, problems: [] });
    await expect(checkIntegrityInBackground(file)).resolves.toEqual({ ok: true, problems: [] });
  });

  it("gives the problems of a file with broken pages, as checkIntegrity gives them", async () => {
    writeLog(file);
    breakPages(file, ["e40", "e160", "e280"]);
    for (const quick of [true, false]) {
      const integrity = await checkIntegrityInBackground(file, { quick });
      expect(integrity.ok).toBe(false);
      expect(integrity.problems.length).toBeGreaterThan(0);
      expect(integrity).toEqual(checkHere(file, quick));
    }
  });

  it("keeps the limit of problems", async () => {
    writeLog(file);
    breakPages(file, ["e40", "e160", "e280"]);
    const integrity = await checkIntegrityInBackground(file, { quick: true, limit: 1 });
    expect(integrity.problems).toHaveLength(1);
  });

  it("gives one problem for a file that is not a database", async () => {
    writeFileSync(file, Buffer.alloc(8192, 0x41));
    const integrity = await checkIntegrityInBackground(file, { quick: true });
    expect(integrity.ok).toBe(false);
    expect(integrity.problems).toHaveLength(1);
  });

  it("rejects a path with no file, a database in memory and a bad limit", async () => {
    await expect(checkIntegrityInBackground(join(folder, "missing.db"))).rejects.toThrow();
    await expect(checkIntegrityInBackground(":memory:")).rejects.toThrow(RangeError);
    await expect(checkIntegrityInBackground(file, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(checkIntegrityInBackground(file, { busyTimeoutMs: -1 })).rejects.toThrow(RangeError);
  });

  it("does not stop a writer, and examines the commits in the WAL file", async () => {
    const log = openEventLog(file, parse);
    try {
      log.appendAll(Array.from({ length: 50 }, (_, n) => padded(n + 1)));
      const check = checkIntegrityInBackground(file, { quick: true });
      log.append(padded(51));
      await expect(check).resolves.toEqual({ ok: true, problems: [] });
      log.append(padded(52));
      expect(log.count()).toBe(52);
    } finally {
      log.close();
    }
  });

  it("starts no worker when the signal is aborted before the call", async () => {
    writeLog(file);
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    let started = false;
    const check = checkIntegrityInBackgroundWith(file, { signal: controller.signal }, () => {
      started = true;
    });
    await expect(check).rejects.toBe(reason);
    expect(started).toBe(false);
  });

  it("rejects with the reason of an abort, and the worker ends", async () => {
    writeLog(file);
    const controller = new AbortController();
    const reason = new Error("stop");
    let worker: Worker | undefined;
    const check = checkIntegrityInBackgroundWith(file, { signal: controller.signal }, (started) => {
      worker = started;
    });
    expect(worker).toBeDefined();
    const exit = exitOf(worker as Worker);
    controller.abort(reason);
    await expect(check).rejects.toBe(reason);
    await exit;
    expect(worker?.threadId).toBe(-1);
  });
});
