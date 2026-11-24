import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAutomationCompletions } from './automation-completions.js';
import type { CodexExecution } from './executions.js';

function fixture() {
  const cache = new CodexAutomationCompletions();
  const fact = { commandId: 'command', connectionId: 'lease', runId: 'turn', phase: 'completed',
    nativeHistory: { state: 'verified', turnId: 'turn', connectionId: 'lease' } } as CodexExecution;
  cache.begin('session', 'command', 'lease', 'alice', 100);
  const ack = () => cache.acknowledge('session', 'command', 'lease', 'turn');
  const live = (outcome = 'completed') => cache.live('session', 'lease', 'turn', outcome, 200);
  const take = (owner = 'alice', lease = 'lease', at = 300, idle = true) => cache.take(owner, lease, at, () => fact, () => idle);
  return { cache, fact, ack, live, take };
}
test('live completion needs original ACK and verified idle; it is consumed once', () => {
  const f = fixture(); f.live(); assert.deepEqual(f.take(), []); f.ack();
  assert.deepEqual(f.take('bob'), []); assert.deepEqual(f.take('alice', 'lease', 300, false), []);
  assert.equal(f.take().length, 1); f.live(); assert.deepEqual(f.take(), []);
});
test('history terminal or ACK without live completion is never a trigger', () => {
  const f = fixture(); f.ack(); assert.deepEqual(f.take(), []);
});
for (const field of ['command', 'run', 'connection', 'history', 'successor', 'protection', 'failed', 'interrupted', 'reconnect', 'restart', 'expired', 'clock'] as const) {
  test(`completion rejects ${field} ambiguity without replay`, () => {
    const f = fixture(); f.ack(); f.live(field === 'failed' || field === 'interrupted' ? field : 'completed');
    if (field === 'command') f.fact.commandId = 'other';
    if (field === 'run') f.fact.runId = 'other';
    if (field === 'connection') f.fact.connectionId = 'other';
    if (field === 'history') f.fact.nativeHistory!.connectionId = 'other';
    if (field === 'successor') f.fact.nativeHistory!.turnId = 'successor';
    if (field === 'protection') f.fact.nativeHistory!.state = 'blocked';
    if (field === 'restart') f.cache.reset();
    assert.deepEqual(f.take('alice', field === 'reconnect' ? 'new' : 'lease', field === 'expired' ? 300201 : field === 'clock' ? 199 : 300), []);
  });
}
test('duplicate events do not refresh age and inconsistent early completion cannot acquire an ACK', () => {
  const f = fixture(); f.live(); f.cache.live('session', 'lease', 'turn', 'completed', 300000); f.ack();
  assert.deepEqual(f.take('alice', 'lease', 300201), []);
  const g = fixture(); g.live(); g.cache.acknowledge('session', 'command', 'lease', 'different'); g.ack(); assert.deepEqual(g.take(), []);
});
test('unowned new start clears old authority; cache is bounded, no oldest eviction replay', () => {
  const f = fixture(); f.ack(); f.live(); f.cache.begin('session', 'new', 'lease', undefined, 250); assert.deepEqual(f.take(), []);
  for (let i = 0; i < 513; i++) f.cache.begin(String(i), 'command', 'lease', 'alice', 100);
  f.cache.acknowledge('512', 'command', 'lease', 'turn'); f.cache.live('512', 'lease', 'turn', 'completed', 200);
  assert.deepEqual(f.take(), []);
});
