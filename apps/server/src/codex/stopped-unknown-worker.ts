import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { canonicalPrivatePath } from '../connector/windows-private-worker.js';
import { assertPrivateSqlitePaths } from '../storage/private-sqlite-path.js';
import { registerNativeHistoryWriter } from './native-history.js';
import { registerNativeResumeWriter } from './native-resume.js';
import { disposeStoppedUnknown } from './stopped-unknown-disposition.js';
import { disposeStoppedUnknownBatch } from './stopped-unknown-batch.js';
import { retireStoppedUnknown } from './stopped-unknown-retirement.js';
import { recoverStoppedOwnedLoad } from './stopped-owned-load-recovery.js';
import type { StoppedUnknownOwnerRequest } from './stopped-unknown-owner.js';

function verify(request: StoppedUnknownOwnerRequest) {
  const { file, dev, ino, deadline } = request;
  if (!['linux', 'win32'].includes(process.platform) || !isAbsolute(file) || resolve(file) !== file
    || !Number.isSafeInteger(deadline) || deadline <= Date.now() || !canonicalPrivatePath(file)) throw Error('Unavailable');
  const paths = [{ file: dirname(file), directory: true }, { file, directory: false }];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(`${file}${suffix}`); paths.push({ file: `${file}${suffix}`, directory: false }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const before = lstatSync(file, { bigint: true });
  assertPrivateSqlitePaths(paths);
  const after = lstatSync(file, { bigint: true });
  if (before.dev.toString() !== String(dev) || before.ino.toString() !== String(ino)
    || after.dev !== before.dev || after.ino !== before.ino) throw Error('Unavailable');
}

const request = workerData.request as StoppedUnknownOwnerRequest;
let db: DatabaseSync | undefined, failed = false;
try {
  verify(request);
  db = new DatabaseSync(request.file);
  db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
  registerNativeHistoryWriter(db); registerNativeResumeWriter(db);
  verify(request);
  if (request.disposition.action === 'recover-acknowledged-load-before-turn-start')
    recoverStoppedOwnedLoad(db, request.disposition, request.deadline);
  else if (request.disposition.action === 'retire-archived-batch-protection-without-replay')
    retireStoppedUnknown(db, request.disposition, request.deadline);
  else if (request.disposition.action === 'retain-batch-without-replay-hold-successors')
    disposeStoppedUnknownBatch(db, request.disposition, undefined, request.deadline);
  else disposeStoppedUnknown(db, request.disposition, undefined, request.deadline);
} catch { failed = true; }
finally { try { db?.close(); } catch { failed = true; } }
parentPort!.postMessage({ kind: 'stopped-unknown', ok: !failed });
parentPort!.close();
