/**
 * The candidate budgets of each rung of the scale bench (roadmap SQ-26): `node scale/limits.ts <folder> <out.json>`.
 *
 * The script reads the record of each rung and job in the folder. For each rung and measure with 5 jobs or more, it gives
 * the two values of a median budget of `@mark1russell7/rigor-bench`, from the values that `budgetVerdict` reads:
 * - `limit` is the worst high end of the interval of the median of the first arm, plus the spread of the jobs (`runLimit`).
 * - `maxDifference` is the worst difference of the medians of the two arms, plus the spread of the jobs.
 *
 * These budgets are a report, not a gate. The CPU models of the runners differ, and a time on one model can be 4 times
 * the time on a different model. The gate of the bench is the growth on one runner (`growth.ts`). The script writes the
 * candidates to `<out.json>` and a table to stdout.
 */
import { writeFileSync } from "node:fs";
import { runLimit } from "@mark1russell7/rigor-bench";
import { median, medianInterval } from "@mark1russell7/rigor-statistics";
import { type Measure, MEASURES, type MeasureValues, readRecords, RUNG_EVENTS } from "./shared.ts";

/** The fewest jobs that give a limit, by the rule of the gate limits. */
const MIN_JOBS = 5;

/** The level of the interval of the median, as in `budgetVerdict`. */
const LEVEL = 0.95;

/** The candidate budget of one measure at one rung. */
interface Candidate {
  readonly events: number;
  readonly measure: Measure;
  /** The median of the values of both arms, for each job. */
  readonly medians: readonly number[];
  /** The high end of the interval of the median of the first arm, for each job. `budgetVerdict` compares it to the limit. */
  readonly highs: readonly number[];
  /** The size of the difference of the medians of the two arms, for each job. `budgetVerdict` compares it to `maxDifference`. */
  readonly differences: readonly number[];
  /** The limit, or `undefined` with fewer than `MIN_JOBS` jobs. */
  readonly limit: number | undefined;
  /** The largest A/A difference, or `undefined` with fewer than `MIN_JOBS` jobs. */
  readonly maxDifference: number | undefined;
}

const [folder, out] = process.argv.slice(2);
if (folder === undefined || out === undefined) throw new RangeError("The script needs <folder> and <out.json>.");

const records = readRecords(folder);

/** This function gives the values of one measure at one rung, one for each job. */
function valuesOf(events: number, measure: Measure): MeasureValues[] {
  return records.filter((record) => record.events === events).flatMap((record) => record.measures.filter((each) => each.measure === measure));
}

const candidates: Candidate[] = [];
for (const events of RUNG_EVENTS) {
  for (const measure of MEASURES) {
    const jobs = valuesOf(events, measure);
    if (jobs.length === 0) continue;
    const highs = jobs.map((each) => medianInterval(each.rounds.map((round) => round.a), LEVEL).high);
    const differences = jobs.map((each) => Math.abs(median(each.rounds.map((round) => round.a)) - median(each.rounds.map((round) => round.b))));
    const enough = jobs.length >= MIN_JOBS;
    candidates.push({
      events,
      measure,
      medians: jobs.map((each) => each.median),
      highs,
      differences,
      limit: enough ? runLimit(highs).limit : undefined,
      maxDifference: enough ? runLimit(differences).limit : undefined,
    });
  }
}

const builds = RUNG_EVENTS.flatMap((events) => {
  const rungRecords = records.filter((record) => record.events === events);
  if (rungRecords.length === 0) return [];
  return [{ events, jobs: rungRecords.length, rate: median(rungRecords.map((record) => record.built.rate)), bytes: median(rungRecords.map((record) => record.built.bytes)) }];
});

writeFileSync(
  out,
  `${JSON.stringify(
    {
      format: "sqlite-scale-limits/2",
      rule: `For ${MIN_JOBS} or more jobs: the limit is the worst high end of the interval of the median plus the spread (runLimit), and maxDifference is the worst A/A difference plus the spread.`,
      commits: [...new Set(records.map((record) => record.commit))],
      nodes: [...new Set(records.map((record) => record.node))],
      sqlite: [...new Set(records.map((record) => record.sqlite))],
      cpus: [...new Set(records.map((record) => record.cpu))],
      builds,
      candidates,
    },
    null,
    2,
  )}\n`,
);

const ms = (value: number | undefined): string => (value === undefined ? "" : value.toFixed(3));
const lines = [
  "## The scale bench: candidate budgets of each rung (a report)",
  "",
  `${records.length} records. A budget needs ${MIN_JOBS} jobs or more. CPU models: ${[...new Set(records.map((record) => record.cpu))].join(", ")}.`,
  "",
  "| Events | Jobs | Build (events each second) | File (MiB) |",
  "| ---: | ---: | ---: | ---: |",
  ...builds.map((build) => `| ${build.events.toLocaleString("en-US")} | ${build.jobs} | ${Math.round(build.rate).toLocaleString("en-US")} | ${(build.bytes / 2 ** 20).toFixed(1)} |`),
  "",
  "| Events | Measure | Jobs | Median of the jobs (ms) | Worst high end (ms) | Candidate limit (ms) | Candidate maxDifference (ms) |",
  "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
  ...candidates.map((each) => {
    const missing = `no budget: ${each.medians.length} of ${MIN_JOBS} jobs`;
    return `| ${each.events.toLocaleString("en-US")} | ${each.measure} | ${each.medians.length} | ${ms(median(each.medians))} | ${ms(Math.max(...each.highs))} | ${each.limit === undefined ? missing : ms(each.limit)} | ${ms(each.maxDifference)} |`;
  }),
  "",
];
process.stdout.write(`${lines.join("\n")}\n`);
