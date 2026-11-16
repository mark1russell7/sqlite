/**
 * This file is a type test of the floor of `@types/node`. It does not run. `tsconfig.node22.json` examines the source and
 * this file with `@types/node` 22. `tsconfig.test.json` examines them with the `@types/node` of the package.
 *
 * In `@types/node` 22, the type `DatabaseSync` has no `setAuthorizer`. Thus each call below has the connection type of a
 * caller on that version. A change of the public API that refuses such a caller fails the typecheck.
 *
 * @packageDocumentation
 */

import type { DatabaseSync } from "node:sqlite";
import {
  addMissingColumns,
  checkIntegrity,
  checkpoint,
  clearDatabase,
  type ConfinableDatabase,
  confineToFile,
  eachStatement,
  migrate,
  openDatabase,
  readTransaction,
  schemaVersion,
  snapshot,
  tableColumns,
  transaction,
  userVersion,
} from "../../src/index.ts";

declare const connection: DatabaseSync;
declare const part: ConfinableDatabase;

/** This function holds the uses of a caller. No code starts it. */
export function callsOfACaller(): void {
  // The guard takes a `DatabaseSync` of each version of `@types/node`, and each value with the part that it uses
  confineToFile(connection);
  confineToFile(openDatabase(":memory:"));
  confineToFile(part);
  confineToFile({});

  // The other functions that take a connection
  transaction(connection, () => 1);
  readTransaction(connection, () => 1);
  migrate(connection, []);
  schemaVersion(connection);
  userVersion(connection);
  tableColumns(connection, "t");
  addMissingColumns(connection, "t", {});
  checkpoint(connection);
  clearDatabase(connection);
  checkIntegrity(connection);
  snapshot(connection, "copy.db");
  for (const statement of eachStatement(connection, "SELECT 1")) statement.run();
}
