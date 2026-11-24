import { parentPort, workerData } from 'node:worker_threads';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { addSqlFailure } from '../storage/sql-failure-diagnostics.js';

// Only a private, canonical lock path crosses this boundary. No update body,
// authorization decision, domain SQL, lock expiry or business retry is admitted.
const port = parentPort;
let db: DatabaseSync | undefined, closing = false;
const trace = guardedTrace(performanceDiagnostics, 'update-mutation-lock');
trace.add('step', 4);
function stop() {
  if (closing) return;
  closing = true;
  try { db?.close(); trace.add('settled', 1); }
  catch (error) { trace.add('unknown', 1); addSqlFailure(trace, error); process.exitCode = 1; }
  finally { trace.finish(process.exitCode === 1); port?.close(); }
}
try {
  if (!port || typeof workerData.file !== 'string' || workerData.file.length === 0) throw Error('update lock unavailable');
  db = new DatabaseSync(workerData.file);
  chmodSync(workerData.file, 0o600);
  // Same inode is retained permanently. Closing/replacing another same-process
  // descriptor is forbidden by the main-thread canonical-path group fence.
  db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
  port.on('message', (value: unknown) => {
    if (value !== 'close') process.exitCode = 1;
    stop();
  });
  port.postMessage({ kind: 'acquired' });
} catch (error) {
  trace.add('unknown', 1); addSqlFailure(trace, error);
  let busy = false;
  try {
    const e = error as { code?: unknown; errcode?: unknown };
    busy = e?.code === 'ERR_SQLITE_ERROR' && typeof e.errcode === 'number' && Number.isSafeInteger(e.errcode)
      && e.errcode >= 0 && ((e.errcode & 255) === 5 || (e.errcode & 255) === 6);
  } catch { /* Unclassified errors are not contention evidence. */ }
  try { port?.postMessage({ kind: 'failed', busy }); }
  finally { process.exitCode = 1; stop(); }
}
