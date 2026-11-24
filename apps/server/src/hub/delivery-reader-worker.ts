import { parentPort, workerData } from 'node:worker_threads';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validDeliveryRead, validPreferenceRead, validUserRead, validWorkspaceRevisionRead, isDeliverySnapshotReadRejected, type DeliveryReaderConfig } from './delivery-reader-protocol.js';
import { readDeliveryPage } from './delivery-page.js';
import { readSessionPreferences } from './preference-read.js';
import { readUsers } from './user-read.js';
import { readConnections } from './connection-read.js';
import { readWorkspaceRevisions } from './workspace-revision-read.js';
import { readWorkspacePreferences } from './workspace-preference-read.js';
import { readWorkspaceLayout } from './workspace-layout-read.js';
import { readCompletionSummary, validCompletionSummaryRead } from './completion-summary-read.js';
import { readWorkspaceBoard, validWorkspaceBoardRead } from './workspace-board-snapshot-read.js';
import { readNotebookSnapshot, validNotebookSnapshotRead } from './notebook-snapshot-read.js';
import { reportReadonlySqlOwnerFailure, type ReadonlyOwnerFailurePoint } from '../storage/readonly-sql-owner-diagnostics.js';

if (!parentPort) throw Error('Delivery reader requires a parent');
const port = parentPort, config = workerData as DeliveryReaderConfig;
let failurePoint: ReadonlyOwnerFailurePoint = 'main-identity';
const validate = () => {
  failurePoint = 'main-identity';
  const directory = dirname(config.file), stat = lstatSync(config.file);
  failurePoint = 'directory-identity';
  const canonicalDirectory = realpathSync(directory);
  const sameDirectory = process.platform === 'win32'
    ? canonicalDirectory.toLowerCase() === directory.toLowerCase() : canonicalDirectory === directory;
  if (!sameDirectory) throw Error('Delivery reader unavailable');
  failurePoint = 'main-identity';
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== config.dev || stat.ino !== config.ino)
    throw Error('Delivery reader unavailable');
  failurePoint = 'sidecar-identity';
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      const path = config.file + suffix, sidecar = lstatSync(path);
      if (!sidecar.isFile() || sidecar.isSymbolicLink()) throw Error();
      if (sidecar.nlink === 0) {
        // A concurrent SQLite writer may unlink its regular rollback journal
        // during lstat. Accept only a second observation of absence. An
        // existing/replaced path, alias or I/O error still refuses this owner.
        // This rechecks metadata only: no SQL retry, repair or write replay.
        lstatSync(path); throw Error();
      }
      if (sidecar.nlink !== 1) throw Error();
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
};
let db!: DatabaseSync;
try {
  validate(); failurePoint = 'database-open'; db = new DatabaseSync(config.file, { readOnly: true });
  validate(); failurePoint = 'configure-readonly'; db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
} catch (error) {
  reportReadonlySqlOwnerFailure('hub', 'open', error, undefined, failurePoint, notice => port.postMessage(notice));
  if (db !== undefined) {
    try { db.close(); } catch (closeError) { reportReadonlySqlOwnerFailure('hub', 'close', closeError, undefined, 'close', notice => port.postMessage(notice)); }
  }
  throw Error('Delivery reader unavailable');
}
let closed = false, highest = 0;
port.postMessage({ kind: 'ready' });
port.on('message', (message: unknown) => {
  if (closed) return;
  let phase: 'read' | 'close' = 'read';
  try {
    failurePoint = 'protocol';
    const r = message as { id?: number; kind?: string; read?: unknown } | null;
    if (!r || typeof r !== 'object' || Array.isArray(r) || !Number.isSafeInteger(r.id) || r.id! <= highest
      || Object.keys(r).some(key => !['id', 'kind', 'read'].includes(key))) throw Error();
    highest = r.id!;
    if (r.kind === 'close' && Object.keys(r).length === 2) {
      phase = 'close';
      failurePoint = 'close';
      closed = true; db.close(); port.postMessage({ id: r.id, kind: 'close', ok: true }); port.close(); return;
    }
    if (!(r.kind === 'page' && validDeliveryRead(r.read)) && !(r.kind === 'preferences' && validPreferenceRead(r.read))
      && !(r.kind === 'users' && validUserRead(r.read)) && !(r.kind === 'revisions' && validWorkspaceRevisionRead(r.read))
      && !(['connections', 'workspace', 'layout-current', 'layout-saved'].includes(r.kind ?? '') && validPreferenceRead(r.read))
      && !(r.kind === 'completions' && validCompletionSummaryRead(r.read))
      && !(r.kind === 'boards' && validWorkspaceBoardRead(r.read))
      && !(r.kind === 'notebooks' && validNotebookSnapshotRead(r.read))) throw Error();
    validate();
    failurePoint = 'snapshot-read';
    // Cursor lookup, retention boundary and page use ONE readonly snapshot.
    // No writer transaction, schema initialization or repair on this handle.
    let value;
    try {
      value = r.kind === 'users' && validUserRead(r.read) ? readUsers(db, r.read)
        : r.kind === 'preferences' && validPreferenceRead(r.read) ? readSessionPreferences(db, r.read.owner)
        : r.kind === 'revisions' && validWorkspaceRevisionRead(r.read) ? readWorkspaceRevisions(db, r.read.owner)
        : r.kind === 'connections' && validPreferenceRead(r.read) ? readConnections(db, r.read.owner)
        : r.kind === 'workspace' && validPreferenceRead(r.read) ? readWorkspacePreferences(db, r.read.owner)
        : r.kind === 'layout-current' && validPreferenceRead(r.read) ? readWorkspaceLayout(db, r.read.owner, 'current')
        : r.kind === 'layout-saved' && validPreferenceRead(r.read) ? readWorkspaceLayout(db, r.read.owner, 'saved')
        : r.kind === 'completions' && validCompletionSummaryRead(r.read) ? readCompletionSummary(db, r.read)
        : r.kind === 'boards' && validWorkspaceBoardRead(r.read) ? readWorkspaceBoard(db, r.read)
        : r.kind === 'notebooks' && validNotebookSnapshotRead(r.read) ? readNotebookSnapshot(db, r.read)
        : r.kind === 'page' && validDeliveryRead(r.read) ? readDeliveryPage(db, r.read) : (() => { throw Error(); })();
    } catch (error) {
      if (r.kind === 'page' || !isDeliverySnapshotReadRejected(error)) throw error;
      // A bounded display refusal occurs only after iterate() has unwound.
      // No partial preference/user snapshot; chat replay keeps its owner.
      // SQL, cleanup and identity failures remain physical-owner failures.
      validate(); failurePoint = 'reply';
      port.postMessage({ id: r.id, kind: r.kind, ok: false }); return;
    }
    validate(); failurePoint = 'reply'; port.postMessage({ id: r.id, kind: r.kind, ok: true, value });
  } catch (error) {
    reportReadonlySqlOwnerFailure('hub', phase, error, undefined, failurePoint, notice => port.postMessage(notice));
    closed = true;
    try { db.close(); } catch (closeError) { reportReadonlySqlOwnerFailure('hub', 'close', closeError, undefined, 'close', notice => port.postMessage(notice)); }
    port.close(); process.exitCode = 1;
  }
});
