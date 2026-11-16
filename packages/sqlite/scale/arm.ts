/**
 * One child of the scale bench. The fresh runner of `@mark1russell7/rigor-bench` starts it for each measure and round:
 * `node scale/arm.ts --path <file> --events <n> --case <measure>`. It prints one JSON line with the time in ms.
 *
 * The time includes only the work of the measure. A measure that writes removes its writes after the time, so each child
 * gets the same file of `n` events.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { random } from "@mark1russell7/rigor-generators";
import { median } from "@mark1russell7/rigor-statistics";
import { checkIntegrity, checkpoint, openDatabase, openEventLog, transaction } from "../src/index.ts";
import { APPEND_EVENTS, MEASURES, type Measure, parseScaleEvent, READ_LIMIT, READS, RECOVERY_EVENTS, scaleEvents, scaleId } from "./shared.ts";

const { values } = parseArgs({
  options: { path: { type: "string" }, events: { type: "string" }, case: { type: "string" }, crash: { type: "boolean" } },
});
const path = values.path ?? "";
const events = Number(values.events);
if (path === "" || !Number.isSafeInteger(events) || events < READ_LIMIT) {
  throw new RangeError(`The child needs --path <file> and --events <n> with n of ${READ_LIMIT} or more, not ${JSON.stringify(values)}.`);
}

/** This function gives the time of one call of `work` in ms. */
function timed(work: () => void): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

/** This function removes each event after the first `events`, and empties the WAL file. The time of a measure does not include it. */
function restore(): void {
  const db = openDatabase(path);
  try {
    db.exec(`DELETE FROM events WHERE seq > ${events}`);
    if (checkpoint(db, "TRUNCATE").busy) throw new Error(`A different connection stopped the checkpoint of ${path}.`);
  } finally {
    db.close();
  }
}

/** This function throws when the log does not have exactly `expected` events. */
function expectHead(head: number, expected: number, measure: string): void {
  if (head !== expected) throw new Error(`The measure ${measure} found ${head} events in ${path}, not ${expected}.`);
}

/**
 * The writer of the measure `recovery`. It writes `RECOVERY_EVENTS` events with no checkpoint, so they stay in the WAL
 * file. Then it stops itself with SIGKILL, before its close.
 */
function crashWriter(): never {
  const db = openDatabase(path);
  db.exec("PRAGMA wal_autocheckpoint = 0");
  const insert = db.prepare("INSERT INTO events (id, at, type, body) VALUES (?, ?, ?, ?)");
  const last = events + RECOVERY_EVENTS;
  for (let from = events + 1; from <= last; from += 500) {
    transaction(db, () => {
      for (const event of scaleEvents(from, Math.min(from + 499, last))) insert.run(event.id, event.at, event.type, JSON.stringify(event));
    });
  }
  process.kill(process.pid, "SIGKILL");
  throw new Error("The writer of the measure recovery did not stop at its SIGKILL.");
}

const MEASURE_RUNS: Readonly<Record<Measure, () => number>> = {
  append() {
    const batch = [...scaleEvents(events + 1, events + APPEND_EVENTS)];
    const log = openEventLog(path, parseScaleEvent);
    let added = 0;
    let ms: number;
    try {
      ms = timed(() => {
        added = log.appendAll(batch).filter((result) => result.kind === "added").length;
      });
    } finally {
      log.close();
    }
    if (added !== APPEND_EVENTS) throw new Error(`The append added ${added} events, not ${APPEND_EVENTS}.`);
    restore();
    return ms;
  },

  "read-after"() {
    const draw = random(`sqlite-scale-read-after-${events}`);
    const positions = Array.from({ length: READS }, () => draw.below(events - READ_LIMIT + 1));
    const log = openEventLog(path, parseScaleEvent);
    try {
      const times = positions.map((after) => {
        let read = 0;
        const ms = timed(() => {
          read = [...log.entries({ after, limit: READ_LIMIT })].length;
        });
        if (read !== READ_LIMIT) throw new Error(`The read after ${after} gave ${read} events, not ${READ_LIMIT}.`);
        return ms;
      });
      return median(times);
    } finally {
      log.close();
    }
  },

  get() {
    const draw = random(`sqlite-scale-get-${events}`);
    const ids = Array.from({ length: READS }, () => scaleId(1 + draw.below(events)));
    const log = openEventLog(path, parseScaleEvent);
    try {
      const times = ids.map((id) => {
        let found = false;
        const ms = timed(() => {
          found = log.get(id) !== undefined;
        });
        if (!found) throw new Error(`The log did not find the event ${id}.`);
        return ms;
      });
      return median(times);
    } finally {
      log.close();
    }
  },

  open() {
    const start = performance.now();
    const log = openEventLog(path, parseScaleEvent);
    const head = log.head();
    const ms = performance.now() - start;
    log.close();
    expectHead(head, events, "open");
    return ms;
  },

  migrate() {
    const db = openDatabase(path);
    try {
      db.exec("DROP INDEX events_type");
      db.exec("PRAGMA user_version = 1");
      if (checkpoint(db, "TRUNCATE").busy) throw new Error(`A different connection stopped the checkpoint of ${path}.`);
    } finally {
      db.close();
    }
    const start = performance.now();
    const log = openEventLog(path, parseScaleEvent);
    const ms = performance.now() - start;
    const head = log.head();
    log.close();
    expectHead(head, events, "migrate");
    return ms;
  },

  count() {
    const log = openEventLog(path, parseScaleEvent);
    let count = 0;
    try {
      const ms = timed(() => {
        count = log.count();
      });
      expectHead(count, events, "count");
      return ms;
    } finally {
      log.close();
    }
  },

  recovery() {
    const writer = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--path", path, "--events", String(events), "--crash"], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (writer.signal !== "SIGKILL") {
      throw new Error(`The writer of the measure recovery ended with the code ${String(writer.status)} and the signal ${String(writer.signal)}: ${writer.stderr}`);
    }
    const wal = `${path}-wal`;
    if (!existsSync(wal) || statSync(wal).size === 0) throw new Error(`The writer of the measure recovery left no WAL file at ${wal}.`);
    const start = performance.now();
    const log = openEventLog(path, parseScaleEvent);
    const head = log.head();
    const ms = performance.now() - start;
    log.close();
    expectHead(head, events + RECOVERY_EVENTS, "recovery");
    restore();
    return ms;
  },

  "quick-check"() {
    const db = openDatabase(path);
    try {
      let problems: readonly string[] = [];
      const ms = timed(() => {
        problems = checkIntegrity(db, { quick: true }).problems;
      });
      if (problems.length > 0) throw new Error(`The quick check of ${path} found problems: ${problems.join(" | ")}`);
      return ms;
    } finally {
      db.close();
    }
  },
};

if (values.crash === true) crashWriter();
const measure = values.case as Measure;
if (!MEASURES.includes(measure)) throw new RangeError(`The case must be one of ${MEASURES.join(", ")}, not ${String(values.case)}.`);
process.stdout.write(`${JSON.stringify({ ms: MEASURE_RUNS[measure]() })}\n`);
