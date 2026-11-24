import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionExecutionSnapshot, SharedSessionAccessHints } from '@agentopsdeck/shared';
import { createSharedSessionLive, type SharedHistorySnapshot, type SharedLiveState } from './shared-session-live.js';
import { sessionAddress } from './session-address.js';

const target = { ownerUserId: 'owner-a', sessionId: 'node:c2Vzc2lvbg' };
const cursor = (n: number) => `ce1_11111111-1111-4111-8111-111111111111:${n}`;
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
class Source {
  readyState = 0;
  onopen?: () => void;
  onerror?: () => void;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(type: string, extra: object = {}, id = 'hub-replay-id:900') {
    this.listeners.get(type)?.({ type, data: JSON.stringify({ type, sessionKey: target.sessionId, ...extra }), lastEventId: id } as MessageEvent<string>);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const histories: Array<ReturnType<typeof deferred<SharedHistorySnapshot>>> = [];
  const executions: Array<ReturnType<typeof deferred<SessionExecutionSnapshot>>> = [];
  const sources: Source[] = [], states: SharedLiveState[] = [], signals: AbortSignal[] = [];
  let scope = 'account-a';
  const live = createSharedSessionLive({ target, scope: () => scope, url: () => '/exact-scoped-feed',
    history: signal => { signals.push(signal); const d = deferred<SharedHistorySnapshot>(); histories.push(d); return d.promise; },
    execution: signal => { signals.push(signal); const d = deferred<SessionExecutionSnapshot>(); executions.push(d); return d.promise; },
    onChange: state => states.push(state), createSource: url => { const source = new Source(url); sources.push(source); return source as unknown as EventSource; },
  });
  const history = (i: number, n = 1, access: SharedSessionAccessHints = { messagesSend: true, eventsRead: true }) => histories[i]!.resolve({ messages: [{ id: 'message', sessionKey: target.sessionId, role: 'assistant', text: `reply-${n}`, createdAt: n }], updatedAt: n, sourceCursor: cursor(n), access });
  const execution = (i: number, n = 1) => executions[i]!.resolve({ sessionKey: target.sessionId, status: 'running', hasActiveRun: true, sourceCursor: cursor(n) });
  return { live, histories, executions, sources, states, signals, history, execution,
    latest: () => states.at(-1)!, scope: (next: string) => { scope = next; } };
}

test('a newly verified session-scoped page acknowledges an earlier invalidation without a global cursor', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick();
  f.sources[0]!.open(); f.history(1); f.execution(1); await tick();
  f.sources[0]!.emit('session.invalidated', { sourceCursor: cursor(2) });
  f.histories[2]!.resolve({ messages: [], updatedAt: 2, historyStatus: 'verified-session',
    access: { messagesSend: true, eventsRead: true } });
  f.execution(2, 2); await tick();
  assert.equal(f.latest().historySync, 'ready');
  assert.equal(f.latest().history?.sourceCursor, undefined, 'session proof must not fabricate a Deck cursor');
  assert.equal(f.latest().executionSync, 'ready');
  assert.equal(f.histories.length, 3, 'a current session proof does not self-poll');
});

test('malformed cursor-bearing history cannot reuse prior session readiness and valid proof recovers independently', async t => {
  for (const historyStatus of ['verified-session', 'cached'] as const) {
    const f = fixture(); t.after(f.live.stop); f.live.start();
    const verified: SharedHistorySnapshot = { messages: [], updatedAt: 1, historyStatus: 'verified-session',
      access: { messagesSend: true, eventsRead: true } };
    f.histories[0]!.resolve(verified); f.execution(0); await tick();
    assert.equal(f.latest().historySync, 'ready');
    f.sources[0]!.open();
    f.histories[1]!.resolve({ ...verified, updatedAt: 999, historyStatus, sourceCursor: cursor(999),
      access: { messagesSend: false, eventsRead: false } });
    f.execution(1, 2); await tick();
    assert.equal(f.latest().historySync, 'unavailable');
    assert.equal(f.latest().history?.updatedAt, 1, 'malformed history must not replace the last valid display');
    assert.equal(f.latest().access?.messagesSend, true, 'malformed history does not supply policy authority either');
    assert.equal(f.latest().executionSync, 'ready', 'history failure does not fabricate execution failure');
    assert.equal(f.histories.length, 2, 'a malformed response must not start a self-polling loop');

    f.live.refresh(); f.histories[2]!.resolve({ ...verified, updatedAt: 2 }); f.execution(2, 3); await tick();
    assert.equal(f.latest().historySync, 'ready');
    assert.equal(f.latest().history?.updatedAt, 2);
    assert.equal(f.latest().history?.sourceCursor, undefined);
    assert.equal(f.latest().executionSync, 'ready');
    assert.equal(f.histories.length, 3);

    f.live.refresh();
    f.histories[3]!.resolve({ ...verified, updatedAt: 3, access: { messagesSend: false, eventsRead: false } });
    f.execution(3, 4); await tick();
    assert.equal(f.latest().historySync, 'ready', 'verified history is not send permission');
    assert.equal(f.latest().access?.messagesSend, false);
    assert.equal(f.sources[0]!.readyState, 2, 'revocation closes the existing event stream');
    f.live.stop();
  }
});

test('a session proof requested before a newer invalidation stays stale until a fresh request finishes', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick();
  f.sources[0]!.emit('session.invalidated', { sourceCursor: cursor(2) });
  f.sources[0]!.emit('session.invalidated', { sourceCursor: cursor(3) });
  f.histories[1]!.resolve({ messages: [], updatedAt: 2, historyStatus: 'verified-session',
    access: { messagesSend: true, eventsRead: true } });
  f.execution(1, 2); await tick();
  assert.equal(f.latest().historySync, 'stale');
  assert.equal(f.histories.length, 3);
  f.histories[2]!.resolve({ messages: [], updatedAt: 3, historyStatus: 'verified-session',
    access: { messagesSend: false, eventsRead: false } });
  f.execution(2, 3); await tick();
  assert.equal(f.latest().historySync, 'ready');
  assert.equal(f.latest().access?.messagesSend, false, 'fresh history is not send authorization');
  assert.equal(f.latest().executionSync, 'ready');
});

test('a session proof never refreshes execution authority and a subsequent cache stays display-only', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick();
  f.sources[0]!.open(); f.history(1); f.execution(1); await tick();
  f.sources[0]!.emit('session.invalidated', { sourceCursor: cursor(2) });
  f.histories[2]!.resolve({ messages: [], updatedAt: 2, historyStatus: 'verified-session',
    access: { messagesSend: true, eventsRead: true } });
  f.execution(2, 1); await tick();
  assert.equal(f.latest().historySync, 'ready');
  assert.equal(f.latest().executionSync, 'stale');
  f.execution(3, 1); await tick();
  f.live.refresh();
  f.histories[3]!.resolve({ messages: [], updatedAt: 3, historyStatus: 'cached',
    access: { messagesSend: false, eventsRead: false } });
  f.execution(4, 1); await tick();
  assert.equal(f.latest().historySync, 'stale');
  assert.equal(f.latest().access?.messagesSend, false);
  // The cache can request one bounded catch-up, but must never become ready.
  if (f.histories[4]) {
    f.histories[4].resolve({ messages: [], updatedAt: 4, historyStatus: 'cached' }); await tick();
  }
  assert.equal(f.latest().historySync, 'stale');
  assert.ok(f.histories.length <= 5, 'no cache self-polling');
});

test('a late verified history cannot revive a shared session denied by the execution read', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick();
  f.live.refresh();
  f.executions[1]!.reject(Object.assign(new Error('revoked'), { status: 403 })); await tick();
  f.histories[1]!.resolve({ messages: [], updatedAt: 2, historyStatus: 'verified-session',
    access: { messagesSend: true, eventsRead: true } }); await tick();
  assert.equal(f.latest().denied, true); assert.equal(f.latest().access, undefined);
  assert.equal(f.latest().history, undefined); assert.equal(f.latest().execution, undefined);
});

test('a session-scoped proof carrying a fabricated global cursor fails closed', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start();
  f.histories[0]!.resolve({ messages: [], updatedAt: 1, historyStatus: 'verified-session', sourceCursor: cursor(1),
    access: { messagesSend: true, eventsRead: true } }); f.execution(0); await tick();
  assert.equal(f.latest().historySync, 'unavailable');
  assert.equal(f.latest().history, undefined); assert.equal(f.latest().access, undefined);
});

test('independent snapshot lanes, exact message identity, no idle from socket failure', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start();
  f.execution(0); await tick();
  assert.equal(f.latest().execution?.status, 'running'); assert.equal(f.latest().historySync, 'loading');
  f.history(0); await tick();
  assert.equal(f.latest().history?.messages[0]?.sessionKey, sessionAddress(target).key);
  f.sources[0]!.open(); f.sources[0]!.onerror?.();
  assert.equal(f.latest().transport, 'reconnecting'); assert.equal(f.latest().execution?.hasActiveRun, true);
  f.histories[1]!.reject(new Error('network')); f.executions[1]!.reject(new Error('network')); await tick();
  assert.equal(f.latest().executionSync, 'unavailable'); assert.equal(f.latest().execution?.status, 'running');
});

test('burst invalidations coalesce, lagging snapshots catch up once, replay IDs never gate projection', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); await tick();
  for (let n = 2; n <= 100; n++) f.sources[0]!.emit('session.invalidated', { sourceCursor: cursor(n) });
  assert.equal(f.histories.length, 2); assert.equal(f.executions.length, 1);
  f.history(1); f.execution(0); await tick();
  assert.equal(f.latest().executionSync, 'stale'); assert.equal(f.executions.length, 2);
  f.history(2); f.execution(1); await tick();
  assert.equal(f.executions.length, 2, 'unchanged lag does not self-poll');
  f.sources[0]!.emit('session.invalidated', { sourceCursor: cursor(100) }); await tick();
  assert.equal(f.executions.length, 2, 'repeated hint does not spin');
  f.live.refresh(); f.history(3, 100); f.execution(2, 100); await tick();
  assert.equal(f.latest().historySync, 'ready'); assert.equal(f.latest().executionSync, 'ready');
});

test('history watermark cannot suppress execution lane catchup; regressed snapshots do not replace data', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0, 8); f.execution(0, 2); await tick();
  f.sources[0]!.open(); f.history(1, 8); f.execution(1, 2); await tick();
  f.sources[0]!.emit('session.invalidated', { sourceCursor: cursor(7) });
  assert.equal(f.histories.length, 2); assert.equal(f.executions.length, 3);
  f.execution(2, 7); await tick(); f.live.refresh(); f.history(2, 6); f.execution(3, 5); await tick();
  assert.equal(f.latest().history?.updatedAt, 8); assert.equal(f.latest().execution?.sourceCursor, cursor(7));
  assert.equal(f.latest().executionSync, 'stale');
});

test('authorized cursorless cached text updates display without advancing history or execution authority', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0, 8); f.execution(0, 8); await tick();
  f.sources[0]!.emit('session.invalidated', { sourceCursor: cursor(10) });
  const cached: SharedHistorySnapshot = { messages: [{ id: 'new-reply', sessionKey: target.sessionId,
    role: 'assistant', text: 'reply-10', createdAt: 10 }], updatedAt: 10, historyStatus: 'cached',
    access: { messagesSend: false, eventsRead: false } };
  f.histories[1]!.resolve(cached); f.execution(1, 8); await tick();
  assert.equal(f.latest().history?.messages[0]?.text, 'reply-10', 'freshly authorized display text must not disappear behind a missing cursor');
  assert.equal(f.latest().history?.messages[0]?.sessionKey, sessionAddress(target).key);
  assert.equal(f.latest().history?.sourceCursor, undefined, 'never invent a display watermark');
  assert.equal(f.latest().historySync, 'stale', 'display is not send-readiness evidence');
  assert.equal(f.latest().execution?.sourceCursor, cursor(8));
  assert.equal(f.latest().execution?.status, 'running');
  assert.equal(f.latest().executionSync, 'stale');
  assert.equal(f.latest().access?.messagesSend, false);
  assert.equal(f.sources[0]!.readyState, 2, 'new policy applies even to display-only pages');
  assert.equal(f.histories.length, 3, 'one bounded catch-up remains allowed');
  f.histories[2]!.resolve(cached); f.execution(2, 8); await tick();
  assert.equal(f.histories.length, 3, 'a repeated cached response must not self-poll');
  // The display did not clear the last authoritative cursor (8).
  f.live.refresh(); f.history(3, 7, { messagesSend: false, eventsRead: false }); f.execution(3, 7); await tick();
  assert.equal(f.latest().history?.messages[0]?.text, 'reply-10');
  assert.equal(f.latest().execution?.sourceCursor, cursor(8));
  f.live.refresh(); f.history(4, 10, { messagesSend: false, eventsRead: false }); f.execution(4, 10); await tick();
  assert.equal(f.latest().historySync, 'ready'); assert.equal(f.latest().executionSync, 'ready');
});

test('initial cached text remains stale and cannot restore private data after denial or account switch', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start();
  const cached: SharedHistorySnapshot = { messages: [], updatedAt: 1, historyStatus: 'cached',
    access: { messagesSend: true, eventsRead: false } };
  f.histories[0]!.resolve(cached); f.execution(0); await tick();
  assert.equal(f.latest().historySync, 'stale'); assert.equal(f.latest().executionSync, 'ready');
  f.live.refresh(); f.executions[1]!.reject(Object.assign(new Error('revoked'), { status: 403 })); await tick();
  f.histories[1]!.resolve(cached); await tick();
  assert.equal(f.latest().denied, true); assert.equal(f.latest().history, undefined);
  const g = fixture(); t.after(g.live.stop); g.live.start(); g.scope('account-b');
  g.histories[0]!.resolve(cached); g.execution(0); await tick();
  assert.equal(g.states.length, 0);
});

test('only explicit cursorless display pages bypass text regression checks, never malformed authority', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0, 8); f.execution(0, 8); await tick();
  f.live.refresh(); f.histories[1]!.resolve({ messages: [], updatedAt: 9 }); f.execution(1, 8); await tick();
  assert.equal(f.latest().history?.updatedAt, 8, 'an unmarked cursorless snapshot still fails the authority gate');
  assert.equal(f.latest().historySync, 'stale');
  f.live.refresh(); f.histories[2]!.resolve({ messages: [], updatedAt: 999, historyStatus: 'cached', sourceCursor: cursor(999) });
  f.execution(2, 8); await tick();
  assert.equal(f.latest().history?.updatedAt, 8); assert.equal(f.latest().historySync, 'unavailable');
  f.live.refresh(); f.history(3, 9); f.execution(3, 9); await tick();
  assert.equal(f.latest().historySync, 'ready', 'the malformed page did not advance the authoritative watermark');
});

test('exact stream filters foreign frames, allows unscoped expiry reset and does not consume event text', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick();
  f.sources[0]!.open(); f.history(1); f.execution(1); await tick();
  f.sources[0]!.emit('session.invalidated', { sessionKey: 'other', text: 'injected', sourceCursor: cursor(5) });
  assert.equal(f.histories.length, 2);
  f.sources[0]!.emit('stream.reset', { sessionKey: undefined });
  assert.equal(f.latest().historySync, 'stale'); assert.equal(f.histories.length, 3);
  f.history(2, 2); f.execution(2, 2); await tick();
  assert.equal(f.latest().history?.messages[0]?.text, 'reply-2');
});

test('node transport status is not execution or browser transport status', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick();
  f.sources[0]!.emit('stream.status', { payload: { connection: 'unauthorized' } });
  assert.equal(f.latest().source, 'unauthorized'); assert.equal(f.latest().transport, 'connected');
  assert.equal(f.latest().execution?.status, 'running'); assert.equal(f.latest().denied, false);
});

test('delayed upstream connection refreshes snapshots without a session event or message replay', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start();
  f.history(0); f.execution(0); await tick();
  // The browser socket opens before Connector attaches. These reads can have
  // captured old state while native execution progressed without live events.
  f.sources[0]!.open();
  assert.equal(f.histories.length, 2);
  f.sources[0]!.emit('stream.reset', { payload: { reason: 'source_changed' } });
  assert.equal(f.latest().execution?.hasActiveRun, true);
  f.history(1, 2); f.execution(1, 2); await tick();
  assert.equal(f.histories.length, 3); assert.equal(f.executions.length, 3);
  f.history(2, 3); f.execution(2, 3); await tick();
  assert.equal(f.latest().history?.messages[0]?.text, 'reply-3');
  assert.equal(f.latest().execution?.sourceCursor, cursor(3));
  assert.equal(f.latest().historySync, 'ready');
  assert.equal(f.latest().executionSync, 'ready');
  assert.equal(f.sources.length, 1, 'Snapshot recovery does not open a second feed');
});

test('read denial clears both lanes, cancels I/O and stops stream; late reply cannot restore content', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick(); f.live.refresh();
  f.histories[1]!.reject(Object.assign(new Error('denied'), { status: 403 })); await tick();
  assert.equal(f.latest().denied, true); assert.equal(f.latest().history, undefined); assert.equal(f.latest().execution, undefined);
  assert.ok(f.signals.every(signal => signal.aborted)); assert.equal(f.sources[0]!.readyState, 2);
  f.execution(1, 5); await tick(); assert.equal(f.latest().execution, undefined);
});

test('404 state removes last-known state without synthesizing idle or discarding independently authorized history', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick(); f.live.refresh();
  f.executions[1]!.reject(Object.assign(new Error('missing'), { status: 404 })); f.history(1, 2); await tick();
  assert.equal(f.latest().execution, undefined); assert.equal(f.latest().executionSync, 'unavailable');
  assert.equal(f.latest().historySync, 'ready'); assert.equal(f.latest().denied, false);
});

for (const first of ['history', 'execution'] as const) {
  for (const warm of [false, true]) {
    test(`masked denial in both lanes clears shared controls: ${first} first, warm=${warm}`, async context => {
      const setup = fixture(); context.after(setup.live.stop); setup.live.start();
      if (warm) { setup.history(0); setup.execution(0); await tick(); setup.live.refresh(); }
      const index = warm ? 1 : 0;
      const missing = () => Object.assign(new Error('not found'), { status: 404 });
      const initial = first === 'history' ? setup.histories : setup.executions;
      const remaining = first === 'history' ? setup.executions : setup.histories;
      initial[index]!.reject(missing()); await tick();
      assert.equal(setup.latest().denied, false);
      remaining[index]!.reject(missing()); await tick();
      assert.equal(setup.latest().denied, true);
      assert.equal(setup.latest().history, undefined);
      assert.equal(setup.latest().execution, undefined);
      assert.equal(setup.latest().access, undefined);
      assert.ok(setup.signals.every(signal => signal.aborted));
      assert.ok(setup.sources.every(source => source.readyState === 2));
      setup.live.refresh(); setup.live.ensureConnected(); await tick();
      assert.equal(setup.histories.length, index + 1);
      assert.equal(setup.executions.length, index + 1);
    });
  }
}

for (const recoveredStatus of [200, 503]) {
  test(`a history ${recoveredStatus} clears its earlier missing observation before state 404`, async context => {
    const setup = fixture(); context.after(setup.live.stop); setup.live.start();
    setup.histories[0]!.reject(Object.assign(new Error('not found'), { status: 404 }));
    setup.execution(0); await tick(); setup.live.refresh();
    if (recoveredStatus === 200) setup.history(1);
    else setup.histories[1]!.reject(Object.assign(new Error('unavailable'), { status: 503 }));
    await tick();
    setup.executions[1]!.reject(Object.assign(new Error('not found'), { status: 404 })); await tick();
    assert.equal(setup.latest().denied, false);
    assert.equal(setup.latest().historySync, recoveredStatus === 200 ? 'ready' : 'unavailable');
    assert.equal(setup.latest().execution, undefined);
    assert.ok(setup.signals.every(signal => !signal.aborted));
  });
}

test('scope change and unmount fence every pending lane and event, without creating new requests', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.scope('account-b'); f.history(0); f.execution(0); await tick();
  assert.equal(f.states.length, 0); f.live.refresh(); f.live.ensureConnected();
  assert.equal(f.sources.length, 0, 'late access response cannot start an old account feed');
  assert.equal(f.histories.length, 1); assert.equal(f.states.length, 0);
  f.live.stop(); assert.ok(f.signals.every(signal => signal.aborted));
});

test('account switch fences an already connected feed and pending refreshes', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick();
  f.sources[0]!.open(); const count = f.states.length;
  f.scope('account-b'); f.sources[0]!.emit('session.invalidated', { sourceCursor: cursor(2) });
  f.history(1); f.execution(1); await tick(); f.live.ensureConnected();
  assert.equal(f.states.length, count); assert.equal(f.sources.length, 1);
  f.live.stop(); assert.equal(f.sources[0]!.readyState, 2);
});

test('invalid execution target or cursor never replaces last-known snapshot', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0); f.execution(0); await tick(); f.live.refresh();
  f.executions[1]!.resolve({ sessionKey: 'other', status: 'idle', sourceCursor: cursor(999) }); await tick();
  assert.equal(f.latest().execution?.status, 'running');
  f.live.refresh(); f.executions[2]!.resolve({ sessionKey: target.sessionId, status: 'idle', sourceCursor: 'hub-cursor:100' }); await tick();
  assert.equal(f.latest().execution?.status, 'running'); assert.equal(f.latest().executionSync, 'stale');
});

test('read-only history waits for exact policy hints and never starts a forbidden reconnect loop', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.live.ensureConnected();
  assert.equal(f.sources.length, 0, 'no speculative SSE before current history access');
  f.history(0, 1, { messagesSend: false, eventsRead: false }); f.execution(0); await tick();
  assert.equal(f.latest().historySync, 'ready'); assert.equal(f.latest().execution?.status, 'running');
  assert.deepEqual(f.latest().access, { messagesSend: false, messagesMirror: false, eventsRead: false });
  f.live.ensureConnected(); assert.equal(f.sources.length, 0);
  f.live.refresh(); f.history(1); f.execution(1); await tick();
  assert.equal(f.sources.length, 1, 'explicit read discovers newly enabled access');
  assert.equal(f.latest().access?.messagesSend, true);
});

test('policy hints revoke even on regressed projection, without erasing independently readable data', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start(); f.history(0, 5); f.execution(0, 5); await tick();
  f.live.refresh(); f.history(1, 1, { messagesSend: false, eventsRead: false }); f.execution(1, 5); await tick();
  assert.equal(f.sources[0]!.readyState, 2); assert.equal(f.latest().denied, false);
  assert.equal(f.latest().history?.updatedAt, 5); assert.equal(f.latest().execution?.status, 'running');
  assert.deepEqual(f.latest().access, { messagesSend: false, messagesMirror: false, eventsRead: false });
  f.live.ensureConnected(); assert.equal(f.sources.length, 1);
});

test('missing or malformed hints fail closed; history 404 also suspends shared actions', async t => {
  const f = fixture(); t.after(f.live.stop); f.live.start();
  f.histories[0]!.resolve({ messages: [], updatedAt: 1 }); f.execution(0); await tick();
  assert.deepEqual(f.latest().access, { messagesSend: false, messagesMirror: false, eventsRead: false }); assert.equal(f.sources.length, 0);
  f.live.refresh(); f.history(1, 2, { messagesSend: 'true', eventsRead: 1 } as any); f.execution(1); await tick();
  assert.deepEqual(f.latest().access, { messagesSend: false, messagesMirror: false, eventsRead: false }); assert.equal(f.sources.length, 0);
  f.live.refresh(); f.history(2, 3); f.execution(2); await tick(); assert.equal(f.sources.length, 1);
  f.live.refresh(); f.histories[3]!.reject(Object.assign(new Error('missing'), { status: 404 })); f.execution(3); await tick();
  assert.equal(f.sources[0]!.readyState, 2); assert.equal(f.latest().history, undefined);
  assert.deepEqual(f.latest().access, { messagesSend: false, messagesMirror: false, eventsRead: false }); assert.equal(f.latest().execution?.status, 'running');
});

test('mirror hint is explicit, depends on send, and revokes despite an older projection', async context => {
  const setup = fixture(); context.after(setup.live.stop); setup.live.start();
  setup.history(0, 5, { messagesSend: true, messagesMirror: true, eventsRead: false }); setup.execution(0, 5); await tick();
  assert.equal(setup.latest().access?.messagesMirror, true);
  setup.live.refresh(); setup.history(1, 1, { messagesSend: true, eventsRead: false }); setup.execution(1, 5); await tick();
  assert.equal(setup.latest().history?.updatedAt, 5);
  assert.equal(setup.latest().access?.messagesMirror, false);
  setup.live.refresh(); setup.history(2, 6, { messagesSend: false, messagesMirror: true, eventsRead: false }); setup.execution(2, 6); await tick();
  assert.equal(setup.latest().access?.messagesMirror, false);
  setup.live.refresh(); setup.history(3, 7, { messagesSend: true, messagesMirror: 'true', eventsRead: false } as any); setup.execution(3, 7); await tick();
  assert.equal(setup.latest().access?.messagesMirror, false);
});

test('creator sharing hint survives normalization and clears on absent or malformed permission', async context => {
  const setup = fixture(); context.after(setup.live.stop); setup.live.start();
  setup.history(0, 5, { messagesSend: true, eventsRead: false, sessionsShare: true }); setup.execution(0, 5); await tick();
  assert.equal(setup.latest().access?.sessionsShare, true);
  setup.live.refresh(); setup.history(1, 1, { messagesSend: true, eventsRead: false }); setup.execution(1, 5); await tick();
  assert.equal(setup.latest().history?.updatedAt, 5);
  assert.equal(setup.latest().access?.sessionsShare, undefined);
  setup.live.refresh(); setup.history(2, 6, { messagesSend: true, eventsRead: false, sessionsShare: 'true' } as any); setup.execution(2, 6); await tick();
  assert.equal(setup.latest().access?.sessionsShare, undefined);
});
