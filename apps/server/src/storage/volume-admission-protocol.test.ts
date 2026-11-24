import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { MessagePort } from 'node:worker_threads';
import type { VolumeAdmission } from './volume-admission.js';
import { installVolumeAdmissionProtocol } from './volume-admission-protocol.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VolumeAdmission as RealVolumeAdmission } from './volume-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { StorageWorkAdmission } from './work-admission.js';

class Port extends EventEmitter {
  replies: any[] = [];
  postMessage(value: unknown) { this.replies.push(value); }
  close() {}
  begin(id: number, extra: object = {}) { this.emit('message', { id, kind: 'begin', root: '/fixture', workClass: 'recovery', bytes: 1, ...extra }); }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('prebound volume mismatch fails before any lease is committed or writer begins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-protocol-bind-')), db = new DatabaseSync(':memory:');
  const volume = String(statSync(root, { bigint: true }).dev), port = new Port();
  try {
    const admission = new RealVolumeAdmission(db, root, Date.now, () => 1024n ** 3n);
    installVolumeAdmissionProtocol(port as unknown as MessagePort, () => admission);
    port.begin(1, { root, lease: `transient-${randomUUID()}`, volume: volume === '0' ? '1' : '0' });
    await turn();
    assert.deepEqual(port.replies, [{ id: 1, kind: 'begin', ok: false, reason: 'volume-changed' }]);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='storage_work_reservations'").get(), undefined,
      'volume mismatch does not even initialize the admission ledger');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unstarted proof checks exact payload and fingerprint; absence is settled rather than recovered', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-protocol-unstarted-')), db = new DatabaseSync(':memory:');
  const volume = String(statSync(root, { bigint: true }).dev), lease = `transient-${randomUUID()}`;
  const port = new Port(), rows: any[] = [];
  try {
    const admission = new RealVolumeAdmission(db, root, Date.now, () => 1024n ** 3n), ledger = new StorageWorkAdmission(db);
    ledger.startTransient(volume, lease, 'recovery', 7, () => ({ freeBytes: 1024n ** 3n, observedAt: Date.now() }));
    installVolumeAdmissionProtocol(port as unknown as MessagePort, () => admission,
      new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
    const recover = (id: number, extra = {}) => port.emit('message', { id, kind: 'reconcile', root, lease, volume,
      full: false, unstarted: true, workClass: 'recovery', bytes: 7, ...extra });
    for (const [index, extra] of [{ bytes: 8 }, { workClass: 'durable' }, { full: true }, { unstarted: false },
      { bytes: undefined }, { unstarted: undefined }].entries()) {
      recover(index + 1, extra);
      assert.equal(port.replies.at(-1).ok, false);
      assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
    }
    const original = String(db.prepare('SELECT payload FROM storage_work_reservations').get()!.payload);
    for (const [index, field] of ['fingerprint', 'requestId', 'state'].entries()) {
      const payload = { ...JSON.parse(original), [field]: 'mismatched' };
      db.prepare('UPDATE storage_work_reservations SET payload=?').run(JSON.stringify(payload));
      recover(7 + index);
      assert.equal(port.replies.at(-1).ok, false);
      assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 1);
    }
    db.prepare('UPDATE storage_work_reservations SET payload=?').run(original);
    recover(10); assert.equal(port.replies.at(-1).ok, true);
    recover(11); assert.equal(port.replies.at(-1).ok, true);
    const success = rows.filter(row => row.operation === 'storage-coordinator-recovery' && !row.failed);
    assert.equal(success.filter(row => row.recovered === 1).length, 1);
    assert.equal(success.filter(row => row.settled === 1).length, 1);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('replacement recovers only the exact original lease and volume, preserving foreign and durable receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-protocol-proof-')), db = new DatabaseSync(':memory:');
  const volume = String(statSync(root, { bigint: true }).dev), lease = `transient-${randomUUID()}`, foreign = `transient-${randomUUID()}`;
  const port = new Port(), rows: any[] = [];
  try {
    const admission = new RealVolumeAdmission(db, root, Date.now, () => 1024n ** 3n);
    const ledger = new StorageWorkAdmission(db);
    const sample = () => ({ freeBytes: 1024n ** 3n, observedAt: Date.now() });
    for (const requestId of [lease, foreign]) ledger.startTransient(volume, requestId, 'recovery', 1, sample);
    ledger.reserve(volume, 'external-command', 'recovery', 1, sample); ledger.claim(volume, 'external-command');
    installVolumeAdmissionProtocol(port as unknown as MessagePort, () => admission,
      new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
    const recover = (id: number, extra = {}) => port.emit('message', { id, kind: 'reconcile', root, lease, volume, full: false, ...extra });
    recover(1, { volume: volume === '0' ? '1' : '0' });
    assert.equal(port.replies[0].ok, false);
    assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, 3);
    recover(2, { full: true }); recover(3);
    assert.equal(port.replies[1].ok, true); assert.equal(port.replies[2].ok, true);
    assert.deepEqual(db.prepare('SELECT request FROM storage_work_reservations ORDER BY request').all().map(row => row.request), ['external-command', foreign]);
    assert.ok(db.prepare('SELECT denied_at FROM storage_volume_pressure WHERE volume=?').get(volume));
    recover(4, { lease: 'external-command' });
    assert.equal(port.replies[3].ok, false);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(`${lease}|${foreign}|${root}`));
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('queued acquisition counts toward capacity before any writer is admitted', async () => {
  const port = new Port(); let selects = 0;
  const queued: (() => void)[] = [];
  installVolumeAdmissionProtocol(port as unknown as MessagePort, () => {
    selects++;
    return { run: () => new Promise<void>((_resolve, reject) => queued.push(() => reject(Error('fixture denial')))) } as unknown as VolumeAdmission;
  });
  for (let id = 1; id <= 257; id++) port.begin(id);
  assert.equal(selects, 256);
  assert.deepEqual(port.replies, [{ id: 257, kind: 'begin', ok: false, reason: 'coordinator-capacity' }]);
  // Failed begin also frees the bounded transport slot, not a writer charge.
  queued.forEach(resolve => resolve()); await turn();
  port.begin(258); assert.equal(selects, 257); queued[256]!(); await turn();
});

test('invalid estimates are rejected before touching the filesystem or ledger', () => {
  const port = new Port();
  installVolumeAdmissionProtocol(port as unknown as MessagePort, () => assert.fail('must not select'));
  const invalid = [{ bytes: 0 }, { bytes: 1.5 }, { bytes: 4 * 1024 ** 3 + 1 }, { workClass: 'constructor' },
    { root: '' }, { root: 'private\0path' }];
  invalid.forEach((extra, n) => port.begin(n + 1, extra));
  assert.equal(port.replies.length, invalid.length);
  for (const reply of port.replies) assert.deepEqual(reply, { id: reply.id, kind: 'begin', ok: false, reason: 'estimate' });
});

test('begin and finish acknowledgments are distinct and release waits for ledger completion', async () => {
  const port = new Port(); let release!: () => void;
  installVolumeAdmissionProtocol(port as unknown as MessagePort, () => ({
    run: async (_class: unknown, _bytes: unknown, write: () => Promise<void>) => {
      await write(); await new Promise<void>(resolve => { release = resolve; });
    },
  }) as unknown as VolumeAdmission);
  port.begin(1);
  assert.deepEqual(port.replies, [{ id: 1, kind: 'begin', ok: true }]);
  port.emit('message', { id: 1, kind: 'finish', full: false }); await turn();
  assert.equal(port.replies.length, 1);
  release(); await turn();
  assert.deepEqual(port.replies[1], { id: 1, kind: 'finish', ok: true });
});

test('failed acquisition replies in begin phase and frees the transport slot', async () => {
  const port = new Port();
  installVolumeAdmissionProtocol(port as unknown as MessagePort, () => ({ run: async () => { throw Error('private ledger details'); } }) as unknown as VolumeAdmission);
  port.begin(1); await turn();
  assert.deepEqual(port.replies, [{ id: 1, kind: 'begin', ok: false, reason: 'coordinator-unavailable' }]);
});

for (const admitted of [false, true]) test(`coordinator domain failures have sanitized numeric evidence before negative ACK (${admitted})`, async () => {
  const port = new Port(), rows: any[] = [];
  const error = Object.assign(Error('private-sql-path-and-query'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
  const diagnostics = new PerformanceDiagnostics(line => { rows.push(JSON.parse(line)); throw Error('private sink'); });
  installVolumeAdmissionProtocol(port as unknown as MessagePort, () => ({
    run: async (_class: unknown, _bytes: unknown, write: () => Promise<void>) => {
      if (admitted) await write();
      throw error;
    },
  }) as unknown as VolumeAdmission, diagnostics);
  port.begin(1); if (admitted) port.emit('message', { id: 1, kind: 'finish', full: false });
  await turn();
  const event = rows.find(row => row.operation === 'storage-coordinator-recovery');
  assert.equal(event.step, admitted ? 4 : 3); assert.equal(event.sqlErrorCode, 5);
  assert.equal(event.unknown, 1); assert.equal(event.pending, 1);
  assert.doesNotMatch(JSON.stringify(rows), /private|path-and-query|fixture/);
  assert.deepEqual(port.replies.at(-1), { id: 1, kind: admitted ? 'finish' : 'begin', ok: false, reason: 'coordinator-unavailable' });
});

for (const lost of ['begin', 'finish'] as const) test(`throwing ${lost} acknowledgment fences transport without false ledger settlement`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-protocol-ack-'));
  const db = new DatabaseSync(':memory:');
  const rows: any[] = []; let closed = 0, selects = 0;
  const port = new Port();
  port.close = () => { closed++; };
  port.postMessage = (value: any) => {
    if (value.kind === lost) throw Error('private transport failure');
    port.replies.push(value);
  };
  try {
    const admission = new RealVolumeAdmission(db, root, Date.now, () => 1024n ** 3n);
    installVolumeAdmissionProtocol(port as unknown as MessagePort, () => { selects++; return admission; },
      new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
    port.begin(1);
    if (lost === 'finish') { port.emit('message', { id: 1, kind: 'finish', full: false }); await turn(); }
    assert.equal(closed, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, 'storage-coordinator-recovery');
    assert.equal(rows[0].category, 'failed');
    assert.equal(rows[0].unknown, lost === 'begin' ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(rows), /private|transport failure/);
    assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, lost === 'begin' ? 1 : 0);
    // A late finish is not writer-quiescence proof after transport failure.
    port.emit('message', { id: 1, kind: 'finish', full: false }); port.begin(2); await turn();
    assert.equal(selects, 1); assert.equal(closed, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n, lost === 'begin' ? 1 : 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('failed denial transport and throwing diagnostics never escape message dispatch', async () => {
  const port = new Port(); let closed = 0;
  port.postMessage = () => { throw Error('transport'); };
  port.close = () => { closed++; throw Error('close'); };
  installVolumeAdmissionProtocol(port as unknown as MessagePort, () => assert.fail('must not select'),
    new PerformanceDiagnostics(() => { throw Error('sink'); }));
  assert.doesNotThrow(() => port.begin(1, { bytes: 0 }));
  port.begin(2); await turn(); assert.equal(closed, 1);
});
