/**
 * The statements of one SQL text. The function `prepare` of `node:sqlite` compiles only the first statement of a text, and
 * it ignores the rest with no error. `eachStatement` gives each statement of the text in turn.
 *
 * @packageDocumentation
 */

/** A compiled statement that knows its SQL text. A `StatementSync` of `node:sqlite` has `sourceSQL` from Node.js 22.5. */
export interface SourcedStatement {
  /** This value is the text of the statement, as SQLite compiled it: a prefix of the text that `prepare` got. */
  readonly sourceSQL: string;
}

/** The part of a connection that `eachStatement` uses. A `DatabaseSync` of `node:sqlite` has it. */
export interface StatementSource<S extends SourcedStatement> {
  prepare(sql: string): S;
}

/**
 * The characters that the tokenizer of SQLite reads as a space. The vertical tab is not one of them: SQLite refuses it.
 */
const SPACES: ReadonlySet<string> = new Set([" ", "\t", "\n", "\f", "\r"]);

/**
 * This function gives the index of the first character after the spaces, the comments and the empty statements. A line
 * comment ends at a line feed. A block comment with no end goes to the end of the text, as in SQLite.
 */
function skipEmpty(sql: string, from: number): number {
  let at = from;
  while (at < sql.length) {
    const char = sql.charAt(at);
    if (SPACES.has(char) || char === ";") {
      at += 1;
    } else if (sql.startsWith("--", at)) {
      const end = sql.indexOf("\n", at + 2);
      at = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", at)) {
      const end = sql.indexOf("*/", at + 2);
      at = end === -1 ? sql.length : end + 2;
    } else {
      break;
    }
  }
  return at;
}

/**
 * This function gives each statement of a SQL text in order, compiled by `db.prepare`. Use it to run a script that has
 * several statements.
 *
 * - Run each statement before you ask for the next one. The next statement compiles against the database after that run,
 *   so `CREATE TABLE t (x); INSERT INTO t VALUES (1)` works.
 * - When a statement does not compile, the iteration throws the error of `prepare`. Each earlier statement that ran stays
 *   done. Run the text in a transaction to get all or nothing.
 * - A `;` in a string, a quoted name, a comment or the body of a trigger does not end a statement. SQLite finds the end.
 * - The function skips the spaces, the comments and the empty statements between two statements. A text with no
 *   statement gives no statement, and the function does not call `prepare`.
 * - A block comment with no end goes to the end of the text, as in SQLite.
 *
 * @param db - The connection. A `DatabaseSync` of `node:sqlite` works.
 * @param sql - The SQL text.
 * @throws Error when the `sourceSQL` of a statement is not the start of the remaining text. Then the function cannot find
 *   the next statement.
 */
export function* eachStatement<S extends SourcedStatement>(db: StatementSource<S>, sql: string): Generator<S, void, undefined> {
  let at = skipEmpty(sql, 0);
  while (at < sql.length) {
    const rest = sql.slice(at);
    const statement = db.prepare(rest);
    const text = statement.sourceSQL;
    if (text.length === 0 || !rest.startsWith(text)) {
      throw new Error(
        `The text of the statement at index ${at} is not the start of the remaining SQL text, so eachStatement cannot find the next statement.`,
      );
    }
    yield statement;
    at = skipEmpty(sql, at + text.length);
  }
}
