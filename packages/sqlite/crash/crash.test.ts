/**
 * The crash suite of the home. Seeded stop plans of `@mark1russell7/rigor-chaos` stop the writer of `writer.ts` in a
 * transaction, a migration step, a checkpoint and a salvage. After each stop, the test opens the file again and examines
 * it. Then a rerun with no stop completes the work, and the test examines the file again.
 *
 * The suite starts many processes, and its stops at a time depend on the load of the computer. Thus it operates only in CI
 * (`crash.yml`). With the variable `CRASH_RECORDS`, each run adds its record to that JSONL file.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Stop, type StopPlan, type StopSignal, stopPlan } from "@mark1russell7/rigor-chaos";
import { type StopRun, type StopRunOptions, countStops, runToStop } from "@mark1russell7/rigor-testkit/stop";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkIntegrity, openDatabase, openEventLog, schemaVersion } from "../src/index.ts";
import { type Scenario, type ScenarioArgs, crashEvent, markTime, parseCrashEvent, writerLines } from "./shared.ts";

const WRITER = fileURLToPath(new URL("./writer.ts", import.meta.url));
// Node.js 22 strips the types of TypeScript only with this flag
const NODE_FLAGS = Number(process.versions.node.split(".")[0]) >= 23 ? [] : ["--experimental-strip-types"];
// On Windows, SIGTERM ends a process at once, as SIGKILL does
const SIGNALS: readonly StopSignal[] = process.platform === "win32" ? ["SIGKILL"] : ["SIGKILL", "SIGTERM"];
/** The count of the seeded points of each plan, between its edges. */
const DRAWS = 12;
const RUN_MS = 60_000;
const TEST_MS = 900_000;
const RECORDS = process.env["CRASH_RECORDS"];

type Facts = Record<string, unknown>;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(entry: Facts): void {
  if (RECORDS !== undefined && RECORDS !== "") appendFileSync(RECORDS, `${JSON.stringify(entry)}\n`);
}

function writer<S extends Scenario>(scenario: S, args: ScenarioArgs[S]): Omit<StopRunOptions, "stop"> {
  return {
    command: process.execPath,
    args: [...NODE_FLAGS, "--disable-warning=ExperimentalWarning", WRITER, scenario, JSON.stringify(args)],
    timeoutMs: RUN_MS,
  };
}

function outputOf(run: StopRun): string {
  const text = `${run.stdout}${run.stderr}`.slice(-2_000);
  return text === "" ? "" : `\nThe last output of the writer:\n${text}`;
}

/** This function starts the writer with no stop, and throws when it does not end with the code 0. */
async function complete<S extends Scenario>(scenario: S, args: ScenarioArgs[S]): Promise<StopRun> {
  const run = await runToStop(writer(scenario, args));
  assert(run.exit.code === 0, `The run with no stop ended with ${JSON.stringify(run.exit)}.${outputOf(run)}`);
  return run;
}

let folder = "";
let files = 0;
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "sqlite-crash-"));
});
afterAll(() => {
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** This function gives the path of a new database file in the folder of the suite. */
function freshPath(name: string): string {
  files += 1;
  return join(folder, `${name}-${files}.db`);
}

function removeDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true, maxRetries: 5, retryDelay: 50 });
}

/** This function opens a file as an app does after a crash, checks its integrity, and gives the result of `read`. */
function examine<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = openDatabase(path);
  try {
    const integrity = checkIntegrity(db);
    assert(integrity.ok, `integrity_check: ${integrity.problems.join(" ")}`);
    return read(db);
  } finally {
    db.close();
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** This function gives the count of the committed transactions of a table. Each one is complete, and they are 0 to n - 1. */
function committedTransactions(db: DatabaseSync, table: string, size: number): number {
  if (!hasTable(db, table)) return 0;
  const rows = db.prepare(`SELECT tx, COUNT(*) AS n FROM ${table} GROUP BY tx ORDER BY tx`).all() as { tx: number; n: number }[];
  rows.forEach((row, index) => {
    assert(row.tx === index, `The committed transactions are not 0 to ${rows.length - 1}: ${rows.map((each) => each.tx).join(", ")}.`);
    assert(row.n === size, `The transaction ${row.tx} has ${row.n} of its ${size} rows.`);
  });
  return rows.length;
}

/** This function tells if the stop ended the writer: the exit of the writer has a signal. */
function signalled(run: StopRun): boolean {
  return run.exit.signal !== null;
}

/** This function gives a stop at a time later by `offset` ms. */
function later(stop: Stop, offset: number): Stop {
  if (!("ms" in stop.at)) throw new RangeError("Only a stop at a time takes an offset.");
  return { ...stop, at: { ms: stop.at.ms + offset } };
}

/** The phase of a complete run between two marks of the writer, in ms from the start of its process. */
interface Phase {
  readonly offset: number;
  readonly span: number;
}

async function phaseOf<S extends Scenario>(scenario: S, args: ScenarioArgs[S], begin: string, end: string): Promise<Phase> {
  const run = await complete(scenario, args);
  const from = markTime(run.stdout, begin);
  const to = markTime(run.stdout, end);
  assert(from !== undefined && to !== undefined, `The complete run has no mark "${begin}" or "${end}".${outputOf(run)}`);
  return { offset: Math.floor(from), span: Math.max(1, Math.ceil(to - from)) };
}

/** One case of the suite: a plan, the arguments of each run, and the checks after the stop and after the rerun. */
interface Case<S extends Scenario> {
  readonly scenario: S;
  readonly plan: StopPlan;
  /** The ms that each stop at a time waits more, so that the plan aims at a phase of the run. */
  readonly offset?: number;
  /** This function gives the arguments of one run. It can prepare the file of the run first. */
  readonly args: () => ScenarioArgs[S] | Promise<ScenarioArgs[S]>;
  readonly afterStop: (run: StopRun, args: ScenarioArgs[S]) => Facts;
  readonly afterRerun: (rerun: StopRun, args: ScenarioArgs[S], facts: Facts) => Facts;
  readonly cleanup?: (args: ScenarioArgs[S]) => void;
}

/** This function applies each stop of a plan, and gives the run of each stop. It throws at the first failed check. */
async function runCase<S extends Scenario>(test: Case<S>): Promise<StopRun[]> {
  const runs: StopRun[] = [];
  for (const planned of test.plan.stops) {
    const stop = test.offset === undefined ? planned : later(planned, test.offset);
    const args = await test.args();
    const run = await runToStop({ ...writer(test.scenario, args), stop });
    const entry: Facts = {
      scenario: test.scenario,
      node: process.versions.node,
      sqlite: process.versions["sqlite"],
      seed: test.plan.seed,
      offset: test.offset ?? 0,
      stop,
      exit: run.exit,
      stopped: run.stopped,
      steps: run.steps,
      lastLabel: run.lastLabel ?? null,
      ms: Math.round(run.ms),
    };
    try {
      const ended = run.exit.signal !== null ? `the signal ${run.exit.signal}` : `the code ${String(run.exit.code)}`;
      if ("step" in stop.at) {
        assert(run.stopped && run.lastStep === stop.at.step, `The writer did not stop at the step ${stop.at.step}: the last step is ${String(run.lastStep)}.`);
        assert(ended === `the signal ${stop.signal}`, `The writer ended with ${ended}, not the signal ${stop.signal}.`);
      } else {
        // A stop at a time ends the writer with its signal. A writer that ends before the stop ends with the code 0.
        // The exit decides, not `stopped`: a signal to a writer that ended before the test read its exit gives `stopped`.
        const allowed = [`the signal ${stop.signal}`, "the code 0"];
        assert(allowed.includes(ended), `The writer ended with ${ended}, not ${allowed.join(" or ")}.`);
      }
      const facts = test.afterStop(run, args);
      const rerun = await complete(test.scenario, args);
      const after = test.afterRerun(rerun, args, facts);
      record({ ...entry, facts, after, pass: true });
      runs.push(run);
    } catch (error) {
      record({ ...entry, pass: false, problem: messageOf(error) });
      throw new Error(`${test.scenario}: the stop ${JSON.stringify(stop)} after the point "${String(run.lastLabel)}": ${messageOf(error)}${outputOf(run)}`, {
        cause: error,
      });
    } finally {
      test.cleanup?.(args);
    }
  }
  return runs;
}

/** The size of the work of the writer in the transaction cases. */
interface TransactionSize {
  readonly transactions: number;
  readonly writes: number;
}

describe("a stop in a transaction", () => {
  /** The stops at a step examine each point of a small file. */
  const size: TransactionSize = { transactions: 12, writes: 5 };
  /**
   * The stops at a time need a long phase. In CI, the start of the writer varies by approximately 10 ms, and 12
   * transactions take approximately 6 ms.
   */
  const timeSize: TransactionSize = { transactions: 240, writes: 5 };

  /**
   * The count of the committed transactions after the last stop point, as a range. A stop at a step stops at its point,
   * thus the count is exact. After a stop at a time, the commit after the last write can come before the signal.
   */
  function committedRange(label: string | undefined, measure: "step" | "ms", writes: number): readonly [number, number] {
    if (label === undefined) return [0, 0];
    const [kind, tx, write] = label.split(" ");
    const k = Number(tx);
    if (kind === "commit") return [k + 1, k + 1];
    const lastWrite = kind === "write" && Number(write) === writes - 1;
    return [k, measure === "ms" && lastWrite ? k + 1 : k];
  }

  function transactionCase(plan: StopPlan, measure: "step" | "ms", given: TransactionSize, offset?: number): Case<"transaction"> {
    return {
      scenario: "transaction",
      plan,
      ...(offset === undefined ? {} : { offset }),
      args: () => ({ path: freshPath("transaction"), ...given }),
      afterStop: (run, args) => {
        const committed = examine(args.path, (db) => committedTransactions(db, "rows", given.writes));
        const [least, most] = committedRange(run.lastLabel, measure, given.writes);
        assert(committed >= least && committed <= most, `The file has ${committed} committed transactions, not ${least} to ${most}.`);
        return { committed };
      },
      afterRerun: (_rerun, args) => {
        const committed = examine(args.path, (db) => committedTransactions(db, "rows", given.writes));
        assert(committed === given.transactions, `After the rerun, the file has ${committed} of ${given.transactions} transactions.`);
        return { committed };
      },
      cleanup: (args) => removeDatabase(args.path),
    };
  }

  it(
    "keeps each committed transaction and no part of the others, at each stop of a step",
    async () => {
      const steps = await countStops(writer("transaction", { path: freshPath("transaction-count"), ...size }));
      expect(steps).toBe(size.transactions * (size.writes + 2));
      const plan = stopPlan({ within: { step: steps }, draws: DRAWS, signals: SIGNALS }, "sqlite/crash/transaction/step");
      const runs = await runCase(transactionCase(plan, "step", size));
      expect(runs).toHaveLength(plan.stops.length);
    },
    TEST_MS,
  );

  it(
    "keeps each committed transaction and no part of the others, at each stop of a time",
    async () => {
      const phase = await phaseOf("transaction", { path: freshPath("transaction-phase"), ...timeSize }, "transactions begin", "transactions end");
      const plan = stopPlan({ within: { ms: phase.span }, draws: DRAWS, signals: SIGNALS }, "sqlite/crash/transaction/ms");
      const runs = await runCase(transactionCase(plan, "ms", timeSize, phase.offset));
      expect(runs).toHaveLength(plan.stops.length);
      const last = `commit ${timeSize.transactions - 1}`;
      const inTransactions = runs.filter((run) => signalled(run) && run.lastLabel !== undefined && run.lastLabel !== last).length;
      record({ scenario: "transaction", phase, stops: runs.length, inTransactions });
      // A plan that no stop applied during the transactions did not examine them
      expect(inTransactions, `The phase is ${JSON.stringify(phase)} ms.`).toBeGreaterThan(0);
    },
    TEST_MS,
  );
});

describe("a stop in a migration step", () => {
  const size = { steps: 6, rows: 4 };

  /** The schema version after the last stop point. Each step commits in one transaction with its version. */
  function versionAfter(label: string | undefined): number {
    if (label === "migrated") return size.steps;
    const [kind, step] = (label ?? "").split(" ");
    assert(kind === "step", `The point "${String(label)}" is not a point of the migration.`);
    return Number(step);
  }

  /** This function examines the tables of the steps, and gives the schema version. */
  function migratedSteps(db: DatabaseSync): number {
    const version = schemaVersion(db);
    for (let k = 0; k < size.steps; k += 1) {
      const has = hasTable(db, `m${k}`);
      assert(has === k < version, `At the schema version ${version}, the table m${k} is ${has ? "there" : "not there"}.`);
      if (!has) continue;
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM m${k}`).get() as { n: number };
      assert(n === size.rows, `The table m${k} has ${n} of its ${size.rows} rows.`);
    }
    return version;
  }

  it(
    "keeps the version of the last complete step and no part of the next step, at each stop of a step",
    async () => {
      const steps = await countStops(writer("migration", { path: freshPath("migration-count"), ...size }));
      expect(steps).toBe(size.steps * (size.rows + 1) + 1);
      const plan = stopPlan({ within: { step: steps }, draws: DRAWS, signals: SIGNALS }, "sqlite/crash/migration/step");
      const runs = await runCase({
        scenario: "migration",
        plan,
        args: () => ({ path: freshPath("migration"), ...size }),
        afterStop: (run, args) => {
          const version = examine(args.path, migratedSteps);
          const expected = versionAfter(run.lastLabel);
          assert(version === expected, `The schema version is ${version}, not ${expected}.`);
          return { version };
        },
        afterRerun: (_rerun, args) => {
          const version = examine(args.path, migratedSteps);
          assert(version === size.steps, `After the rerun, the schema version is ${version}, not ${size.steps}.`);
          return { version };
        },
        cleanup: (args) => removeDatabase(args.path),
      });
      expect(runs).toHaveLength(plan.stops.length);
    },
    TEST_MS,
  );
});

describe("a stop in a checkpoint", () => {
  // About 24 MiB of blobs in the log before the checkpoint
  const size = { transactions: 24, rows: 64, bytes: 16 * 1024 };

  /** This function examines the blobs: each byte of a blob is the number of its transaction modulo 251. */
  function checkedBlobs(db: DatabaseSync): number {
    const committed = committedTransactions(db, "blobs", size.rows);
    if (committed === 0) return 0;
    // The read of each transaction is 1 MiB, with no iterator. On Node.js 22.13, a collection during an iterate() can
    // finalize the statement of the iterator.
    const statement = db.prepare("SELECT i, body FROM blobs WHERE tx = ? ORDER BY i");
    for (let tx = 0; tx < committed; tx++) {
      const byte = tx % 251;
      for (const row of statement.all(tx) as { i: number; body: Uint8Array }[]) {
        assert(row.body.length === size.bytes, `The blob ${tx} ${row.i} has ${row.body.length} of its ${size.bytes} bytes.`);
        assert(
          row.body.every((value) => value === byte),
          `The blob ${tx} ${row.i} has a byte that is not ${byte}.`,
        );
      }
    }
    return committed;
  }

  /**
   * This function gives a file with each transaction in its log and no checkpoint. The writer has no automatic checkpoint,
   * thus a `SIGKILL` after the last commit leaves the full log. The next run of the writer does only the checkpoint. Thus
   * the time to its checkpoint does not include the writes and their variation.
   */
  async function loggedFile(name: string): Promise<ScenarioArgs["checkpoint"]> {
    const args = { path: freshPath(name), ...size };
    const last = size.transactions - 1;
    const run = await runToStop({ ...writer("checkpoint", args), stop: { at: { step: last }, signal: "SIGKILL" } });
    assert(run.stopped && run.lastLabel === `commit ${last}`, `The setup did not stop after the commit ${last}: the last point is "${String(run.lastLabel)}".${outputOf(run)}`);
    const log = `${args.path}-wal`;
    assert(existsSync(log) && statSync(log).size > 0, `The setup left no log in ${log}.`);
    return args;
  }

  it(
    "keeps each transaction of the log after a stop during the TRUNCATE checkpoint, and a rerun empties the log",
    async () => {
      const phase = await phaseOf("checkpoint", await loggedFile("checkpoint-phase"), "checkpoint begin", "checkpoint end");
      const plan = stopPlan({ within: { ms: phase.span }, draws: DRAWS, signals: SIGNALS }, "sqlite/crash/checkpoint/ms");
      const runs = await runCase({
        scenario: "checkpoint",
        plan,
        offset: phase.offset,
        args: () => loggedFile("checkpoint"),
        afterStop: (run, args) => {
          // Each transaction was in the log before the run, so a stop at each time keeps all of them
          const committed = examine(args.path, checkedBlobs);
          assert(committed === size.transactions, `After the stop, the file has ${committed} of ${size.transactions} transactions.`);
          return { committed, inCheckpoint: run.lastLabel === "checkpoint begin" };
        },
        afterRerun: (_rerun, args) => {
          const log = `${args.path}-wal`;
          const logBytes = existsSync(log) ? statSync(log).size : 0;
          assert(logBytes === 0, `After the rerun, the log has ${logBytes} bytes.`);
          const committed = examine(args.path, checkedBlobs);
          assert(committed === size.transactions, `After the rerun, the file has ${committed} of ${size.transactions} transactions.`);
          return { committed, logBytes };
        },
        cleanup: (args) => removeDatabase(args.path),
      });
      const inCheckpoint = runs.filter((run) => signalled(run) && run.lastLabel === "checkpoint begin").length;
      record({ scenario: "checkpoint", phase, stops: runs.length, inCheckpoint });
      // A plan that no stop applied during the checkpoint did not examine the checkpoint
      expect(inCheckpoint, `The phase is ${JSON.stringify(phase)} ms.`).toBeGreaterThan(0);
    },
    TEST_MS,
  );
});

describe("a stop in a salvage", () => {
  const events = 20_000;
  let source = "";
  let sourceHash = "";
  let sourceFiles: string[] = [];

  const hashOf = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

  beforeAll(() => {
    const sourceFolder = join(folder, "source");
    mkdirSync(sourceFolder);
    source = join(sourceFolder, "source.db");
    const log = openEventLog(source, parseCrashEvent, { wal: false });
    try {
      log.appendAll(Array.from({ length: events }, (_, n) => crashEvent(n)));
    } finally {
      log.close();
    }
    sourceHash = hashOf(source);
    sourceFiles = readdirSync(sourceFolder).sort();
  });

  /** This function checks that the source file and its folder did not change. */
  function checkSource(): void {
    assert(hashOf(source) === sourceHash, "The source file changed.");
    const now = readdirSync(join(folder, "source")).sort();
    assert(JSON.stringify(now) === JSON.stringify(sourceFiles), `The folder of the source has ${now.join(", ")}, not ${sourceFiles.join(", ")}.`);
  }

  /**
   * This function gives the count of the events of the new log, and does not write. `eventLog` keeps its version as a
   * part of the file and migrates, but `openEventLog` keeps the `user_version` of the file. Thus this read uses SQL.
   * Each step of the log commits with its version, so the table is there only at the version 1 or more.
   */
  function storedEvents(db: DatabaseSync): number {
    const version = schemaVersion(db);
    const has = hasTable(db, "events");
    assert(has === version >= 1, `At the schema version ${version}, the table events is ${has ? "there" : "not there"}.`);
    return has ? (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n : 0;
  }

  it(
    "keeps the source, and a rerun adds each missing event with no conflict",
    async () => {
      const phase = await phaseOf("salvage", { source, target: freshPath("salvage-phase") }, "salvage begin", "salvage end");
      const plan = stopPlan({ within: { ms: phase.span }, draws: DRAWS, signals: SIGNALS }, "sqlite/crash/salvage/ms");
      const runs = await runCase({
        scenario: "salvage",
        plan,
        offset: phase.offset,
        args: () => ({ source, target: freshPath("salvage") }),
        afterStop: (run, args) => {
          checkSource();
          const stored = examine(args.target, storedEvents);
          assert(stored <= events, `The new log has ${stored} events, more than the ${events} of the source.`);
          return { stored, inSalvage: run.lastLabel === "salvage begin" };
        },
        afterRerun: (rerun, args, facts) => {
          checkSource();
          const line = writerLines(rerun.stdout).find((each) => "salvaged" in each);
          assert(line !== undefined && "salvaged" in line, `The rerun wrote no result.${outputOf(rerun)}`);
          const { read, added, duplicate, conflict, lost } = line.salvaged;
          const before = facts["stored"] as number;
          assert(read === events && lost === 0, `The rerun read ${read} events and lost ${lost}, not ${events} and 0.`);
          assert(conflict === 0, `The rerun found ${conflict} conflicts: an event of the new log is not the event of the source.`);
          assert(added === events - before && duplicate === before, `The rerun added ${added} and found ${duplicate} duplicates, after ${before} events.`);
          const stored = examine(args.target, storedEvents);
          assert(stored === events, `After the rerun, the new log has ${stored} of ${events} events.`);
          return { added, duplicate, stored };
        },
        cleanup: (args) => removeDatabase(args.target),
      });
      const inSalvage = runs.filter((run) => signalled(run) && run.lastLabel === "salvage begin").length;
      record({ scenario: "salvage", phase, stops: runs.length, inSalvage });
      // A plan that no stop applied during the salvage did not examine the salvage
      expect(inSalvage, `The phase is ${JSON.stringify(phase)} ms.`).toBeGreaterThan(0);
    },
    TEST_MS,
  );
});
