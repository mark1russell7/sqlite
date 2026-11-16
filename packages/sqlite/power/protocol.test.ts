/**
 * The tests of the protocol of the power-cut test (`subject/protocol.ts`). They need no Docker, thus the default suite
 * includes this file.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  type Kept,
  boundsOf,
  claimProblems,
  commitsOf,
  envOf,
  eventsOf,
  labelOf,
  parseEvent,
  progressOf,
  settingsOf,
} from "./subject/protocol.ts";

const BATCH = 3;
const logOf = (commits: number, extra = 0) => [...Array.from({ length: commits }, (_, at) => eventsOf(at + 1, BATCH)).flat(), ...eventsOf(commits + 1, BATCH).slice(0, extra)];
const whole = (commits: number): Extract<Kept, { opened: true }> => ({ file: true, bytes: 4_096, opened: true, integrity: ["ok"], events: commits * BATCH, commits, problems: [] });

describe("the settings of the writer", () => {
  it("go through the environment and come back the same", () => {
    const settings = { ...DEFAULTS, synchronous: "NORMAL" as const, checkpointEvery: 4, pauseMs: 20 };
    expect(settingsOf(envOf(settings))).toEqual(settings);
    expect(settingsOf({})).toEqual(DEFAULTS);
  });

  it("refuse a value that is not correct", () => {
    expect(() => settingsOf({ POWER_SYNCHRONOUS: "SOME" })).toThrow(RangeError);
    expect(() => settingsOf({ POWER_JOURNAL: "memory" })).toThrow(RangeError);
    expect(() => settingsOf({ POWER_TRANSACTIONS: "0" })).toThrow(RangeError);
    expect(() => settingsOf({ POWER_BATCH: "2.5" })).toThrow(RangeError);
    expect(() => settingsOf({ POWER_JOURNAL: "delete", POWER_CHECKPOINT_EVERY: "2" })).toThrow("A checkpoint needs the journal wal.");
  });
});

describe("the events and the labels", () => {
  it("parse each event of a transaction, and refuse a different value", () => {
    for (const event of eventsOf(7, BATCH)) expect(parseEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(() => parseEvent({ ...eventsOf(1, 1)[0], id: "c2e1" })).toThrow(TypeError);
    expect(() => parseEvent({ ...eventsOf(1, 1)[0], index: 0 })).toThrow(TypeError);
    expect(() => parseEvent(null)).toThrow(TypeError);
  });

  it("read the label of a stop point back, and give 0 commits for no point", () => {
    expect(progressOf(labelOf({ commits: 10, checkpointed: 8 }))).toEqual({ commits: 10, checkpointed: 8 });
    expect(progressOf(null)).toEqual({ commits: 0, checkpointed: 0 });
    expect(() => progressOf("write 3")).toThrow(RangeError);
  });
});

describe("the commits of a log", () => {
  it("count each whole transaction from the commit 1", () => {
    expect(commitsOf(logOf(0), BATCH)).toEqual({ commits: 0, problems: [] });
    expect(commitsOf(logOf(5), BATCH)).toEqual({ commits: 5, problems: [] });
  });

  it("name a part of a transaction, a gap and an event out of its sequence", () => {
    expect(commitsOf(logOf(2, 1), BATCH)).toEqual({ commits: 2, problems: ["The log keeps 1 events of the transaction 3, not all 3."] });
    const gap = [...eventsOf(1, BATCH), ...eventsOf(3, BATCH)];
    expect(commitsOf(gap, BATCH)).toEqual({ commits: 1, problems: ["The event 4 is c3e1, not c2e1."] });
    const swapped = [eventsOf(1, BATCH)[1], eventsOf(1, BATCH)[0], eventsOf(1, BATCH)[2]].map((event) => event!);
    expect(commitsOf(swapped, BATCH).problems).toEqual(["The event 1 is c1e2, not c1e1."]);
  });
});

describe("the claims of a power cut", () => {
  const progress = { commits: 10, checkpointed: 8 };

  it("give the bounds of each claim, and one more commit for a cut at a time", () => {
    expect(boundsOf("durable", progress, false)).toEqual({ least: 10, most: 10 });
    expect(boundsOf("durable", progress, true)).toEqual({ least: 10, most: 11 });
    expect(boundsOf("checkpointed", progress, false)).toEqual({ least: 8, most: 10 });
    expect(boundsOf("none", progress, true)).toBeUndefined();
  });

  it("hold for a whole file in the bounds", () => {
    expect(claimProblems(whole(10), "durable", progress, false)).toEqual([]);
    expect(claimProblems(whole(11), "durable", progress, true)).toEqual([]);
    expect(claimProblems(whole(8), "checkpointed", progress, false)).toEqual([]);
    expect(claimProblems({ file: false }, "checkpointed", { commits: 3, checkpointed: 0 }, false)).toEqual([]);
  });

  it("name each break: a lost commit, a broken file, a part of a transaction and a file that does not open", () => {
    expect(claimProblems(whole(9), "durable", progress, false)).toEqual(["The disk kept 9 commits, not 10."]);
    expect(claimProblems(whole(7), "checkpointed", progress, false)).toEqual(["The disk kept 7 commits, not 8 to 10."]);
    expect(claimProblems({ ...whole(10), integrity: ["row 3 missing from index"] }, "durable", progress, false)).toEqual([
      'The integrity check gave ["row 3 missing from index"], not ["ok"].',
    ]);
    expect(claimProblems({ ...whole(10), problems: ["The log keeps 1 events of the transaction 11, not all 3."] }, "durable", progress, true)).toEqual([
      "The log keeps 1 events of the transaction 11, not all 3.",
    ]);
    const broken: Kept = { file: true, bytes: 8_192, opened: false, fault: "corrupt", error: "database disk image is malformed" };
    expect(claimProblems(broken, "durable", progress, false)).toEqual(["The file did not open: the fault corrupt, database disk image is malformed"]);
    expect(claimProblems({ file: false }, "durable", progress, false)).toEqual(["The disk kept no file, not 10 commits."]);
  });

  it("make no claim under the claim none", () => {
    expect(claimProblems({ file: true, bytes: 0, opened: false, fault: "corrupt", error: "malformed" }, "none", progress, false)).toEqual([]);
  });
});
