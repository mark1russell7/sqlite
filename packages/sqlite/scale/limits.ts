/**
 * The candidate limits of the scale bench (roadmap SQ-26): `node scale/limits.ts <folder> <out.json>`.
 *
 * The script reads the record of each rung and job in the folder. For each rung and measure with 5 jobs or more, the limit
 * is the worst median of the jobs plus their spread (`runLimit` of `@mark1russell7/rigor-bench`). A limit is only a
 * candidate: a pull request writes it into the ladder. The script writes the limits to `<out.json>` and a table to stdout.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLimit } from "@mark1russell7/rigor-bench";
import { median } from "@mark1russell7/rigor-statistics";
import { type Measure, MEASURES, RUNG_EVENTS, SCALE_FORMAT, type ScaleRecord } from "./shared.ts";

/** The fewest jobs that give a limit, by the rule of the gate limits. */
const MIN_JOBS = 5;

/** The candidate limit of one measure at one rung. */
interface Candidate {
  readonly events: number;
  readonly measure: Measure;
  /** The median of each job. */
  readonly medians: readonly number[];
  /** The limit, or `undefined` with fewer than `MIN_JOBS` jobs. */
  readonly limit: number | undefined;
  readonly worst: number | undefined;
  readonly spread: number | undefined;
  /** The median of the jobs at this rung over the median of the jobs at the rung with 10 times fewer events. */
  readonly growth: number | undefined;
}

const [folder, out] = process.argv.slice(2);
if (folder === undefined || out === undefined) throw new RangeError("The script needs <folder> and <out.json>.");

const records: ScaleRecord[] = [];
for (const file of readdirSync(folder, { recursive: true, encoding: "utf8" })) {
  if (!file.endsWith(".json")) continue;
  const value = JSON.parse(readFileSync(join(folder, file), "utf8")) as Partial<ScaleRecord>;
  if (value.format === SCALE_FORMAT) records.push(value as ScaleRecord);
}

/** This function gives the median of each job for one measure at one rung. */
function mediansOf(events: number, measure: Measure): number[] {
  return records.filter((record) => record.events === events).flatMap((record) => record.measures.filter((each) => each.measure === measure).map((each) => each.median));
}

const candidates: Candidate[] = [];
for (const events of RUNG_EVENTS) {
  for (const measure of MEASURES) {
    const medians = mediansOf(events, measure);
    if (medians.length === 0) continue;
    const limit = medians.length >= MIN_JOBS ? runLimit(medians) : undefined;
    const lower = mediansOf(events / 10, measure);
    const growth = lower.length > 0 && median(lower) > 0 ? median(medians) / median(lower) : undefined;
    candidates.push({ events, measure, medians, limit: limit?.limit, worst: limit?.worst, spread: limit?.spread, growth });
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
      format: "sqlite-scale-limits/1",
      rule: `The limit is the worst median of ${MIN_JOBS} or more jobs plus their spread (runLimit).`,
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
  "## The scale bench: candidate limits",
  "",
  `${records.length} records. A limit needs ${MIN_JOBS} jobs or more. CPU models: ${[...new Set(records.map((record) => record.cpu))].join(", ")}.`,
  "",
  "| Events | Jobs | Build (events each second) | File (MiB) |",
  "| ---: | ---: | ---: | ---: |",
  ...builds.map((build) => `| ${build.events.toLocaleString("en-US")} | ${build.jobs} | ${Math.round(build.rate).toLocaleString("en-US")} | ${(build.bytes / 2 ** 20).toFixed(1)} |`),
  "",
  "| Events | Measure | Jobs | Median of the jobs (ms) | Worst (ms) | Spread (ms) | Candidate limit (ms) | Growth for 10 times the events |",
  "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...candidates.map(
    (each) =>
      `| ${each.events.toLocaleString("en-US")} | ${each.measure} | ${each.medians.length} | ${ms(median(each.medians))} | ${ms(each.worst)} | ${ms(each.spread)} | ${each.limit === undefined ? `no limit: ${each.medians.length} of ${MIN_JOBS} jobs` : ms(each.limit)} | ${each.growth === undefined ? "" : `${each.growth.toFixed(2)} times`} |`,
  ),
  "",
];
process.stdout.write(`${lines.join("\n")}\n`);
