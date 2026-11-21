/**
 * The snapshot of a fold in its own file, next to the file of its log.
 *
 * @packageDocumentation
 */
import { openDatabase, type OpenOptions } from "./database.ts";
import { foldSnapshot, type FoldSnapshot } from "./fold-snapshot.ts";

/** A snapshot that owns its connection: `openFoldSnapshot` gives it. */
export interface FoldSnapshotFile extends FoldSnapshot {
  /** This function closes the connection of the snapshot. */
  close(): void;
}

/**
 * This function opens a snapshot in its own file, and makes the file when it is not there. `:memory:` gives a snapshot
 * with no file. The rules of `foldSnapshot` apply.
 *
 * A separate file keeps the writes of the snapshot out of the file of the log. A broken snapshot file then does not
 * change the log.
 *
 * @param path - The path of the file, or `:memory:`.
 * @param options - The pragmas of the connection. The defaults are the defaults of `openDatabase`.
 */
export function openFoldSnapshot(path: string, options: OpenOptions = {}): FoldSnapshotFile {
  const db = openDatabase(path, options);
  try {
    const store = foldSnapshot(db);
    return {
      ...store,
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
