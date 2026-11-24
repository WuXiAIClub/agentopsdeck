import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AutomationStore } from './automation-store.js';
import { AutomationRunner, type AutomationQueueAdapter, type AutomationQueueCommand, type AutomationQueueEvidence } from './automation-runner.js';
import type { AutomationRule, AutomationObservation } from './automation-policy.js';

const start = 1_000_000;
const rule: AutomationRule = { id: 'rule', revision: 1, authorityEpoch: 1,
  target: { ownerId: 'owner', connectionId: 'connector', runtime: 'codex', sessionId: 'session' },
  enabled: true, startsAt: start, expiresAt: start + 86400000, maxSends: 3, maxPerHour: 3,
  minIntervalMs: 60000, mode: { kind: 'interval', intervalMs: 60000 } };
async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const db = new DatabaseSync(':memory:'); try { await run(setup(db)); } finally { db.close(); }
}
function setup(db: DatabaseSync) {
  const store = new AutomationStore(db, () => start);
  store.save('owner', rule, 'synthetic authorized template', 0);
  const view: AutomationObservation = { now: start, connectedSince: start - 1, target: rule.target, revision: 1, authorityEpoch: 1,
    online: true, idle: true, queueEmpty: true, admissionAllowed: true };
  const receipt = store.reserve('owner', 'rule', { kind: 'timer', at: start, slot: 0 }, view);
  let allowed = true, sends = 0, queries = 0;
  const results = new Map<string, AutomationQueueEvidence>();
  const adapter: AutomationQueueAdapter = {
    withAdmission: async (_target, callback) => callback(view, async command => {
      assert.equal(db.isTransaction, false, 'dispatch claim must be durable before IO');
      assert.equal(store.receipt('owner', command.requestId)!.state, 'dispatching');
      sends++; const evidence = { requestId: command.requestId, fingerprint: command.fingerprint, outcome: 'accepted' as const };
      results.set(command.requestId, evidence); return evidence;
    }),
    queryOriginal: async (_target, id, fingerprint) => { queries++; return results.get(id) ?? { requestId: id, fingerprint, outcome: 'unknown' }; },
  };
  const runner = new AutomationRunner(store, adapter, owner => allowed && owner === 'owner');
  return { db, store, view, receipt, adapter, runner, results, revoke: () => { allowed = false; }, counts: () => ({ sends, queries }) };
}
test('durable claim enqueues once; queue acceptance is not native completion', () => fixture(async f => {
  const [a, b] = await Promise.all([f.runner.dispatch('owner', f.receipt.requestId), f.runner.dispatch('owner', f.receipt.requestId)]);
  assert.ok([a.state, b.state].includes('queued')); assert.equal(f.counts().sends, 1);
  await f.runner.dispatch('owner', f.receipt.requestId); assert.equal(f.counts().sends, 1);
}));
test('lost ACK only queries original and never resends even through a new runner', () => fixture(async f => {
  const admission = f.adapter.withAdmission.bind(f.adapter);
  f.adapter.withAdmission = (target, run, context) => admission(target, (view, enqueue) => run(view, async command => { await enqueue(command); throw Error('lost ack'); }), context);
  assert.equal((await f.runner.dispatch('owner', f.receipt.requestId)).state, 'unknown');
  const reopened = new AutomationRunner(f.store, f.adapter, () => true);
  assert.equal((await reopened.dispatch('owner', f.receipt.requestId)).state, 'unknown');
  assert.equal((await reopened.recover('owner', f.receipt.requestId)).state, 'queued');
  assert.deepEqual(f.counts(), { sends: 1, queries: 1 });
}));
test('authority and busy admission are rechecked after fence acquisition before queue IO', () => fixture(async f => {
  const original = f.adapter.withAdmission.bind(f.adapter);
  f.adapter.withAdmission = (target, run, context) => original(target, (view, enqueue) => { view.queueEmpty = false; return run(view, enqueue); }, context);
  await assert.rejects(f.runner.dispatch('owner', f.receipt.requestId));
  assert.equal(f.store.receipt('owner', f.receipt.requestId)!.state, 'reserved');
  f.view.queueEmpty = true;
  f.adapter.withAdmission = (target, run, context) => original(target, (view, enqueue) => { f.revoke(); return run(view, enqueue); }, context);
  await assert.rejects(f.runner.dispatch('owner', f.receipt.requestId), /forbidden/);
  assert.equal(f.counts().sends, 0);
}));
test('foreign or malformed queue evidence stays unknown and missing original is not rejection', () => fixture(async f => {
  f.adapter.withAdmission = async (_target, run) => run(f.view, async () => ({ requestId: 'wrong', fingerprint: 'wrong', outcome: 'accepted' }));
  assert.equal((await f.runner.dispatch('owner', f.receipt.requestId)).state, 'unknown');
  assert.equal((await f.runner.recover('owner', f.receipt.requestId)).state, 'unknown');
  await assert.rejects(f.runner.recover('other', f.receipt.requestId), /forbidden/);
}));
test('only confirmed non-acceptance settles rejection, without reusing request identity', () => fixture(async f => {
  f.adapter.withAdmission = async (_target, run) => run(f.view, async (command: AutomationQueueCommand) => ({ ...command, outcome: 'confirmed-not-accepted' }));
  assert.equal((await f.runner.dispatch('owner', f.receipt.requestId)).state, 'rejected');
  assert.equal((await f.runner.dispatch('owner', f.receipt.requestId)).state, 'rejected');
}));
test('late enqueue failure cannot undo success from concurrent original query', () => fixture(async f => {
  const original = f.adapter.withAdmission.bind(f.adapter);
  f.adapter.withAdmission = (target, run, context) => original(target, (view, enqueue) => run(view, async command => {
    await enqueue(command); await f.runner.recover('owner', command.requestId); throw Error('late timeout');
  }), context);
  assert.equal((await f.runner.dispatch('owner', f.receipt.requestId)).state, 'queued');
}));
test('revocation during enqueue hides the response and does not manufacture a rejection', () => fixture(async f => {
  const original = f.adapter.withAdmission.bind(f.adapter);
  f.adapter.withAdmission = (target, run, context) => original(target, (view, enqueue) => run(view, async command => { const result = await enqueue(command); f.revoke(); return result; }), context);
  await assert.rejects(f.runner.dispatch('owner', f.receipt.requestId), /forbidden/);
  assert.equal(f.store.receipt('owner', f.receipt.requestId)!.state, 'dispatching');
  assert.equal(f.counts().sends, 1);
}));
