// The probe of the home page for `site-pages check`: it uses the demo as a visitor does, at each width of the check.
declare const check: (name: string, ok: boolean, detail?: unknown) => void;
declare const $: (selector: string) => HTMLElement | null;
declare const $$: (selector: string) => HTMLElement[];
declare const click: (element: Element | string | null) => void;
declare const type: (element: Element | string | null, text: string) => void;
declare const until: (fn: () => unknown, ms?: number) => Promise<boolean>;

/** This function gives the kind of agreement that the page shows. */
const agreement = (): string | undefined => $("#agreement")?.dataset["kind"];
/** This function gives the count of notes of a copy. */
const notes = (copy: string): number => $$(`.copy-${copy} .entry`).length;
/** This function finds a button of a card by its text. */
const button = (copy: string, text: string): HTMLElement | null =>
  $$(`.copy-${copy} button`).find((element) => element.textContent === text) ?? null;

check("SQLite in WebAssembly loads", await until(() => agreement() !== undefined, 20000), $("#engine")?.textContent);
check("the engine line names the version of SQLite", /^SQLite \d+\.\d+/.test($("#engine")?.textContent ?? ""), $("#engine")?.textContent);

click("#reset");
check("the copies start different", agreement() === "ids" && notes("a") === 2 && notes("b") === 1 && notes("c") === 0, [agreement(), notes("a"), notes("b"), notes("c")]);

click("#exchange");
check("Exchange all makes the copies agree", await until(() => agreement() === "same"), $("#agreement")?.textContent);
check("each copy has the 3 notes", notes("a") === 3 && notes("b") === 3 && notes("c") === 3, [notes("a"), notes("b"), notes("c")]);

type(".copy-c input", "Jam");
click(button("c", "Write"));
check("copy C writes the note c1", await until(() => notes("c") === 4 && $(".copy-c .entry.fresh code")?.textContent === "c1"), $("#last")?.textContent);

click(button("a", "Make a conflict"));
click(button("a", "Send to C"));
check("the send reports one conflict", await until(() => $$("#conflicts li").length === 1 && $("#conflicts")?.hidden === false), $("#last")?.textContent);
check("copy C keeps its own text of c1", ($("#conflicts li")?.textContent ?? "").includes("copy C keeps “Jam”"), $("#conflicts li")?.textContent);

click("#exchange");
check("the copies have the same ids and a different text at c1", await until(() => agreement() === "bodies"), $("#agreement")?.textContent);
check("each law holds", $$(".law.holds").length === 5 && $$(".law.fails").length === 0, $$(".law").map((law) => law.textContent));

export {};
