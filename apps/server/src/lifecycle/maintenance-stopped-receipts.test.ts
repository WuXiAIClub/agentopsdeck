import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import test from 'node:test';
import { AsyncMaintenanceJournal, MaintenanceJournalUnavailable } from './async-maintenance-journal.js';
import { newMaintenanceJob, type MaintenanceJob } from './connector-maintenance.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const job = () => newMaintenanceJob({ id: 'request:1', nodeId: 'node:1', actorId: 'actor:1', operation: 'restart', createdAt: 1000, deadline: 60_000 });
type StoppedReads = {
  inspectStopped(kind: 'get' | 'unresolved', key: string): Promise<MaintenanceJob | undefined>;
};
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-stopped-receipts-'));
  const file = join(root, 'journal.sqlite');
  const db = new DatabaseSync(file); db.close(); chmodSync(file, 0o600);
  const { dev, ino } = lstatSync(file), logs: string[] = [];
  const owner = new AsyncMaintenanceJournal({ file, dev, ino }, new PerformanceDiagnostics(line => logs.push(line)));
  const reader = owner as unknown as StoppedReads;
  await owner.enqueue(job());
  const worker = (owner as unknown as { worker: Worker }).worker;
  const stop = async () => { await worker.terminate(); await new Promise<void>(resolve => setImmediate(resolve)); };
  t.after(async () => { try { await owner.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  return { owner, reader, file, logs, stop };
}

test('a confirmed stopped journal remains observable without reviving writes or original ACK certainty', async t => {
  const f = await fixture(t); await f.stop();
  await assert.rejects(f.owner.get(job().id), MaintenanceJournalUnavailable);
  const before = f.owner.snapshot();
  assert.equal(before.unavailable, true); assert.equal(before.ownerExitConfirmed, true);
  assert.deepEqual(await f.reader.inspectStopped('get', job().id), job());
  assert.deepEqual(await f.reader.inspectStopped('unresolved', job().nodeId), job());
  assert.deepEqual(f.owner.snapshot(), before, 'receipt visibility is not writer recovery');
  await assert.rejects(f.owner.enqueue({ ...job(), id: 'request:2' }), MaintenanceJournalUnavailable);
  await assert.rejects(f.owner.compareAndSwap(job(), { ...job(), revision: 1, executing: true }), MaintenanceJournalUnavailable);
  assert.equal(await f.reader.inspectStopped('get', 'absent'), undefined);
  assert.ok(f.logs.some(line => JSON.parse(line).operation === 'maintenance-stopped-receipt'));
  assert.ok(f.logs.every(line => !line.includes(f.file) && !line.includes('request:1')));
});

test('stopped observations reject before original exit and after host close', async t => {
  const f = await fixture(t);
  await assert.rejects(f.reader.inspectStopped('get', job().id), MaintenanceJournalUnavailable);
  await f.stop(); await f.owner.close();
  await assert.rejects(f.reader.inspectStopped('get', job().id), MaintenanceJournalUnavailable);
});

test('read-only protocol cannot admit a mutation even when called directly', async t => {
  const f = await fixture(t); await f.stop();
  const { dev, ino } = lstatSync(f.file);
  const readonly = new AsyncMaintenanceJournal({ file: f.file, dev, ino, readOnly: true });
  try {
    await assert.rejects(readonly.enqueue({ ...job(), id: 'request:2' }), MaintenanceJournalUnavailable);
    assert.deepEqual(await readonly.get(job().id), job());
  } finally { await readonly.close(); }
});

test('stopped observation never repairs or creates a missing journal schema', async t => {
  const f = await fixture(t); await f.stop();
  const db = new DatabaseSync(f.file);
  try { db.exec('DROP TABLE connector_maintenance_jobs'); } finally { db.close(); }
  await assert.rejects(f.reader.inspectStopped('get', job().id), MaintenanceJournalUnavailable);
  const check = new DatabaseSync(f.file, { readOnly: true });
  try { assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='connector_maintenance_jobs'").get(), undefined); }
  finally { check.close(); }
});

test('stopped observation rejects a replaced original inode rather than selecting a new journal', async t => {
  const f = await fixture(t); await f.stop(); renameSync(f.file, f.file + '.original');
  const db = new DatabaseSync(f.file); db.close(); chmodSync(f.file, 0o600);
  await assert.rejects(f.reader.inspectStopped('get', job().id), MaintenanceJournalUnavailable);
});

test('independent receipt consumers cannot mutate a joined read or enable writer admission', async t => {
  const f = await fixture(t); await f.stop();
  const [first, second] = await Promise.all([f.reader.inspectStopped('get', job().id), f.reader.inspectStopped('get', job().id)]);
  assert.deepEqual(first, second); first!.actorId = 'changed';
  assert.deepEqual(second, job()); assert.deepEqual(await f.reader.inspectStopped('get', job().id), job());
  await assert.rejects(f.owner.enqueue(job()), MaintenanceJournalUnavailable);
});

test('a read-only SQL refusal is latched even if somebody later repairs the file', async t => {
  const f = await fixture(t); await f.stop();
  const db = new DatabaseSync(f.file);
  try { db.exec('ALTER TABLE connector_maintenance_jobs RENAME TO hidden_receipts'); } finally { db.close(); }
  await assert.rejects(f.reader.inspectStopped('get', job().id), MaintenanceJournalUnavailable);
  const reader = (f.owner as unknown as { stoppedReader: AsyncMaintenanceJournal }).stoppedReader;
  const repair = new DatabaseSync(f.file);
  try { repair.exec('ALTER TABLE hidden_receipts RENAME TO connector_maintenance_jobs'); } finally { repair.close(); }
  await assert.rejects(f.reader.inspectStopped('get', job().id), MaintenanceJournalUnavailable);
  assert.equal((f.owner as unknown as { stoppedReader: AsyncMaintenanceJournal }).stoppedReader, reader);
  assert.equal(reader.snapshot().unavailable, true);
});

test('every stopped observation checks original inode, including after reader startup', async t => {
  const f = await fixture(t); await f.stop();
  assert.deepEqual(await f.reader.inspectStopped('get', job().id), job());
  renameSync(f.file, f.file + '.original');
  const replacement = new DatabaseSync(f.file); replacement.close(); chmodSync(f.file, 0o600);
  await assert.rejects(f.reader.inspectStopped('get', job().id), MaintenanceJournalUnavailable);
  const reader = (f.owner as unknown as { stoppedReader: AsyncMaintenanceJournal }).stoppedReader;
  assert.equal(reader.snapshot().unavailable, true);
});

test('close drains an admitted observation and fences its result without replacing the reader', async t => {
  const f = await fixture(t); await f.stop();
  const observed = f.reader.inspectStopped('get', job().id);
  const denied = assert.rejects(observed, MaintenanceJournalUnavailable);
  const reader = (f.owner as unknown as { stoppedReader: AsyncMaintenanceJournal }).stoppedReader;
  await f.owner.close(); await denied;
  assert.equal(reader.snapshot().ownerExitConfirmed, true);
  await assert.rejects(f.reader.inspectStopped('get', job().id), MaintenanceJournalUnavailable);
  assert.equal((f.owner as unknown as { stoppedReader: AsyncMaintenanceJournal }).stoppedReader, reader);
});
