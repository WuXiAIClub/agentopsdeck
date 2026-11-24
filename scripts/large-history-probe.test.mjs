import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyLargeHistory } from './lib/large-history-probe.mjs';

for (const deltaMode of ['standard', 'preview']) test(`read acceptance restores HTTP 200 header-marked ${deltaMode} delta then 304`, async () => {
  const key = 'synthetic:delta';
  const etags = ['a', 'b'].map(value => `W/"history-${value.repeat(64)}"`);
  let step = 0;
  const result = await verifyLargeHistory({ sessionKeys: [key], rounds: 2, wait: async () => {}, request: async (path, init) => {
    const preview = init.method === 'POST';
    const deltaStep = deltaMode === 'preview' ? 1 : 2;
    const current = step++;
    let status = 200;
    const headers = { etag: etags[current >= deltaStep ? 1 : 0] };
    let body = { messages: [{ sessionKey: key, id: 'known', text: 'before' }], updatedAt: 1 };
    if (current === deltaStep) {
      headers['x-agentopsdeck-history-delta'] = '1';
      body = { historyDelta: 1, base: etags[0], slots: [0, { sessionKey: key, id: 'new', text: 'after' }], metadata: { updatedAt: 2 } };
    } else if (current > deltaStep) {
      status = 304; body = undefined;
      headers['x-agentopsdeck-history-meta'] = JSON.stringify({ updatedAt: 3, sourceCursor: null });
    }
    if (preview) return new Response(JSON.stringify({ sessionKey: key, status, headers, body }), { headers: { 'x-agentopsdeck-workspace-sync': '1' } });
    return new Response(body ? JSON.stringify(body) : null, { status, headers });
  } });
  assert.equal(result.state, 'verified');
  assert.equal(result.observations.at(-1).messages, 2);
  assert.equal(result.observations.at(-1).status, 304);
  assert.equal(result.observations.at(-1).digest, result.observations.at(-2).digest);
});

test('invalid delta base fails closed with safe classified evidence', async () => {
  let evidence;
  await assert.rejects(verifyLargeHistory({ sessionKeys: ['synthetic:private'], rounds: 1,
    save: async value => { evidence = value; }, request: async () => Response.json({ historyDelta: 1,
      base: 'invalid-secret', slots: [], metadata: { updatedAt: 1 } }, { headers: { 'x-agentopsdeck-history-delta': '1' } }) }), /acceptance failed/);
  assert.equal(evidence.failure.stage, 'restore');
  assert.equal(evidence.failure.status, 200);
  assert.match(evidence.failure.session, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /invalid-secret|synthetic:private/);
});

test('read acceptance handles pending independently, verifies six histories and never sends a message', async () => {
  const keys = Array.from({ length: 6 }, (_, i) => `synthetic:${i}`);
  let pending = true, calls = 0;
  const result = await verifyLargeHistory({ sessionKeys: keys, rounds: 2, wait: async () => {}, request: async (path, init) => {
    calls++;
    const page = key => ({ messages: [{ sessionKey: key, id: 'known', text: 'synthetic' }], updatedAt: 1 });
    if (init.method === 'POST') {
      assert.equal(path, '/api/hub/v1/workspace/sync');
      return new Response(JSON.parse(init.body).items.map(item => JSON.stringify({ sessionKey: item.sessionKey, status: 200, body: page(item.sessionKey) })).join('\n'),
        { headers: { 'x-agentopsdeck-workspace-sync': '1' } });
    }
    const key = decodeURIComponent(path.split('/')[5]);
    if (pending && key === keys[0]) { pending = false; return Response.json({ code: 'history_preparing', retryAfterMs: 1000 }, { status: 202 }); }
    return Response.json(page(key));
  } });
  assert.equal(result.state, 'verified'); assert.equal(result.observations.length, 24); assert.equal(calls, 15); assert.equal(result.writes, 0);
});

for (const failure of ['http', 'frame', 'empty', 'identity', 'pending']) test(`read acceptance does not certify ${failure} failure`, async () => {
  let result;
  let clock = 1_000;
  let pendingAttempts = 0;
  await assert.rejects(verifyLargeHistory({ sessionKeys: ['synthetic:1'], rounds: 1, maxPendingMs: failure === 'pending' ? 2_500 : 1_000,
    now: () => clock,
    wait: async ms => { clock += ms; },
    save: async value => { result = value; }, request: async (path, init) => {
      assert.ok(init.signal instanceof AbortSignal, 'probe requests carry an interrupting deadline signal');
      if (failure === 'http') return new Response('', { status: 503 });
      if (failure === 'pending') {
        pendingAttempts++;
        return Response.json({ code: 'history_preparing', retryAfterMs: 1000 }, { status: 202 });
      }
      const body = { messages: failure === 'empty' ? [] : [{ sessionKey: failure === 'identity' ? 'wrong' : 'synthetic:1', id: 'known' }] };
      if (init.method === 'POST') return new Response(JSON.stringify({ sessionKey: 'synthetic:1', status: 503 }), { headers: { 'x-agentopsdeck-workspace-sync': '1' } });
      return Response.json(body);
    } }), /acceptance failed/);
  assert.equal(result.state, 'needs-review');
  if (failure === 'pending') {
    assert.equal(pendingAttempts, 3, 'exercises repeated HTTP 202 pending receipts before deadline expiration');
    assert.equal(result.failure.stage, 'deadline');
  }
});

test('oversized response body fails closed before unbounded buffering', async () => {
  let result;
  await assert.rejects(verifyLargeHistory({
    sessionKeys: ['synthetic:oversized'],
    rounds: 1,
    maxResponseBytes: 64,
    save: async value => { result = value; },
    request: async () => new Response(JSON.stringify({
      messages: [{ sessionKey: 'synthetic:oversized', id: 'm1', text: 'x'.repeat(256) }],
      updatedAt: 1,
    }), { status: 200 }),
  }), /acceptance failed/);
  assert.equal(result.state, 'needs-review');
  assert.equal(result.failure.stage, 'request');
});
