import assert from 'node:assert/strict';
import test from 'node:test';
import type { HubDeckEvent } from '../api.js';
import { createCompletionTracker, isCompletionRefreshEvent, prepareNotificationWorker, requestDesktopNotification } from './desktop-notifications.js';
import { contextUsageValues, contextUsageDescription, contextUsageLabel, formatCompactionCount, formatContextUsage } from './context-usage.js';
import { passkeyError } from './passkey-ui.js';

const session = { sessionKey: 'codex:test', title: 'Test', agentId: 'codex', source: 'codex' as const, status: 'idle' as const };
const event = (phase: string, turnId = 'turn-1', env = 'remote-a'): HubDeckEvent => ({ id: `${phase}-${turnId}`, ts: Date.now(), type: 'session.updated', envConnectionId: env, sessionKey: session.sessionKey, payload: { ...session, runtime: { phase, turnId } } });
test('execution completion refreshes immediately but history syncing does not consume its notification', () => {
  const track = createCompletionTracker(); track(event('running'));
  const terminal = (sync: string, type = 'session.updated') => ({ ...event('completed'), type,
    payload: { ...session, runtime: { phase: 'completed', turnId: 'turn-1', sync } } }) as HubDeckEvent;
  assert.equal(isCompletionRefreshEvent(terminal('syncing')), true);
  assert.equal(track(terminal('syncing')), undefined);
  assert.equal(track(terminal('error', 'run.completed')), undefined);
  assert.equal(track(terminal('current'))?.title, 'AgentOpsDeck run finished');
  assert.equal(track(terminal('current', 'run.completed')), undefined);
  const failed = createCompletionTracker(); failed(event('running'));
  assert.equal(failed({ ...event('failed'), payload: { ...session, runtime: { phase: 'failed', sync: 'syncing' } } }), undefined);
  assert.equal(failed(event('failed'))?.title, 'AgentOpsDeck run failed');
});
test('Codex completion notifications follow native session updates and deduplicate history sync', () => {
  const track = createCompletionTracker();
  assert.equal(track(event('completed')), undefined, 'initial snapshot is not a new completion');
  assert.equal(track(event('running')), undefined);
  assert.equal(track(event('completed'))?.title, 'AgentOpsDeck run finished');
  assert.equal(track(event('completed')), undefined);
  assert.equal(track({ ...event('completed'), type: 'run.completed' }), undefined);
  track(event('running', 'turn-2'));
  track(event('finalizing', 'turn-2'));
  assert.equal(track(event('failed', 'turn-2'))?.title, 'AgentOpsDeck run failed');
  track(event('running', 'turn-1', 'remote-b'));
  assert.equal(track(event('completed', 'turn-1', 'remote-b'))?.title, 'AgentOpsDeck run finished');
});
test('opening during a run seeds notification tracking without replaying historical completions', () => {
  const track = createCompletionTracker();
  track.seed([{ ...session, envConnectionId: 'remote-a', runtime: { phase: 'running', turnId: 'turn-1', connection: 'connected', sync: 'current', lastEventAt: 1 } }]);
  assert.equal(track(event('completed'))?.title, 'AgentOpsDeck run finished');
  track.seed([{ ...session, envConnectionId: 'remote-a', runtime: { phase: 'running', turnId: 'turn-1', connection: 'connected', sync: 'current', lastEventAt: 1 } }]);
  assert.equal(track(event('completed')), undefined);
});
test('Codex context is not cumulative usage or a message estimate, absent compact count is unknown', () => {
  assert.equal(formatContextUsage({ ...session, totalTokens: 800000, estimatedTokens: 5000 }), '—');
  assert.equal(contextUsageValues({ ...session, contextUsedTokens: 20000, contextTokens: 100000 }).ratio, .2);
  assert.equal(contextUsageValues({ ...session, contextUsedTokens: 0, contextTokens: 100000 }).ratio, 0);
  assert.equal(formatContextUsage({ ...session, contextUsedTokens: null }), '—');
  assert.equal(formatCompactionCount(session), '—');
  assert.equal(formatCompactionCount({ ...session, compactionCount: 0 }), '0');
});
test('reused context formatter preserves rounding, grouping and invalid-value handling', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, -1, -0, 0, .49, .5, 999.5, 12345.6, 1e20]) {
    const expected = typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? new Intl.NumberFormat('en-US').format(Math.round(value)) : '—';
    assert.equal(formatContextUsage({ ...session, ...(value === undefined ? {} : { contextUsedTokens: value }), contextTokens: 100000 }), `${expected}/100,000`);
    assert.equal(formatCompactionCount({ ...session, ...(typeof value === 'number' ? { compactionCount: value } : {}) }), expected);
  }
});
test('SDK context never falls back to lifetime/estimated tokens, and native sample scope is explicit', () => {
  for (const source of ['claude-code', 'ghcp']) {
    assert.equal(formatContextUsage({ ...session, source, totalTokens: 800000, estimatedTokens: 9000 }), '—');
    assert.equal(formatContextUsage({ ...session, source, totalTokens: 800000, contextUsedTokens: null }), '—');
    assert.equal(formatContextUsage({ ...session, source, contextUsedTokens: 0, contextTokens: 1000 }), '0/1,000');
  }
  assert.match(contextUsageDescription({ ...session, contextSampleBasis: 'last-request-input', contextUsedTokens: 10 }), /Last request input/);
  assert.equal(contextUsageLabel({ ...session, contextSampleBasis: 'last-request-input' }, true), 'Last input');
  assert.equal(contextUsageLabel({ ...session, contextSampleBasis: 'native-context' }, true), 'ctx');
  assert.equal(contextUsageLabel(session), 'Context');
  assert.deepEqual(contextUsageValues({ ...session, contextSampleBasis: 'last-request-input', contextUsedTokens: 10, contextTokens: 1000 }), { used: 10, limit: undefined, ratio: 0 });
  assert.match(contextUsageDescription({ ...session, contextSampleBasis: 'post-compaction', contextUsedTokens: null }), /not reported/);
});
test('passkey cancellation is actionable, not a cryptic browser error', () => {
  const error = new Error('opaque browser failure'); error.name = 'NotAllowedError';
  assert.match(passkeyError(error), /cancelled or timed out/);
  error.name = 'SecurityError'; assert.match(passkeyError(error), /hostname/);
});

test('notification preparation bounds both registration and activation', async () => {
  const pending = new Promise<ServiceWorkerRegistration>(() => {});
  const registration = {} as ServiceWorkerRegistration;
  assert.equal(await prepareNotificationWorker({ register: () => pending, ready: Promise.resolve(registration) }, 5), false);
  assert.equal(await prepareNotificationWorker({ register: async () => registration, ready: pending }, 5), false);
  assert.equal(await prepareNotificationWorker({ register: async () => registration, ready: Promise.resolve(registration) }), true);
});

test('notification worker acceptance and failure do not create duplicate desktop notifications', async t => {
  const replace = (key: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  };
  let desktop = 0, submissions = 0, fail = false;
  class FakeNotification { static permission = 'granted'; constructor() { desktop++; } }
  replace('Notification', FakeNotification);
  replace('localStorage', { getItem: () => 'on' });
  replace('navigator', { serviceWorker: { getRegistration: async () => ({ active: {}, showNotification: async () => { submissions++; if (fail) throw new Error('worker rejected'); } }) } });
  assert.equal((await requestDesktopNotification('test')).accepted, true);
  fail = true;
  const rejected = await requestDesktopNotification('test');
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.transport, 'worker');
  assert.equal(submissions, 2);
  assert.equal(desktop, 0);
});

function browserGlobals(context: test.TestContext, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

test('notification worker timeout remains unknown and never falls back or resends after late success', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let desktop = 0, submissions = 0;
  let submitted!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { submitted = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  class FakeNotification { static permission = 'granted'; constructor() { desktop++; } }
  browserGlobals(context, {
    Notification: FakeNotification, localStorage: { getItem: () => 'on' },
    navigator: { serviceWorker: { getRegistration: async () => ({ active: {}, showNotification: () => {
      submissions++; submitted(); return pending;
    } }) } },
  });
  const delivery = requestDesktopNotification('fixture');
  await started;
  context.mock.timers.tick(5001);
  const result = await delivery;
  assert.equal(result.code, 'workerUnknown');
  assert.equal(result.accepted, false);
  finish();
  await Promise.resolve();
  assert.equal(submissions, 1);
  assert.equal(desktop, 0);
});

test('unsupported, denied and locally disabled notifications make no delivery attempt', async context => {
  let submissions = 0;
  class FakeNotification { static permission = 'denied'; constructor() { submissions++; } }
  const navigator = { serviceWorker: { getRegistration: async () => { submissions++; return undefined; } } };
  browserGlobals(context, { Notification: undefined, localStorage: { getItem: () => 'off' }, navigator });
  assert.equal((await requestDesktopNotification('fixture')).code, 'unsupported');
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FakeNotification });
  assert.equal((await requestDesktopNotification('fixture')).code, 'permission');
  FakeNotification.permission = 'granted';
  assert.equal((await requestDesktopNotification('fixture')).code, 'disabled');
  assert.equal(submissions, 0);
});

test('missing worker permits one desktop attempt but does not claim OS banner visibility', async context => {
  let desktop = 0;
  class FakeNotification {
    static permission = 'granted';
    onshow?: () => void;
    constructor() { desktop++; queueMicrotask(() => this.onshow?.()); }
  }
  browserGlobals(context, { Notification: FakeNotification, localStorage: { getItem: () => 'on' },
    navigator: { serviceWorker: { getRegistration: async () => undefined } } });
  const result = await requestDesktopNotification('fixture');
  assert.equal(result.code, 'desktopShown');
  assert.equal(result.accepted, true);
  assert.equal(result.transport, 'desktop');
  assert.match(result.detail, /OS settings may still hide/);
  assert.equal(desktop, 1);
});
