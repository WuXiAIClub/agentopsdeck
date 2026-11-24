import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationStore } from './automation-store.js';
import { AutomationRunner, automationQueueCommand } from './automation-runner.js';
import { AutomationTurnQueueAdapter, type AutomationRuntimeObservation } from './automation-queue-adapter.js';
import { TurnQueue } from './turn-queue.js';
import type { AutomationRule } from './automation-policy.js';

const at = 1000000;
const target = { ownerId: 'alice', connectionId: 'connection1', runtime: 'codex', sessionId: 'codex:session' };
const rule: AutomationRule = { id: 'rule', revision: 1, authorityEpoch: 1, target,
  enabled: true, startsAt: at, expiresAt: at + 3600000, maxSends: 3, maxPerHour: 3,
  minIntervalMs: 60000, mode: { kind: 'interval', intervalMs: 60000 } };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'automation-queue-')), path = join(root, 'queue.sqlite');
  let db = new DatabaseSync(path), maintenance = false, allowed = true, calls = 0, lostAck = false;
  let beforeCommit = () => {}, senderActor: string | undefined = 'alice';
  const observe: AutomationRuntimeObservation = { now: at, connectedSince: at - 1, online: true, idle: true, admissionAllowed: true };
  let queue = new TurnQueue(db, undefined, undefined, () => true, () => !maintenance);
  let store = new AutomationStore(db, () => observe.now);
  store.save('alice', rule, 'fixture message', 0);
  const receipt = store.reserve('alice', rule.id, { kind: 'timer', at, slot: 0 }, { ...observe, target, revision: 1, authorityEpoch: 1, queueEmpty: true });
  const sender = async (command: Parameters<ConstructorParameters<typeof AutomationTurnQueueAdapter>[5]>[0], commit: Parameters<TurnQueue['enqueue']>[2]) => {
    calls++; beforeCommit();
    queue.enqueue('codex', { id: randomUUID(), sessionKey: target.sessionId,
      payload: { text: command.template, ...(senderActor ? { actorId: senderActor } : {}) }, createdAt: observe.now }, commit);
    if (lostAck) throw Error('lost ACK after queue COMMIT');
  };
  const authorized = (value: typeof target) => allowed && value.ownerId === 'alice' && value.connectionId === target.connectionId;
  let adapter = new AutomationTurnQueueAdapter(db, queue, store, () => ({ ...observe }), authorized, sender);
  let runner = new AutomationRunner(store, adapter, owner => owner === 'alice' && allowed);
  function reopen() {
    db.close(); db = new DatabaseSync(path);
    queue = new TurnQueue(db, undefined, undefined, () => true, () => !maintenance);
    store = new AutomationStore(db, () => observe.now);
    adapter = new AutomationTurnQueueAdapter(db, queue, store, () => ({ ...observe }), authorized, sender);
    runner = new AutomationRunner(store, adapter, owner => owner === 'alice' && allowed);
  }
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, get queue() { return queue; }, get store() { return store; }, get runner() { return runner; },
    get adapter() { return adapter; }, receipt, observe, reopen, calls: () => calls,
    setMaintenance: () => { maintenance = true; }, revoke: () => { allowed = false; },
    before: (fn: () => void) => { beforeCommit = fn; }, loseAck: () => { lostAck = true; },
    senderActor: (actor?: string) => { senderActor = actor; } };
}
for (const actor of [undefined, 'mallory']) test(`actual queue rejects ${actor ?? 'missing'} automation actor without a receipt`, async t => {
  const f = fixture(t); f.senderActor(actor);
  assert.equal((await f.runner.dispatch('alice', f.receipt.requestId)).state, 'unknown');
  assert.equal(f.queue.maintenanceCount(), 0);
  assert.equal(Number(f.db.prepare('SELECT count(*) n FROM automation_queue_receipts').get()!.n), 0);
});
test('actual queue admission and immutable original receipt commit atomically, once', async t => {
  const f = fixture(t);
  assert.equal((await f.runner.dispatch('alice', f.receipt.requestId)).state, 'queued');
  assert.equal(f.queue.maintenanceCount(), 1);
  await f.runner.dispatch('alice', f.receipt.requestId); assert.equal(f.calls(), 1);
  const turn = f.queue.head('codex', target.sessionId)!;
  assert.equal((turn.payload as { text: string }).text, 'fixture message');
  f.db.prepare('DELETE FROM connector_turns').run(); f.reopen();
  const command = automationQueueCommand(f.receipt);
  assert.equal((await f.adapter.queryOriginal(target, command.requestId, command.fingerprint)).outcome, 'accepted');
});
test('lost ACK and physical restart only query original; queue is never duplicated', async t => {
  const f = fixture(t); f.loseAck();
  assert.equal((await f.runner.dispatch('alice', f.receipt.requestId)).state, 'unknown');
  f.reopen();
  assert.equal((await f.runner.recover('alice', f.receipt.requestId)).state, 'queued');
  assert.equal(f.queue.maintenanceCount(), 1); assert.equal(f.calls(), 1);
});
for (const change of ['maintenance', 'busy', 'offline', 'admission', 'goal', 'paused-rule', 'manual-queue', 'expired', 'clock'] as const) {
  test(`fresh ${change} fence rolls back actual queue row and receipt`, async t => {
    const f = fixture(t);
    f.before(() => {
      if (change === 'maintenance') f.setMaintenance();
      if (change === 'busy' || change === 'goal') f.observe.idle = false;
      if (change === 'offline') f.observe.online = false;
      if (change === 'admission') f.observe.admissionAllowed = false;
      if (change === 'paused-rule') f.store.save('alice', { ...rule, revision: 2, authorityEpoch: 2, enabled: false }, 'fixture message', 1);
      if (change === 'manual-queue') f.queue.enqueue('codex', { id: 'manual', sessionKey: target.sessionId, payload: {}, createdAt: at });
      if (change === 'expired') f.observe.now = rule.expiresAt;
      if (change === 'clock') f.observe.now = at - 1;
    });
    if (change === 'clock') {
      await assert.rejects(f.runner.dispatch('alice', f.receipt.requestId), /clock/);
      assert.equal(f.store.receipt('alice', f.receipt.requestId)!.state, 'dispatching');
      f.observe.now = at;
      assert.equal((await f.runner.recover('alice', f.receipt.requestId)).state, 'unknown');
    } else {
      assert.equal((await f.runner.dispatch('alice', f.receipt.requestId)).state, 'unknown');
    }
    assert.equal(f.queue.maintenanceCount(), change === 'manual-queue' ? 1 : 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM automation_queue_receipts').get()!.n, 0);
  });
}
test('permission revoked at commit never queues or leaks original evidence', async t => {
  const f = fixture(t); f.before(f.revoke);
  await assert.rejects(f.runner.dispatch('alice', f.receipt.requestId), /forbidden/);
  assert.equal(f.queue.maintenanceCount(), 0);
});
test('receipt persistence failure rolls back native queue insertion and keeps unknown occupied', async t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON automation_queue_receipts BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.equal((await f.runner.dispatch('alice', f.receipt.requestId)).state, 'unknown');
  assert.equal(f.queue.maintenanceCount(), 0);
  assert.equal((await f.runner.recover('alice', f.receipt.requestId)).state, 'unknown');
  assert.equal(f.calls(), 1);
});
test('foreign connection or fingerprint cannot recover someone else original receipt', async t => {
  const f = fixture(t); await f.runner.dispatch('alice', f.receipt.requestId);
  const command = automationQueueCommand(f.receipt);
  await assert.rejects(f.adapter.queryOriginal({ ...target, connectionId: 'other' }, command.requestId, command.fingerprint), /forbidden/);
  await assert.rejects(f.adapter.queryOriginal(target, command.requestId, 'wrong'), /identity/);
});
