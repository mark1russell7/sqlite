/**
 * The snapshot of a fold of an event log. An app folds the events of its log into a state at each start. The snapshot
 * keeps that state at one position of the log. Then the next start reads the snapshot, and it folds only the events after
 * that position. A snapshot is a projection: the app can make it again from its log.
 *
 * @packageDocumentation
 */
import type { SqlConnection } from "./connection.ts";
import type { LogEntry } from "./event-log.ts";
import { ensureProjection } from "./projection.ts";
import { readTransaction, transaction } from "./transaction.ts";

/**
 * The version of the tables of a snapshot. A different version of the file opens with no snapshot. Version 2 keeps the
 * position of the first row in the meta row. Thus a write in chunks puts its rows next to the rows of the old snapshot.
 */
export const FOLD_SNAPSHOT_SCHEMA_VERSION = 2;

/** The name of the part of a snapshot in the table `schema_versions`. */
export const FOLD_SNAPSHOT_PART = "fold-snapshot";

const META = "fold_snapshot";
const ROWS = "fold_snapshot_rows";

// The rows of the snapshot are the rows with `n` from `first` to `first + count - 1`. Each other row is an orphan: a row
// of an old snapshot, or of a write that stopped. The next write removes the orphans.
const SCHEMA = `
CREATE TABLE ${META} (
  one INTEGER PRIMARY KEY CHECK (one = 1),
  version INTEGER NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  first INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE ${ROWS} (
  n INTEGER PRIMARY KEY,
  part TEXT NOT NULL,
  value TEXT NOT NULL
);
`;

/** The position of a snapshot in its log: the position of the last event of the fold, and the id of that event. */
export interface FoldMark {
  readonly seq: number;
  readonly id: string;
}

/** The identity of the fold of a snapshot. A read with a different identity gives no snapshot. */
export interface FoldKey {
  /** This value is the version of the fold: a whole number of 1 or more. A change of the fold or of its rows needs a new version. */
  readonly version: number;
  /** This value is a text of the app, for example a hash of the settings of the fold. */
  readonly key: string;
}

/** One row of a snapshot: the name of a part of the state, and its value as text. */
export interface FoldRow {
  readonly part: string;
  readonly value: string;
}

/** The part of a log that the check of a mark reads. The function `get` of `EventLog` has this shape. */
export interface MarkLog {
  get(id: string): Pick<LogEntry<unknown>, "seq"> | undefined;
}

/** The limits of one transaction of `writeInChunks`, and the pause between two transactions. */
export interface ChunkOptions {
  /** This value is the most rows of one transaction: a whole number of 1 or more. The default is 1000. */
  readonly rows?: number;
  /** This value is the most characters of the parts and values of one transaction. The default is 1000000. */
  readonly chars?: number;
  /** The write awaits this function after each transaction. The default waits for one timer of 0 ms. */
  readonly pause?: () => Promise<void>;
}

/** The snapshot of a connection. `foldSnapshot` gives it. */
export interface FoldSnapshot {
  /**
   * This function reads the snapshot, and gives the result of `work`. It gives `undefined` with no call of `work` in these
   * cases:
   * - The file has no snapshot.
   * - The snapshot has a different version or key.
   * - The log has no event with the id of the mark at that position, or that event has a different position.
   *
   * The read is one read transaction. The rows come in the order of the write, and they are valid only in `work`. When
   * `work` reads each row and the count of the rows is not the count of the write, the read throws.
   */
  read<T>(key: FoldKey, log: MarkLog, work: (mark: FoldMark, rows: Iterable<FoldRow>) => T): T | undefined;
  /**
   * This function replaces the snapshot in one transaction, and gives the count of its rows. It reads one row at a time
   * from `rows`. When `rows` throws, the old snapshot stays, and the function throws that error.
   */
  write(key: FoldKey, mark: FoldMark, rows: Iterable<FoldRow>): number;
  /**
   * This function replaces the snapshot in many short transactions, and gives the count of its rows. Between two
   * transactions, it awaits the pause. Thus a large snapshot does not stop the event loop for the time of the whole write.
   *
   * The function first removes the orphans. Then it writes the new rows next to the rows of the old snapshot, in chunks.
   * One short transaction then changes the meta row to the new rows. At last, the function removes the old rows in chunks.
   * A read before the change of the meta row gives the old snapshot, and a read after it gives the new snapshot.
   *
   * The function reads `rows` over all the pauses. Thus the rows must come from a value that does not change in the
   * write. When `rows` throws or a transaction fails, the old snapshot stays, and the promise rejects with that error. A
   * `clear` before the change of the meta row stops the write, and the promise rejects. A second write in the write is an error.
   */
  writeInChunks(key: FoldKey, mark: FoldMark, rows: Iterable<FoldRow>, options?: ChunkOptions): Promise<number>;
  /** This function removes the snapshot. A write in chunks in progress stops. */
  clear(): void;
}

// The meta row of a snapshot.
interface MetaRow {
  readonly version: number;
  readonly key: string;
  readonly seq: number;
  readonly id: string;
  readonly first: number;
  readonly count: number;
}

const DEFAULT_ROWS = 1000;
const DEFAULT_CHARS = 1_000_000;
const pauseOneTimer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * This function gives the snapshot of a connection. It makes the tables of the snapshot when the file does not have them.
 * The tables are the part `fold-snapshot` of the file. Thus a snapshot can have its own file, or it can be in the file of
 * the app.
 *
 * A snapshot is correct only for an append-only log. A rewrite of the log, for example the salvage of a broken file, needs
 * a new key or a `clear`.
 *
 * @param db - The connection.
 */
export function foldSnapshot(db: SqlConnection): FoldSnapshot {
  ensureProjection(db, SCHEMA, { version: FOLD_SNAPSHOT_SCHEMA_VERSION, part: FOLD_SNAPSHOT_PART, tables: [META, ROWS] });
  const meta = db.prepare(`SELECT version, key, seq, id, first, count FROM ${META} WHERE one = 1`);
  const rows = db.prepare(`SELECT part, value FROM ${ROWS} WHERE n >= ? AND n < ? ORDER BY n`);
  const insertRow = db.prepare(`INSERT INTO ${ROWS} (n, part, value) VALUES (?, ?, ?)`);
  const insertMeta = db.prepare(`INSERT INTO ${META} (one, version, key, seq, id, first, count) VALUES (1, ?, ?, ?, ?, ?, ?)`);
  const lowest = db.prepare(`SELECT MIN(n) AS n FROM ${ROWS} WHERE n >= ? AND n < ?`);
  const highest = db.prepare(`SELECT MAX(n) AS n FROM ${ROWS}`);
  const removeRange = db.prepare(`DELETE FROM ${ROWS} WHERE n >= ? AND n < ?`);
  const remove = (): void => {
    db.exec(`DELETE FROM ${ROWS}`);
    db.exec(`DELETE FROM ${META}`);
  };
  const metaRow = (): MetaRow | undefined => {
    const row = meta.get() as Record<keyof MetaRow, number | string> | undefined;
    if (row === undefined) return undefined;
    return { version: Number(row.version), key: String(row.key), seq: Number(row.seq), id: String(row.id), first: Number(row.first), count: Number(row.count) };
  };
  // The write in chunks in progress: a clear sets `cleared`, and the write stops at its next transaction.
  let writing: { cleared: boolean } | undefined;

  // This function removes the rows outside the rows of the meta row, at most `size` rows in each transaction.
  const removeOrphans = async (size: number, pause: () => Promise<void>, check: () => void): Promise<void> => {
    const live = metaRow();
    const keep = live === undefined ? { from: 0, to: 0 } : { from: live.first, to: live.first + live.count };
    for (const [from, to] of [
      [Number.MIN_SAFE_INTEGER, keep.from],
      [keep.to, Number.MAX_SAFE_INTEGER],
    ] as const) {
      for (;;) {
        check();
        const done = transaction(db, () => {
          const low = (lowest.get(from, to) as { n: number | null } | undefined)?.n;
          if (low === null || low === undefined) return true;
          removeRange.run(Number(low), Math.min(Number(low) + size, to));
          return false;
        });
        if (done) break;
        await pause();
      }
    }
  };

  return {
    read(key, log, work) {
      checkKey(key);
      return readTransaction(db, () => {
        const row = metaRow();
        if (row === undefined || row.version !== key.version || row.key !== key.key) return undefined;
        const mark: FoldMark = { seq: row.seq, id: row.id };
        if (log.get(mark.id)?.seq !== mark.seq) return undefined;
        let open = true;
        const iterable: Iterable<FoldRow> = {
          *[Symbol.iterator]() {
            if (!open) throw new Error("The rows of a snapshot are valid only in the work of its read.");
            let read = 0;
            for (const one of rows.iterate(row.first, row.first + row.count) as Iterable<{ part: string; value: string }>) {
              read += 1;
              yield { part: one.part, value: one.value };
            }
            if (read !== row.count) throw new Error(`The snapshot has ${read} rows, but its write had ${row.count} rows.`);
          },
        };
        try {
          return work(mark, iterable);
        } finally {
          open = false;
        }
      });
    },
    write(key, mark, given) {
      checkKey(key);
      checkMark(mark);
      if (writing !== undefined) throw new Error("A write in chunks of the snapshot is in progress.");
      return transaction(db, () => {
        remove();
        let count = 0;
        for (const one of given) {
          count += 1;
          insertRow.run(count, one.part, one.value);
        }
        insertMeta.run(key.version, key.key, mark.seq, mark.id, 1, count);
        return count;
      });
    },
    async writeInChunks(key, mark, given, options = {}) {
      checkKey(key);
      checkMark(mark);
      const size = options.rows ?? DEFAULT_ROWS;
      const chars = options.chars ?? DEFAULT_CHARS;
      const pause = options.pause ?? pauseOneTimer;
      if (!Number.isSafeInteger(size) || size < 1) throw new RangeError(`The rows of a chunk must be a whole number of 1 or more, not ${String(size)}.`);
      if (!(chars >= 1)) throw new RangeError(`The characters of a chunk must be 1 or more, not ${String(chars)}.`);
      if (writing !== undefined) throw new Error("A write in chunks of the snapshot is in progress.");
      const own = { cleared: false };
      writing = own;
      const check = (): void => {
        if (own.cleared) throw new Error("A clear of the snapshot stopped the write.");
      };
      const iterator = given[Symbol.iterator]();
      let finished = false;
      try {
        await removeOrphans(size, pause, check);
        check();
        const first = transaction(db, () => Number((highest.get() as { n: number | null } | undefined)?.n ?? 0) + 1);
        let count = 0;
        while (!finished) {
          check();
          transaction(db, () => {
            let used = 0;
            for (let taken = 0; taken < size && used < chars; taken += 1) {
              const step = iterator.next();
              if (step.done === true) {
                finished = true;
                return;
              }
              insertRow.run(first + count, step.value.part, step.value.value);
              count += 1;
              used += step.value.part.length + step.value.value.length;
            }
          });
          await pause();
        }
        check();
        transaction(db, () => {
          db.exec(`DELETE FROM ${META}`);
          insertMeta.run(key.version, key.key, mark.seq, mark.id, first, count);
        });
        // The new snapshot is in place. A clear from here on removes it, and the end of the write has nothing to stop.
        await removeOrphans(size, pause, () => undefined);
        return count;
      } finally {
        if (!finished) iterator.return?.();
        if (writing === own) writing = undefined;
      }
    },
    clear() {
      transaction(db, remove);
      if (writing !== undefined) writing.cleared = true;
    },
  };
}

// The check of the version of a key.
function checkKey(key: FoldKey): void {
  if (!Number.isSafeInteger(key.version) || key.version < 1) throw new RangeError(`The version of a snapshot must be a whole number of 1 or more, not ${String(key.version)}.`);
}

// The check of the position of a mark.
function checkMark(mark: FoldMark): void {
  if (!Number.isSafeInteger(mark.seq) || mark.seq < 1) throw new RangeError(`The position of a mark must be a whole number of 1 or more, not ${String(mark.seq)}.`);
}
