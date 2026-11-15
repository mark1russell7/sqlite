import type { StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "./database.ts";
import { databaseClass } from "./node-sqlite.ts";
import { transaction } from "./transaction.ts";

/** The state of the mock: the getter `isTransaction` is on (Node.js 22.16 or later). */
const state = vi.hoisted(() => ({ withGetter: true }));

// The mock is node:sqlite of Node.js 26.11 or later: it has only the new name Database
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  class Database {
    readonly #inner: InstanceType<typeof actual.DatabaseSync>;
    constructor(path: string, options?: { readonly readOnly?: boolean }) {
      this.#inner = options === undefined ? new actual.DatabaseSync(path) : new actual.DatabaseSync(path, options);
      // Node.js before 22.16 has no getter, so there the mock has none
      if (state.withGetter && typeof this.#inner.isTransaction === "boolean") Object.defineProperty(this, "isTransaction", { get: () => this.#inner.isTransaction });
    }
    exec(sql: string): void {
      this.#inner.exec(sql);
    }
    prepare(sql: string): StatementSync {
      return this.#inner.prepare(sql);
    }
    close(): void {
      this.#inner.close();
    }
  }
  return { Database };
});

describe("the class of node:sqlite", () => {
  it("takes Database first, then DatabaseSync, and throws with no class", () => {
    const Database = class {};
    const DatabaseSync = class {};
    expect(databaseClass({ Database, DatabaseSync })).toBe(Database);
    expect(databaseClass({ DatabaseSync })).toBe(DatabaseSync);
    expect(() => databaseClass({})).toThrow(/no class Database or DatabaseSync/);
    expect(() => databaseClass({ Database: 1 })).toThrow(/no class Database or DatabaseSync/);
  });

  it("opens with the class Database of a new Node.js", () => {
    state.withGetter = true;
    const db = openDatabase(":memory:");
    expect(db.constructor.name).toBe("Database");
    expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it("gives a probe of the transaction to a Node.js with no isTransaction", () => {
    state.withGetter = false;
    const db = openDatabase(":memory:");
    state.withGetter = true;
    expect(db.isTransaction).toBe(false);
    db.exec("BEGIN");
    expect(db.isTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(db.isTransaction).toBe(false);

    // A failed work rolls back, so the connection is not left in the transaction
    db.exec("CREATE TABLE t (x INTEGER)");
    expect(() =>
      transaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        throw new Error("the work fails");
      }),
    ).toThrow("the work fails");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 0 });
    db.close();
  });
});
