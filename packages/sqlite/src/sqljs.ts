/**
 * The adapter of sql.js to `SqlConnection`. The types are structural, so the package does not depend on `sql.js`. The
 * `Database` and the `Statement` of sql.js have these members.
 *
 * @packageDocumentation
 */
import type { SqlChanges, SqlConnection, SqlStatement, SqlValue } from "./connection.ts";
import { probeTransaction } from "./probe.ts";

/** A value that sql.js binds. sql.js has no `bigint`. */
export type SqlJsValue = null | number | string | Uint8Array;

/** The part of a `Statement` of sql.js that the adapter uses. */
export interface SqlJsStatement {
  bind(values: SqlJsValue[]): unknown;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  /** This method resets the statement and clears its bindings. */
  reset(): unknown;
  free(): unknown;
}

/** The part of a `Database` of sql.js that the adapter uses. */
export interface SqlJsDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlJsStatement;
  getRowsModified(): number;
  close(): unknown;
}

/** A connection that owns its database. `close` frees each statement of the connection, and then closes the database. */
export interface SqlJsConnection extends SqlConnection {
  close(): void;
}

/** This function gives the value that sql.js binds for a value of a statement. */
function toSqlJs(value: SqlValue): SqlJsValue {
  if (typeof value !== "bigint") return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new RangeError(`sql.js binds each number as a JavaScript number, so it cannot bind ${String(value)} with no loss.`);
  }
  return number;
}

/**
 * This function gives a `SqlConnection` over a database of sql.js (SQLite in WebAssembly, with the database in memory).
 *
 * The connection keeps one compiled statement for each SQL text. Each call steps its statement to the end, or to the
 * first row for `get`, and then resets it. So `iterate` gives an array. sql.js gives each integer as a JavaScript
 * number, and a `bigint` parameter must be a safe integer.
 *
 * sql.js has no call for the state of the transaction. Thus `isTransaction` starts a `BEGIN`: SQLite refuses it in a
 * transaction, and else a `ROLLBACK` ends it at once. The check changes nothing.
 *
 * @param db - The database. The connection owns it, and `close` closes it.
 */
export function sqlJsConnection(db: SqlJsDatabase): SqlJsConnection {
  const compiled = new Map<string, SqlJsStatement>();

  /** This function gives the compiled statement of a SQL text, and compiles it at the first use. */
  const compile = (sql: string): SqlJsStatement => {
    const kept = compiled.get(sql);
    if (kept !== undefined) return kept;
    const statement = db.prepare(sql);
    compiled.set(sql, statement);
    return statement;
  };

  /** This function binds the parameters and does the work. Then it resets the statement, which clears its bindings. */
  const bound = <T>(statement: SqlJsStatement, parameters: readonly SqlValue[], work: () => T): T => {
    try {
      if (parameters.length > 0) statement.bind(parameters.map(toSqlJs));
      return work();
    } finally {
      statement.reset();
    }
  };

  /** This function gives each row of a statement. */
  const rows = (statement: SqlJsStatement, parameters: readonly SqlValue[]): Record<string, unknown>[] =>
    bound(statement, parameters, () => {
      const result: Record<string, unknown>[] = [];
      while (statement.step()) result.push(statement.getAsObject());
      return result;
    });

  const prepare = (sql: string): SqlStatement => {
    const statement = compile(sql);
    return {
      get: (...parameters) => bound(statement, parameters, () => (statement.step() ? statement.getAsObject() : undefined)),
      all: (...parameters) => rows(statement, parameters),
      run: (...parameters): SqlChanges => {
        rows(statement, parameters);
        // A SELECT does not change the count of changed rows, so the count comes first and the row id after it
        const changes = db.getRowsModified();
        const last = rows(compile("SELECT last_insert_rowid() AS id"), [])[0]?.["id"];
        return { changes, lastInsertRowid: typeof last === "number" || typeof last === "bigint" ? last : 0 };
      },
      iterate: (...parameters) => rows(statement, parameters),
    };
  };

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare,
    get isTransaction(): boolean {
      return probeTransaction(db);
    },
    close(): void {
      for (const statement of compiled.values()) statement.free();
      compiled.clear();
      db.close();
    },
  };
}
