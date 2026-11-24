import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AutomationStore } from './automation-store.js';
import { AutomationRunner } from './automation-runner.js';
import { AutomationTurnQueueAdapter } from './automation-queue-adapter.js';
import { AutomationScheduler } from './automation-scheduler.js';
import { TurnQueue } from './turn-queue.js';
import type { AutomationObservation, AutomationRule, CompletionTrigger } from './automation-policy.js';

const start = 1_000_000;
function fixture(t: TestContext, mode: AutomationRule['mode'] = { kind: 'interval', intervalMs: 60_000 }) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let now = start, allowed = true, online = true, busy = false, lostAck = false, calls = 0;
  const queue = new TurnQueue(db), store = new AutomationStore(db, () => now);
  const target = { ownerId: 'owner', connectionId: 'conn', runtime: 'codex', sessionId: 'codex:test' };
  const rule: AutomationRule = { id: 'schedule', revision: 1, authorityEpoch: 1, target, enabled: true,
    startsAt: start, expiresAt: start + 86_400_000, maxSends: 3, maxPerHour: 3, minIntervalMs: 60_000, mode };
  store.save('owner', rule, 'test', 0);
  const observe = (): AutomationObservation => ({ now, connectedSince: start, target,
    revision: store.read('owner', rule.id)!.rule.revision, authorityEpoch: store.read('owner', rule.id)!.rule.authorityEpoch,
    online, idle: !busy, queueEmpty: !queue.hasPending('codex', target.sessionId), admissionAllowed: true });
  const adapter = new AutomationTurnQueueAdapter(db, queue, store, observe, () => allowed, async (command, commit) => {
    calls++;
    queue.enqueue('codex', { id: randomUUID(), sessionKey: command.target.sessionId, createdAt: now,
      payload: { actorId: 'owner', text: command.template } }, commit);
    if (lostAck) throw Error('fixture ACK lost');
  });
  const runner = new AutomationRunner(store, adapter, () => allowed);
  const scheduler = new AutomationScheduler('owner', store, runner, observe, () => allowed, () => now);
  t.after(() => scheduler.stop());
  const completion = (): CompletionTrigger => ({ kind: 'completion', turnId: 'turn', startedAt: start,
    completedAt: now, outcome: 'completed', operation: 'message', authoritative: true, historical: false, origin: 'manual' });
  return { db, queue, store, rule, scheduler, runner, target, observe, completion,
    calls: () => calls, at: (n: number) => { now = n; }, offline: () => { online = false; },
    busy: (b: boolean) => { busy = b; }, revoke: () => { allowed = false; }, loseAck: () => { lostAck = true; },
    clearQueue: () => db.exec('DELETE FROM connector_turns') };
}

test('construction and startup do not send; due slot enters real queue only once', async t => {
  const f = fixture(t);
  assert.equal((await f.scheduler.tick()).considered, 0);
  f.scheduler.start(false); f.scheduler.start(false);
  assert.equal((await f.scheduler.tick()).dispatched, 0);
  f.at(start + 60_000);
  assert.equal((await f.scheduler.tick()).dispatched, 1);
  assert.equal((await f.scheduler.tick()).considered, 0);
  assert.equal(f.calls(), 1); assert.equal(f.queue.maintenanceCount(), 1);
});
test('late tick skips history, advances directly to future, restart never catches up', async t => {
  const f = fixture(t); f.scheduler.start(false); f.at(start + 180_001);
  assert.equal((await f.scheduler.tick()).rejected, 1);
  assert.equal(f.calls(), 0);
  f.at(start + 240_000); assert.equal((await f.scheduler.tick()).dispatched, 1);
  f.clearQueue(); f.scheduler.stop(); f.at(start + 600_000); f.scheduler.start(false);
  assert.equal((await f.scheduler.tick()).considered, 0);
  f.at(start + 660_000); assert.equal((await f.scheduler.tick()).dispatched, 1);
});
for (const gate of ['offline', 'busy', 'revoked'] as const) test(`${gate} skips slot without retry after gate clears`, async t => {
  const f = fixture(t); f.scheduler.start(false); f.at(start + 60_000);
  if (gate === 'offline') f.offline();
  if (gate === 'busy') f.busy(true);
  if (gate === 'revoked') f.revoke();
  assert.equal((await f.scheduler.tick()).rejected, 1);
  f.busy(false);
  assert.equal((await f.scheduler.tick()).considered, 0); assert.equal(f.calls(), 0);
});
test('clock rollback does not revisit slots, stopped scheduler does nothing', async t => {
  const f = fixture(t); f.scheduler.start(false); f.at(start + 60_000); await f.scheduler.tick();
  f.clearQueue(); f.at(start + 1); assert.equal((await f.scheduler.tick()).considered, 0);
  f.at(start + 60_000); assert.equal((await f.scheduler.tick()).considered, 0);
  f.scheduler.stop(); f.at(start + 120_000); assert.equal((await f.scheduler.tick()).considered, 0);
  assert.equal(f.calls(), 1);
});
test('rule edit replaces schedule without catchup and revoked tombstone never fires', async t => {
  const f = fixture(t); f.scheduler.start(false); f.at(start + 60_000);
  f.store.save('owner', { ...f.rule, revision: 2, authorityEpoch: 2 }, 'new', 1);
  assert.equal((await f.scheduler.tick()).considered, 0);
  f.at(start + 120_000); assert.equal((await f.scheduler.tick()).dispatched, 1);
  f.clearQueue(); f.store.revoke('owner', f.rule.id, 2);
  f.at(start + 180_000); assert.equal((await f.scheduler.tick()).considered, 0);
});
test('lost ACK stays occupied and is never retried by scheduler; durable count survives restart', async t => {
  const f = fixture(t); f.scheduler.start(false); f.loseAck();
  for (let n = 1; n <= 4; n++) { f.at(start + n * 60_000); await f.scheduler.tick(); f.clearQueue(); }
  assert.equal(f.calls(), 3);
  assert.equal(f.db.prepare("SELECT count(*) n FROM automation_reservations WHERE state='unknown'").get()!.n, 3);
  f.scheduler.stop(); f.scheduler.start(false); f.at(start + 300_000); await f.scheduler.tick();
  assert.equal(f.calls(), 3);
});
test('once timing is future-only and cannot fire twice', async t => {
  const f = fixture(t, { kind: 'once', at: start + 60_000 }); f.scheduler.start(false);
  f.at(start + 60_000); assert.equal((await f.scheduler.tick()).dispatched, 1);
  f.clearQueue(); f.at(start + 120_000); assert.equal((await f.scheduler.tick()).considered, 0);
});
test('trusted current completion fires once; historical, foreign and failed evidence cannot send', async t => {
  const f = fixture(t, { kind: 'completion', allowOwnTurns: false }); f.scheduler.start(false); f.at(start + 60_000);
  const event = f.completion();
  for (const invalid of [{ ...event, historical: true }, { ...event, authoritative: false },
    { ...event, outcome: 'failed' as const }, { ...event, operation: 'compact' as const },
    { ...event, origin: 'automation' as const, originRuleId: f.rule.id },
    { ...event, completedAt: start - 1 }]) {
    assert.equal((await f.scheduler.completed(f.target, invalid)).dispatched, 0);
  }
  assert.equal((await f.scheduler.completed({ ...f.target, connectionId: 'old' }, event)).considered, 0);
  assert.equal((await f.scheduler.completed(f.target, event)).dispatched, 1);
  f.clearQueue(); assert.equal((await f.scheduler.completed(f.target, event)).dispatched, 0);
  assert.equal(f.calls(), 1);
});
test('owner enumeration isolates templates and does not create schema on read', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = new AutomationStore(db);
  assert.deepEqual(store.list('owner'), []);
  assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master').get()!.n, 0);
  const f = fixture(t); assert.equal(f.store.list('owner').length, 1); assert.deepEqual(f.store.list('other'), []);
});
test('global concurrency bound skips excess triggers, with no deferred queue or overlapping tick', async t => {
  const f = fixture(t); let active = 0, maximum = 0, calls = 0;
  for (let i = 0; i < 8; i++) f.store.save('owner', { ...f.rule, id: `r${i}` }, 'test', 0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new AutomationScheduler('owner', f.store, { dispatch: async () => {
    calls++; active++; maximum = Math.max(maximum, active); await gate; active--;
    throw Error('fixture unknown');
  } }, () => f.observe(), () => true, () => f.observe().now);
  t.after(() => scheduler.stop()); scheduler.start(false); f.at(start + 60_000);
  const first = scheduler.tick(); assert.equal((await scheduler.tick()).busy, true);
  release(); assert.equal((await first).busy, true);
  assert.equal(maximum, 4); assert.equal(calls, 4);
  assert.equal((await scheduler.tick()).considered, 0);
});
