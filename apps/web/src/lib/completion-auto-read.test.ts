import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { completionViewReadable, createCompletionAutoRead, finalReplyExposed, finalReplyMatchesTurn, type ReadIdentity } from './completion-auto-read.js';

const identity: ReadIdentity = { scope: 'alice', epoch: 1, sessionKey: 'session', turnId: 'turn', replyId: 'reply' };
test('foreground, focus, activity and synchronized final history are all necessary', () => {
  const view = { foreground: true, focused: true, online: true, ready: true, active: true, collapsed: false, dimmed: false, synchronized: true, completed: true };
  assert.equal(completionViewReadable(view), true);
  for (const key of Object.keys(view) as (keyof typeof view)[]) {
    assert.equal(completionViewReadable({ ...view, [key]: !view[key] }), false, key);
  }
});
function fixture() {
  let current: ReadIdentity | undefined = identity;
  const calls: string[] = [];
  let proof = { token: 'token', throughSequence: 3, turnId: 'turn' };
  let observed: (() => Promise<void>) | undefined, reading: (() => Promise<void>) | undefined;
  const reader = createCompletionAutoRead({ current: () => current,
    observe: async () => { calls.push('observe'); await observed?.(); return proof; },
    read: async (_key, value) => { calls.push(`read:${value.throughSequence}`); await reading?.(); },
    seen: () => { calls.push('seen'); },
  });
  return { reader, calls, setCurrent: (value: ReadIdentity | undefined) => { current = value; },
    setProof: (value: typeof proof) => { proof = value; },
    onObserve: (fn: () => Promise<void>) => { observed = fn; }, onRead: (fn: () => Promise<void>) => { reading = fn; } };
}
test('visible final tail is required: old history, clipped/offscreen and zero-size replies remain unread', () => {
  const viewport = { top: 100, bottom: 500, left: 20, right: 300 };
  assert.equal(finalReplyExposed({ top: 300, bottom: 480, left: 30, right: 280 }, viewport), true);
  assert.equal(finalReplyExposed({ top: -900, bottom: 480, left: 30, right: 280 }, viewport), true, 'long reply tail is visible');
  for (const reply of [
    { top: 600, bottom: 800, left: 30, right: 280 },
    { top: 50, bottom: 90, left: 30, right: 280 },
    { top: 300, bottom: 600, left: 30, right: 280 },
    { top: 300, bottom: 480, left: -400, right: 0 },
    { top: 480, bottom: 480, left: 30, right: 280 },
  ]) assert.equal(finalReplyExposed(reply, viewport), false);
});
test('final message needs current turn or current-run timestamp evidence', () => {
  const session = { runtime: { turnId: 'turn' }, runStartedAt: 100 } as SessionSummary;
  assert.equal(finalReplyMatchesTurn(session, { turnId: 'turn', createdAt: 110 } as ChatMessage), true);
  assert.equal(finalReplyMatchesTurn(session, { turnId: 'old', createdAt: 110 } as ChatMessage), false);
  assert.equal(finalReplyMatchesTurn(session, { createdAt: 110 } as ChatMessage), true);
  assert.equal(finalReplyMatchesTurn(session, { createdAt: 90 } as ChatMessage), false);
  assert.equal(finalReplyMatchesTurn({ runtime: { turnId: 'turn' } } as SessionSummary, { createdAt: 110 } as ChatMessage), false);
  assert.equal(finalReplyMatchesTurn(session, undefined), false);
});
test('qualifying view observes and ACKs only that ceiling, once', async () => {
  const f = fixture(); await f.reader.attempt(); await f.reader.attempt();
  assert.deepEqual(f.calls, ['observe', 'read:3', 'seen']);
});
test('background/inactive/unloaded view supplies no identity and cannot ACK', async () => {
  const f = fixture(); f.setCurrent(undefined); await f.reader.attempt(); assert.deepEqual(f.calls, []);
});
test('hidden view or navigation during observation prevents ACK', async () => {
  for (const next of [undefined, { ...identity, sessionKey: 'other' }, { ...identity, scope: 'bob' }, { ...identity, epoch: 2 }, { ...identity, replyId: 'other' }]) {
    const f = fixture(); f.onObserve(async () => { f.setCurrent(next); }); await f.reader.attempt();
    assert.deepEqual(f.calls, ['observe']);
  }
});
test('server successor completed before observation is never cleared by an old rendered reply', async () => {
  const f = fixture(); f.setProof({ token: 'new', throughSequence: 4, turnId: 'successor' });
  await f.reader.attempt(); assert.deepEqual(f.calls, ['observe']);
});
test('missing legacy proof identity and malformed ceilings fail closed', async () => {
  for (const proof of [{ token: 'token', throughSequence: 3 }, { token: 'token', throughSequence: 0, turnId: 'turn' },
    { token: 'token', throughSequence: 1.5, turnId: 'turn' }]) {
    const f = fixture(); f.setProof(proof as { token: string; throughSequence: number; turnId: string });
    await f.reader.attempt(); assert.deepEqual(f.calls, ['observe']);
  }
});
test('late ACK does not publish local seen into a successor or different account', async () => {
  const f = fixture(); f.onRead(async () => { f.setCurrent({ ...identity, turnId: 'next', replyId: 'next-reply' }); });
  await f.reader.attempt(); assert.deepEqual(f.calls, ['observe', 'read:3']);
});
test('observation/read failures retain unread and may retry', async () => {
  for (const step of ['observe', 'read'] as const) {
    const f = fixture(); const fail = async () => { throw Error('offline'); };
    if (step === 'observe') f.onObserve(fail); else f.onRead(fail);
    await assert.rejects(f.reader.attempt(), /offline/);
    f.onObserve(async () => {}); f.onRead(async () => {}); await f.reader.attempt();
    assert.equal(f.calls.at(-1), 'seen');
  }
});
test('scroll/focus bursts do not duplicate an in-flight observation', async () => {
  const f = fixture(); let release!: () => void;
  f.onObserve(() => new Promise<void>(resolve => { release = resolve; }));
  const first = f.reader.attempt(); await f.reader.attempt(); release(); await first;
  assert.deepEqual(f.calls, ['observe', 'read:3', 'seen']);
});
