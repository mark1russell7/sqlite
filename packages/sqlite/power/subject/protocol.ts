/**
 * The protocol of the power-cut test: the settings of the writer, the events of a transaction, the label of a stop point
 * and the value that the check writes. The writer and the check operate in a container with Node.js 24 and no packages,
 * thus this file imports only the source of the package.
 */
import type { LogRecord, Synchronous } from "../../src/index.ts";

/** The file of the log, in the folder of the writer and of the check. */
export const LOG_FILE = "log.db";

/** The variables of the environment of the writer and of the check. */
export const ENV = {
  synchronous: "POWER_SYNCHRONOUS",
  journal: "POWER_JOURNAL",
  transactions: "POWER_TRANSACTIONS",
  batch: "POWER_BATCH",
  checkpointEvery: "POWER_CHECKPOINT_EVERY",
  pauseMs: "POWER_PAUSE_MS",
  syncEvery: "POWER_SYNC_EVERY",
} as const;

/** The journal of the log: the write-ahead log, or the rollback journal of the open with `wal: false`. */
export type Journal = "wal" | "delete";

/** The settings of one writer. */
export interface PowerSettings {
  readonly synchronous: Synchronous;
  readonly journal: Journal;
  /** The count of transactions. */
  readonly transactions: number;
  /** The count of events in each transaction. */
  readonly batch: number;
  /** A checkpoint after each multiple of this count of commits. The value 0 gives no checkpoint. */
  readonly checkpointEvery: number;
  /** The pause in ms after each commit. */
  readonly pauseMs: number;
  /** A synced transaction (`syncedTransaction`) for each multiple of this count of commits. The value 0 gives none. */
  readonly syncEvery: number;
}

const SYNCHRONOUS: readonly Synchronous[] = ["OFF", "NORMAL", "FULL", "EXTRA"];
const JOURNALS: readonly Journal[] = ["wal", "delete"];

/** The default settings. A case of the test changes some of them. */
export const DEFAULTS: PowerSettings = { synchronous: "FULL", journal: "wal", transactions: 12, batch: 10, checkpointEvery: 0, pauseMs: 0, syncEvery: 0 };

/** This function gives the variables of the environment for the settings. */
export function envOf(settings: PowerSettings): Record<string, string> {
  return {
    [ENV.synchronous]: settings.synchronous,
    [ENV.journal]: settings.journal,
    [ENV.transactions]: String(settings.transactions),
    [ENV.batch]: String(settings.batch),
    [ENV.checkpointEvery]: String(settings.checkpointEvery),
    [ENV.pauseMs]: String(settings.pauseMs),
    [ENV.syncEvery]: String(settings.syncEvery),
  };
}

/** This function reads the settings from the environment. It throws a `RangeError` for a value that is not correct. */
export function settingsOf(env: Readonly<Record<string, string | undefined>>): PowerSettings {
  const count = (name: string, fallback: number, least: number): number => {
    const text = env[name];
    const value = text === undefined ? fallback : Number(text);
    if (!Number.isInteger(value) || value < least) throw new RangeError(`${name} is a whole number of ${least} or more, not ${String(text)}.`);
    return value;
  };
  const synchronous = (env[ENV.synchronous] ?? DEFAULTS.synchronous) as Synchronous;
  if (!SYNCHRONOUS.includes(synchronous)) throw new RangeError(`${ENV.synchronous} is one of ${SYNCHRONOUS.join(", ")}, not ${synchronous}.`);
  const journal = (env[ENV.journal] ?? DEFAULTS.journal) as Journal;
  if (!JOURNALS.includes(journal)) throw new RangeError(`${ENV.journal} is one of ${JOURNALS.join(", ")}, not ${journal}.`);
  const settings: PowerSettings = {
    synchronous,
    journal,
    transactions: count(ENV.transactions, DEFAULTS.transactions, 1),
    batch: count(ENV.batch, DEFAULTS.batch, 1),
    checkpointEvery: count(ENV.checkpointEvery, DEFAULTS.checkpointEvery, 0),
    pauseMs: count(ENV.pauseMs, DEFAULTS.pauseMs, 0),
    syncEvery: count(ENV.syncEvery, DEFAULTS.syncEvery, 0),
  };
  if (settings.journal === "delete" && settings.checkpointEvery > 0) throw new RangeError("A checkpoint needs the journal wal.");
  return settings;
}

/** The event `index` of the transaction `commit`. Both counts start at 1. */
export interface PowerEvent extends LogRecord {
  readonly type: "power";
  readonly commit: number;
  readonly index: number;
}

/** This function gives the events of one transaction. */
export function eventsOf(commit: number, batch: number): PowerEvent[] {
  return Array.from({ length: batch }, (_, at) => ({ id: `c${String(commit)}e${String(at + 1)}`, at: "2026-11-16T00:00:00Z", type: "power", commit, index: at + 1 }));
}

/** This function is the parse of the log: it refuses each value that is not a `PowerEvent`. */
export function parseEvent(value: unknown): PowerEvent {
  const event = value as Partial<PowerEvent> | null;
  const whole = (part: unknown): part is number => Number.isInteger(part) && (part as number) >= 1;
  if (event === null || typeof event !== "object" || event.type !== "power" || !whole(event.commit) || !whole(event.index)) {
    throw new TypeError(`The value is not an event of the power-cut test: ${JSON.stringify(value)}.`);
  }
  if (event.id !== `c${String(event.commit)}e${String(event.index)}` || typeof event.at !== "string") {
    throw new TypeError(`The id or the time of the event is not correct: ${JSON.stringify(value)}.`);
  }
  return event as PowerEvent;
}

/**
 * The facts of a stop point: the count of commits, the count of commits that a complete checkpoint holds, and the count
 * of commits that the last synced transaction holds.
 */
export interface Progress {
  readonly commits: number;
  readonly checkpointed: number;
  readonly synced: number;
}

/** This function gives the label of the stop point after a commit. */
export const labelOf = (progress: Progress): string =>
  `commit ${String(progress.commits)} checkpointed ${String(progress.checkpointed)} synced ${String(progress.synced)}`;

/** This function reads the label of a stop point. The value `null`, for a writer that got to no point, gives 0 commits. */
export function progressOf(label: string | null): Progress {
  if (label === null) return { commits: 0, checkpointed: 0, synced: 0 };
  const match = /^commit (\d+) checkpointed (\d+) synced (\d+)$/.exec(label);
  if (match === null) throw new RangeError(`The label "${label}" is not the label of a commit.`);
  return { commits: Number(match[1]), checkpointed: Number(match[2]), synced: Number(match[3]) };
}

/** The value of the check: what the disk kept of the log. */
export type Kept =
  | { readonly file: false }
  | {
      readonly file: true;
      readonly bytes: number;
      readonly opened: false;
      /** The fault kind of `sqliteFault`, or `other` for an error that is not of SQLite. */
      readonly fault: string;
      readonly error: string;
    }
  | {
      readonly file: true;
      readonly bytes: number;
      readonly opened: true;
      /** The rows of `PRAGMA integrity_check`. A whole file gives `["ok"]`. */
      readonly integrity: readonly string[];
      readonly events: number;
      /** The count of complete transactions from the commit 1, in the sequence of the log. */
      readonly commits: number;
      /** Each problem of the events: a part of a transaction, a gap, or an event out of its sequence. */
      readonly problems: readonly string[];
    };

/**
 * The claim of a case: the rule of the doc of `openDatabase` that a power cut examines.
 *
 * - `durable`: the disk keeps each commit that ended before the cut. This is the claim of `FULL` and `EXTRA`. It is also
 *   the claim of a writer that closed its connections, because the close of the last connection makes a checkpoint.
 * - `synced`: the disk keeps each commit up to the last synced transaction, and the file stays good. This is the claim of
 *   `syncedTransaction` on a connection with `NORMAL`. The cut can lose the commits after that transaction.
 * - `checkpointed`: the disk keeps each commit of the last complete checkpoint, and the file stays good. This is the
 *   claim of `NORMAL` with WAL. The cut can lose the commits after that checkpoint.
 * - `none`: the doc makes no claim. The test only records what the disk kept.
 */
export type Claim = "durable" | "synced" | "checkpointed" | "none";

/** The least and the most count of commits that the disk keeps under a claim. */
export interface Bounds {
  readonly least: number;
  readonly most: number;
}

/**
 * This function gives the bounds of a claim, or `undefined` for the claim `none`. A cut at a time can come after a
 * commit and before its stop point, thus the most count is one more than the count of the label.
 */
export function boundsOf(claim: Claim, progress: Progress, atTime: boolean): Bounds | undefined {
  if (claim === "none") return undefined;
  const least = { durable: progress.commits, synced: progress.synced, checkpointed: progress.checkpointed }[claim];
  return { least, most: progress.commits + (atTime ? 1 : 0) };
}

/**
 * This function gives each problem of what the disk kept under a claim. An empty list means that the disk keeps the
 * claim. Under each claim but `none`, the file opens, `PRAGMA integrity_check` gives `ok`, each transaction is whole,
 * and the count of commits is in the bounds.
 */
export function claimProblems(kept: Kept, claim: Claim, progress: Progress, atTime: boolean): string[] {
  const bounds = boundsOf(claim, progress, atTime);
  if (bounds === undefined) return [];
  const range = bounds.least === bounds.most ? String(bounds.least) : `${String(bounds.least)} to ${String(bounds.most)}`;
  if (!kept.file) return bounds.least === 0 ? [] : [`The disk kept no file, not ${range} commits.`];
  if (!kept.opened) return [`The file did not open: the fault ${kept.fault}, ${kept.error}`];
  const problems: string[] = [];
  if (kept.integrity.length !== 1 || kept.integrity[0] !== "ok") problems.push(`The integrity check gave ${JSON.stringify(kept.integrity)}, not ["ok"].`);
  problems.push(...kept.problems);
  if (kept.commits < bounds.least || kept.commits > bounds.most) problems.push(`The disk kept ${String(kept.commits)} commits, not ${range}.`);
  return problems;
}

/**
 * This function gives the count of complete transactions at the start of the log, and each problem. The events of a
 * complete transaction are its `batch` events in their sequence, and the transactions follow from the commit 1.
 */
export function commitsOf(events: readonly PowerEvent[], batch: number): { readonly commits: number; readonly problems: string[] } {
  const problems: string[] = [];
  let commits = 0;
  for (let at = 0; at < events.length; at++) {
    const event = events[at] as PowerEvent;
    const commit = Math.floor(at / batch) + 1;
    const index = (at % batch) + 1;
    if (event.commit !== commit || event.index !== index) {
      problems.push(`The event ${String(at + 1)} is ${event.id}, not c${String(commit)}e${String(index)}.`);
      break;
    }
    if (index === batch) commits = commit;
  }
  if (problems.length === 0 && events.length !== commits * batch) {
    problems.push(`The log keeps ${String(events.length - commits * batch)} events of the transaction ${String(commits + 1)}, not all ${String(batch)}.`);
  }
  return { commits, problems };
}
