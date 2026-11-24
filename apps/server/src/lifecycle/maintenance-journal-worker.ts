import { snapshotMaintenanceJournalRequest, type MaintenanceJournalKind } from './maintenance-journal-protocol.js';
import { parentPort, workerData } from 'node:worker_threads';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recoverableConnection, connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { SqliteMaintenanceJournal, MaintenanceConflict } from './maintenance-journal.js';
import { MaintenanceReceiptReader } from './maintenance-receipt-reader.js';
import { validMaintenanceJob } from './connector-maintenance.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { reportMaintenanceSqlOwnerFailure } from './maintenance-sql-owner-diagnostics.js';
import type { MaintenanceJournalOwnerConfig } from './async-maintenance-journal.js';
import type { UnstartedPreparationProof, SupersededPreFenceProof } from './maintenance-reconciliation.js';
import type { RecoveredReadinessProof } from './maintenance-recovery-reconciliation.js';

// Entire independent journal connection belongs here. No SQL, callbacks or
// native service effects cross the protocol. Never reconnect or replay writes.
if (!parentPort) throw Error('Maintenance journal requires a parent');
const port = parentPort;
const config = workerData as MaintenanceJournalOwnerConfig;
const check = (file: string, directory = false) => {
  const s = lstatSync(file);
  if (!process.getuid || s.uid !== process.getuid() || (s.mode & 0o077)
    || s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) throw Error('Private journal unavailable');
  return s;
};
const validate = () => {
  const dir = dirname(config.file); check(dir, true);
  if (realpathSync(dir) !== dir) throw Error('Private journal unavailable');
  const s = check(config.file);
  if (s.dev !== config.dev || s.ino !== config.ino) throw Error('Private journal unavailable');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { check(config.file + suffix); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
};
const raw = (() => {
  try { validate(); return new DatabaseSync(config.file, { readOnly: config.readOnly === true }); }
  catch (error) { reportMaintenanceSqlOwnerFailure('open', error, undefined, notice => port.postMessage(notice)); throw Error('Private journal unavailable'); }
})();
const closeOriginal = (connection: DatabaseSync) => {
  try { connection.close(); }
  catch (error) { reportMaintenanceSqlOwnerFailure('close', error, undefined, notice => port.postMessage(notice)); throw error; }
};
let db: DatabaseSync;
let journal: SqliteMaintenanceJournal | undefined;
let receipts: MaintenanceReceiptReader;
try {
  validate();
  raw.exec('PRAGMA busy_timeout=1000');
  if (config.readOnly === true) raw.exec('PRAGMA query_only=ON');
  else raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=4194304');
  db = recoverableConnection(raw);
  receipts = new MaintenanceReceiptReader(db);
  if (config.readOnly !== true) journal = new SqliteMaintenanceJournal(db, undefined, {
    now: Date.now,
    authorize: job => {
      const policy = config.reconciliation;
      if (!policy || job.nodeId !== policy.nodeId || !policy.operations.includes(job.operation)) return false;
      // A fresh durable read, never bootstrap or frozen bearer authority. This
      // is not atomic revocation across the token file and SQLite domains.
      try {
        const stat = lstatSync(policy.tokenFile);
        if (!process.getuid || stat.uid !== process.getuid() || !stat.isFile() || stat.isSymbolicLink()
          || stat.nlink !== 1 || (stat.mode & 0o022) || realpathSync(policy.tokenFile) !== policy.tokenFile) return false;
        return new ConnectorTokenStore(policy.tokenFile).hasScope(job.actorId, 'connector:lifecycle');
      } catch { return false; }
    },
  }); validate();
} catch (error) {
  reportMaintenanceSqlOwnerFailure('open', error, undefined, notice => port.postMessage(notice));
  try { closeOriginal(raw); } catch {}
  throw Error('Private journal unavailable');
}
let highest = 0, closing = false;
let chain = Promise.resolve();
port.postMessage({ kind: 'ready' });
port.on('message', (request: unknown) => {
  chain = chain.then(async () => {
    const r = request as { id?: number; kind?: string; args?: unknown[] } | null;
    if (!r || typeof r !== 'object' || Array.isArray(r) || !Number.isSafeInteger(r.id) || r.id! <= highest || !Array.isArray(r.args) || closing
      || Object.keys(r).some(key => !['id', 'kind', 'args'].includes(key))) {
      closing = true; port.close(); return;
    }
    highest = r.id!;
    const { id, kind } = r;
    let args: unknown[];
    try { args = snapshotMaintenanceJournalRequest(kind as MaintenanceJournalKind, r.args!).args; }
    catch { closing = true; port.close(); return; }
    let value: unknown, reply: unknown;
    try {
      if (config.readOnly === true) validate();
      if ((kind === 'get' || kind === 'unresolved') && args.length === 1
        && typeof args[0] === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(args[0])) {
        value = kind === 'get' ? receipts.get(args[0]) : receipts.unresolved(args[0]);
      } else if (journal && kind === 'enqueue' && args.length === 1 && validMaintenanceJob(args[0])) value = journal.enqueue(args[0]);
      else if (journal && kind === 'compareAndSwap' && args.length === 2 && validMaintenanceJob(args[0]) && validMaintenanceJob(args[1])) {
        value = await journal.compareAndSwap(args[0], args[1]);
      } else if (journal && args.length === 3 && validMaintenanceJob(args[0]) && Number.isSafeInteger(args[2])
        && args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])) {
        if (kind === 'cancelUnstartedPreparation') value = journal.cancelUnstartedPreparation(args[0], args[1] as UnstartedPreparationProof, args[2] as number);
        else if (kind === 'cancelSupersededObservation') value = journal.cancelSupersededObservation(args[0], args[1] as SupersededPreFenceProof, args[2] as number);
        else if (kind === 'completeRecoveredReadiness') value = journal.completeRecoveredReadiness(args[0], args[1] as RecoveredReadinessProof, args[2] as number);
        else { closing = true; port.close(); return; }
      } else if (kind === 'observe' && !args.length) {
        // WeakMap observation only: no SQL, rollback, reopen, close or replay.
        value = connectionRecoverySnapshot(db);
      } else if (kind === 'close' && !args.length) { closing = true; db.close(); }
      else { closing = true; port.close(); return; }
      if (config.readOnly === true && kind !== 'close') validate();
      reply = { id, kind, ok: true, value };
    } catch (error) {
      reportMaintenanceSqlOwnerFailure(kind === 'close' ? 'close'
        : kind === 'get' || kind === 'unresolved' || kind === 'observe' ? 'read' : 'command', error,
        undefined, notice => port.postMessage(notice));
      // Writable settled SQL refusals remain distinguishable from transport
      // ambiguity. A read-only observer retires on any refusal, never repairs
      // schema/identity or repeatedly queries a damaged receipt source.
      reply = { id, kind, ok: false, conflict: error instanceof MaintenanceConflict };
      if (config.readOnly === true) closing = true;
    }
    // A failed response send can follow a durable COMMIT. Never misreport that
    // transport ambiguity as a settled SQL rejection or run further requests.
    try { port.postMessage(reply); } catch { closing = true; port.close(); }
    if (closing) port.close();
  }).catch(() => { try { closeOriginal(db); } catch {} port.close(); });
});
port.on('close', () => { try { closeOriginal(db); } catch {} });
