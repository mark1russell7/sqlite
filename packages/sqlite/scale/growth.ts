/**
 * The growth gate of the scale bench (roadmap SQ-26): `node scale/growth.ts <folder> <out.json> [--lock]`.
 *
 * Each job of `scale.yml` measures each rung on one runner. Thus a growth from one rung to the next comes from the values
 * of one computer, and the speed of the computer cancels. For each measure, `growthVerdict` of `@mark1russell7/rigor-bench`
 * gives the median growth over the runners at each step of 10 times the events, with its distribution-free interval. The
 * value of a runner at a rung is the median of the rounds of its two arms. The claim of a measure is its class in
 * `MEASURE_GROWTH`.
 *
 * - A step is `within` when the high end of its interval is under the claim, and `beyond` when the low end is above it.
 * - A step with too few runners for the level is `cannot decide`, unless it is `beyond`. Six runners give the coverage 0.969.
 * - With `--lock`, the script ends with the code 1 when a measure is not `within`. A `cannot decide` is no read, not a pass.
 * - Without `--lock`, the script only reports.
 *
 * The script writes the verdicts to `<out.json>` and a table to stdout.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type GrowthRound, type GrowthStep, growthVerdict } from "@mark1russell7/rigor-bench";
import { GROWTH_CLASSES, type GrowthClass, type Measure, MEASURE_GROWTH, MEASURES, readRecords, type ScaleRecord } from "./shared.ts";

/** The level of the interval of each step. */
const LEVEL = 0.95;

/** The outcome of a step or of a measure. */
type Outcome = "within" | "beyond" | "cannot decide";

/** The verdict of one step, with the count of its runners and the outcome of the gate. */
interface StepResult extends GrowthStep {
  readonly runners: number;
  /** The outcome of the gate: the outcome of `growthVerdict`, and `cannot decide` for a `within` with too few runners. */
  readonly result: Outcome;
}

/** The growth verdict of one measure. */
interface MeasureGrowth {
  readonly measure: Measure;
  readonly class: GrowthClass;
  readonly maxGrowth: number;
  readonly outcome: Outcome;
  /** The reason of the outcome, in one sentence, with the numbers. */
  readonly reason: string;
  readonly steps: readonly StepResult[];
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { lock: { type: "boolean", default: false } } });
const [folder, out] = positionals;
if (folder === undefined || out === undefined) throw new RangeError("The script needs <folder> and <out.json>.");
const lock = values.lock;

const records = readRecords(folder);

/** This function gives each runner with its CPU model and its rungs. A runner with two CPU models is not one computer. */
function runnersOf(all: readonly ScaleRecord[]): { readonly runner: string; readonly cpu: string; readonly rungs: readonly number[] }[] {
  const names = [...new Set(all.map((record) => record.runner))].sort();
  return names.map((runner) => {
    const own = all.filter((record) => record.runner === runner);
    const cpus = [...new Set(own.map((record) => record.cpu))];
    if (cpus.length !== 1) throw new Error(`The records of the runner ${runner} name ${cpus.length} CPU models: ${cpus.join(", ")}.`);
    return { runner, cpu: cpus[0] as string, rungs: own.map((record) => record.events).sort((a, b) => a - b) };
  });
}

const times = (value: number): string => `${value.toFixed(2)} times`;
const step = (each: GrowthStep): string => `${each.from.toLocaleString("en-US")} to ${each.to.toLocaleString("en-US")}`;

/** This function gives the reason of the outcome of a measure. */
function reasonOf(outcome: Outcome, steps: readonly StepResult[], maxGrowth: number): string {
  const claim = `the claim of ${times(maxGrowth)}`;
  if (outcome === "within") {
    const top = steps.reduce((a, b) => (b.high > a.high ? b : a));
    return `Each step is under ${claim}. The highest end is ${times(top.high)}, at the step ${step(top)}.`;
  }
  const beyond = steps.find((each) => each.result === "beyond");
  if (beyond !== undefined) return `The step ${step(beyond)} grows ${times(beyond.low)} to ${times(beyond.high)}, above ${claim}.`;
  const open = steps.find((each) => each.result === "cannot decide") as StepResult;
  if (open.outcome === "within") return `The step ${step(open)} has ${open.runners} runners, and the coverage ${open.coverage.toFixed(3)} is under ${LEVEL}.`;
  return `The interval of the step ${step(open)} is ${times(open.low)} to ${times(open.high)}, across ${claim}.`;
}

/** This function gives the growth verdict of one measure from the records. */
function growthOf(measure: Measure): MeasureGrowth {
  const klass = MEASURE_GROWTH[measure];
  const { maxGrowth } = GROWTH_CLASSES[klass];
  const rounds: GrowthRound[] = records.flatMap((record) =>
    record.measures
      .filter((each) => each.measure === measure)
      .flatMap((each) => each.rounds.flatMap((round) => [round.a, round.b]).map((value) => ({ job: record.runner, size: record.events, value }))),
  );
  const noRead = (reason: string): MeasureGrowth => ({ measure, class: klass, maxGrowth, outcome: "cannot decide", reason, steps: [] });
  const sizes = new Set(rounds.map((round) => round.size)).size;
  if (sizes < 2) return noRead(`The records give ${sizes} rungs of the measure. A growth needs 2 rungs or more.`);
  let steps: StepResult[];
  try {
    steps = growthVerdict(rounds, { maxGrowth, level: LEVEL }).steps.map((each): StepResult => ({
      ...each,
      runners: each.growths.length,
      result: each.outcome === "within" && each.coverage < LEVEL ? "cannot decide" : each.outcome,
    }));
  } catch (error) {
    // A value of 0 or a step that no runner gives both rungs of has no growth. That is no read, not a pass.
    if (error instanceof RangeError) return noRead(error.message);
    throw error;
  }
  const outcome: Outcome = steps.some((each) => each.result === "beyond") ? "beyond" : steps.every((each) => each.result === "within") ? "within" : "cannot decide";
  return { measure, class: klass, maxGrowth, outcome, reason: reasonOf(outcome, steps, maxGrowth), steps };
}

const runners = runnersOf(records);
const measures = MEASURES.map(growthOf);
const failed = measures.filter((each) => each.outcome !== "within");

writeFileSync(
  out,
  `${JSON.stringify(
    {
      format: "sqlite-scale-growth/1",
      level: LEVEL,
      lock,
      classes: GROWTH_CLASSES,
      commits: [...new Set(records.map((record) => record.commit))],
      runners,
      measures,
    },
    null,
    2,
  )}\n`,
);

const lines = [
  "## The scale bench: the growth of each measure on one runner",
  "",
  `${records.length} records of ${runners.length} runners. ${lock ? "The gate is locked: each measure must be within." : "The gate only reports."}`,
  "",
  "| Runner | CPU model | Rungs |",
  "| --- | --- | --- |",
  ...runners.map((each) => `| ${each.runner} | ${each.cpu} | ${each.rungs.map((events) => events.toLocaleString("en-US")).join(", ")} |`),
  "",
  "| Measure | Claim | Step (events) | Runners | Median growth | Interval | Exponent | Verdict |",
  "| --- | --- | --- | ---: | ---: | --- | ---: | --- |",
  ...measures.flatMap((each) =>
    each.steps.length === 0
      ? [`| ${each.measure} | ${GROWTH_CLASSES[each.class].describe} | | | | | | ${each.outcome}: ${each.reason} |`]
      : each.steps.map(
          (one) =>
            `| ${each.measure} | ${GROWTH_CLASSES[each.class].describe} | ${step(one)} | ${one.runners} | ${times(one.median)} | ${one.low.toFixed(2)} to ${one.high.toFixed(2)} | ${one.exponent.toFixed(2)} | ${one.result} |`,
        ),
  ),
  "",
  ...measures.map((each) => `- **${each.measure}** (${each.outcome}): ${each.reason}`),
  "",
];
process.stdout.write(`${lines.join("\n")}\n`);
if (lock && failed.length > 0) {
  process.stderr.write(`The growth gate fails: ${failed.map((each) => `${each.measure} is ${each.outcome}`).join(", ")}.\n`);
  process.exitCode = 1;
}
