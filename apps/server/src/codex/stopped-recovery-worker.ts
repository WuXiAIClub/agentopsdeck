import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { canonicalPrivatePath } from '../connector/windows-private-worker.js';
import { assertPrivateSqlitePaths } from '../storage/private-sqlite-path.js';
import { recordStoppedCodexRecovery } from './stopped-recovery.js';
import type { StoppedRecoveryOwnerRequest } from './stopped-recovery-owner.js';

function verify(request: StoppedRecoveryOwnerRequest) {
  const { file, dev, ino, deadline } = request;
  if (!['linux', 'win32'].includes(process.platform) || !isAbsolute(file) || resolve(file) !== file
    || !Number.isSafeInteger(deadline) || deadline <= Date.now() || !canonicalPrivatePath(file)) throw Error('Unavailable');
  const paths = [{ file: dirname(file), directory: true }, { file, directory: false }];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(`${file}${suffix}`); paths.push({ file: `${file}${suffix}`, directory: false }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const stat = assertPrivateSqlitePaths(paths)[1]!;
  if (stat.dev !== dev || stat.ino !== ino) throw Error('Unavailable');
}

// Node-installed one-shot capability only. Ordinary Hub input never supplies
// this worker's file, and no live Connector connection is opened alongside it.
const request = workerData.request as StoppedRecoveryOwnerRequest;
let db: DatabaseSync | undefined, failed = false;
try {
  verify(request);
  db = new DatabaseSync(request.file);
  db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL');
  verify(request);
  recordStoppedCodexRecovery(db, request.runs, request.proof, undefined, request.deadline);
} catch { failed = true; }
finally {
  try { db?.close(); } catch { failed = true; }
}
parentPort!.postMessage({ kind: 'stopped-recovery', ok: !failed });
parentPort!.close();
