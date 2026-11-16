/**
 * The check of the power-cut test (`power.test.ts`). It operates in the folder below the mount of LazyFS, after the
 * cut. It opens the log as the next start of an app opens it, and writes one JSON value of the type `Kept`: what the
 * disk kept.
 *
 * The first open recovers the write-ahead log. Then `PRAGMA integrity_check` examines the file, and the log reads each
 * event. An error of SQLite is a fact of the file, thus the value keeps its fault kind. A different error ends the
 * check with a code that is not 0, and then the disk tier gives no record.
 */
import { statSync } from "node:fs";
import { openDatabase, openEventLog, sqliteFault } from "../../src/index.ts";
import { LOG_FILE, type Kept, commitsOf, parseEvent, settingsOf } from "./protocol.ts";

const settings = settingsOf(process.env);

function keptOf(): Kept {
  const stat = statSync(LOG_FILE, { throwIfNoEntry: false });
  if (stat === undefined) return { file: false };
  const bytes = stat.size;
  try {
    // With wal: false, the open keeps the journal mode of the file: a file in WAL mode opens with its WAL
    const db = openDatabase(LOG_FILE, { wal: false });
    let integrity: string[];
    try {
      integrity = (db.prepare("PRAGMA integrity_check").all() as Record<string, unknown>[]).map((row) => String(Object.values(row)[0]));
    } finally {
      db.close();
    }
    const log = openEventLog(LOG_FILE, parseEvent, { wal: false });
    try {
      const events = [...log.read()];
      return { file: true, bytes, opened: true, integrity, events: events.length, ...commitsOf(events, settings.batch) };
    } finally {
      log.close();
    }
  } catch (error) {
    const fault = sqliteFault(error);
    if (fault === undefined) throw error;
    return { file: true, bytes, opened: false, fault: fault.kind, error: fault.message };
  }
}

process.stdout.write(`${JSON.stringify(keptOf())}\n`);
