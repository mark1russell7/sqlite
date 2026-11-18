/**
 * The writer of the power-cut test (`power.test.ts`). It operates in the mount of LazyFS, in a container of the disk
 * tier of `@mark1russell7/harness`. The container has Node.js 24 and no packages. Thus the test copies the source of
 * the package and this folder into the folder of the subject. The entry `@mark1russell7/rigor-testkit/stop-point`
 * imports only modules of Node.js, thus the test copies that one file into a `node_modules` folder of the subject.
 *
 * The writer opens the log `log.db` with the settings of its environment (`protocol.ts`). Each transaction appends one
 * batch of events with one `appendAll`. After each commit, the writer gets to a stop point. Its label tells the count
 * of commits, and the count of commits that a complete checkpoint holds.
 *
 * A checkpoint operates on a second connection with the same `synchronous` setting, because that setting decides its
 * fsync. The writer closes each connection at its end, and the close of the last connection makes a checkpoint too.
 *
 * With `syncEvery`, the writer opens the log as `openEventLog` opens it, with one change: an append in a transaction is a
 * savepoint of that transaction. Then a synced transaction holds the append of each multiple of `syncEvery`.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { stopPoint } from "@mark1russell7/rigor-testkit/stop-point";
import { attach, DEFAULT_TABLE, logSteps } from "../../src/event-log.ts";
import { checkpoint, migrate, openDatabase, openEventLog, syncedTransaction } from "../../src/index.ts";
import { LOG_FILE, type PowerEvent, eventsOf, labelOf, parseEvent, settingsOf } from "./protocol.ts";

const settings = settingsOf(process.env);
const wal = settings.journal === "wal";
const options = { synchronous: settings.synchronous, wal };
const main = settings.syncEvery > 0 ? openDatabase(LOG_FILE, options) : undefined;
if (main !== undefined) migrate(main, logSteps(DEFAULT_TABLE), { name: "log" });
const log =
  main === undefined
    ? openEventLog(LOG_FILE, parseEvent, options)
    : { ...attach<PowerEvent>(main, DEFAULT_TABLE, parseEvent, undefined, "savepoint"), close: () => main.close() };
const side = settings.checkpointEvery > 0 ? openDatabase(LOG_FILE, { synchronous: settings.synchronous, wal }) : undefined;

let checkpointed = 0;
let synced = 0;
for (let commits = 1; commits <= settings.transactions; commits++) {
  const append = (): void => {
    log.appendAll(eventsOf(commits, settings.batch));
  };
  if (main !== undefined && commits % settings.syncEvery === 0) {
    syncedTransaction(main, append);
    synced = commits;
  } else append();
  if (side !== undefined && commits % settings.checkpointEvery === 0) {
    const result = checkpoint(side, "PASSIVE");
    if (!result.busy && result.log >= 0 && result.checkpointed === result.log) checkpointed = commits;
  }
  stopPoint(labelOf({ commits, checkpointed, synced }));
  if (settings.pauseMs > 0) await sleep(settings.pauseMs);
}
side?.close();
log.close();
