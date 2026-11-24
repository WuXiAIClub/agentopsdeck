import { parentPort, workerData } from 'node:worker_threads';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readStoredSqliteCredentials } from './sqlite-passkeys.js';
import { credentialHashForAudit } from './security.js';
import type { AuthDisplayConfig } from './async-sqlite-display.js';
import { reportReadonlySqlOwnerFailure } from '../storage/readonly-sql-owner-diagnostics.js';
import { assertPrivateSqlitePaths } from '../storage/private-sqlite-path.js';

if (!parentPort) throw Error('Auth display requires a parent');
const port = parentPort, config = workerData as AuthDisplayConfig;
const validate = () => {
  const paths = [{ file: dirname(config.file), directory: true }, { file: config.file, directory: false }];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(config.file + suffix); paths.push({ file: config.file + suffix, directory: false }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const s = assertPrivateSqlitePaths(paths)[1]!;
  if (s.dev !== config.dev || s.ino !== config.ino) throw Error('Private auth display unavailable');
};
// This is a display snapshot, not the SqlitePasskeys writer constructor.
// Opening never creates schema, sets WAL mode, repairs records or reads tokens.
let db!: DatabaseSync;
try {
  validate(); db = new DatabaseSync(config.file, { readOnly: true });
  validate(); db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
} catch (error) {
  reportReadonlySqlOwnerFailure('auth', 'open', error, undefined, undefined, notice => port.postMessage(notice));
  if (db !== undefined) {
    try { db.close(); } catch (closeError) { reportReadonlySqlOwnerFailure('auth', 'close', closeError, undefined, undefined, notice => port.postMessage(notice)); }
  }
  throw Error('Private auth display unavailable');
}
let highest = 0, closed = false;
port.postMessage({ kind: 'ready' });
port.on('message', (message: unknown) => {
  if (closed) return;
  const r = message as { id?: number; kind?: string; key?: string } | null;
  let phase: 'read' | 'close' = 'read';
  try {
    if (!r || typeof r !== 'object' || Array.isArray(r) || !Number.isSafeInteger(r.id) || r.id! <= highest
      || Object.keys(r).some(key => !['id', 'kind', 'key'].includes(key))) throw Error();
    highest = r.id!;
    if (r.kind === 'close' && !Object.hasOwn(r, 'key')) {
      phase = 'close';
      closed = true; db.close(); port.postMessage({ id: r.id, kind: 'close', ok: true }); port.close(); return;
    }
    if (!['status', 'list'].includes(r.kind!) || (r.key !== undefined && (typeof r.key !== 'string' || !/^[a-f0-9]{24}$/.test(r.key)))) throw Error();
    validate();
    const active = readStoredSqliteCredentials(db).filter(c => c.value.revokedAt === undefined
      && (!r.key || c.value.keyIdentityHash === r.key));
    const value = r.kind === 'status' ? { available: active.length > 0, count: active.length }
      : active.map(({ value: c }) => ({ id: credentialHashForAudit(c.id), label: c.label,
        transports: c.transports ?? [], createdAt: c.createdAt,
        ...(c.lastUsedAt === undefined ? {} : { lastUsedAt: c.lastUsedAt }) }));
    validate(); port.postMessage({ id: r.id, kind: r.kind, ok: true, value });
  } catch (error) {
    reportReadonlySqlOwnerFailure('auth', phase, error, undefined, undefined, notice => port.postMessage(notice));
    closed = true;
    // No corrupt record, path, token, SQL or raw exception crosses the port.
    // Any refusal retires this observer; the parent never replays the query.
    try { db.close(); } catch (closeError) { reportReadonlySqlOwnerFailure('auth', 'close', closeError, undefined, undefined, notice => port.postMessage(notice)); }
    port.close(); process.exitCode = 1;
  }
});
