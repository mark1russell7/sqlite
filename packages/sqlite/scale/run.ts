/**
 * The driver of one rung of the scale bench (roadmap SQ-26). The workflow `scale.yml` starts it in CI:
 * `node scale/run.ts --events <n> --rounds <r> --job <k> --dir <folder> --out <file>`.
 *
 * It builds a log of `n` events. Then the fresh runner of `@mark1russell7/rigor-bench` starts a child for each measure
 * and round, in two arms of one build. It writes the record of the rung to `--out` and a table to the summary of the job.
 */
import { appendFileSync, mkdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  options: { events: { type: "string" }, rounds: { type: "string", default: "6" }, job: { type: "string", default: "1" }, dir: { type: "string" }, out: { type: "string" } },
});
const events = Number(values.events);
const rounds = Number(values.rounds);
const job = Number(values.job);
if (!RUNG_EVENTS.includes(events)) throw new RangeError(`The events must be one of ${RUNG_EVENTS.join(", ")}, not ${String(values.events)}.`);
if (!Number.isSafeInteger(rounds) || rounds < 6) throw new RangeError(`A median at the level 0.95 needs 6 rounds or more, not ${String(values.rounds)}.`);
if (!Number.isSafeInteger(job) || job < 1) throw new RangeError(`The job is a whole number of 1 or more, not ${String(values.job)}.`);
if (values.dir === undefined || values.out === undefined) throw new RangeError("The driver needs --dir <folder> and --out <file>.");
const dir = values.dir;
const out = values.out;
const path = join(dir, `events-${events}.db`);

/** This function removes the file of the rung and its side files. */
function removeFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

/** This function throws when the folder has too little free space for the file of the rung. */
function checkSpace(): void {
  // The file takes about 1.1 KiB for each event with its two indexes. The WAL file and a rebuilt index need more.
  const need = events * 1300 + 512 * 2 ** 20;
  const disk = statfsSync(dir);
  const free = disk.bavail * disk.bsize;
  if (free < need) throw new Error(`The folder ${dir} has ${free} bytes free. The rung of ${events} events needs ${need} bytes.`);
}

/** This function writes the log of the rung, and gives the facts of the build. */
function build(): Built {
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

mkdirSync(dir, { recursive: true });
removeFiles();
checkSpace();
const built = build();
const run = await freshRun({
  base: {
    id: "sqlite",
    command: [process.execPath, "--disable-warning=ExperimentalWarning", ARM, "--path", path, "--events", String(events)],
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
removeFiles();

const records = run.pairs["sqlite~aa"] ?? [];
const measures: MeasureValues[] = [];
for (const measure of MEASURES) {
  const rows = records.filter((record) => record.case === measure);
  if (rows.length === 0) continue;
  measures.push({
    measure,
    unit: MEASURE_TEXT[measure].unit,
    rounds: rows.map((row) => ({ round: row.round, a: row.a, b: row.b })),
    median: median(rows.flatMap((row) => [row.a, row.b])),
  });
}

const record: ScaleRecord = {
  format: SCALE_FORMAT,
  events,
  job: String(job),
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
  ],
  synthetic: [
    `each event has ${PAD_CHARS} characters of padding, so one event takes about 1 KiB`,
    `the build writes the events in transactions of ${BUILD_BATCH} events`,
  ],
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary !== undefined) {
  const rows = [
    `### ${events.toLocaleString("en-US")} events, job ${job}`,
    "",
    `The build wrote ${Math.round(built.rate).toLocaleString("en-US")} events each second. The file has ${(built.bytes / 2 ** 20).toFixed(1)} MiB. SQLite ${record.sqlite}, Node.js ${record.node}, ${record.cpu}.`,
    "",
    "| Measure | Median (ms) | Arm a (ms) | Arm b (ms) | Rounds |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...measures.map((each) => {
      const a = median(each.rounds.map((round) => round.a));
      const b = median(each.rounds.map((round) => round.b));
      return `| ${each.measure} | ${each.median.toFixed(3)} | ${a.toFixed(3)} | ${b.toFixed(3)} | ${each.rounds.length} |`;
    }),
    ...record.skipped.map((skip) => `| ${skip.measure} | skipped: ${skip.reason} | | | |`),
    "",
  ];
  appendFileSync(summary, `${rows.join("\n")}\n`);
}
