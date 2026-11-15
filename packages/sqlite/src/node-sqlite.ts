/**
 * The class of a database of `node:sqlite`. Node.js 26.11 renamed the class `DatabaseSync` to `Database`, and kept the
 * old name as a deprecated alias (DEP0210). This module takes `Database` first, so a new Node.js gives no warning.
 *
 * @packageDocumentation
 */
import * as sqlite from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

/** The constructor of a database of `node:sqlite`. It has the type of `DatabaseSync`. */
export type DatabaseConstructor = typeof DatabaseSync;

/** This function gives the class of a database of the module, or throws when the module has no such class. */
export function databaseClass(module: Readonly<Record<string, unknown>>): DatabaseConstructor {
  // The operator `in` does not read a missing name, so a mock of a test with one name works
  const found = "Database" in module ? module["Database"] : "DatabaseSync" in module ? module["DatabaseSync"] : undefined;
  if (typeof found !== "function") throw new Error("The module node:sqlite of this Node.js has no class Database or DatabaseSync.");
  return found as DatabaseConstructor;
}

/** The class of a database of `node:sqlite` of this Node.js: `Database` from Node.js 26.11, else `DatabaseSync`. */
export const NodeDatabase: DatabaseConstructor = databaseClass(sqlite as unknown as Readonly<Record<string, unknown>>);
