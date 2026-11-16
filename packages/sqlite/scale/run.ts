/**
 * The driver of one job of the scale bench (roadmap SQ-26). The workflow `scale.yml` starts it in CI:
 * `node scale/run.ts --events <n,n,...> --rounds <r> --job <k> --runner <id> --dir <folder> --records <folder>`.
 *
 * The job measures each rung of `--events` on one runner, from the smallest rung to the largest. For each rung, it builds
 * a log of `n` events. Then the fresh runner of `@mark1russell7/rigor-bench` starts a child for each measure and round,
 * in two arms of one build. The driver removes the file of the rung before the next rung. It writes the record of each
 * rung to `<records>/scale-<n>-job-<k>.json` and a table to the summary of the job.
 */
import { appendFileSync, mkdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { freshRun } from "@mark1russell7/rigor-bench/fresh";
import { median } from "@mark1russell7/rigor-statistics";
import { checkpoint, openDatabase, openEventLog } from "../src/index.ts";
import {
  BUILD_BATCH,
  type Built,
  MEASURES,
  MEASURE_TEXT,
  PAD_CHARS,
  type MeasureValues,
  parseScaleEvent,
  RUNG_EVENTS,
  SCALE_FORMAT,
  type ScaleRecord,
  scaleEvents,
} from "./shared.ts";

const ARM = fileURLToPath(new URL("./arm.ts", import.meta.url));

const { values } = parseArgs({
  options: {
    events: { type: "string" },
    rounds: { type: "string", default: "6" },
    job: { type: "string", default: "1" },
    runner: { type: "string" },
    dir: { type: "string" },
    records: { type: "string" },
  },
});
const rungs = String(values.events)
  .split(",")
  .map((each) => Number(each.trim()));
const rounds = Number(values.rounds);
const job = Number(values.job);
for (const events of rungs) {
  if (!RUNG_EVENTS.includes(events)) throw new RangeError(`Each rung must be one of ${RUNG_EVENTS.join(", ")}, not ${String(values.events)}.`);
}
if (rungs.some((events, k) => k > 0 && events <= (rungs[k - 1] as number))) throw new RangeError(`The rungs must rise, with no rung two times: ${String(values.events)}.`);
if (!Number.isSafeInteger(rounds) || rounds < 6) throw new RangeError(`A median at the level 0.95 needs 6 rounds or more, not ${String(values.rounds)}.`);
if (!Number.isSafeInteger(job) || job < 1) throw new RangeError(`The job is a whole number of 1 or more, not ${String(values.job)}.`);
if (values.dir === undefined || values.records === undefined) throw new RangeError("The driver needs --dir <folder> and --records <folder>.");
const dir = values.dir;
const recordsDir = values.records;
// A local run has no runner of CI. The job number then names the runner.
const runner = values.runner ?? `local-${job}`;

/** This function gives the path of the file of a rung. */
function pathOf(events: number): string {
  return join(dir, `events-${events}.db`);
}

/** This function removes the file of a rung and its side files. */
function removeFiles(events: number): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${pathOf(events)}${suffix}`, { force: true });
}

/** This function throws when the folder has too little free space for the file of a rung. */
function checkSpace(events: number): void {
  // The file takes about 1.1 KiB for each event with its two indexes. The WAL file and a rebuilt index need more.
  const need = events * 1300 + 512 * 2 ** 20;
  const disk = statfsSync(dir);
  const free = disk.bavail * disk.bsize;
  if (free < need) throw new Error(`The folder ${dir} has ${free} bytes free. The rung of ${events} events needs ${need} bytes.`);
}

/** This function writes the log of a rung, and gives the facts of the build. */
function build(events: number): Built {
  const path = pathOf(events);
  const start = performance.now();
  const log = openEventLog(path, parseScaleEvent);
  let added = 0;
  try {
    for (let from = 1; from <= events; from += BUILD_BATCH) {
      added += log.appendAll(scaleEvents(from, Math.min(from + BUILD_BATCH - 1, events))).filter((result) => result.kind === "added").length;
    }
  } finally {
    log.close();
  }
  const ms = performance.now() - start;
  if (added !== events) throw new Error(`The build added ${added} events, not ${events}.`);
  const db = openDatabase(path);
  try {
    if (checkpoint(db, "TRUNCATE").busy) throw new Error(`A different connection stopped the checkpoint of ${path}.`);
  } finally {
    db.close();
  }
  return { events, ms, rate: events / (ms / 1000), bytes: statSync(path).size };
}

/** This function gives the version of SQLite in this Node.js. */
function sqliteVersion(): string {
  const db = openDatabase(":memory:");
  try {
    return (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
  } finally {
    db.close();
  }
}

/** This function measures one rung, and gives its record. */
async function measureRung(events: number): Promise<ScaleRecord> {
  removeFiles(events);
  checkSpace(events);
  const built = build(events);
  const run = await freshRun({
    base: {
      id: "sqlite",
      command: [process.execPath, "--disable-warning=ExperimentalWarning", ARM, "--path", pathOf(events), "--events", String(events)],
      ...(process.env["GITHUB_SHA"] === undefined ? {} : { commit: process.env["GITHUB_SHA"] }),
    },
    candidates: [],
    cases: [...MEASURES],
    rounds,
    roundOffset: (job - 1) * rounds,
    job: String(job),
    timeoutMs: 600_000,
    overLimit: "skip",
  });
  removeFiles(events);

  const pairs = run.pairs["sqlite~aa"] ?? [];
  const measures: MeasureValues[] = [];
  for (const measure of MEASURES) {
    const rows = pairs.filter((pair) => pair.case === measure);
    if (rows.length === 0) continue;
    measures.push({
      measure,
      unit: MEASURE_TEXT[measure].unit,
      rounds: rows.map((row) => ({ round: row.round, a: row.a, b: row.b })),
      median: median(rows.flatMap((row) => [row.a, row.b])),
    });
  }

  return {
    format: SCALE_FORMAT,
    events,
    job: String(job),
    runner,
    commit: process.env["GITHUB_SHA"] ?? "local",
    at: new Date().toISOString(),
    node: process.version,
    sqlite: sqliteVersion(),
    cpu: run.env.cpu,
    built,
    measures,
    skipped: run.skipped.map((skip) => ({ measure: skip.case, reason: skip.reason })),
    real: [
      "node:sqlite in WAL mode with synchronous FULL, on the disk of the runner",
      "a fresh process for each measure and round, in two arms of one build",
      "a real writer that stops with SIGKILL before the measure recovery",
      "each rung of the job on the same runner",
    ],
    synthetic: [
      `each event has ${PAD_CHARS} characters of padding, so one event takes about 1 KiB`,
      `the build writes the events in transactions of ${BUILD_BATCH} events`,
    ],
  };
}

/** This function adds the table of a rung to the summary of the job. */
function summarize(record: ScaleRecord): void {
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary === undefined) return;
  const rows = [
    `### ${record.events.toLocaleString("en-US")} events, job ${job}`,
    "",
    `The build wrote ${Math.round(record.built.rate).toLocaleString("en-US")} events each second. The file has ${(record.built.bytes / 2 ** 20).toFixed(1)} MiB. SQLite ${record.sqlite}, Node.js ${record.node}, ${record.cpu}.`,
    "",
    "| Measure | Median (ms) | Arm a (ms) | Arm b (ms) | Rounds |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...record.measures.map((each) => {
      const a = median(each.rounds.map((round) => round.a));
      const b = median(each.rounds.map((round) => round.b));
      return `| ${each.measure} | ${each.median.toFixed(3)} | ${a.toFixed(3)} | ${b.toFixed(3)} | ${each.rounds.length} |`;
    }),
    ...record.skipped.map((skip) => `| ${skip.measure} | skipped: ${skip.reason} | | | |`),
    "",
  ];
  appendFileSync(summary, `${rows.join("\n")}\n`);
}

mkdirSync(dir, { recursive: true });
mkdirSync(recordsDir, { recursive: true });
for (const events of rungs) {
  const record = await measureRung(events);
  writeFileSync(join(recordsDir, `scale-${events}-job-${job}.json`), `${JSON.stringify(record, null, 2)}\n`);
  summarize(record);
}
