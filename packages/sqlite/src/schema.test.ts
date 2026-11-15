// A validator of the Standard Schema as the parse of a log: zod 4, a hand-made validator and a callable validator.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { eventLog, type LogEntry, type LogRecord } from "./event-log.ts";
import { openEventLog } from "./event-log-file.ts";
import { salvageEventLog } from "./recovery.ts";
import { parseFunction, SchemaError, type StandardResult, type StandardSchema } from "./schema.ts";

/** A schema of zod 4. The default fills `count` in the events that an older app wrote. */
const Note = z.object({
  id: z.string(),
  at: z.string(),
  type: z.literal("note"),
  text: z.string().max(40),
  count: z.number().int().default(0),
});
type Note = z.output<typeof Note>;

const note = (id: string, text = "Milk"): Note => ({ id, at: "2026-11-15T00:00:00Z", type: "note", text, count: 1 });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlite-schema-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** This function writes a stored body into the table `events` directly, as a different app or an older version does. */
function store(db: DatabaseSync, id: string, body: unknown): void {
  db.prepare("INSERT INTO events (id, at, type, body) VALUES (?, ?, ?, ?)").run(id, "2026-11-15T00:00:00Z", "note", JSON.stringify(body));
}

describe("a schema of zod 4 as the parse of a log", () => {
  it("gives the output of the schema when the log reads, and the type of the log is the output type", () => {
    const db = new DatabaseSync(":memory:");
    const log = eventLog(db, { parse: Note });
    expectTypeOf(log.get("x")).toEqualTypeOf<LogEntry<Note> | undefined>();
    expect(log.append(note("a1"))).toEqual({ kind: "added", seq: 1 });
    store(db, "a2", { id: "a2", at: "2026-11-15T00:00:00Z", type: "note", text: "Bread" });
    expect([...log.read()]).toEqual([note("a1"), { ...note("a2", "Bread"), count: 0 }]);
    db.close();
  });

  it("refuses a stored value with a SchemaError that has each problem and its path", () => {
    const db = new DatabaseSync(":memory:");
    const log = eventLog(db, { parse: Note });
    store(db, "b1", { id: "b1", at: "2026-11-15T00:00:00Z", type: "note", text: 7 });
    const error = (() => {
      try {
        log.get("b1");
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The event at the position 1 of the log is not valid.");
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(SchemaError);
    expect(cause).toBeInstanceOf(TypeError);
    expect((cause as SchemaError).vendor).toBe("zod");
    expect((cause as SchemaError).issues.map((issue) => issue.path)).toEqual([["text"]]);
    expect((cause as SchemaError).message).toMatch(/^The schema of zod refuses the value: text: /);
    db.close();
  });

  it("finds a conflict with the parsed stored event", () => {
    const db = new DatabaseSync(":memory:");
    const log = eventLog(db, { parse: Note });
    log.append(note("c1"));
    expect(log.append(note("c1", "Jam"))).toEqual({ kind: "conflict", seq: 1, stored: note("c1") });
    db.close();
  });

  it("refuses a schema that validates asynchronously", () => {
    const db = new DatabaseSync(":memory:");
    const Slow = Note.refine(async (value) => {
      await Promise.resolve();
      return value.text.length > 0;
    });
    const log = eventLog(db, { parse: Slow });
    log.append(note("d1"));
    expect(() => [...log.read()]).toThrow(expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringMatching(/validates asynchronously/) }) }));
    db.close();
  });

  it("opens a log file and salvages a log with a schema", () => {
    const path = join(dir, "notes.db");
    const file = openEventLog(path, Note);
    file.append(note("e1"));
    file.close();
    const target = openEventLog(":memory:", Note);
    expect(salvageEventLog(path, target, { parse: Note })).toMatchObject({ read: 1, added: 1, lost: 0 });
    expect(target.get("e1")?.event).toEqual(note("e1"));
    target.close();
  });
});

describe("the parse function of a parse", () => {
  /** This function makes a validator by hand, with no library. */
  const handMade = (validate: (value: unknown) => StandardResult<LogRecord> | Promise<StandardResult<LogRecord>>): StandardSchema<LogRecord> => ({
    "~standard": { version: 1, vendor: "hand", validate },
  });

  it("gives a function as it is", () => {
    const parse = (value: unknown): LogRecord => value as LogRecord;
    expect(parseFunction(parse)).toBe(parse);
  });

  it("writes the path of each problem, with the keys of path segments and the indexes of lists", () => {
    const parse = parseFunction(
      handMade(() => ({
        issues: [{ message: "Required", path: ["items", 0, { key: "name" }] }, { message: "Not an event" }],
      })),
    );
    expect(() => parse({})).toThrow(SchemaError);
    expect(() => parse({})).toThrow("The schema of hand refuses the value: items.0.name: Required. The value: Not an event.");
  });

  it("uses the validator of a callable validator, not its call", () => {
    const record = { id: "f1", at: "2026-11-15T00:00:00Z", type: "note" };
    const callable = Object.assign(() => {
      throw new Error("The log must not call the function.");
    }, handMade(() => ({ value: record })));
    expect(parseFunction<LogRecord>(callable)({})).toBe(record);
  });

  it("handles the rejection of an asynchronous result, so no rejection stays unhandled", async () => {
    const parse = parseFunction(handMade(() => Promise.reject(new Error("The validator fails later."))));
    expect(() => parse({})).toThrow(/validates asynchronously/);
    // A rejection that nobody handles makes vitest fail the run. This tick lets the rejection happen.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("refuses a thenable result that is not a promise", () => {
    const parse = parseFunction(handMade(() => ({ then: () => undefined }) as unknown as Promise<StandardResult<LogRecord>>));
    expect(() => parse({})).toThrow("The schema of hand validates asynchronously. A log reads its events synchronously, so it needs a synchronous schema.");
  });
});
