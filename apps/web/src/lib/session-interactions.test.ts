import assert from 'node:assert/strict';
import test from 'node:test';
import { api, setRecoveryScope } from '../api.js';
import { createInteractionReads, interactionSubmissionLedger } from './session-interactions.js';
import type { InteractionSnapshot } from '@agentopsdeck/shared';
const data: InteractionSnapshot = { version: 1, mode: 'automatic', capabilities: { version: 1, modes: ['automatic'], kinds: [] }, requests: [] };
const wait = () => new Promise(resolve => setTimeout(resolve, 130));
test('explicit missing capability skips reads, rechecks only on demand and manual refresh discovers upgrades', async t => {
  let supported: boolean | undefined = false, checks = 0, reads = 0, clock = 1;
  const cache = createInteractionReads(async () => { reads++; return data; }, 4, () => clock,
    async () => { checks++; return supported; });
  const stop = cache.subscribe('a', 's', () => {}); t.after(stop);
  await wait(); assert.equal(checks, 1); assert.equal(reads, 0);
  assert.deepEqual(cache.snapshot('a', 's'), { loading: false, failed: false, unavailable: 'unsupported' });
  for (let i = 0; i < 20; i++) cache.connected('a');
  await wait(); assert.equal(checks, 1);
  clock += 300_000; cache.connected('a'); await wait(); assert.equal(checks, 2); assert.equal(reads, 0);
  supported = true; cache.refresh('a', 's'); await wait(); assert.equal(checks, 3); assert.equal(reads, 1);
  cache.connected('a'); await wait(); assert.equal(checks, 3); assert.equal(reads, 2, 'reuse positive capability within five minutes');
  clock += 300_000; supported = false; cache.connected('a'); await wait();
  assert.equal(reads, 2); assert.equal(cache.snapshot('a', 's').data, undefined, 'withdrawal clears stale pending requests');
  supported = undefined; cache.refresh('a', 's'); await wait(); assert.equal(reads, 3, 'legacy absent advertisement may probe');
});
test('capability failures do not probe interactions and closing during capability read prevents stale delivery', async t => {
  let reads = 0, fail = true, resolve!: (value: boolean) => void;
  const cache = createInteractionReads(async () => { reads++; return data; }, 4, Date.now, async () => {
    if (fail) throw Object.assign(new Error('denied'), { status: 403 });
    return new Promise<boolean>(done => { resolve = done; });
  });
  const stop = cache.subscribe('a', 's', () => {}); t.after(stop);
  await wait(); assert.equal(reads, 0); assert.equal(cache.snapshot('a', 's').failed, true);
  fail = false; cache.refresh('a', 's'); await wait(); stop(); resolve(true); await wait();
  assert.equal(reads, 0); assert.equal(cache.snapshot('a', 's').data, undefined);
});
test('missing remote interaction routes stop automatic probes; manual retry and later recovery remain available', async () => {
  let clock = 1, calls = 0, missing = true;
  const cache = createInteractionReads(async () => { calls++; if (missing) throw Object.assign(new Error('missing'), { status: 404 }); return data; }, 4, () => clock);
  const stop = cache.subscribe('alice', 's', () => {});
  try {
    await wait(); assert.equal(calls, 1);
    for (let i = 0; i < 20; i++) { cache.connected('alice'); cache.receive('alice', { type: 'interaction.updated', sessionKey: 's' }); }
    await wait(); assert.equal(calls, 1); assert.equal(cache.snapshot('alice', 's').failed, true);
    clock += 299_999; cache.connected('alice'); await wait(); assert.equal(calls, 1);
    clock += 3_600_000; cache.connected('alice'); await wait(); assert.equal(calls, 1);
    assert.equal(cache.snapshot('alice', 's').unavailable, 'missing');
    missing = false; cache.refresh('alice', 's'); await wait(); assert.equal(calls, 2); assert.equal(cache.snapshot('alice', 's').failed, false);
    assert.equal(cache.snapshot('alice', 's').unavailable, undefined);
    cache.connected('alice'); await wait(); assert.equal(calls, 3);
  } finally { stop(); }
});
test('transient reads use exponential backoff and honor Retry-After without creating polling timers', async () => {
  let clock = 1, calls = 0;
  const cache = createInteractionReads(async () => { calls++; throw Object.assign(new Error('busy'), { status: 503, retryAfterMs: calls === 2 ? 90_000 : undefined }); }, 4, () => clock);
  const stop = cache.subscribe('alice', 's', () => {});
  try {
    await wait(); clock += 14_999; cache.connected('alice'); await wait(); assert.equal(calls, 1);
    clock++; cache.connected('alice'); await wait(); assert.equal(calls, 2);
    clock += 89_999; cache.connected('alice'); await wait(); assert.equal(calls, 2);
    clock++; cache.connected('alice'); await wait(); assert.equal(calls, 3);
    clock += 60_000; await wait(); assert.equal(calls, 3, 'deadline alone does not poll');
    cache.connected('alice'); await wait(); assert.equal(calls, 4);
  } finally { stop(); }
});
test('sixteen mixed Agent/goal views cap concurrent reads at four and drain reconnects fairly', async t => {
  const calls: string[] = [], pending = new Map<string, () => void>();
  let active = 0, peak = 0;
  const cache = createInteractionReads((key, signal) => new Promise(resolve => {
    calls.push(key); peak = Math.max(peak, ++active);
    const finish = () => { signal.removeEventListener('abort', finish); pending.delete(key); active--; resolve(data); };
    pending.set(key, finish); signal.addEventListener('abort', finish, { once: true });
  }));
  const keys = Array.from({ length: 16 }, (_, i) => `${['codex', 'claude-code', 'ghcp', 'codex-goal'][i % 4]}:${i}`);
  const stops = keys.map(key => cache.subscribe('owner', key, () => {}));
  t.after(() => stops.forEach(stop => stop()));
  await wait(); assert.deepEqual(calls, keys.slice(0, 4));
  for (let i = 0; i < 100; i++) cache.connected('owner');
  await wait(); assert.equal(calls.length, 4, 'no duplicate while queued or in flight');
  for (let batch = 1; batch < 4; batch++) {
    [...pending.values()].forEach(finish => finish());
    await wait(); assert.deepEqual(calls, keys.slice(0, (batch + 1) * 4), 'unread sessions precede trailing reads');
  }
  [...pending.values()].forEach(finish => finish()); await wait();
  assert.deepEqual(calls.slice(16), keys.slice(0, 4), 'in-flight storm coalesces to one trailing read per active session');
  [...pending.values()].forEach(finish => finish()); await wait();
  assert.equal(calls.length, 20); assert.equal(peak, 4); assert.equal(active, 0);
  await wait(); assert.equal(calls.length, 20, 'idle views still do not poll');
});
test('closing queued views cancels dispatch and failed reads release capacity', async t => {
  const calls: string[] = [];
  let reject!: (reason: Error) => void;
  const cache = createInteractionReads(async key => {
    calls.push(key); if (key === 'first') return new Promise((_resolve, fail) => { reject = fail; }); return data;
  }, 1);
  const first = cache.subscribe('a', 'first', () => {}), cancelled = cache.subscribe('a', 'cancelled', () => {}), last = cache.subscribe('a', 'last', () => {});
  t.after(() => { first(); cancelled(); last(); });
  await wait(); cancelled(); reject(new Error('timeout')); await wait();
  assert.deepEqual(calls, ['first', 'last']); assert.equal(cache.snapshot('a', 'first').failed, true);
  assert.deepEqual(cache.snapshot('a', 'last').data, data);
});
test('aborting a view retains its slot until the actual transport settles', async t => {
  let calls = 0, resolve!: (value: InteractionSnapshot) => void, signal!: AbortSignal;
  const cache = createInteractionReads(async (_key, s) => {
    signal = s; if (++calls === 1) return new Promise(done => { resolve = done; }); return data;
  }, 1);
  const first = cache.subscribe('old-owner', 'a', () => {}); await wait(); first();
  assert.equal(signal.aborted, true);
  const next = cache.subscribe('new-owner', 'a', () => {}); t.after(next);
  await wait(); assert.equal(calls, 1, 'no false capacity from Promise.race cancellation');
  resolve(data); await wait(); assert.equal(calls, 2);
  assert.equal(cache.snapshot('old-owner', 'a').data, undefined);
  assert.deepEqual(cache.snapshot('new-owner', 'a').data, data);
});
test('duplicate callbacks retain independent ownership and old repeated cleanup cannot remove a replacement', async () => {
  let calls = 0, notifications = 0, closes = 0;
  const cache = createInteractionReads(async () => { calls++; return data; });
  cache.configure(() => ({ close() { closes++; } }));
  const notify = () => { notifications++; };
  const first = cache.subscribe('a', 's', notify), second = cache.subscribe('a', 's', notify);
  first(); first(); await wait(); assert.equal(calls, 1); assert.equal(notifications, 2); assert.equal(closes, 0);
  second(); assert.equal(closes, 1);
  const replacement = cache.subscribe('a', 's', notify);
  try { first(); second(); await wait(); assert.equal(calls, 2); assert.deepEqual(cache.snapshot('a', 's').data, data); }
  finally { replacement(); }
  assert.equal(closes, 2);
});
test('synchronous unmount on loading avoids starting an already cancelled transport', async () => {
  let calls = 0;
  const cache = createInteractionReads(async () => { calls++; return data; });
  const stop = cache.subscribe('a', 's', () => stop());
  await wait(); assert.equal(calls, 0);
  assert.equal(cache.snapshot('a', 's').data, undefined);
});
test('read concurrency rejects invalid or excessive budgets', () => {
  for (const cap of [0, -1, 1.5, Infinity, NaN, 17]) assert.throws(() => createInteractionReads(async () => data, cap));
});
test('multiple surfaces share reads/transport, event storms coalesce, idle produces no polls', async () => {
  let calls = 0, opens = 0, closes = 0;
  const cache = createInteractionReads(async () => { calls++; return data; });
  cache.configure(() => { opens++; return { close() { closes++; } }; });
  const a = cache.subscribe('alice', 'a', () => {}), a2 = cache.subscribe('alice', 'a', () => {}), b = cache.subscribe('alice', 'b', () => {});
  await wait(); assert.equal(calls, 2); assert.equal(opens, 1);
  for (let i = 0; i < 50; i++) cache.receive('alice', { type: 'interaction.updated', sessionKey: 'a' });
  await wait(); assert.equal(calls, 3);
  cache.receive('bob', { type: 'interaction.updated', sessionKey: 'a' }); cache.receive('alice', { type: 'message.created', sessionKey: 'a' });
  await wait(); assert.equal(calls, 3);
  cache.connected('alice'); await wait(); assert.equal(calls, 5);
  a(); a2(); assert.equal(closes, 0); b(); assert.equal(closes, 1);
});
test('close aborts in-flight work, late success cannot cross account or repopulate deleted state', async () => {
  let resolve!: (value: InteractionSnapshot) => void, signal!: AbortSignal;
  const cache = createInteractionReads(async (_key, s) => { signal = s; return new Promise(r => { resolve = r; }); });
  const close = cache.subscribe('alice', 'a', () => {}); await wait(); close(); assert.equal(signal.aborted, true);
  resolve(data); await wait(); assert.equal(cache.snapshot('alice', 'a').data, undefined); assert.equal(cache.snapshot('bob', 'a').data, undefined);
});
test('events during an in-flight read cause exactly one trailing read and failures preserve last snapshot', async () => {
  let calls = 0, resolve!: (value: InteractionSnapshot) => void;
  const cache = createInteractionReads(async () => { calls++; if (calls === 1) return new Promise(r => { resolve = r; }); throw new Error('offline'); });
  const stop = cache.subscribe('alice', 'a', () => {}); await wait();
  for (let i = 0; i < 20; i++) cache.receive('alice', { type: 'interaction.updated', sessionKey: 'a' });
  resolve(data); await wait(); assert.equal(calls, 2); assert.deepEqual(cache.snapshot('alice', 'a'), { data, loading: false, failed: true });
  await wait(); assert.equal(calls, 2); stop();
});
test('closing before debounce cancels the read and a subsequent mount acquires a fresh stream', async () => {
  let calls = 0, opens = 0, closes = 0;
  const cache = createInteractionReads(async () => { calls++; return data; });
  cache.configure(() => { opens++; return { close() { closes++; } }; });
  cache.subscribe('alice', 'a', () => {})();
  await wait(); assert.equal(calls, 0); assert.equal(closes, 1);
  const close = cache.subscribe('alice', 'a', () => {});
  try { await wait(); assert.equal(calls, 1); assert.equal(opens, 2); }
  finally { close(); }
  assert.equal(closes, 2);
});
test('reopening the same session rejects old success and old trailing invalidations', async () => {
  let calls = 0, oldResolve!: (value: InteractionSnapshot) => void;
  const fresh: InteractionSnapshot = { ...data, mode: 'interactive' };
  const cache = createInteractionReads(async () => {
    calls++; return calls === 1 ? new Promise(resolve => { oldResolve = resolve; }) : fresh;
  });
  const first = cache.subscribe('alice', 'a', () => {});
  await wait(); cache.receive('alice', { type: 'interaction.updated', sessionKey: 'a' }); first();
  const second = cache.subscribe('alice', 'a', () => {});
  try {
    await wait(); assert.equal(cache.snapshot('alice', 'a').data?.mode, 'interactive');
    oldResolve(data); await wait();
    assert.equal(cache.snapshot('alice', 'a').data?.mode, 'interactive');
    assert.equal(calls, 2, 'closed entry cannot enqueue a trailing read into its replacement');
  } finally { second(); }
});
test('twelve session views share one stream and disposed views ignore reconnect storms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settleScheduledReads = async () => {
    t.mock.timers.tick(100);
    for (let batch = 0; batch < 4; batch++) {
      t.mock.timers.tick(0);
      for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    }
  };
  const calls = new Map<string, number>(); let opens = 0, closes = 0;
  const cache = createInteractionReads(async key => { calls.set(key, (calls.get(key) ?? 0) + 1); return data; });
  cache.configure(() => { opens++; return { close() { closes++; } }; });
  const stops = Array.from({ length: 12 }, (_, i) => cache.subscribe('alice', String(i), () => {}));
  t.after(() => stops.forEach(stop => stop()));
  await settleScheduledReads(); assert.equal(calls.size, 12); assert.equal(opens, 1);
  stops.splice(0, 8).forEach(stop => stop());
  try {
    for (let i = 0; i < 50; i++) {
      cache.connected('alice');
      for (let j = 0; j < 12; j++) cache.receive('alice', { type: 'interaction.updated', sessionKey: String(j) });
    }
    await settleScheduledReads();
    for (let i = 0; i < 12; i++) assert.equal(calls.get(String(i)), i < 8 ? 1 : 2);
    await settleScheduledReads(); assert.equal([...calls.values()].reduce((a, b) => a + b, 0), 16, 'idle has no periodic reads');
  } finally { stops.forEach(stop => stop()); }
  assert.equal(closes, 1);
  cache.connected('alice'); await settleScheduledReads();
  assert.equal([...calls.values()].reduce((a, b) => a + b, 0), 16);
});
test('failure retains data and reconnect heals after cooldown without an automatic retry loop', async () => {
  let calls = 0, offline = false, now = 0;
  const cache = createInteractionReads(async () => { calls++; if (offline) throw new Error('offline'); return data; }, 4, () => now);
  const close = cache.subscribe('alice', 'a', () => {});
  try {
    await wait(); offline = true; cache.refresh('alice', 'a'); await wait();
    assert.deepEqual(cache.snapshot('alice', 'a'), { data, loading: false, failed: true });
    await wait(); assert.equal(calls, 2);
    offline = false; cache.connected('alice'); await wait();
    assert.equal(calls, 2, 'early reconnect respects failure cooldown');
    now = 15_000; cache.connected('alice'); await wait();
    assert.deepEqual(cache.snapshot('alice', 'a'), { data, loading: false, failed: false });
    assert.equal(calls, 3);
  } finally { close(); }
});
test('submission identity survives panel recreation; it stores no answer and isolates owner/session', () => {
  let raw: string | null = null, now = 100;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  const ledger = interactionSubmissionLedger(storage, () => now);
  ledger.begin('alice', 'a', 'q', 200, 'r');
  assert.equal(interactionSubmissionLedger(storage, () => now).has('alice', 'a', 'q'), true);
  assert.equal(ledger.has('bob', 'a', 'q'), false); assert.equal(ledger.has('alice', 'b', 'q'), false);
  assert.throws(() => ledger.begin('alice', 'a', 'q', 200, 'different'));
  assert.deepEqual(Object.keys(JSON.parse(raw!)[0]).sort(), ['expires', 'request', 'response', 'scope', 'session']);
  now = 201; assert.equal(ledger.has('alice', 'a', 'q'), false);
});
test('malformed or blocked receipt storage fails closed before any submission', () => {
  assert.throws(() => interactionSubmissionLedger({ getItem: () => '{}', setItem() {} }).has('a', 'b', 'c'));
  assert.throws(() => interactionSubmissionLedger({ getItem: () => null, setItem() { throw new Error('quota'); } }).begin('a', 'b', 'c', Date.now() + 1000, 'd'));
});
test('capability API distinguishes explicit support, legacy absence and authentication failure without probing shared owners', async t => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent() {},
    location: { hostname: 'example.invalid', protocol: 'https:' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } } });
  t.after(() => { setRecoveryScope(undefined); globalThis.fetch = originalFetch; Object.assign(globalThis, { window: originalWindow }); });
  setRecoveryScope('a'.repeat(64));
  const signal = new AbortController().signal;
  let calls = 0, status = 200, payload: unknown = { features: { interactions: false } };
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(new URL(String(url), 'https://example.invalid').pathname, '/api/hub/v1/connections/node/capabilities');
    assert.equal(new Headers(init?.headers).get('x-agentopsdeck-recovery-scope'), 'a'.repeat(64));
    return Response.json(payload, { status });
  };
  const key = `node:${Buffer.from('codex:fixture').toString('base64url')}`;
  assert.equal(await api.sessionInteractionCapability(key, signal), false);
  payload = { features: { interactions: true } }; assert.equal(await api.sessionInteractionCapability(key, signal), true);
  for (const value of [{}, { features: {} }, { features: { interactions: 'false' } }]) {
    payload = value; assert.equal(await api.sessionInteractionCapability(key, signal), undefined);
  }
  status = 404; assert.equal(await api.sessionInteractionCapability(key, signal), undefined);
  for (const failure of [403, 429, 503]) { status = failure; await assert.rejects(api.sessionInteractionCapability(key, signal), { status: failure }); }
  const before = calls;
  await assert.rejects(api.sessionInteractionCapability(JSON.stringify(['shared-session-v1', 'other', key]), signal), /not available for shared sessions/);
  assert.equal(await api.sessionInteractionCapability('legacy:key:fixture', signal), undefined);
  assert.equal(calls, before);
});
test('three Agent API paths use the registered Hub routes; unknown writes never retry or use legacy routes', async t => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent() {},
    location: { hostname: 'example.invalid', protocol: 'https:' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } } });
  t.after(() => { setRecoveryScope(undefined); globalThis.fetch = originalFetch; Object.assign(globalThis, { window: originalWindow }); });
  setRecoveryScope('a'.repeat(64));
  const signal = new AbortController().signal;
  for (const agent of ['codex', 'claude-code', 'ghcp']) {
    const nativeKey = `${agent}:fixture`, key = `node:${Buffer.from(nativeKey).toString('base64url')}`;
    const base = `/api/hub/v1/sessions/${encodeURIComponent(key)}`;
    const request = { version: 1, ownerId: 'owner', nodeId: 'node', sessionKey: nativeKey, runId: 'run', requestId: 'question',
      kind: 'text', prompt: 'Question', createdAt: Date.now(), expiresAt: Date.now() + 60000 };
    const view = { request, status: 'pending', delivery: 'none', revision: 1 };
    const snapshot = { version: 1, mode: 'automatic', capabilities: { version: 1, modes: ['automatic', 'interactive'], kinds: ['text'] }, requests: [view] };
    let calls = 0, failure = false, wrongRun = false, wrongMode = false;
    globalThis.fetch = async (url, init) => {
      calls++; const path = new URL(String(url), 'https://example.invalid').pathname;
      assert.equal(new Headers(init?.headers).get('x-agentopsdeck-recovery-scope'), 'a'.repeat(64));
      if (path === `${base}/interactions`) return Response.json(snapshot);
      if (path === `${base}/interaction-mode`) {
        assert.equal(init?.method, 'PATCH'); assert.deepEqual(JSON.parse(String(init?.body)), { mode: 'interactive' });
        return Response.json({ mode: wrongMode ? 'automatic' : 'interactive' });
      }
      assert.equal(path, `${base}/interactions/question/answer`); assert.equal(init?.method, 'POST');
      return failure ? Response.json({ error: 'Uncertain answer' }, { status: 503 }) : Response.json({ ...view,
        request: { ...request, runId: wrongRun ? 'other-run' : 'run' }, revision: 2, status: 'answered', delivery: 'confirmed' });
    };
    assert.deepEqual(await api.sessionInteractions(key, signal), snapshot);
    assert.deepEqual(await api.setInteractionMode(key, 'interactive', signal), { mode: 'interactive' });
    wrongMode = true; await assert.rejects(api.setInteractionMode(key, 'interactive', signal), /Invalid interaction mode receipt/);
    const answer = { runId: 'run', expectedRevision: 1, responseId: 'response', answer: { kind: 'text' as const, text: 'Reply' } };
    assert.equal((await api.answerInteraction(key, 'question', answer, signal)).delivery, 'confirmed');
    wrongRun = true; await assert.rejects(api.answerInteraction(key, 'question', answer, signal), /Invalid interaction receipt/);
    failure = true; const before = calls;
    await assert.rejects(api.answerInteraction(key, 'question', answer, signal), /Uncertain answer/);
    assert.equal(calls, before + 1);
    const shared = JSON.stringify(['shared-session-v1', 'someone-else', key]);
    await assert.rejects(api.sessionInteractions(shared, signal), /not available for shared sessions/);
    await assert.rejects(api.setInteractionMode(shared, 'interactive', signal), /not available for shared sessions/);
    await assert.rejects(api.answerInteraction(shared, 'question', answer, signal), /not available for shared sessions/);
    assert.equal(calls, before + 1, 'Shared/delegated routes never probe owner interaction endpoints');
  }
});
