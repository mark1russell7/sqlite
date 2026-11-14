/**
 * The faults of `node:sqlite`: the kind of each error and the action that it needs. A pure calculation from the result
 * code of SQLite, so a caller decides with no text match on the message.
 *
 * @packageDocumentation
 */

/** The kind of a fault of SQLite, from its primary result code. */
export type SqliteFaultKind =
  | "sql"
  | "internal"
  | "permission"
  | "aborted"
  | "busy"
  | "locked"
  | "no-memory"
  | "read-only"
  | "interrupted"
  | "io"
  | "corrupt"
  | "not-found"
  | "full"
  | "cannot-open"
  | "protocol"
  | "schema"
  | "too-big"
  | "constraint"
  | "mismatch"
  | "misuse"
  | "no-lfs"
  | "authorization"
  | "range"
  | "not-a-database"
  | "other";

/**
 * The action that a fault needs.
 *
 * - `retry`: the fault can go away alone. Do the work again later, for example after a wait for a lock.
 * - `quarantine`: the file is broken. Move it away, and make the data again from its source or from a copy.
 * - `operator`: the computer needs a change that the program cannot do: disk space, access, a path or memory.
 * - `bug`: the program used SQLite wrongly. The same work fails again.
 */
export type SqliteFaultAction = "retry" | "quarantine" | "operator" | "bug";

/** One fault of SQLite. */
export interface SqliteFault {
  readonly kind: SqliteFaultKind;
  readonly action: SqliteFaultAction;
  /** This value is the primary result code of SQLite, for example 5 for `SQLITE_BUSY`. */
  readonly code: number;
  /** This value is the extended result code of SQLite, for example 1555 for `SQLITE_CONSTRAINT_PRIMARYKEY`. */
  readonly extendedCode: number;
  /** This value is the message of the error. */
  readonly message: string;
  /** This value is the error of SQLite. It can be the cause of the error that the caller got. */
  readonly error: Error;
}

/** The kind of each primary result code of SQLite. */
const KINDS: Readonly<Record<number, SqliteFaultKind>> = {
  1: "sql",
  2: "internal",
  3: "permission",
  4: "aborted",
  5: "busy",
  6: "locked",
  7: "no-memory",
  8: "read-only",
  9: "interrupted",
  10: "io",
  11: "corrupt",
  12: "not-found",
  13: "full",
  14: "cannot-open",
  15: "protocol",
  17: "schema",
  18: "too-big",
  19: "constraint",
  20: "mismatch",
  21: "misuse",
  22: "no-lfs",
  23: "authorization",
  25: "range",
  26: "not-a-database",
};

/** The action of each kind of fault. */
export const SQLITE_FAULT_ACTIONS: Readonly<Record<SqliteFaultKind, SqliteFaultAction>> = {
  busy: "retry",
  locked: "retry",
  aborted: "retry",
  interrupted: "retry",
  protocol: "retry",
  schema: "retry",
  corrupt: "quarantine",
  "not-a-database": "quarantine",
  full: "operator",
  io: "operator",
  "read-only": "operator",
  "cannot-open": "operator",
  permission: "operator",
  "no-memory": "operator",
  "no-lfs": "operator",
  other: "operator",
  sql: "bug",
  internal: "bug",
  "not-found": "bug",
  "too-big": "bug",
  constraint: "bug",
  mismatch: "bug",
  misuse: "bug",
  authorization: "bug",
  range: "bug",
};

/** The longest chain of causes that `sqliteFault` reads. */
const MAX_DEPTH = 16;

/** This function tells if a value is an error of `node:sqlite`. */
function isSqliteError(value: unknown): value is Error & { readonly errcode: number } {
  return value instanceof Error && (value as { code?: unknown }).code === "ERR_SQLITE_ERROR" && typeof (value as { errcode?: unknown }).errcode === "number";
}

/**
 * This function gives the fault of SQLite in an error, or `undefined` when the error has none.
 *
 * It reads the error first, and then its chain of causes. Thus it finds the fault in the error of a broken log too.
 *
 * @param error - The error that the caller got.
 */
export function sqliteFault(error: unknown): SqliteFault | undefined {
  let value: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH && value instanceof Error; depth++) {
    if (isSqliteError(value)) {
      const code = value.errcode & 0xff;
      const kind = KINDS[code] ?? "other";
      return { kind, action: SQLITE_FAULT_ACTIONS[kind], code, extendedCode: value.errcode, message: value.message, error: value };
    }
    value = value.cause;
  }
  return undefined;
}
