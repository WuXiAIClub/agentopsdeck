import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { AsyncRuntimeReads } from './async-runtime-reads.js';
import { registerRuntimeReadsHttp } from './runtime-reads-http.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { DeckStore } from '../projection/deck-store.js';

function fixture(context: test.TestContext) {
  const state = { denied: false, changed: false, requested: true, calls: 0, deliveries: 0 };
  const owner = { command: (async (kind: string) => {
    if (state.denied) return { error: 403 };
    if (kind === 'codexReadDeliver' && ++state.deliveries > 1 && state.changed) return { error: 409 };
    return { key: 'codex:synthetic', readerId: 'reader' };
  }) as AsyncConnectorOwner['command'] };
  const reads = new AsyncRuntimeReads(owner, { projection: new DeckStore(), snapshot: async read => read('cursor'),
    historyReady: () => false, refresh: async () => assert.fail('Recovery must not create parallel history reads'),
    requestRecovery: async (key, runId) => {
      assert.equal(key, 'codex:synthetic');
      assert.equal(runId, 'turn');
      state.calls++;
      return state.requested;
    } }, 'codex');
  context.after(() => reads.close());
  const app = new Hono();
  registerRuntimeReadsHttp(app, '/sessions/:sessionKey', { reads }, 'codex');
  const request = (body: unknown = { expectedRunId: 'turn' }, signal?: AbortSignal) => app.request('/sessions/codex:synthetic/recovery', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return { reads, state, request };
}

test('recovery requests only the original recovery worker and returns no unlock proof', async context => {
  const f = fixture(context), response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requested: true });
  assert.equal(f.state.calls, 1);
  assert.equal(f.state.deliveries, 2);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('recovery rejects revoked access without scheduling work', async context => {
  const f = fixture(context);
  f.state.denied = true;
  assert.equal((await f.request()).status, 403);
  assert.equal(f.state.calls, 0);
});

test('successor identity conflict is not reported as recovery success', async context => {
  const f = fixture(context);
  f.state.requested = false;
  assert.equal((await f.request()).status, 409);
});

test('authority changed during scheduling never returns success or repeats work', async context => {
  const f = fixture(context);
  f.state.changed = true;
  assert.equal((await f.request()).status, 409);
  assert.equal(f.state.calls, 1);
});

test('cancelled recovery request does not schedule work', async context => {
  const f = fixture(context), controller = new AbortController();
  controller.abort();
  assert.equal((await f.request(undefined, controller.signal)).status, 408);
  assert.equal(f.state.calls, 0);
});

test('malformed recovery identities cannot reach the worker', async context => {
  const f = fixture(context);
  for (const body of [{}, { expectedRunId: '' }, { expectedRunId: 1 }, { expectedRunId: 'turn', unlock: true },
    { expectedRunId: 'turn\n' }, { expectedRunId: 'x'.repeat(513) }, []]) {
    assert.equal((await f.request(body)).status, 400);
  }
  assert.equal(f.state.calls, 0);
});

test('older read ports fail closed without inventing recovery', async () => {
  const app = new Hono();
  registerRuntimeReadsHttp(app, '/sessions/:sessionKey', { reads: {
    state: async () => ({ error: 503 }), page: async () => ({ error: 503 }), message: async () => ({ error: 503 }),
  } }, 'codex');
  const response = await app.request('/sessions/codex:synthetic/recovery', { method: 'POST',
    body: JSON.stringify({ expectedRunId: 'turn' }) });
  assert.equal(response.status, 409);
});
