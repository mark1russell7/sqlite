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
 */
import { setTimeout as sleep } from "node:timers/promises";
import { stopPoint } from "@mark1russell7/rigor-testkit/stop-point";
import { checkpoint, openDatabase, openEventLog } from "../../src/index.ts";
import { LOG_FILE, eventsOf, labelOf, parseEvent, settingsOf } from "./protocol.ts";

const settings = settingsOf(process.env);
const wal = settings.journal === "wal";
const log = openEventLog(LOG_FILE, parseEvent, { synchronous: settings.synchronous, wal });
const side = settings.checkpointEvery > 0 ? openDatabase(LOG_FILE, { synchronous: settings.synchronous, wal }) : undefined;

let checkpointed = 0;
for (let commits = 1; commits <= settings.transactions; commits++) {
  log.appendAll(eventsOf(commits, settings.batch));
  if (side !== undefined && commits % settings.checkpointEvery === 0) {
    const result = checkpoint(side, "PASSIVE");
    if (!result.busy && result.log >= 0 && result.checkpointed === result.log) checkpointed = commits;
  }
  stopPoint(labelOf({ commits, checkpointed }));
  if (settings.pauseMs > 0) await sleep(settings.pauseMs);
}
side?.close();
log.close();
