/**
 * The scale bench (roadmap SQ-26) and its children share these parts. They are the measures, the events of the bench log
 * and the format of a record.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogRecord } from "../src/index.ts";

/** The measures of the scale bench. Each measure is one case of the fresh runner, so each round starts a fresh child. */
export const MEASURES = ["append", "read-after", "get", "open", "migrate", "count", "recovery", "quick-check"] as const;

/** The name of one measure. */
export type Measure = (typeof MEASURES)[number];

/** The unit and the meaning of each measure. The summary and the records show them. */
export const MEASURE_TEXT: Readonly<Record<Measure, { readonly unit: string; readonly describe: string }>> = {
  append: { unit: "ms", describe: "One appendAll of 1000 new events, with its commit." },
  "read-after": { unit: "ms", describe: "The median of 200 reads of 100 events after a seeded position." },
  get: { unit: "ms", describe: "The median of 200 reads of one event by a seeded id." },
  open: { unit: "ms", describe: "openEventLog of the file, with the check of its schema version, and head()." },
  migrate: { unit: "ms", describe: "openEventLog of a file at schema version 1: the step that builds the index of types." },
  count: { unit: "ms", describe: "count() of the events of the log." },
  recovery: { unit: "ms", describe: "openEventLog and head() after a SIGKILL that left 3500 events in the WAL file." },
  "quick-check": { unit: "ms", describe: "checkIntegrity with quick: true on the whole file." },
};

/**
 * The classes of growth. The claim of a class is the largest growth of the cost for 10 times the events, on one runner.
 * - A flat cost has a growth of 2 times or less: an exponent of 0.3. A cost that grows as a logarithm stays in this class.
 * - A linear cost has a growth of 20 times or less: an exponent of 1.3. A cost that grows as n log n stays in this class.
 * A cost that grows as the square root of n is beyond the flat class, and a quadratic cost is beyond the linear class.
 */
export const GROWTH_CLASSES = {
  flat: { maxGrowth: 2, describe: "at most 2 times for 10 times the events" },
  linear: { maxGrowth: 20, describe: "at most 20 times for 10 times the events" },
} as const satisfies Readonly<Record<string, { readonly maxGrowth: number; readonly describe: string }>>;

/** The name of one class of growth. */
export type GrowthClass = keyof typeof GROWTH_CLASSES;

/**
 * The class of growth of each measure. A read, an append, an open and a recovery do not scan the log, so their cost is
 * flat. A count, a quick check and a migration that builds an index scan each event, so their cost is linear.
 */
export const MEASURE_GROWTH: Readonly<Record<Measure, GrowthClass>> = {
  append: "flat",
  "read-after": "flat",
  get: "flat",
  open: "flat",
  migrate: "linear",
  count: "linear",
  recovery: "flat",
  "quick-check": "linear",
};

/** The sizes of the rungs of the ladder: 10^3 to 10^7 events. One event takes approximately 1 KiB, so the files are 1 MB to 10 GB. */
export const RUNG_EVENTS: readonly number[] = [1e3, 1e4, 1e5, 1e6, 1e7];

/** The count of characters of the padding of each event. With its other fields, one event takes approximately 1 KiB in the file. */
export const PAD_CHARS = 900;

/** The count of events of the append of the measure `append`. */
export const APPEND_EVENTS = 1000;

/** The count of reads of the measures `read-after` and `get` in one child. */
export const READS = 200;

/** The count of events of each read of the measure `read-after`. */
export const READ_LIMIT = 100;

/** The count of events that the writer of the measure `recovery` leaves in the WAL file. They take approximately 3.5 MiB, under the default checkpoint limit of 1000 pages. */
export const RECOVERY_EVENTS = 3500;

/** The count of events of each transaction of the build of a file. */
export const BUILD_BATCH = 10_000;

/** The types of the events. Each fourth event has the same type, so the index of types has four keys. */
export const TYPES = ["note", "move", "mark", "link"] as const;

/** One event of the bench log. */
export interface ScaleEvent extends LogRecord {
  readonly n: number;
  readonly pad: string;
}

const PAD = "x".repeat(PAD_CHARS);

/** This function gives the id of the event with the number `n`. */
export function scaleId(n: number): string {
  return `e-${String(n).padStart(9, "0")}`;
}

/** This function gives the event with the number `n`. The same `n` always gives the same event. The first event has the number 1. */
export function scaleEvent(n: number): ScaleEvent {
  return { id: scaleId(n), at: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(), type: TYPES[n % TYPES.length] as string, n, pad: PAD };
}

/** This function gives the events with the numbers `from` to `to`, `to` included. */
export function* scaleEvents(from: number, to: number): Generator<ScaleEvent> {
  for (let n = from; n <= to; n++) yield scaleEvent(n);
}

/** This function gives the event of a stored value, and throws a `TypeError` for a value that is not an event of the bench. */
export function parseScaleEvent(value: unknown): ScaleEvent {
  const { id, at, type, n, pad } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof id !== "string" || typeof at !== "string" || typeof type !== "string" || typeof n !== "number" || typeof pad !== "string") {
    throw new TypeError(`This value is not an event of the scale bench: ${JSON.stringify(value).slice(0, 200)}`);
  }
  return { id, at, type, n, pad };
}

/** The format name of the record of one rung. It changes when a reader of an older form cannot read the data. */
export const SCALE_FORMAT = "sqlite-scale/2";

/** The values of one measure in one job: the rounds of the first arm and of its A/A copy, in ms. */
export interface MeasureValues {
  readonly measure: Measure;
  readonly unit: string;
  readonly rounds: readonly { readonly round: number; readonly a: number; readonly b: number }[];
  /** The median of the values of both arms. */
  readonly median: number;
}

/** The facts of the build of the file of a rung. */
export interface Built {
  readonly events: number;
  readonly ms: number;
  /** The events that the build wrote each second, in transactions of `BUILD_BATCH` events. */
  readonly rate: number;
  /** The bytes of the file after a checkpoint that empties the WAL file. */
  readonly bytes: number;
}

/** The record of one rung in one job. The growth gate compares the rungs of each runner. */
export interface ScaleRecord {
  readonly format: typeof SCALE_FORMAT;
  readonly events: number;
  readonly job: string;
  /**
   * The runner of the job, unique in the run and its attempts. Each job measures all its rungs on one runner, so the
   * records with the same runner come from one computer. The format 2 adds this field.
   */
  readonly runner: string;
  readonly commit: string;
  readonly at: string;
  readonly node: string;
  readonly sqlite: string;
  readonly cpu: string;
  readonly built: Built;
  readonly measures: readonly MeasureValues[];
  /** Each measure that a child skipped, with its reason. A skip is not a value. */
  readonly skipped: readonly { readonly measure: string; readonly reason: string }[];
  /** What the run did for real. */
  readonly real: readonly string[];
  /** What the run made up. */
  readonly synthetic: readonly string[];
}

/** This function reads each record of the format `SCALE_FORMAT` in a folder and its subfolders. It skips the other JSON files. */
export function readRecords(folder: string): ScaleRecord[] {
  const records: ScaleRecord[] = [];
  for (const file of readdirSync(folder, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(join(folder, file), "utf8")) as Partial<ScaleRecord>;
    if (value.format === SCALE_FORMAT) records.push(value as ScaleRecord);
  }
  return records;
}
