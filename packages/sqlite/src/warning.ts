/**
 * A filter of the experimental warning of `node:sqlite`. Node.js 22 writes the warning to the standard error at the
 * first load of `node:sqlite`. This file does not import `node:sqlite`, so a command loads it first.
 *
 * ```ts
 * import { quietSqliteWarning } from "@mark1russell7/sqlite/warning";
 *
 * quietSqliteWarning();
 * const { openDatabase } = await import("@mark1russell7/sqlite");
 * ```
 *
 * @packageDocumentation
 */

/** The start of the text of the experimental warning of `node:sqlite`. */
export const SQLITE_WARNING = "SQLite is an experimental feature";

/** The part of `process` that the filter changes. A test can give a fake. */
export interface WarningTarget {
  emitWarning(warning: string | Error, ...rest: unknown[]): void;
}

/**
 * This function tells if the arguments of `process.emitWarning` give the experimental warning of `node:sqlite`. The
 * type of the warning is the second argument, the field `type` of the options, or the name of an `Error`.
 */
export function isSqliteWarning(warning: string | Error, ...rest: unknown[]): boolean {
  const first = rest[0];
  let kind: unknown;
  if (typeof first === "string") kind = first;
  else if (typeof first === "object" && first !== null && "type" in first) kind = first.type;
  else if (warning instanceof Error) kind = warning.name;
  const text = typeof warning === "string" ? warning : warning.message;
  return kind === "ExperimentalWarning" && text.startsWith(SQLITE_WARNING);
}

/**
 * This function removes only the experimental warning of `node:sqlite` from `emitWarning`. Each other warning stays.
 * Use it before the first import of `node:sqlite`. It gives a function that puts the earlier `emitWarning` back.
 *
 * @param target - The object with `emitWarning`. The default is `process`.
 */
export function quietSqliteWarning(target: WarningTarget = process): () => void {
  const earlier = target.emitWarning;
  const filtered = (warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteWarning(warning, ...rest)) return;
    earlier.call(target, warning, ...rest);
  };
  target.emitWarning = filtered;
  return () => {
    if (target.emitWarning === filtered) target.emitWarning = earlier;
  };
}
