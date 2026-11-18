/**
 * The power-cut test of the home (SQ-26): the data loss of each setting of `synchronous` at a power cut, the recovery
 * point objective (RPO). The disk tier of `@mark1russell7/harness` starts the writer of `subject/writer.mts` on LazyFS,
 * stops it at a point, and loses each write after the last fsync. Then `subject/check.mts` opens the log as the next
 * start of an app opens it. Each case examines one claim of the doc of `openDatabase` (`Claim` in `subject/protocol.ts`).
 *
 * The first part needs no Docker. It builds the folder of the subject and starts the writer on this computer. A stop of
 * a process loses no write, thus that part examines the subject itself. The second part needs Docker and privileged
 * containers, thus only the job `power` of `crash.yml` starts it: `SQLITE_POWER=1`. `SQLITE_POWER_OUT` names a folder
 * for the record of each case.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISK_RECORD_FORMAT, DISK_SUBJECT, type DiskLab, type DiskSubject, diskRecordProblems, openDiskLab, runDiskFault } from "@mark1russell7/harness";
import type { DiskFault, StopTrigger } from "@mark1russell7/rigor-chaos";
import { STOP_ENV, parseProgress, stopOrderOf } from "@mark1russell7/rigor-testkit/stop";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Claim, DEFAULTS, type Kept, type PowerSettings, boundsOf, claimProblems, envOf, progressOf } from "./subject/protocol.ts";

const RUN = process.env["SQLITE_POWER"] === "1";
const OUT = process.env["SQLITE_POWER_OUT"] || undefined;

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const SUBJECT_FILES = fileURLToPath(new URL("./subject", import.meta.url));
/** The one module of a package that the subject imports. Its file imports only modules of Node.js. */
const STOP_POINT = "@mark1russell7/rigor-testkit/stop-point";
// Node.js 22 strips the types of TypeScript only with this flag
const NODE_FLAGS = Number(process.versions.node.split(".")[0]) >= 23 ? [] : ["--experimental-strip-types"];
const NODE = [...NODE_FLAGS, "--disable-warning=ExperimentalWarning"];
const WRITER_MS = 60_000;

/** One case: the settings of the writer, the point of the cut and the claim that the cut examines. */
interface PowerCase {
  readonly name: string;
  readonly settings: Partial<PowerSettings>;
  readonly at: StopTrigger;
  readonly claim: Claim;
}

/**
 * The cases. A step counts the stop points from 0, and each commit ends at one stop point. Thus the step 5 is the cut
 * after the commit 6. The writer of the last case ends before its step, and closes its connections.
 */
const CASES: readonly PowerCase[] = [
  { name: "WAL with FULL keeps each commit", settings: { synchronous: "FULL" }, at: { step: 5 }, claim: "durable" },
  { name: "WAL with EXTRA keeps each commit", settings: { synchronous: "EXTRA" }, at: { step: 5 }, claim: "durable" },
  { name: "WAL with NORMAL and no checkpoint keeps a good file", settings: { synchronous: "NORMAL" }, at: { step: 5 }, claim: "checkpointed" },
  { name: "WAL with NORMAL keeps each commit of the last checkpoint", settings: { synchronous: "NORMAL", checkpointEvery: 4 }, at: { step: 9 }, claim: "checkpointed" },
  { name: "WAL with NORMAL keeps each commit of the last synced transaction", settings: { synchronous: "NORMAL", syncEvery: 4 }, at: { step: 9 }, claim: "synced" },
  { name: "WAL with OFF: a record only", settings: { synchronous: "OFF", checkpointEvery: 4 }, at: { step: 9 }, claim: "none" },
  {
    name: "WAL with FULL, a cut at a time, keeps each commit",
    settings: { synchronous: "FULL", transactions: 1_000, pauseMs: 20 },
    at: { ms: 1_500 },
    claim: "durable",
  },
  {
    name: "WAL with NORMAL, a cut at a time, keeps each commit of the last checkpoint",
    settings: { synchronous: "NORMAL", transactions: 1_000, pauseMs: 20, checkpointEvery: 25 },
    at: { ms: 1_500 },
    claim: "checkpointed",
  },
  {
    name: "WAL with NORMAL, a cut at a time, keeps each commit of the last synced transaction",
    settings: { synchronous: "NORMAL", transactions: 1_000, pauseMs: 20, syncEvery: 25 },
    at: { ms: 1_500 },
    claim: "synced",
  },
  { name: "the rollback journal with FULL keeps each commit", settings: { journal: "delete", synchronous: "FULL" }, at: { step: 5 }, claim: "durable" },
  { name: "the rollback journal with NORMAL: a record only", settings: { journal: "delete", synchronous: "NORMAL" }, at: { step: 5 }, claim: "none" },
  { name: "WAL with NORMAL keeps each commit after the close of the writer", settings: { synchronous: "NORMAL" }, at: { step: 50 }, claim: "durable" },
];

const settingsOfCase = (each: PowerCase): PowerSettings => ({ ...DEFAULTS, ...each.settings });
const atTime = (at: StopTrigger): boolean => "ms" in at;
/** A cut at a time always stops the writer. A cut at a step stops it only when the writer gets to that step. */
const stops = (each: PowerCase): boolean => !("step" in each.at) || each.at.step < settingsOfCase(each).transactions;

/** This function gives the specifiers of the imports of a module that are not of Node.js. It ignores the comments. */
function importsOf(text: string): string[] {
  const code = text
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  const found = code.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm);
  return [...found].map((match) => match[1] ?? match[2] ?? match[3] ?? "").filter((name) => !name.startsWith("node:"));
}

/**
 * This function builds the folder of the subject: the modules of `src` but the tests and the conformance suite, which
 * imports `fast-check`, the files of `subject`, and a `node_modules` folder with only the file of the stop point. It
 * throws when a module imports a package that the folder does not hold, because the container has no packages.
 */
function subjectFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "sqlite-power-"));
  writeFileSync(join(folder, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
  /** A copy of the folder keeps each relative import of the source. The copy of the stop point is one file only. */
  const copy = (from: string, to: string, allowed: (name: string) => boolean): void => {
    const foreign = importsOf(readFileSync(from, "utf8")).filter((name) => !allowed(name));
    if (foreign.length > 0) throw new Error(`The module ${from} imports ${foreign.join(", ")}, and the folder of the subject does not hold it.`);
    copyFileSync(from, to);
  };
  const relative = (name: string): boolean => name.startsWith(".");
  mkdirSync(join(folder, "src"));
  for (const name of readdirSync(join(PACKAGE, "src"))) {
    if (name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "conformance.ts") copy(join(PACKAGE, "src", name), join(folder, "src", name), relative);
  }
  mkdirSync(join(folder, "power", "subject"), { recursive: true });
  for (const name of readdirSync(SUBJECT_FILES)) {
    copy(join(SUBJECT_FILES, name), join(folder, "power", "subject", name), (each) => relative(each) || each === STOP_POINT);
  }
  const testkit = join(folder, "node_modules", "@mark1russell7", "rigor-testkit");
  mkdirSync(testkit, { recursive: true });
  const manifest = { name: "@mark1russell7/rigor-testkit", private: true, type: "module", exports: { "./stop-point": "./stop-point.js" } };
  writeFileSync(join(testkit, "package.json"), `${JSON.stringify(manifest)}\n`);
  copy(createRequire(import.meta.url).resolve(STOP_POINT), join(testkit, "stop-point.js"), () => false);
  return folder;
}

const folders: string[] = [];
const remove = (folder: string): void => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
let subject = "";
beforeAll(() => {
  subject = subjectFolder();
  folders.push(subject);
});
afterAll(() => {
  for (const folder of folders) remove(folder);
});

describe("the subject of the power-cut test, on this computer", () => {
  const node = (script: string, cwd: string, env: Readonly<Record<string, string>>): string =>
    execFileSync(process.execPath, [...NODE, join(subject, "power", "subject", script)], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });

  it("writes each transaction and reads it back, with no package but the stop point", () => {
    // The second writer makes each fourth commit in a synced transaction, on a log that takes a savepoint of it
    for (const settings of [{ checkpointEvery: 4 }, { syncEvery: 4 }]) {
      const work = mkdtempSync(join(tmpdir(), "sqlite-power-work-"));
      folders.push(work);
      const env = envOf({ ...DEFAULTS, synchronous: "NORMAL", ...settings });
      node("writer.mts", work, env);
      const kept = JSON.parse(node("check.mts", work, env)) as Kept;
      expect(kept).toMatchObject({ file: true, opened: true, integrity: ["ok"], commits: DEFAULTS.transactions, problems: [] });
    }
  });

  it("stops itself at the step of the order, and the stop of a process loses no commit", () => {
    const work = mkdtempSync(join(tmpdir(), "sqlite-power-work-"));
    folders.push(work);
    const progress = join(work, "progress.jsonl");
    const env = envOf(DEFAULTS);
    const order = stopOrderOf({ at: { step: 3 }, signal: "SIGKILL" }, progress);
    // The writer stops itself with SIGKILL, thus execFileSync throws
    expect(() => node("writer.mts", work, { ...env, [STOP_ENV]: JSON.stringify(order) })).toThrow();
    const lines = parseProgress(readFileSync(progress, "utf8"));
    expect(lines.at(-1)).toEqual({ step: 3, label: "commit 4 checkpointed 0 synced 0", stop: true });
    const kept = JSON.parse(node("check.mts", work, env)) as Kept;
    expect(kept).toMatchObject({ file: true, opened: true, integrity: ["ok"], commits: 4, problems: [] });
  });
});

const git = (args: readonly string[]): string => execFileSync("git", [...args], { cwd: PACKAGE, encoding: "utf8" }).trim();

describe.runIf(RUN)("the power cut on LazyFS (SQLITE_POWER=1)", () => {
  const labs = new Map<string, DiskLab>();
  const keyOf = (each: PowerCase): string => JSON.stringify(envOf(settingsOfCase(each)));

  beforeAll(async () => {
    const code = { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "" };
    const base: Omit<DiskSubject, "env"> = {
      name: "sqlite-power",
      folder: subject,
      // The image has Node.js 24, which strips the types with no flag
      writer: ["node", "--disable-warning=ExperimentalWarning", `${DISK_SUBJECT}/power/subject/writer.mts`],
      check: ["node", "--disable-warning=ExperimentalWarning", `${DISK_SUBJECT}/power/subject/check.mts`],
      timeoutMs: WRITER_MS,
    };
    for (const each of CASES) {
      const key = keyOf(each);
      if (!labs.has(key)) labs.set(key, await openDiskLab({ subject: { ...base, env: envOf(settingsOfCase(each)) }, code }));
    }
    if (OUT !== undefined) mkdirSync(OUT, { recursive: true });
  }, 900_000);

  for (const [index, each] of CASES.entries()) {
    it(each.name, async () => {
      const fault: DiskFault = { kind: "lose-unsynced", at: each.at };
      const record = await runDiskFault(labs.get(keyOf(each))!, fault);
      const progress = progressOf(record.writer.lastLabel);
      const kept = record.persisted as Kept;
      const problems = claimProblems(kept, each.claim, progress, atTime(each.at));
      const commits = kept.file && kept.opened ? kept.commits : null;
      const result = {
        index,
        case: each.name,
        settings: settingsOfCase(each),
        claim: each.claim,
        progress,
        bounds: boundsOf(each.claim, progress, atTime(each.at)) ?? null,
        // The RPO of the case: the commits that ended before the cut, and that the disk lost
        lost: commits === null ? null : Math.max(0, progress.commits - commits),
        problems,
        record,
      };
      if (OUT !== undefined) writeFileSync(join(OUT, `case-${String(index)}.json`), `${JSON.stringify(result, null, 2)}\n`);

      expect(record.format).toBe(DISK_RECORD_FORMAT);
      expect(diskRecordProblems(record)).toEqual([]);
      // `timeout` gives 137 for a writer that it stops with SIGKILL, and the code of a writer that ends first
      expect({ exit: record.writer.exit, stopped: record.writer.stopped }).toEqual(stops(each) ? { exit: 137, stopped: true } : { exit: 0, stopped: false });
      if ("step" in each.at && stops(each)) expect(record.writer.lastStep).toBe(each.at.step);
      // A cut at a time comes after some commits, or the case examines nothing
      if (atTime(each.at)) expect(progress.commits).toBeGreaterThan(0);
      expect(problems).toEqual([]);
    }, 180_000);
  }
});
