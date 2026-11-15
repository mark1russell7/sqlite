/**
 * The live demo of the home page: three copies of one event log, each in its own database of SQLite in WebAssembly.
 *
 * @packageDocumentation
 */
import { byId, h } from "@mark1russell7/site-pages/chrome";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { checkLaws, compare, count, openCopy, reuseId, send, write, type Conflict, type Copy, type History, type Note, type Tally } from "./copies.ts";

const NAMES = ["A", "B", "C"] as const;

/** The first notes of each copy, so the copies differ at the start. */
const SEED: Readonly<Record<(typeof NAMES)[number], readonly string[]>> = { A: ["Milk", "Bread"], B: ["Eggs"], C: [] };

/** The elements of the card of one copy that change. */
interface Card {
  readonly copy: () => Copy;
  readonly meta: HTMLElement;
  readonly notes: HTMLOListElement;
  readonly result: HTMLElement;
  readonly buttons: readonly HTMLButtonElement[];
}

/** This function gives the text of a tally, for example "2 added, 1 duplicate, no conflict". */
function describeTally(tally: Tally): string {
  const conflicts = tally.conflicts.length === 0 ? "no conflict" : count(tally.conflicts.length, "conflict");
  return `${String(tally.added)} added, ${count(tally.duplicate, "duplicate")}, ${conflicts}`;
}

/** This function adds the counts of two tallies. */
function sum(a: Tally, b: Tally): Tally {
  return { added: a.added + b.added, duplicate: a.duplicate + b.duplicate, conflicts: [...a.conflicts, ...b.conflicts] };
}

const EMPTY: Tally = { added: 0, duplicate: 0, conflicts: [] };

/** The sends of Exchange all, in order. After them, each copy has each note. */
const PAIRS = [
  ["A", "B"],
  ["B", "A"],
  ["B", "C"],
  ["C", "B"],
  ["A", "C"],
  ["C", "A"],
] as const;

/** This function starts the demo in the section with the ID `demo`. */
export async function startDemo(): Promise<void> {
  const engine = byId("engine");
  const controls = [byId<HTMLButtonElement>("exchange"), byId<HTMLButtonElement>("reset")];
  let sqlite3: Sqlite3Static;
  try {
    const { default: init } = await import("@sqlite.org/sqlite-wasm");
    sqlite3 = await init();
  } catch (error) {
    engine.textContent = `SQLite in WebAssembly did not load: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  engine.textContent = `SQLite ${sqlite3.version.libVersion} in WebAssembly runs in this tab. Each copy is a database in memory.`;
  new Demo(sqlite3, controls).start();
}

class Demo {
  private copies: Copy[] = [];
  private readonly cards: Card[] = [];
  /** The ids that the last change added to each copy, so the page marks them. */
  private fresh = new Map<string, Set<string>>();

  private readonly sqlite3: Sqlite3Static;
  private readonly controls: readonly HTMLButtonElement[];

  constructor(sqlite3: Sqlite3Static, controls: readonly HTMLButtonElement[]) {
    this.sqlite3 = sqlite3;
    this.controls = controls;
  }

  start(): void {
    const [exchange, reset] = this.controls;
    exchange?.addEventListener("click", () => {
      this.act(() => this.exchangeAll());
    });
    reset?.addEventListener("click", () => {
      this.act(() => this.reset());
    });
    const container = byId("copies");
    container.replaceChildren(...NAMES.map((name, index) => this.card(name, index)));
    this.act(() => this.reset());
    for (const button of this.controls) button.disabled = false;
  }

  /** This function makes the card of one copy, with its form and its buttons. */
  private card(name: string, index: number): HTMLElement {
    const input = h("input", { name: "text", maxlength: 40, autocomplete: "off", placeholder: "A note", "aria-label": `The text of a new note in copy ${name}`, required: true });
    const writeButton = h("button", { type: "submit", disabled: true }, "Write");
    const form = h("form", { class: "write" }, input, writeButton);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (text.length === 0) return;
      this.act(() => {
        const note = write(this.copy(index), text, new Date().toISOString());
        input.value = "";
        this.mark(name, [note.id]);
        return `Copy ${name} wrote ${note.id}.`;
      });
    });
    const others = NAMES.filter((other) => other !== name);
    const sends = others.map((other) => {
      const button = h("button", { type: "button", disabled: true }, `Send to ${other}`);
      button.addEventListener("click", () => {
        this.act(() => this.send(name, other));
      });
      return button;
    });
    const reuse = h("button", { type: "button", class: "quiet", disabled: true, title: "Write a note with the id of a note of a different copy, and a different text." }, "Make a conflict");
    reuse.addEventListener("click", () => {
      this.act(() => {
        const note = reuseId(
          this.copy(index),
          this.copies.filter((copy) => copy.name !== name),
          new Date().toISOString(),
        );
        if (note === undefined) return `Copy ${name} has each id of the other copies. Write a note in a different copy first.`;
        this.mark(name, [note.id]);
        return `Copy ${name} wrote ${note.id} with a different text. Send it to see the conflict.`;
      });
    });
    const meta = h("span", { class: "meta" });
    const notes = h("ol", { class: "notes", "aria-label": `The notes of copy ${name}` });
    const result = h("p", { class: "result" });
    this.cards.push({ copy: () => this.copy(index), meta, notes, result, buttons: [writeButton, ...sends, reuse] });
    return h(
      "article",
      { class: `copy copy-${name.toLowerCase()}` },
      h("div", { class: "copy-head" }, h("h3", {}, `Copy ${name}`), meta),
      form,
      notes,
      h("div", { class: "send" }, ...sends, reuse),
      result,
    );
  }

  private copy(index: number): Copy {
    const copy = this.copies[index];
    if (copy === undefined) throw new Error(`The demo has no copy ${String(index)}.`);
    return copy;
  }

  /** This function marks ids as new in a copy until the next change. */
  private mark(name: string, ids: readonly string[]): void {
    const set = this.fresh.get(name) ?? new Set<string>();
    for (const id of ids) set.add(id);
    this.fresh.set(name, set);
  }

  /** This function does a change, shows its text, and draws the page again. */
  private act(change: () => string): void {
    const last = byId("last");
    this.fresh = new Map();
    for (const card of this.cards) card.result.textContent = "";
    this.showConflicts([]);
    try {
      last.textContent = change();
      last.classList.remove("error");
    } catch (error) {
      last.textContent = `The change failed: ${error instanceof Error ? error.message : String(error)}`;
      last.classList.add("error");
    }
    this.draw();
  }

  private reset(): string {
    for (const copy of this.copies) copy.close();
    this.copies = NAMES.map((name) => openCopy(this.sqlite3, name));
    const at = "2026-11-15T00:00:00.000Z";
    for (const copy of this.copies) for (const text of SEED[copy.name as (typeof NAMES)[number]]) write(copy, text, at);
    for (const button of this.cards.flatMap((card) => card.buttons)) button.disabled = false;
    return "Each copy starts again: A has 2 notes, B has 1, and C has none.";
  }

  /** This function sends the notes of one copy to a different copy, and marks the notes that the receiver did not have. */
  private deliver(from: string, to: string): Tally {
    const target = this.byName(to);
    const before = new Set([...target.log.read()].map((note) => note.id));
    const tally = send(this.byName(from), target);
    this.mark(to, [...target.log.read()].filter((note) => !before.has(note.id)).map((note) => note.id));
    return tally;
  }

  /** This function does one send, and shows its result on the card of the receiver. */
  private send(from: string, to: string): string {
    const tally = this.deliver(from, to);
    const card = this.cards[NAMES.indexOf(to as (typeof NAMES)[number])];
    if (card !== undefined) card.result.textContent = `From ${from}: ${describeTally(tally)}.`;
    this.showConflicts(tally.conflicts.map((conflict) => conflictText(conflict, to, from)));
    return `${from} → ${to}: ${describeTally(tally)}.`;
  }

  /** This function sends the notes of each copy to each other copy. */
  private exchangeAll(): string {
    let total = EMPTY;
    const conflicts: string[] = [];
    for (const [from, to] of PAIRS) {
      const tally = this.deliver(from, to);
      conflicts.push(...tally.conflicts.map((conflict) => conflictText(conflict, to, from)));
      total = sum(total, tally);
    }
    this.showConflicts(conflicts);
    return `Exchange all, six sends: ${describeTally(total)}.`;
  }

  private byName(name: string): Copy {
    const copy = this.copies.find((candidate) => candidate.name === name);
    if (copy === undefined) throw new Error(`The demo has no copy ${name}.`);
    return copy;
  }

  private showConflicts(lines: readonly string[]): void {
    const list = byId("conflicts");
    list.replaceChildren(...lines.map((line) => h("li", {}, line)));
    list.hidden = lines.length === 0;
  }

  /** This function draws the notes of each copy, the agreement of the copies and the laws. */
  private draw(): void {
    const histories: History[] = this.copies.map((copy) => ({ name: copy.name, notes: [...copy.log.read()] }));
    for (const card of this.cards) {
      const copy = card.copy();
      const entries = [...copy.log.entries()];
      const fresh = this.fresh.get(copy.name);
      card.meta.textContent = `${count(entries.length, "note")}, head ${String(copy.log.head())}`;
      card.notes.replaceChildren(
        ...(entries.length === 0
          ? [h("li", { class: "empty" }, "No notes yet.")]
          : entries.map(({ seq, event }) => noteItem(seq, event, fresh?.has(event.id) === true))),
      );
    }
    drawAgreement(histories);
    drawLaws(histories.length === 3 ? checkLaws(this.sqlite3, histories as [History, History, History]) : []);
  }
}

/** This function gives the text of one conflict. */
function conflictText({ kept, refused }: Conflict, to: string, from: string): string {
  return `${kept.id}: copy ${to} keeps “${kept.text}” and refuses “${refused.text}” from copy ${from}.`;
}

/** This function gives the item of one note: its position, its id, its text and the copy that wrote it. */
function noteItem(seq: number, note: Note, fresh: boolean): HTMLLIElement {
  return h(
    "li",
    { class: fresh ? "entry fresh" : "entry" },
    h("span", { class: "seq", title: "The position in this copy" }, String(seq)),
    h("code", { class: `id by-${note.by.toLowerCase()}` }, note.id),
    h("span", { class: "text" }, note.text),
  );
}

function drawAgreement(histories: readonly History[]): void {
  const agreement = byId("agreement");
  const result = compare(histories);
  agreement.dataset["kind"] = result.kind;
  if (result.kind === "same") {
    agreement.textContent = `The copies agree: each copy has the same ${count(result.notes, "note")}.`;
  } else if (result.kind === "ids") {
    const counts = histories.map((history, index) => `${history.name} has ${String(result.counts[index] ?? 0)}`).join(", ");
    agreement.textContent = `The copies differ: ${counts}. Send the notes, or push Exchange all.`;
  } else {
    agreement.textContent = `The copies have the same ids, but ${result.ids.join(", ")} has a different text in different copies. Each copy keeps the text that it got first.`;
  }
}

function drawLaws(laws: ReturnType<typeof checkLaws>): void {
  byId("laws").replaceChildren(
    ...laws.map((law) =>
      h(
        "li",
        { class: law.holds ? "law holds" : "law fails" },
        h("span", { class: "mark", "aria-hidden": "true" }, law.holds ? "✓" : "✗"),
        h("span", { class: "law-name" }, law.name, h("span", { class: "sr" }, law.holds ? ": holds" : ": fails")),
        h("span", { class: "law-detail" }, law.detail),
      ),
    ),
  );
}
