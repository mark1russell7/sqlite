// The model of the demo on the real driver: the copies, the sends, the conflicts and the laws.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkLaws, compare, count, exchange, nextId, openCopy, parseNote, reuseId, send, write, type Copy, type History } from "./copies.ts";

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

const AT = "2026-11-15T00:00:00.000Z";

let sqlite3: Sqlite3;
let open: Copy[] = [];

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

afterEach(() => {
  for (const copy of open) copy.close();
  open = [];
});

/** This function opens a copy that the test closes after it. */
function copyOf(name: string, ...texts: readonly string[]): Copy {
  const copy = openCopy(sqlite3, name);
  open.push(copy);
  for (const text of texts) write(copy, text, AT);
  return copy;
}

const history = (copy: Copy): History => ({ name: copy.name, notes: [...copy.log.read()] });

describe("the copies of the demo", () => {
  it("gives each copy its own ids", () => {
    const a = copyOf("A", "one", "two");
    expect([...a.log.read()].map((note) => note.id)).toEqual(["a1", "a2"]);
    expect(nextId(a)).toBe("a3");
  });

  it("sends the new notes and counts the duplicates", () => {
    const a = copyOf("A", "one", "two");
    const b = copyOf("B", "three");
    expect(send(a, b)).toEqual({ added: 2, duplicate: 0, conflicts: [] });
    expect(send(a, b)).toEqual({ added: 0, duplicate: 2, conflicts: [] });
    expect(exchange(a, b)).toEqual({ toB: { added: 0, duplicate: 2, conflicts: [] }, toA: { added: 1, duplicate: 2, conflicts: [] } });
    expect(compare([history(a), history(b)])).toEqual({ kind: "same", notes: 3 });
  });

  it("reports a conflict, and each copy keeps the body that it got first", () => {
    const a = copyOf("A", "one");
    const b = copyOf("B");
    const reused = reuseId(b, [a], AT);
    expect(reused).toMatchObject({ id: "a1", by: "B", text: "B also wrote a1" });
    expect(reuseId(b, [a], AT)).toBeUndefined();
    const { toB, toA } = exchange(a, b);
    expect(toB.conflicts).toEqual([{ kept: reused, refused: a.log.get("a1")?.event }]);
    expect(toA.conflicts).toHaveLength(1);
    expect(compare([history(a), history(b)])).toEqual({ kind: "bodies", ids: ["a1"] });
  });

  it("tells when the copies have different ids", () => {
    const a = copyOf("A", "one");
    const b = copyOf("B");
    expect(compare([history(a), history(b)])).toEqual({ kind: "ids", counts: [1, 0] });
  });

  it("finds that each law holds on the histories of the copies", () => {
    const a = copyOf("A", "one", "two");
    const b = copyOf("B", "three");
    const c = copyOf("C");
    send(a, c);
    reuseId(c, [b], AT);
    const laws = checkLaws(sqlite3, [history(a), history(b), history(c)]);
    expect(laws.map((law) => [law.name, law.holds])).toEqual([
      ["Idempotent", true],
      ["Commutative", true],
      ["Associative", true],
      ["Union", true],
      ["First body kept", true],
    ]);
    expect(laws[3]?.detail).toBe("The join has 3 notes, one for each of the 3 distinct ids.");
    expect(laws[4]?.detail).toContain("1 conflict");
  });

  it("refuses a stored value that is not a note", () => {
    expect(() => parseNote({ id: "x" })).toThrow(TypeError);
    expect(count(1, "note")).toBe("1 note");
    expect(count(2, "note")).toBe("2 notes");
  });
});
