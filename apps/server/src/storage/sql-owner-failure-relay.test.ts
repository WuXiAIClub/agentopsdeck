import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import type { Worker } from 'node:worker_threads';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AsyncSqliteAuthOwner } from '../auth/async-sqlite-owner.js';
import { AsyncMaintenanceJournal } from '../lifecycle/async-maintenance-journal.js';
import { reportSqliteAuthOwnerFailure } from '../auth/sqlite-owner-diagnostics.js';
import { reportMaintenanceSqlOwnerFailure } from '../lifecycle/maintenance-sql-owner-diagnostics.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createSqlOwnerFailureReceiver } from './sql-owner-failure-relay.js';

for (const owner of ['auth', 'maintenance'] as const)
test(`${owner} SQL phase relay records numeric failure without settlement or recovery claims`, () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), receive = createSqlOwnerFailureReceiver(owner, diagnostics);
  for (let step = owner === 'auth' ? 0 : 1; step <= (owner === 'auth' ? 15 : 4); step++) {
    assert.equal(receive({ kind: 'sql-owner-failure', owner, step, sqlErrorCode: 5 }), true);
  }
  const rows = diagnostics.snapshot().events;
  assert.equal(rows.length, owner === 'auth' ? 16 : 4);
  assert.ok(rows.every(row => row.sqlErrorCode === 5 && row.settled === undefined && row.recovered === undefined));
  assert.equal(rows.find(row => row.step === (owner === 'auth' ? 15 : 3))!.unknown, owner === 'auth' ? undefined : 1);
});

const malformed = [null, [], {}, { kind: 'sql-owner-failure', owner: 'hub', step: 1 },
  { kind: 'sql-owner-failure', owner: 'auth', step: -1 }, { kind: 'sql-owner-failure', owner: 'auth', step: 20 },
  { kind: 'sql-owner-failure', owner: 'auth', step: 1.5 }, { kind: 'sql-owner-failure', owner: 'auth', step: '1' },
  { kind: 'sql-owner-failure', owner: 'auth', step: 1, sqlErrorCode: undefined },
  { kind: 'sql-owner-failure', owner: 'auth', step: 1, sqlErrorCode: 0 },
  { kind: 'sql-owner-failure', owner: 'auth', step: 1, sqlErrorCode: 65536 },
  { kind: 'sql-owner-failure', owner: 'auth', step: 1, id: 1 },
  { kind: 'sql-owner-failure', owner: 'auth', step: 1, [Symbol('private')]: true },
  Object.defineProperty({ kind: 'sql-owner-failure', owner: 'auth' }, 'step', { value: 1 })];
for (const [index, value] of malformed.entries()) test(`malformed SQL observation ${index} stays outside the private telemetry lane`, () => {
  const diagnostics = new PerformanceDiagnostics(() => {});
  assert.equal(createSqlOwnerFailureReceiver('auth', diagnostics)(value), false);
  assert.deepEqual(diagnostics.snapshot().events, []);
});

test('SQL relay validation never invokes accessors or Proxy traps', () => {
  let calls = 0;
  const receive = createSqlOwnerFailureReceiver('auth', new PerformanceDiagnostics(() => {}));
  assert.equal(receive({ get kind() { calls++; throw Error(); }, owner: 'auth', step: 1 }), false);
  assert.equal(receive(new Proxy({}, { ownKeys() { calls++; throw Error(); } })), false);
  assert.equal(calls, 0);
});

test('SQL parent observation budget is per original worker and never becomes a business refusal', () => {
  const diagnostics = new PerformanceDiagnostics(() => {}, () => 0), receive = createSqlOwnerFailureReceiver('auth', diagnostics);
  for (let i = 0; i < 100; i++) assert.equal(receive({ kind: 'sql-owner-failure', owner: 'auth', step: 1 }), true);
  assert.equal(diagnostics.snapshot().events.length, 16);
  assert.equal(createSqlOwnerFailureReceiver('auth', diagnostics)({ kind: 'sql-owner-failure', owner: 'auth', step: 1 }), true);
  assert.equal(diagnostics.snapshot().events.length, 17);
});

for (const owner of ['auth', 'maintenance'] as const)
test(`${owner} child failure relay survives diagnostic and transport failure without exposing exception data`, () => {
  const notices: unknown[] = [], error = Object.assign(Error('PRIVATE_SQL_PATH_TOKEN'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  const diagnostics = new PerformanceDiagnostics(() => { throw Error(); }, () => { throw Error(); });
  const relay = (notice: unknown) => { notices.push(notice); throw Error(); };
  assert.doesNotThrow(() => owner === 'auth' ? reportSqliteAuthOwnerFailure('open', error, diagnostics, relay)
    : reportMaintenanceSqlOwnerFailure('open', error, diagnostics, relay));
  assert.deepEqual(notices, [{ kind: 'sql-owner-failure', owner, step: owner === 'auth' ? 0 : 1, sqlErrorCode: 10 }]);
});

test('JSON and no-Key fixed phases retain bounded numeric-only owner diagnostics', () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), notices: unknown[] = [];
  const receive = createSqlOwnerFailureReceiver('auth', diagnostics);
  for (const kind of ['originalJsonSession', 'originalJsonAuthorized', 'issueUnrestrictedSession', 'currentKeyBinding'] as const) {
    reportSqliteAuthOwnerFailure(kind, Error('PRIVATE_COOKIE_PATH'), quietDiagnostics(), notice => {
      notices.push(notice); assert.equal(receive(notice), true);
    });
  }
  assert.deepEqual(notices, [16, 17, 18, 19].map(step => ({ kind: 'sql-owner-failure', owner: 'auth', step })));
  assert.deepEqual(diagnostics.snapshot().events.map(row => row.step), [16, 17, 18, 19]);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE_COOKIE_PATH/);
});
function quietDiagnostics() { return new PerformanceDiagnostics(() => {}); }

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string }[] = [];
  postMessage(message: { id: number; kind: string }) { this.messages.push(message); }
  terminate() { return new Promise<number>(() => {}); }
}
for (const kind of ['auth', 'maintenance'] as const)
test(`${kind} telemetry before ready or during close never ACKs work, releases admission or certifies exit`, async () => {
  const worker = new FakeWorker(), diagnostics = new PerformanceDiagnostics(() => {}, () => 0);
  const owner = kind === 'auth' ? new AsyncSqliteAuthOwner({ file: 'unused', legacyFiles: [] }, diagnostics, () => worker as unknown as Worker)
    : new AsyncMaintenanceJournal({ file: 'unused', dev: 1, ino: 1 }, diagnostics, undefined, () => worker as unknown as Worker);
  let settled = false;
  const read = (owner instanceof AsyncSqliteAuthOwner ? owner.command('status', {}) : owner.get('request:1')).then(() => { settled = true; });
  worker.emit('message', { kind: 'sql-owner-failure', owner: kind, step: kind === 'auth' ? 0 : 1 });
  await turn(); assert.equal(settled, false); assert.equal(worker.messages.length, 0); assert.equal(owner.snapshot().unavailable, false);
  worker.emit('message', { kind: 'ready' }); await turn();
  const request = worker.messages[0]!;
  worker.emit('message', { kind: 'sql-owner-failure', owner: kind, step: kind === 'auth' ? 1 : 2, sqlErrorCode: 5 });
  let closed = false; const close = owner.close().then(() => { closed = true; });
  await turn(); assert.equal(settled, false); assert.equal(closed, false);
  assert.equal(worker.messages.length, 1); assert.equal(owner.snapshot().accepted, 1);
  worker.emit('message', kind === 'auth' ? { id: request.id, kind: request.kind, ok: true, body: '{"available":false,"count":0}' }
    : { id: request.id, kind: request.kind, ok: true, value: undefined });
  await read; await turn(); const closing = worker.messages.at(-1)!; assert.equal(closing.kind, 'close');
  worker.emit('message', { kind: 'sql-owner-failure', owner: kind, step: kind === 'auth' ? 15 : 3 });
  await turn(); assert.equal(closed, false); assert.equal(owner.snapshot().ownerExitConfirmed, false);
  worker.emit('message', kind === 'auth' ? { id: closing.id, kind: 'close', ok: true, body: 'null' }
    : { id: closing.id, kind: 'close', ok: true, value: undefined });
  await turn(); assert.equal(closed, false); worker.emit('exit', 0); await close;
  assert.equal(diagnostics.snapshot().events.filter(row => row.operation.endsWith('sql-owner-failure') || row.operation === 'auth-sqlite-owner-failure').length, 3);
});

for (const kind of ['auth', 'maintenance'] as const)
test(`real ${kind} startup failure reaches parent diagnostics without reopening or repairing database`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sql-parent-failure-')), file = join(directory, 'private.sqlite');
  chmodSync(directory, 0o700);
  if (kind === 'auth') { writeFileSync(file, 'NOT A DATABASE', { mode: 0o600 }); }
  else { const db = new DatabaseSync(file); db.close(); chmodSync(file, 0o600); }
  const stat = lstatSync(file), before = readFileSync(file), diagnostics = new PerformanceDiagnostics(() => {});
  const owner = kind === 'auth' ? new AsyncSqliteAuthOwner({ file, legacyFiles: [] }, diagnostics)
    : new AsyncMaintenanceJournal({ file, dev: stat.dev, ino: stat.ino + 1, readOnly: true }, diagnostics);
  try {
    await assert.rejects(owner instanceof AsyncSqliteAuthOwner ? owner.open() : owner.get('request:1'));
    if (owner instanceof AsyncSqliteAuthOwner) await assert.rejects(owner.close());
    else await owner.close();
    const row = diagnostics.snapshot().events.find(row => row.operation === (kind === 'auth' ? 'auth-sqlite-owner-failure' : 'maintenance-sql-owner-failure'));
    assert.ok(row); assert.equal(row.step, kind === 'auth' ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private.sqlite|NOT A DATABASE/);
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
    assert.deepEqual(readFileSync(file), before);
  } finally { await owner.close().catch(() => {}); rmSync(directory, { recursive: true }); }
});

test('maintenance read SQL refusal reaches parent without repairing the original receipt source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sql-read-refusal-')), file = join(directory, 'private.sqlite');
  chmodSync(directory, 0o700); const db = new DatabaseSync(file); db.close(); chmodSync(file, 0o600);
  const stat = lstatSync(file), before = readFileSync(file), diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncMaintenanceJournal({ file, dev: stat.dev, ino: stat.ino, readOnly: true }, diagnostics);
  try {
    await assert.rejects(owner.get('request:1')); await owner.close();
    const row = diagnostics.snapshot().events.find(row => row.operation === 'maintenance-sql-owner-failure');
    assert.ok(row); assert.equal(row.step, 2); assert.equal(row.sqlErrorCode, 1);
    assert.deepEqual(readFileSync(file), before); assert.equal(owner.snapshot().ownerExitConfirmed, true);
  } finally { await owner.close(); rmSync(directory, { recursive: true }); }
});

for (const kind of ['auth', 'maintenance'] as const)
test(`${kind} malformed telemetry cannot bypass fail-closed command validation`, async () => {
  const worker = new FakeWorker(), diagnostics = new PerformanceDiagnostics(() => {});
  const owner = kind === 'auth' ? new AsyncSqliteAuthOwner({ file: 'unused', legacyFiles: [] }, diagnostics, () => worker as unknown as Worker)
    : new AsyncMaintenanceJournal({ file: 'unused', dev: 1, ino: 1 }, diagnostics, undefined, () => worker as unknown as Worker);
  worker.emit('message', { kind: 'ready' });
  const read = owner instanceof AsyncSqliteAuthOwner ? owner.command('status', {}) : owner.get('request:1');
  const rejected = assert.rejects(read); await turn();
  worker.emit('message', { kind: 'sql-owner-failure', owner: kind, step: kind === 'auth' ? 1 : 2, token: 'PRIVATE_TOKEN' });
  await rejected; assert.equal(owner.snapshot().unavailable, true); assert.equal(worker.messages.length, 1);
  worker.emit('exit', 1); await owner.close().catch(() => {});
  assert.ok(diagnostics.snapshot().events.every(row => row.operation !== 'auth-sqlite-owner-failure' && row.operation !== 'maintenance-sql-owner-failure'));
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE_TOKEN/);
});
