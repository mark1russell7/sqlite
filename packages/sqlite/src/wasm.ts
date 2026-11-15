/**
 * The adapter of SQLite in WebAssembly to `SqlConnection`. The types are structural, so the package does not depend on
 * `@sqlite.org/sqlite-wasm`. The module and the `oo1.DB` of that package have these members.
 *
 * @packageDocumentation
 */
import type { SqlChanges, SqlConnection, SqlStatement, SqlValue } from "./connection.ts";

/** The part of a compiled statement of SQLite in WebAssembly that the adapter uses. */
export interface WasmStatement {
  bind(values: readonly SqlValue[]): unknown;
  step(): boolean;
  get(row: Record<string, never>): Record<string, unknown>;
  reset(clearBindings?: boolean): unknown;
  finalize(): unknown;
}

/** The part of an `oo1.DB` of SQLite in WebAssembly that the adapter uses. */
export interface WasmDatabase {
  /** This value is the pointer of the database for the C API. A closed database has none. */
  readonly pointer?: unknown;
  exec(sql: string): unknown;
  prepare(sql: string): WasmStatement;
  changes(): number | bigint;
  close(): unknown;
}

/** The part of the module of SQLite in WebAssembly that the adapter uses: two functions of its C API. */
export interface WasmModule {
  readonly capi: {
    sqlite3_get_autocommit(db: unknown): number;
    sqlite3_last_insert_rowid(db: unknown): number | bigint;
  };
}

/** A connection that owns its database. `close` finalizes each statement of the connection, and then closes the database. */
export interface WasmConnection extends SqlConnection {
  close(): void;
}

/**
 * This function gives a `SqlConnection` over a database of SQLite in WebAssembly, for example `@sqlite.org/sqlite-wasm`.
 *
 * The connection keeps one compiled statement for each SQL text. Thus a log that prepares a statement for each read does
 * not compile it again. Each call steps its statement to the end, or to the first row for `get`, and then resets it. So a
 * kept statement is not in the middle of a result at any time, and `iterate` gives an array.
 *
 * @param sqlite3 - The module that `sqlite3InitModule` gives.
 * @param db - The database. The connection owns it, and `close` closes it.
 */
export function wasmConnection(sqlite3: WasmModule, db: WasmDatabase): WasmConnection {
  const compiled = new Map<string, WasmStatement>();

  /** This function gives the compiled statement of a SQL text, and compiles it at the first use. */
  const compile = (sql: string): WasmStatement => {
    const kept = compiled.get(sql);
    if (kept !== undefined) return kept;
    const statement = db.prepare(sql);
    compiled.set(sql, statement);
    return statement;
  };

  /** This function binds the parameters and does the work. Then it resets the statement and clears its bindings. */
  const bound = <T>(statement: WasmStatement, parameters: readonly SqlValue[], work: () => T): T => {
    try {
      if (parameters.length > 0) statement.bind(parameters);
      return work();
    } finally {
      statement.reset(true);
    }
  };

  /** This function gives each row of a statement. */
  const rows = (statement: WasmStatement, parameters: readonly SqlValue[]): Record<string, unknown>[] =>
    bound(statement, parameters, () => {
      const result: Record<string, unknown>[] = [];
      while (statement.step()) result.push(statement.get({}));
      return result;
    });

  const prepare = (sql: string): SqlStatement => {
    const statement = compile(sql);
    return {
      get: (...parameters) => bound(statement, parameters, () => (statement.step() ? statement.get({}) : undefined)),
      all: (...parameters) => rows(statement, parameters),
      run: (...parameters): SqlChanges => {
        rows(statement, parameters);
        return { changes: db.changes(), lastInsertRowid: sqlite3.capi.sqlite3_last_insert_rowid(db.pointer) };
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
      return sqlite3.capi.sqlite3_get_autocommit(db.pointer) === 0;
    },
    close(): void {
      for (const statement of compiled.values()) statement.finalize();
      compiled.clear();
      db.close();
    },
  };
}
