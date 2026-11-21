import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describePortable } from "./conformance.ts";
import * as entry from "./index.ts";
import * as portable from "./portable.ts";
import type { LogRecord, SqlConnection, SqlStatement } from "./portable.ts";

const SOURCE = dirname(fileURLToPath(import.meta.url));

/** An import or a re-export with `from`. The text between the keyword and `from` has no `;`, `=`, parentheses or quotes. */
const FROM = /^[ \t]*(import|export)[ \t]+(type[ \t]+)?[^;=()"]*?from[ \t]*"([^"]+)"/gm;
/** An import for its side effects only. */
const BARE = /^[ \t]*import[ \t]*"([^"]+)"/gm;

/** This function gives the specifiers of the imports of a module that stay in the JavaScript. `import type` goes away. */
function valueImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(FROM)) if (match[2] === undefined) specifiers.push(match[3] as string);
  for (const match of source.matchAll(BARE)) specifiers.push(match[1] as string);
  return specifiers;
}

/** This function gives the specifiers of each import of a module, also `import type`. */
function allImports(source: string): string[] {
  return [...[...source.matchAll(FROM)].map((match) => match[3] as string), ...[...source.matchAll(BARE)].map((match) => match[1] as string)];
}

/** This function follows the imports from a module of `src`, and gives each module and each import out of `src`. */
function closure(start: string, imports: (source: string) => string[] = valueImports): { modules: string[]; external: string[] } {
  const modules = new Set<string>();
  const external = new Set<string>();
  const queue = [start];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (modules.has(file)) continue;
    modules.add(file);
    const source = readFileSync(join(SOURCE, file), "utf8");
    if (/\bimport\s*\(/.test(source)) external.add(`import() in ${file}`);
    if (/\brequire\s*\(/.test(source)) external.add(`require() in ${file}`);
    for (const specifier of imports(source)) {
      if (specifier.startsWith("./") && !specifier.slice(2).includes("/")) queue.push(specifier.slice(2));
      else external.add(specifier);
    }
  }
  return { modules: [...modules].sort(), external: [...external].sort() };
}

/** This function gives a connection with only the members of `SqlConnection`, as an adapter of a different driver does. */
function narrow(db: DatabaseSync): SqlConnection {
  const statement = (sql: string): SqlStatement => {
    const prepared = db.prepare(sql);
    return Object.freeze({
      get: (...parameters) => prepared.get(...parameters),
      all: (...parameters) => prepared.all(...parameters),
      run: (...parameters) => prepared.run(...parameters),
      iterate: (...parameters) => prepared.iterate(...parameters),
    } satisfies SqlStatement);
  };
  return Object.freeze({
    exec: (sql: string) => {
      db.exec(sql);
    },
    prepare: statement,
    get isTransaction() {
      return db.isTransaction;
    },
  });
}

interface Note extends LogRecord {
  readonly text: string;
}

const parse = (value: unknown): Note => value as Note;

describe("the portable entry", () => {
  it("imports no module out of the package at run time", () => {
    expect(closure("portable.ts")).toEqual({
      modules: ["checkpoint.ts", "clear.ts", "event-log.ts", "fold-snapshot.ts", "migrate.ts", "portable.ts", "probe.ts", "projection.ts", "schema.ts", "sqljs.ts", "transaction.ts", "wasm.ts"],
      external: [],
    });
  });

  it("names no module out of the package in its types, so a browser project needs no @types/node", () => {
    expect(closure("portable.ts", allImports)).toEqual({
      modules: [
        "checkpoint.ts",
        "clear.ts",
        "connection.ts",
        "event-log.ts",
        "fold-snapshot.ts",
        "migrate.ts",
        "portable.ts",
        "probe.ts",
        "projection.ts",
        "schema.ts",
        "sqljs.ts",
        "transaction.ts",
        "wasm.ts",
      ],
      external: [],
    });
    expect(closure("index.ts", allImports).external).toEqual(expect.arrayContaining(["node:sqlite"]));
  });

  it("sees the node: imports of the main entry, so the walk reads value imports", () => {
    const { modules, external } = closure("index.ts");
    expect(modules).toEqual(expect.arrayContaining(["database.ts", "event-log-file.ts", "recovery.ts"]));
    expect(external).toEqual(expect.arrayContaining(["node:fs", "node:sqlite"]));
  });

  it("reads type imports and value imports apart", () => {
    const source = [
      'import type { A } from "node:sqlite";',
      'export type { B } from "./b.ts";',
      'import { type C, d } from "./c.ts";',
      "export {",
      "  e,",
      "  type F,",
      '} from "./e.ts";',
      'import "./side.ts";',
      'export const G = "from \\"./g.ts\\"";',
      ' * import { h } from "./comment.ts";',
    ].join("\n");
    expect(valueImports(source)).toEqual(["./c.ts", "./e.ts", "./side.ts"]);
  });

  it("exports the same functions as the main entry", () => {
    const names = Object.keys(portable).sort();
    expect(names).toEqual([
      "BrokenLogError",
      "EVENT_LOG_SCHEMA_VERSION",
      "FOLD_SNAPSHOT_PART",
      "FOLD_SNAPSHOT_SCHEMA_VERSION",
      "SCHEMA_VERSIONS_TABLE",
      "SchemaError",
      "addMissingColumns",
      "checkpoint",
      "clearDatabase",
      "ensureProjection",
      "eventLog",
      "foldSnapshot",
      "migrate",
      "readTransaction",
      "schemaVersion",
      "sqlJsConnection",
      "syncedTransaction",
      "tableColumns",
      "transaction",
      "userVersion",
      "wasmConnection",
    ]);
    for (const name of names) expect(portable[name as keyof typeof portable]).toBe(entry[name as keyof typeof entry]);
  });

  it("migrates, projects and keeps a log on a connection with only the members of SqlConnection", () => {
    const file = new DatabaseSync(":memory:");
    const db = narrow(file);
    expect(portable.migrate(db, ["CREATE TABLE app (x INTEGER)", (d) => d.exec("INSERT INTO app VALUES (1)")])).toEqual({ from: 0, to: 2 });
    expect(portable.addMissingColumns(db, "app", { y: "TEXT" })).toEqual(["y"]);
    expect(portable.ensureProjection(db, "CREATE TABLE idx (k TEXT)", { version: 1, part: "idx", tables: ["idx"] })).toEqual({ rebuilt: true, from: 0 });
    const log = portable.eventLog(db, { parse, nested: "savepoint" });
    const note: Note = { id: "n1", at: "2026-11-14T00:00:00.000Z", type: "note", text: "one" };
    portable.transaction(db, () => {
      expect(log.append(note)).toEqual({ kind: "added", seq: 1 });
      expect(log.append({ ...note, text: "two" })).toMatchObject({ kind: "conflict", seq: 1 });
    });
    expect([...log.read()]).toEqual([note]);
    expect(log.head()).toBe(1);
    expect(portable.userVersion(db)).toBe(2);
    expect(portable.schemaVersion(db, "idx")).toBe(1);
    file.close();
  });
});

describePortable("node:sqlite", () => new DatabaseSync(":memory:"));
