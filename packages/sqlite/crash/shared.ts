/**
 * The writer of the crash suite and its tests share these parts. They are the scenarios, their arguments, the event of
 * the salvage log and the reads of the output of the writer.
 */
import type { LogRecord, Salvaged } from "../src/index.ts";

/** The arguments of each scenario of the writer. */
export interface ScenarioArgs {
  /** The writer commits `transactions` transactions of `writes` rows each, with a stop point after each write. */
  readonly transaction: { readonly path: string; readonly transactions: number; readonly writes: number };
  /** The writer migrates through `steps` steps. Each step makes a table and writes `rows` rows, with a stop point after each row. */
  readonly migration: { readonly path: string; readonly steps: number; readonly rows: number };
  /** The writer commits `transactions` transactions of `rows` blobs of `bytes` bytes, then does a `TRUNCATE` checkpoint. */
  readonly checkpoint: { readonly path: string; readonly transactions: number; readonly rows: number; readonly bytes: number };
  /** The writer salvages the event log of the file `source` into the event log of the file `target`. */
  readonly salvage: { readonly source: string; readonly target: string };
}

/** The name of a scenario of the writer. */
export type Scenario = keyof ScenarioArgs;

export const SCENARIOS: readonly Scenario[] = ["transaction", "migration", "checkpoint", "salvage"];

/** The event of the salvage log. */
export interface CrashEvent extends LogRecord {
  readonly type: "crash";
  readonly n: number;
}

/** This function gives the event of a stored value, and throws a `TypeError` for a value that is not an event. */
export function parseCrashEvent(value: unknown): CrashEvent {
  const { id, at, type, n } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof id !== "string" || typeof at !== "string" || type !== "crash" || typeof n !== "number") {
    throw new TypeError(`This value is not a crash event: ${JSON.stringify(value)}`);
  }
  return { id, at, type, n };
}

/** This function gives the event with the number `n`. The same `n` always gives the same event. */
export function crashEvent(n: number): CrashEvent {
  return { id: `event-${String(n).padStart(6, "0")}`, at: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(), type: "crash", n };
}

/** One line of the standard output of the writer. */
export type WriterLine = { readonly mark: string; readonly ms: number } | { readonly salvaged: Salvaged };

/** This function writes one line to the standard output of the writer. */
export function writeLine(line: WriterLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** This function gives each line of the writer in an output. It ignores each other line. */
export function writerLines(stdout: string): WriterLine[] {
  const lines: WriterLine[] = [];
  for (const text of stdout.split("\n")) {
    if (!text.startsWith("{")) continue;
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if ((typeof value["mark"] === "string" && typeof value["ms"] === "number") || typeof value["salvaged"] === "object") lines.push(value as WriterLine);
    } catch {
      // A line that the writer did not write completely before its stop
    }
  }
  return lines;
}

/** This function gives the time of a mark of the writer, in ms from the start of its process, or `undefined`. */
export function markTime(stdout: string, mark: string): number | undefined {
  for (const line of writerLines(stdout)) if ("mark" in line && line.mark === mark) return line.ms;
  return undefined;
}
