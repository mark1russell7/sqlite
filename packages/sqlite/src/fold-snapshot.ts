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
 * The version of the tables of a snapshot. A different version of the file opens with no snapshot. The write in chunks
 * keeps version 1, the version of 0.4: it puts its rows in a third table. Thus 0.4 and this version read the snapshot of
 * each other. A file of 0.5.0 has version 2, and it opens with no snapshot.
 */
export const FOLD_SNAPSHOT_SCHEMA_VERSION = 1;

/** The name of the part of a snapshot in the table `schema_versions`. */
export const FOLD_SNAPSHOT_PART = "fold-snapshot";

const META = "fold_snapshot";
const ROWS = "fold_snapshot_rows";
const NEXT = "fold_snapshot_next";
// The name of the rows table for one moment in the swap of the two tables of rows.
const SWAP = "fold_snapshot_swap";

// The tables of version 1. The table of the rows has only the rows of the snapshot, in the order of the write.
const SCHEMA = `
CREATE TABLE ${META} (
  one INTEGER PRIMARY KEY CHECK (one = 1),
  version INTEGER NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE ${ROWS} (
  n INTEGER PRIMARY KEY,
  part TEXT NOT NULL,
  value TEXT NOT NULL
);
`;

// The table of a write in chunks: the new rows before the swap, and the old rows after it. A file of 0.4 does not have
// it, thus the open makes it. The reads of 0.4 do not read it.
const NEXT_SCHEMA = `CREATE TABLE IF NOT EXISTS ${NEXT} (n INTEGER PRIMARY KEY, part TEXT NOT NULL, value TEXT NOT NULL)`;

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
   * The function writes the new rows in chunks to a second table of rows. One short transaction then swaps the two tables
   * and changes the meta row. At last, the function removes the old rows in chunks. A read before the swap gives the old
   * snapshot, and a read after it gives the new snapshot. The table of the snapshot has only the rows of the snapshot.
   *
   * The function reads `rows` over all the pauses. Thus the rows must come from a value that does not change in the
   * write. When `rows` throws or a transaction fails, the old snapshot stays, and the promise rejects with that error. The
   * next write removes the rows of the stopped write. A `clear` before the swap stops the write, and the promise rejects.
   * A second write in the write is an error.
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
  ensureProjection(db, SCHEMA, { version: FOLD_SNAPSHOT_SCHEMA_VERSION, part: FOLD_SNAPSHOT_PART, tables: [META, ROWS, NEXT] });
  db.exec(NEXT_SCHEMA);
  const meta = db.prepare(`SELECT version, key, seq, id, count FROM ${META} WHERE one = 1`);
  const rows = db.prepare(`SELECT part, value FROM ${ROWS} ORDER BY n`);
  const insertRow = db.prepare(`INSERT INTO ${ROWS} (n, part, value) VALUES (?, ?, ?)`);
  const insertNext = db.prepare(`INSERT INTO ${NEXT} (n, part, value) VALUES (?, ?, ?)`);
  const insertMeta = db.prepare(`INSERT INTO ${META} (one, version, key, seq, id, count) VALUES (1, ?, ?, ?, ?, ?)`);
  const removeNext = db.prepare(`DELETE FROM ${NEXT} WHERE n IN (SELECT n FROM ${NEXT} ORDER BY n LIMIT ?)`);
  const remove = (): void => {
    db.exec(`DELETE FROM ${ROWS}`);
    db.exec(`DELETE FROM ${NEXT}`);
    db.exec(`DELETE FROM ${META}`);
  };
  const metaRow = (): MetaRow | undefined => {
    const row = meta.get() as Record<keyof MetaRow, number | string> | undefined;
    if (row === undefined) return undefined;
    return { version: Number(row.version), key: String(row.key), seq: Number(row.seq), id: String(row.id), count: Number(row.count) };
  };
  // The write in chunks in progress: a clear sets `cleared`, and the write stops at its next transaction.
  let writing: { cleared: boolean } | undefined;

  // This function empties the table of the next rows, at most `size` rows in each transaction, with a pause after each.
  const emptyNext = async (size: number, pause: () => Promise<void>, check: () => void): Promise<void> => {
    for (;;) {
      check();
      const removed = transaction(db, () => Number(removeNext.run(size).changes));
      if (removed === 0) return;
      await pause();
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
            for (const one of rows.iterate() as Iterable<{ part: string; value: string }>) {
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
        insertMeta.run(key.version, key.key, mark.seq, mark.id, count);
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
        // The rows of a stopped write go first. Thus the new rows have the positions 1 to `count`.
        await emptyNext(size, pause, check);
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
              count += 1;
              insertNext.run(count, step.value.part, step.value.value);
              used += step.value.part.length + step.value.value.length;
            }
          });
          await pause();
        }
        check();
        // A rename changes only the schema, thus the swap is short for each size of the snapshot.
        transaction(db, () => {
          db.exec(`ALTER TABLE ${ROWS} RENAME TO ${SWAP}`);
          db.exec(`ALTER TABLE ${NEXT} RENAME TO ${ROWS}`);
          db.exec(`ALTER TABLE ${SWAP} RENAME TO ${NEXT}`);
          db.exec(`DELETE FROM ${META}`);
          insertMeta.run(key.version, key.key, mark.seq, mark.id, count);
        });
        // The new snapshot is in place. A clear from here on removes it, and the end of the write has nothing to stop.
        await emptyNext(size, pause, () => undefined);
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
