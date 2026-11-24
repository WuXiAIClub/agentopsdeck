import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { HubStore } from './hub-store.js';
import { PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';

type Fault = 'start' | 'add' | 'reportPending' | 'finish';
class FailingObservation extends PerformanceDiagnostics {
  calls = 0;
  constructor(private readonly fault: Fault) { super(() => {}); }
  override start(operation: Parameters<PerformanceDiagnostics['start']>[0]): PerformanceTrace {
    if (operation !== 'hub-member-sqlite-command') return super.start(operation);
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
    this.emit('message', ok ? { id: message.id, kind: message.kind, ok: true, body: 'null' }
      : { id: message.id, kind: message.kind, ok: false });
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext, fault: Fault) {
  const worker = new Transport(), diagnostics = new FailingObservation(fault);
  const owner = new AsyncHubMemberOwner({ file: 'isolated-hub-observation-fixture', encryptionSecret: 'private-fixture-vault' },
    diagnostics, () => worker as unknown as Worker, 2);
  t.after(async () => { worker.emit('exit', 1); await owner.closeForShutdown(); });
  worker.emit('message', { kind: 'ready' });
  return { worker, diagnostics, owner };
}
for (const fault of ['start', 'add', 'reportPending', 'finish'] as const) {
  test(`command observer ${fault} failure cannot lose an ACK or release the original reservation before settlement`, async t => {
    const h = fixture(t, fault);
    const command = h.owner.command('memberSnapshot', {}); void command.catch(() => {});
    await delay(12);
    assert.equal(h.worker.messages.length, 1); assert.equal(h.owner.snapshot().accepted, 1);
    assert.equal(h.owner.snapshot().pending, 1); assert.ok(h.owner.snapshot().acceptedBytes > 0); assert.ok(h.owner.snapshot().acceptedResultBytes > 0);
    h.worker.reply(0); assert.equal(await command, null);
    assert.equal(h.owner.snapshot().accepted, 0); assert.equal(h.owner.snapshot().acceptedBytes, 0); assert.equal(h.owner.snapshot().acceptedResultBytes, 0);
    assert.ok(h.diagnostics.calls > 0); assert.equal(h.owner.snapshot().unavailable, false);
    const fresh = h.owner.command('memberSnapshot', {}); await turn();
    h.worker.reply(1); assert.equal(await fresh, null); assert.equal(h.worker.messages.length, 2);
    const close = h.owner.close(); await turn();
    h.worker.reply(2); await turn();
    assert.equal(h.owner.snapshot().closeAcknowledged, true); assert.equal(h.owner.snapshot().ownerExitConfirmed, false);
    h.worker.emit('exit', 0); await close;
  });
  test(`command observer ${fault} failure preserves an unknown original outcome without replay or replacement`, async t => {
    const h = fixture(t, fault);
    const rejection = assert.rejects(h.owner.command('memberSnapshot', {}),
      error => error instanceof HubMemberOwnerUnavailable && error.message === 'hub_member_storage_unavailable');
    await delay(12); assert.equal(h.worker.messages.length, 1);
    h.worker.reply(0, false); await rejection;
    assert.equal(h.worker.messages.length, 1); assert.equal(h.owner.snapshot().accepted, 0);
    assert.equal(h.owner.snapshot().acceptedBytes, 0); assert.equal(h.owner.snapshot().acceptedResultBytes, 0); assert.equal(h.owner.snapshot().unavailable, false);
  });
  test(`command observer ${fault} failure preserves pre-dispatch invalid-input refusal`, async t => {
    const h = fixture(t, fault);
    // A nonempty unknown credential is valid transport input: only its owner
    // can decide whether it names a current session. Empty is malformed.
    await assert.rejects(h.owner.command('memberSnapshot', { sessionToken: '' }), HubMemberOwnerUnavailable);
    assert.equal(h.worker.messages.length, 0); assert.equal(h.owner.snapshot().accepted, 0);
    assert.equal(h.owner.snapshot().acceptedBytes, 0); assert.equal(h.owner.snapshot().acceptedResultBytes, 0);
  });
  test(`command observer ${fault} failure cannot bypass the 256-original-command limit or block its later recovery`, async t => {
    const h = fixture(t, fault);
    const commands = Array.from({ length: 256 }, () => h.owner.command('memberSnapshot', {}));
    const originalResults = Promise.all(commands); void originalResults.catch(() => {});
    await turn();
    assert.equal(h.owner.snapshot().accepted, 256); assert.equal(h.worker.messages.length, 256);
    await assert.rejects(h.owner.command('memberSnapshot', {}), HubMemberOwnerUnavailable);
    assert.equal(h.worker.messages.length, 256); assert.equal(h.owner.snapshot().accepted, 256);
    for (let i = 0; i < 256; i++) h.worker.reply(i);
    assert.deepEqual(await originalResults, Array(256).fill(null));
    assert.equal(h.owner.snapshot().accepted, 0); assert.equal(h.owner.snapshot().acceptedBytes, 0); assert.equal(h.owner.snapshot().acceptedResultBytes, 0);
    const fresh = h.owner.command('memberSnapshot', {}); await turn(); h.worker.reply(256);
    assert.equal(await fresh, null); assert.equal(h.worker.messages.length, 257);
  });
}
test('faulty Hub command finish observation preserves original member-session COMMIT and same-data recovery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-observation-')); chmodSync(dir, 0o700);
  const file = join(dir, 'hub.sqlite'), secret = 'private-fixture-vault';
  const original = new HubStore(file, secret);
  let key: string;
  try { key = original.identities.issueKey('default').token; } finally { await original.close(); }
  const diagnostics = new FailingObservation('finish');
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: secret }, diagnostics);
  t.after(async () => { await owner.closeForShutdown(); rmSync(dir, { recursive: true, force: true }); });
  await owner.open(); const created = await owner.command('memberSessionCreate', { key }); assert.ok(created);
  const initial = await owner.command('memberSnapshot', { sessionToken: created.token }); assert.ok(initial);
  assert.equal(initial.principal.userId, 'default');
  assert.equal(owner.snapshot().accepted, 0); assert.equal(owner.snapshot().acceptedBytes, 0);
  assert.equal(owner.snapshot().acceptedResultBytes, 0); assert.equal(owner.snapshot().unavailable, false);
  assert.equal(diagnostics.calls, 2); await owner.close(); assert.equal(owner.snapshot().ownerExitConfirmed, true);
  const reopened = new AsyncHubMemberOwner({ file, encryptionSecret: secret }, new PerformanceDiagnostics(() => {}));
  try { await reopened.open(); assert.deepEqual(await reopened.command('memberSnapshot', { sessionToken: created.token }), initial); }
  finally { await reopened.closeForShutdown(); }
});
