/**
 * The integrity check of a file in a worker thread. The check reads the whole file, so on a large file it takes many
 * seconds. In a worker, the event loop of the caller continues during the check.
 *
 * @packageDocumentation
 */
import { Worker } from "node:worker_threads";
import { integrityOfError, integrityOfLines, integritySql, type Integrity, type IntegrityOptions } from "./recovery.ts";
import { SQLITE_WARNING } from "./warning.ts";

/** The options of `checkIntegrityInBackground`: the kind of check, the limit of problems, a busy timeout and a signal. */
export interface BackgroundCheckOptions extends IntegrityOptions {
  /** This value is the time in milliseconds that the read waits for the lock of a different connection. The default is 5000. */
  readonly busyTimeoutMs?: number | undefined;
  /** This signal stops the check. Its abort stops the worker, and the promise rejects with the reason of the signal. */
  readonly signal?: AbortSignal | undefined;
}

/** The message of the worker: the lines of the pragma, or the fields of the error that it got. */
type WorkerResult =
  | { readonly kind: "lines"; readonly lines: readonly string[] }
  | { readonly kind: "error"; readonly message: string; readonly code: unknown; readonly errcode: unknown; readonly errstr: unknown };

/** The data that the worker gets. */
interface WorkerInput {
  readonly path: string;
  readonly sql: string;
  readonly busyTimeoutMs: number;
  readonly warning: string;
}

/**
 * The script of the worker, as an ES module in a `data:` URL. The script needs no file next to this module, so it
 * operates from the source, from the build and from a bundle. A `data:` URL is always an ES module, also when the
 * process has `--input-type`. The filter of the experimental warning is a copy of `isSqliteWarning`, because the worker
 * has its own `process`. The filter goes on before the import of `node:sqlite`.
 */
const WORKER_SCRIPT = `import { parentPort, workerData } from "node:worker_threads";
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const first = rest[0];
  const kind = typeof first === "string" ? first : typeof first === "object" && first !== null ? first.type : warning instanceof Error ? warning.name : undefined;
  const text = typeof warning === "string" ? warning : warning.message;
  if (kind === "ExperimentalWarning" && String(text).startsWith(workerData.warning)) return;
  emitWarning.call(process, warning, ...rest);
};
let db;
try {
  const sqlite = await import("node:sqlite");
  const Database = typeof sqlite.Database === "function" ? sqlite.Database : sqlite.DatabaseSync;
  db = new Database(workerData.path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = " + String(workerData.busyTimeoutMs));
  const rows = db.prepare(workerData.sql).all();
  parentPort.postMessage({ kind: "lines", lines: rows.map((row) => String(Object.values(row)[0])) });
} catch (error) {
  const fields = typeof error === "object" && error !== null ? error : {};
  parentPort.postMessage({ kind: "error", message: String(fields.message ?? error), code: fields.code, errcode: fields.errcode, errstr: fields.errstr });
} finally {
  try {
    if (db !== undefined) db.close();
  } catch {}
}
`;

/** The `data:` URL of the script of the worker. */
const WORKER_URL = new URL(`data:text/javascript,${encodeURIComponent(WORKER_SCRIPT)}`);

/**
 * This function does the integrity check of SQLite on a file in a worker thread. The worker opens its own read-only
 * connection, and the event loop of the caller continues. The result is the result of `checkIntegrity`.
 *
 * - A file that is not a database gives a problem, not an error. A different error rejects the promise, for example a
 *   path with no file.
 * - With WAL, the check does not stop the writers of the file. It examines the commits before its start.
 * - The WAL file grows during the check, because a checkpoint does not go past the start of a reader.
 * - An abort stops the worker. SQLite does not stop in the middle of a pragma, so the thread ends at the end of
 *   the pragma. Until then, an exit of the process waits for the thread.
 *
 * @param path - The path of the database file. A database with no file has no path for the worker.
 * @param options - The kind of check, the limit of problems, the busy timeout and the signal.
 */
export function checkIntegrityInBackground(path: string, options: BackgroundCheckOptions = {}): Promise<Integrity> {
  return checkIntegrityInBackgroundWith(path, options, () => undefined);
}

/**
 * This function is `checkIntegrityInBackground` with a seam that gets the worker. A test uses the seam to see the end of
 * the worker after an abort.
 *
 * @param seam - The function that gets the worker after its start.
 */
export function checkIntegrityInBackgroundWith(path: string, options: BackgroundCheckOptions, seam: (worker: Worker) => void): Promise<Integrity> {
  return new Promise<Integrity>((resolve, reject) => {
    if (path === "" || path === ":memory:") throw new RangeError("A check in the background needs the path of a file, not a database in memory.");
    const sql = integritySql(options);
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) throw new RangeError(`The busy timeout must be a whole number of 0 or more, not ${String(busyTimeoutMs)}.`);
    const { signal } = options;
    signal?.throwIfAborted();

    const input: WorkerInput = { path, sql, busyTimeoutMs, warning: SQLITE_WARNING };
    const worker = new Worker(WORKER_URL, { workerData: input });
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      finish();
    };
    const onAbort = (): void => {
      settle(() => reject(signal?.reason));
      void worker.terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (result: WorkerResult) => {
      settle(() => {
        if (result.kind === "lines") resolve(integrityOfLines(result.lines));
        else {
          try {
            resolve(integrityOfError(errorOf(result)));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    worker.on("error", (error) => settle(() => reject(error)));
    worker.on("exit", (code) => settle(() => reject(new Error(`The worker of the check stopped with exit code ${String(code)} before its result.`))));
    seam(worker);
  });
}

/** This function makes an error from the fields that the worker sent. It has the fields that `sqliteFault` reads. */
function errorOf(result: Extract<WorkerResult, { kind: "error" }>): Error {
  const error = new Error(result.message);
  Object.assign(error, { code: result.code, errcode: result.errcode, errstr: result.errstr });
  return error;
}
