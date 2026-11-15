/**
 * The part of a connection that the migrations, the projections and the event log use. `DatabaseSync` of `node:sqlite`
 * has it. A different driver, for example SQLite in a browser, can give it through a small adapter.
 *
 * @packageDocumentation
 */

/** A value that a statement binds to a parameter. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** The result of a statement that writes: the number of changed rows and the id of the last added row. */
export interface SqlChanges {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

/** The part of a prepared statement that the package uses. `StatementSync` of `node:sqlite` has it. */
export interface SqlStatement {
  /** This function gives the first row of the result, or `undefined` when the result has no rows. */
  get(...parameters: SqlValue[]): unknown;
  /** This function gives each row of the result. */
  all(...parameters: SqlValue[]): unknown[];
  /** This function starts a statement that writes, and gives the number of changed rows and the last row id. */
  run(...parameters: SqlValue[]): SqlChanges;
  /** This function gives the rows of the result one at a time. */
  iterate(...parameters: SqlValue[]): Iterable<unknown>;
}

/** The part of a connection that the package uses. `DatabaseSync` of `node:sqlite` has it. */
export interface SqlConnection {
  /** This function starts one or more SQL statements with no parameters. */
  exec(sql: string): void;
  /** This function compiles one SQL statement. */
  prepare(sql: string): SqlStatement;
  /** This value is true while a transaction is in progress. */
  readonly isTransaction: boolean;
}
