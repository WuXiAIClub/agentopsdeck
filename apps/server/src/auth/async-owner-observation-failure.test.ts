import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { AuthPersistenceError } from './private-store.js';
import { createDeckSession } from './passkeys.js';
import { PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';

type Fault = 'start' | 'add' | 'reportPending' | 'finish';
class FailingObservation extends PerformanceDiagnostics {
  calls = 0;
  constructor(private readonly fault: Fault) { super(() => {}); }
  override start(operation: Parameters<PerformanceDiagnostics['start']>[0]): PerformanceTrace {
    if (operation !== 'auth-sqlite-command') return super.start(operation);
    const fail = (phase: Fault) => { if (phase === this.fault) { this.calls++; throw Error('private-observer-failure'); } };
    fail('start');
    return { add: () => fail('add'), reportPending: () => fail('reportPending'), finish: () => fail('finish') };
  }
}
class Transport extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
  reply(index: number, ok = true) {
    const message = this.messages[index]!;
    this.emit('message', ok ? { id: message.id, kind: message.kind, ok: true, body: message.kind === 'close' ? 'null' : 'false' }
      : { id: message.id, kind: message.kind, ok: false });
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext, fault: Fault) {
  const worker = new Transport(), diagnostics = new FailingObservation(fault);
  const owner = new AsyncSqliteAuthOwner({ file: 'isolated-owner-observation-fixture', legacyFiles: [] },
    diagnostics, () => worker as unknown as Worker, 2);
  t.after(async () => { worker.emit('exit', 1); await owner.closeForShutdown(); });
  worker.emit('message', { kind: 'ready' });
  return { worker, diagnostics, owner };
}
for (const fault of ['start', 'add', 'reportPending', 'finish'] as const) {
  test(`command observer ${fault} failure cannot lose an ACK or release the original reservation before settlement`, async t => {
    const h = fixture(t, fault);
    const command = h.owner.command('sessionCurrent', { token: createDeckSession() }); void command.catch(() => {});
    await delay(12);
    assert.equal(h.worker.messages.length, 1); assert.equal(h.owner.snapshot().accepted, 1);
    assert.equal(h.owner.snapshot().pending, 1); assert.ok(h.owner.snapshot().acceptedBytes > 0);
    h.worker.reply(0); assert.equal(await command, false);
    assert.equal(h.owner.snapshot().accepted, 0); assert.equal(h.owner.snapshot().acceptedBytes, 0);
    assert.ok(h.diagnostics.calls > 0); assert.equal(h.owner.snapshot().unavailable, false);
    const fresh = h.owner.command('sessionCurrent', { token: createDeckSession() }); await turn();
    h.worker.reply(1); assert.equal(await fresh, false); assert.equal(h.worker.messages.length, 2);
    const close = h.owner.close(); await turn();
    h.worker.reply(2); await turn();
    assert.equal(h.owner.snapshot().closeAcknowledged, true); assert.equal(h.owner.snapshot().ownerExitConfirmed, false);
    h.worker.emit('exit', 0); await close;
  });
  test(`command observer ${fault} failure preserves an unknown original outcome without replay or replacement`, async t => {
    const h = fixture(t, fault);
    const rejection = assert.rejects(h.owner.command('sessionCurrent', { token: createDeckSession() }),
      error => error instanceof AuthPersistenceError && error.message === 'auth_persistence_failed');
    await delay(12); assert.equal(h.worker.messages.length, 1);
    h.worker.reply(0, false); await rejection;
    assert.equal(h.worker.messages.length, 1); assert.equal(h.owner.snapshot().accepted, 0);
    assert.equal(h.owner.snapshot().acceptedBytes, 0); assert.equal(h.owner.snapshot().unavailable, false);
  });
  test(`command observer ${fault} failure preserves pre-dispatch invalid-input refusal`, async t => {
    const h = fixture(t, fault);
    await assert.rejects(h.owner.command('sessionCurrent', { token: 'invalid' }), AuthPersistenceError);
    assert.equal(h.worker.messages.length, 0); assert.equal(h.owner.snapshot().accepted, 0);
    assert.equal(h.owner.snapshot().acceptedBytes, 0);
  });
  test(`command observer ${fault} failure cannot bypass the 256-original-command limit or block its later recovery`, async t => {
    const h = fixture(t, fault);
    const commands = Array.from({ length: 256 }, () => h.owner.command('sessionCurrent', { token: createDeckSession() }));
    const originalResults = Promise.all(commands); void originalResults.catch(() => {});
    await turn();
    assert.equal(h.owner.snapshot().accepted, 256); assert.equal(h.worker.messages.length, 256);
    await assert.rejects(h.owner.command('sessionCurrent', { token: createDeckSession() }), AuthPersistenceError);
    assert.equal(h.worker.messages.length, 256); assert.equal(h.owner.snapshot().accepted, 256);
    for (let i = 0; i < 256; i++) h.worker.reply(i);
    assert.deepEqual(await originalResults, Array(256).fill(false));
    assert.equal(h.owner.snapshot().accepted, 0); assert.equal(h.owner.snapshot().acceptedBytes, 0);
    const fresh = h.owner.command('sessionCurrent', { token: createDeckSession() }); await turn(); h.worker.reply(256);
    assert.equal(await fresh, false); assert.equal(h.worker.messages.length, 257);
  });
}
test('faulty command finish observation cannot hide a real committed auth session or cause duplicate issuance', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-owner-observation-')); chmodSync(dir, 0o700);
  const digest = 'a'.repeat(64), diagnostics = new FailingObservation('finish');
  const owner = new AsyncSqliteAuthOwner({ file: join(dir, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: digest }, diagnostics);
  t.after(async () => { await owner.closeForShutdown(); rmSync(dir, { recursive: true, force: true }); });
  await owner.open(); const token = createDeckSession();
  assert.equal(await owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } }), null);
  assert.equal(await owner.command('sessionCurrent', { token }), true);
  assert.equal(owner.snapshot().accepted, 0); assert.equal(owner.snapshot().acceptedBytes, 0);
  assert.equal(owner.snapshot().unavailable, false); assert.equal(diagnostics.calls, 2);
  await owner.close(); assert.equal(owner.snapshot().ownerExitConfirmed, true);
  const reopened = new AsyncSqliteAuthOwner({ file: join(dir, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: digest },
    new PerformanceDiagnostics(() => {}));
  try { await reopened.open(); assert.equal(await reopened.command('sessionCurrent', { token }), true); }
  finally { await reopened.closeForShutdown(); }
});
