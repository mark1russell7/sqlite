/**
 * The model of the demo: copies of one event log, each in its own database of SQLite in WebAssembly. The page sends events
 * from copy to copy, and checks the join laws of the log on the events that the copies have.
 *
 * @packageDocumentation
 */
import { eventLog, wasmConnection, type Appended, type EventLog, type LogRecord } from "@mark1russell7/sqlite/portable";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

/** An event of the demo: a note that a copy wrote. */
export interface Note extends LogRecord {
  readonly type: "note";
  /** This value is the name of the copy that wrote the note. */
  readonly by: string;
  readonly text: string;
}

/** This function changes a stored JSON value into a note. It throws on a value that is not a note. */
export function parseNote(value: unknown): Note {
  if (typeof value === "object" && value !== null) {
    const { id, at, type, by, text } = value as Record<string, unknown>;
    if (typeof id === "string" && typeof at === "string" && type === "note" && typeof by === "string" && typeof text === "string") {
      return { id, at, type, by, text };
    }
  }
  throw new TypeError(`The value is not a note: ${JSON.stringify(value)}.`);
}

/** A copy of the log in its own database. */
export interface Copy {
  readonly name: string;
  readonly log: EventLog<Note>;
  close(): void;
}

/** This function opens a copy of the log in a new database in memory. */
export function openCopy(sqlite3: Sqlite3Static, name: string): Copy {
  const db = wasmConnection(sqlite3, new sqlite3.oo1.DB(":memory:", "c"));
  try {
    const log = eventLog(db, { parse: parseNote, nested: "savepoint" });
    return { name, log, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** A conflict: the copy has a different note with the same id. The copy keeps its note and refuses the new one. */
export interface Conflict {
  readonly kept: Note;
  readonly refused: Note;
}

/** The result of a send: the count of each kind of result, and each conflict. */
export interface Tally {
  readonly added: number;
  readonly duplicate: number;
  readonly conflicts: readonly Conflict[];
}

/** This function counts the results of `appendAll` for the notes that it got, in the same order. */
export function tally(results: readonly Appended<Note, never>[], offered: readonly Note[]): Tally {
  let added = 0;
  let duplicate = 0;
  const conflicts: Conflict[] = [];
  results.forEach((result, index) => {
    if (result.kind === "added") added += 1;
    else if (result.kind === "duplicate") duplicate += 1;
    else if (result.kind === "conflict") conflicts.push({ kept: result.stored, refused: offered[index] as Note });
  });
  return { added, duplicate, conflicts };
}

/** This function sends each note of `from` to `to`, in one transaction of `to`. */
export function send(from: Copy, to: Copy): Tally {
  const notes = [...from.log.read()];
  return tally(to.log.appendAll(notes), notes);
}

/** This function sends the notes of each copy to the other copy. */
export function exchange(a: Copy, b: Copy): { readonly toB: Tally; readonly toA: Tally } {
  const toB = send(a, b);
  const toA = send(b, a);
  return { toB, toA };
}

/** A law of the log, checked on the notes that the copies have. */
export interface Law {
  readonly name: string;
  readonly holds: boolean;
  /** This value tells what the check compared. */
  readonly detail: string;
}

/** The notes of a copy at one time. */
export interface History {
  readonly name: string;
  readonly notes: readonly Note[];
}

/** The result of a join: the stored notes in their order, and the count of each kind of result. */
interface Joined {
  readonly notes: readonly Note[];
  readonly added: number;
  readonly conflicts: number;
}

/** This function appends each list of notes to a new copy, in order, and gives the stored notes. */
function join(sqlite3: Sqlite3Static, ...lists: readonly (readonly Note[])[]): Joined {
  const copy = openCopy(sqlite3, "join");
  try {
    let added = 0;
    let conflicts = 0;
    for (const list of lists) {
      const counted = tally(copy.log.appendAll(list), list);
      added += counted.added;
      conflicts += counted.conflicts.length;
    }
    return { notes: [...copy.log.read()], added, conflicts };
  } finally {
    copy.close();
  }
}

/** This function gives the ids of notes in the order of their text. */
function ids(notes: readonly Note[]): string[] {
  return notes.map((note) => note.id).sort();
}

/** This function tells if two lists have the same items in the same order. */
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** This function gives a count with its noun, for example "1 note" or "3 notes". */
export function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * This function checks the join laws of the log on three histories, each in new databases. The laws are the laws of the
 * tests of `@mark1russell7/sqlite`: idempotent, commutative, associative, the union, and the first body of each id.
 */
export function checkLaws(sqlite3: Sqlite3Static, [a, b, c]: readonly [History, History, History]): Law[] {
  const names = `${a.name}, ${b.name} and ${c.name}`;

  const again = [a, b, c].map((history) => join(sqlite3, history.notes, history.notes).added - history.notes.length);
  const idempotent: Law = {
    name: "Idempotent",
    holds: again.every((extra) => extra === 0),
    detail: `A second append of the notes of ${names} adds ${count(again.reduce((sum, extra) => sum + extra, 0), "note")}.`,
  };

  const forward = join(sqlite3, a.notes, b.notes, c.notes);
  const backward = join(sqlite3, c.notes, b.notes, a.notes);
  const commutative: Law = {
    name: "Commutative",
    holds: same(ids(forward.notes), ids(backward.notes)),
    detail: `The orders ${a.name}${b.name}${c.name} and ${c.name}${b.name}${a.name} give the same ${count(forward.notes.length, "id")}.`,
  };

  const left = join(sqlite3, join(sqlite3, a.notes, b.notes).notes, c.notes);
  const right = join(sqlite3, a.notes, join(sqlite3, b.notes, c.notes).notes);
  const associative: Law = {
    name: "Associative",
    holds: same(ids(left.notes), ids(right.notes)),
    detail: `(${a.name} + ${b.name}) + ${c.name} and ${a.name} + (${b.name} + ${c.name}) give the same ${count(left.notes.length, "id")}.`,
  };

  const distinct = new Set([...a.notes, ...b.notes, ...c.notes].map((note) => note.id)).size;
  const union: Law = {
    name: "Union",
    holds: forward.notes.length === distinct,
    detail: `The join has ${count(forward.notes.length, "note")}, one for each of the ${count(distinct, "distinct id")}.`,
  };

  const first = new Map<string, string>();
  for (const note of [...a.notes, ...b.notes, ...c.notes]) if (!first.has(note.id)) first.set(note.id, JSON.stringify(note));
  const kept = forward.notes.every((note) => first.get(note.id) === JSON.stringify(note));
  const firstBody: Law = {
    name: "First body kept",
    holds: kept,
    detail:
      forward.conflicts === 0
        ? "No id has two different bodies. Push Make a conflict, and then send, to see this law."
        : `Each id keeps the body that arrived first, and the log reports ${count(forward.conflicts, "conflict")}.`,
  };

  return [idempotent, commutative, associative, union, firstBody];
}

/** How the copies compare: the same notes, the same ids with a different body at some ids, or different ids. */
export type Agreement =
  | { readonly kind: "same"; readonly notes: number }
  | { readonly kind: "bodies"; readonly ids: readonly string[] }
  | { readonly kind: "ids"; readonly counts: readonly number[] };

/** This function compares the notes of the copies. */
export function compare(histories: readonly History[]): Agreement {
  const sets = histories.map((history) => ids(history.notes));
  const [head, ...rest] = sets;
  if (head === undefined) return { kind: "same", notes: 0 };
  if (!rest.every((other) => same(head, other))) return { kind: "ids", counts: sets.map((set) => set.length) };
  const bodies = new Map<string, Set<string>>();
  for (const history of histories) {
    for (const note of history.notes) {
      const seen = bodies.get(note.id) ?? new Set<string>();
      seen.add(JSON.stringify(note));
      bodies.set(note.id, seen);
    }
  }
  const differ = [...bodies].filter(([, seen]) => seen.size > 1).map(([id]) => id).sort();
  return differ.length === 0 ? { kind: "same", notes: head.length } : { kind: "bodies", ids: differ };
}

/** This function gives the id of the next note of a copy: the lowercase name of the copy and the next number. */
export function nextId(copy: Copy): string {
  const prefix = copy.name.toLowerCase();
  let last = 0;
  for (const note of copy.log.read()) {
    const n = Number(note.id.slice(prefix.length));
    if (note.id.startsWith(prefix) && Number.isInteger(n) && n > last) last = n;
  }
  return `${prefix}${String(last + 1)}`;
}

/** This function writes a new note in a copy, and gives the note. */
export function write(copy: Copy, text: string, at: string): Note {
  const note: Note = { id: nextId(copy), at, type: "note", by: copy.name, text };
  copy.log.append(note);
  return note;
}

/**
 * This function makes a conflict. The copy writes a note with the id of a note of a different copy that it does not have,
 * and a different text. It gives the new note, or `undefined` when the copy has each id of the other copies.
 */
export function reuseId(copy: Copy, others: readonly Copy[], at: string): Note | undefined {
  for (const other of others) {
    for (const note of other.log.read()) {
      if (copy.log.get(note.id) !== undefined) continue;
      const reused: Note = { id: note.id, at, type: "note", by: copy.name, text: `${copy.name} also wrote ${note.id}` };
      copy.log.append(reused);
      return reused;
    }
  }
  return undefined;
}
