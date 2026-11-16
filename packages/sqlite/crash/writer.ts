// This program is the writer of the crash suite. The tests of crash.test.ts start it in a child process, and a stop plan
// of @mark1russell7/rigor-chaos stops it at a stop point or at a time.
//
//   node crash/writer.ts <scenario> <the arguments as JSON>
//
// Each scenario continues the work that an earlier run did before its stop. Thus a rerun with no stop completes the work.
// The writer writes a mark at the start and at the end of a phase that a stop at a time aims at. A mark is one JSON line
// on the standard output, with the time from the start of the process.
import type { DatabaseSync } from "node:sqlite";
import { stopPoint } from "@mark1russell7/rigor-testkit/stop";
import { type Migration, checkpoint, migrate, openDatabase, openEventLog, salvageEventLog, transaction } from "../src/index.ts";
import { type Scenario, type ScenarioArgs, SCENARIOS, parseCrashEvent, writeLine } from "./shared.ts";

function mark(name: string): void {
  writeLine({ mark: name, ms: performance.now() });
}

/** This function gives the count of the transactions in a table with the column `tx`. */
function transactionCount(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(DISTINCT tx) AS n FROM ${table}`).get() as { n: number }).n;
}

function transactions({ path, transactions: count, writes }: ScenarioArgs["transaction"]): void {
  const db = openDatabase(path);
  try {
    migrate(db, ["CREATE TABLE rows (tx INTEGER NOT NULL, i INTEGER NOT NULL, PRIMARY KEY (tx, i)) STRICT"]);
    const insert = db.prepare("INSERT INTO rows (tx, i) VALUES (?, ?)");
    mark("transactions begin");
    for (let k = transactionCount(db, "rows"); k < count; k += 1) {
      transaction(db, () => {
        stopPoint(`begin ${k}`);
        for (let i = 0; i < writes; i += 1) {
          insert.run(k, i);
          stopPoint(`write ${k} ${i}`);
        }
      });
      stopPoint(`commit ${k}`);
    }
    mark("transactions end");
  } finally {
    db.close();
  }
}

function migration({ path, steps, rows }: ScenarioArgs["migration"]): void {
  const db = openDatabase(path);
  try {
    const migrations: Migration[] = Array.from({ length: steps }, (_, k) => (step: DatabaseSync) => {
      stopPoint(`step ${k} begin`);
      step.exec(`CREATE TABLE m${k} (i INTEGER PRIMARY KEY) STRICT`);
      const insert = step.prepare(`INSERT INTO m${k} (i) VALUES (?)`);
      for (let i = 0; i < rows; i += 1) {
        insert.run(i);
        stopPoint(`step ${k} row ${i}`);
      }
    });
    migrate(db, migrations);
    stopPoint("migrated");
  } finally {
    db.close();
  }
}

function checkpointed({ path, transactions: count, rows, bytes }: ScenarioArgs["checkpoint"]): void {
  const db = openDatabase(path);
  try {
    // Without the automatic checkpoints, the log keeps each commit until the TRUNCATE checkpoint
    db.exec("PRAGMA wal_autocheckpoint = 0");
    migrate(db, ["CREATE TABLE blobs (tx INTEGER NOT NULL, i INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY (tx, i)) STRICT"]);
    const insert = db.prepare("INSERT INTO blobs (tx, i, body) VALUES (?, ?, ?)");
    const body = new Uint8Array(bytes);
    for (let k = transactionCount(db, "blobs"); k < count; k += 1) {
      // Each byte of each blob of a transaction is the number of the transaction modulo 251
      body.fill(k % 251);
      transaction(db, () => {
        for (let i = 0; i < rows; i += 1) insert.run(k, i, body);
      });
      stopPoint(`commit ${k}`);
    }
    mark("checkpoint begin");
    stopPoint("checkpoint begin");
    const result = checkpoint(db, "TRUNCATE");
    stopPoint("checkpoint end");
    mark("checkpoint end");
    if (result.busy) throw new Error("The checkpoint was busy, but the writer has the only connection.");
  } finally {
    db.close();
  }
}

function salvage({ source, target }: ScenarioArgs["salvage"]): void {
  const log = openEventLog(target, parseCrashEvent);
  try {
    mark("salvage begin");
    stopPoint("salvage begin");
    const salvaged = salvageEventLog(source, log, { parse: parseCrashEvent });
    stopPoint("salvage end");
    mark("salvage end");
    writeLine({ salvaged });
  } finally {
    log.close();
  }
}

const [scenario, text] = process.argv.slice(2);
if (!SCENARIOS.includes(scenario as Scenario) || text === undefined) {
  throw new Error(`Give a scenario (${SCENARIOS.join(", ")}) and its arguments as JSON, not ${String(scenario)} ${String(text)}.`);
}
const args: unknown = JSON.parse(text);
switch (scenario as Scenario) {
  case "transaction":
    transactions(args as ScenarioArgs["transaction"]);
    break;
  case "migration":
    migration(args as ScenarioArgs["migration"]);
    break;
  case "checkpoint":
    checkpointed(args as ScenarioArgs["checkpoint"]);
    break;
  case "salvage":
    salvage(args as ScenarioArgs["salvage"]);
    break;
}
