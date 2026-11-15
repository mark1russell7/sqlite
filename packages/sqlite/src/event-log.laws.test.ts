// The laws of the log as a grow-only set. The join of two logs is the append of the events of one log to the other.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Appended, type LogRecord } from "./event-log.ts";
import { openEventLog, type EventLogFile } from "./event-log-file.ts";

interface Fact extends LogRecord {
  readonly value: number;
}

const parse = (value: unknown): Fact => value as Fact;

/** An event with a body that is a function of its id: a log of such events has no conflict. */
const fact = (id: number): Fact => ({ id: `e${String(id)}`, at: "2026-11-14T00:00:00Z", type: id % 2 === 0 ? "report" : "ack", value: id * 7 });

/** A list of events, with ids from a small range, so that duplicates are frequent. */
const facts = fc.array(fc.integer({ min: 0, max: 12 }).map(fact), { maxLength: 30 });

function logOf(...batches: readonly (readonly Fact[])[]): EventLogFile<Fact> {
  const log = openEventLog(":memory:", parse);
  for (const batch of batches) log.appendAll(batch);
  return log;
}

/** This function gives the set of a log: each id with its JSON text, in the order of the ids. */
function setOf(log: EventLogFile<Fact>): string[] {
  return [...log.read()].map((event) => JSON.stringify(event)).sort();
}

/** The join: the events of `source` go into `target`. */
function join(target: EventLogFile<Fact>, source: EventLogFile<Fact>): EventLogFile<Fact> {
  target.appendAll(source.read());
  return target;
}

function withLogs<T>(logs: readonly EventLogFile<Fact>[], work: () => T): T {
  try {
    return work();
  } finally {
    for (const log of logs) log.close();
  }
}

describe("the join laws of the log", () => {
  it("is idempotent: a second append of the same events changes nothing", () => {
    fc.assert(
      fc.property(facts, (a) => {
        const log = logOf(a);
        withLogs([log], () => {
          const before = setOf(log);
          const again = log.appendAll(a);
          expect(again.every((result) => result.kind === "duplicate")).toBe(true);
          expect(setOf(log)).toEqual(before);
        });
      }),
    );
  });

  it("is commutative: the order of arrival changes nothing", () => {
    fc.assert(
      fc.property(facts, facts, (a, b) => {
        const ab = logOf(a, b);
        const ba = logOf(b, a);
        withLogs([ab, ba], () => expect(setOf(ab)).toEqual(setOf(ba)));
      }),
    );
  });

  it("is associative: copies that exchange their events get the same set", () => {
    fc.assert(
      fc.property(facts, facts, facts, (a, b, c) => {
        const left = join(join(logOf(a), logOf(b)), logOf(c));
        const right = join(logOf(a), join(logOf(b), logOf(c)));
        withLogs([left, right], () => expect(setOf(left)).toEqual(setOf(right)));
      }),
    );
  });

  it("is the union: the log has each distinct id one time", () => {
    fc.assert(
      fc.property(facts, facts, (a, b) => {
        const log = logOf(a, b);
        withLogs([log], () => {
          const union = new Set([...a, ...b].map((event) => event.id));
          expect(log.count()).toBe(union.size);
          expect(new Set(log.read()).size).toBe(union.size);
        });
      }),
    );
  });
});

describe("conflicts", () => {
  /** An event whose body can differ for one id: `variant` changes the value. */
  const variants = fc.array(
    fc.record({ id: fc.integer({ min: 0, max: 5 }), variant: fc.integer({ min: 0, max: 2 }) }).map(({ id, variant }) => ({ ...fact(id), value: variant })),
    { maxLength: 30 },
  );

  it("keeps the first body of each id, and reports each later different body", () => {
    fc.assert(
      fc.property(variants, (events) => {
        const log = openEventLog(":memory:", parse);
        withLogs([log], () => {
          const results = log.appendAll(events);
          const first = new Map<string, Fact>();
          const expected: Appended<Fact, never>["kind"][] = events.map((event) => {
            const stored = first.get(event.id);
            if (stored === undefined) {
              first.set(event.id, event);
              return "added";
            }
            return stored.value === event.value ? "duplicate" : "conflict";
          });
          expect(results.map((result) => result.kind)).toEqual(expected);
          expect([...log.read()].sort((x, y) => x.id.localeCompare(y.id))).toEqual([...first.values()].sort((x, y) => x.id.localeCompare(y.id)));
        });
      }),
    );
  });
});
