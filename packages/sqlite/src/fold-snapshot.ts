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

/** The version of the tables of a snapshot. A different version of the file opens with no snapshot. */
export const FOLD_SNAPSHOT_SCHEMA_VERSION = 1;

/** The name of the part of a snapshot in the table `schema_versions`. */
export const FOLD_SNAPSHOT_PART = "fold-snapshot";

const META = "fold_snapshot";
const ROWS = "fold_snapshot_rows";

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

/** The snapshot of a connection. `foldSnapshot` gives it. */
export interface FoldSnapshot {
  /**
   * This function reads the snapshot, and gives the result of `work`. It gives `undefined` with no call of `work` in these
   * cases:
   * - The file has no snapshot.
   * - The snapshot has a different version or key.
   * - The log has no event with the id of the mark, or that event has a different position.
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
  /** This function removes the snapshot. */
  clear(): void;
}

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
  const meta = db.prepare(`SELECT version, key, seq, id, count FROM ${META} WHERE one = 1`);
  const rows = db.prepare(`SELECT part, value FROM ${ROWS} ORDER BY n`);
  const insertRow = db.prepare(`INSERT INTO ${ROWS} (n, part, value) VALUES (?, ?, ?)`);
  const insertMeta = db.prepare(`INSERT INTO ${META} (one, version, key, seq, id, count) VALUES (1, ?, ?, ?, ?, ?)`);
  const remove = (): void => {
    db.exec(`DELETE FROM ${ROWS}`);
    db.exec(`DELETE FROM ${META}`);
  };

  return {
    read(key, log, work) {
      checkKey(key);
      return readTransaction(db, () => {
        const row = meta.get() as { version: number; key: string; seq: number; id: string; count: number } | undefined;
        if (row === undefined || Number(row.version) !== key.version || row.key !== key.key) return undefined;
        const mark: FoldMark = { seq: Number(row.seq), id: row.id };
        if (log.get(mark.id)?.seq !== mark.seq) return undefined;
        const count = Number(row.count);
        let open = true;
        const iterable: Iterable<FoldRow> = {
          *[Symbol.iterator]() {
            if (!open) throw new Error("The rows of a snapshot are valid only in the work of its read.");
            let read = 0;
            for (const one of rows.iterate() as Iterable<{ part: string; value: string }>) {
              read += 1;
              yield { part: one.part, value: one.value };
            }
            if (read !== count) throw new Error(`The snapshot has ${read} rows, but its write had ${count} rows.`);
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
      if (!Number.isSafeInteger(mark.seq) || mark.seq < 1) throw new RangeError(`The position of a mark must be a whole number of 1 or more, not ${String(mark.seq)}.`);
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
    clear() {
      transaction(db, remove);
    },
  };
}

// The check of the version of a key.
function checkKey(key: FoldKey): void {
  if (!Number.isSafeInteger(key.version) || key.version < 1) throw new RangeError(`The version of a snapshot must be a whole number of 1 or more, not ${String(key.version)}.`);
}
