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
  free(): unknown;
}

/** The part of a `Database` of sql.js that the adapter uses. */
export interface SqlJsDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlJsStatement;
  getRowsModified(): number;
  close(): unknown;
}

/** A connection that owns its database. `close` closes the database. */
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
 * Each call compiles its statement, steps it to the end or to the first row for `get`, and frees it. So `iterate`
 * gives an array. An `export()` of sql.js frees each statement of the database, and the connection keeps none. So a
 * statement from `prepare` operates after a save. `prepare` compiles the SQL text one time, so a bad text throws there.
 * The driver sql.js gives each integer as a JavaScript number, and a `bigint` parameter must be a safe integer.
 *
 * sql.js has no call for the state of the transaction. Thus `isTransaction` starts a `BEGIN`: SQLite refuses it in a
 * transaction, and else a `ROLLBACK` ends it at once. The check changes nothing.
 *
 * @param db - The database. The connection owns it, and `close` closes it.
 */
export function sqlJsConnection(db: SqlJsDatabase): SqlJsConnection {
  /** This function gives each row of a SQL text. It compiles the statement, binds the parameters and frees it after the work. */
  const rows = (sql: string, parameters: readonly SqlValue[], first = false): Record<string, unknown>[] => {
    const statement = db.prepare(sql);
    try {
      if (parameters.length > 0) statement.bind(parameters.map(toSqlJs));
      const result: Record<string, unknown>[] = [];
      while ((!first || result.length === 0) && statement.step()) result.push(statement.getAsObject());
      return result;
    } finally {
      statement.free();
    }
  };

  const prepare = (sql: string): SqlStatement => {
    db.prepare(sql).free();
    return {
      get: (...parameters) => rows(sql, parameters, true)[0],
      all: (...parameters) => rows(sql, parameters),
      run: (...parameters): SqlChanges => {
        rows(sql, parameters);
        // A SELECT does not change the count of changed rows, so the count comes first and the row id after it
        const changes = db.getRowsModified();
        const last = rows("SELECT last_insert_rowid() AS id", [])[0]?.["id"];
        return { changes, lastInsertRowid: typeof last === "number" || typeof last === "bigint" ? last : 0 };
      },
      iterate: (...parameters) => rows(sql, parameters),
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
      db.close();
    },
  };
}
