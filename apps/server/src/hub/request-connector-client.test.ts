import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorClient, ConnectorClientError } from './connector-client.js';
import { requestConnectorClient } from './request-connector-client.js';
import type { AsyncConnectorOptions } from './async-connector-client.js';
import type { NodeGrantProof } from './node-grants.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request = () => new Request('http://fixture', { headers: { cookie: 'agentopsdeck_session=synthetic' } });
const client = new ConnectorClient('http://fixture', 'synthetic', () => Response.json({ ok: true }));
const forbidden = () => { throw Error('synchronous fallback is forbidden'); };

test('legacy Connector resolution preserves arguments and returned client', async () => {
  const grant = { grantId: 'fixture' } as NodeGrantProof;
  let calls = 0;
  assert.equal(await requestConnectorClient({ connectorClient(id, maintenance, user, proof) {
    calls++; assert.equal(id, 'node'); assert.equal(maintenance, true);
    assert.equal(user, 'recipient'); assert.equal(proof, grant); return client;
  } }, request(), 'node', true, 'recipient', grant), client);
  assert.equal(calls, 1);
});

test('async port receives the real request and recipient expectation, not grant owner authority', async () => {
  const raw = request(), grant = { ownerUserId: 'owner', userId: 'recipient' } as NodeGrantProof;
  let calls = 0, options: AsyncConnectorOptions | undefined;
  const result = await requestConnectorClient({ connectorClient: forbidden,
    async asyncConnectorClient(received, id, value) { calls++; assert.equal(received, raw); assert.equal(id, 'node'); options = value; return client; },
  }, raw, 'node', false, 'recipient', grant);
  assert.equal(result, client); assert.equal(calls, 1);
  assert.deepEqual(options, { maintenance: false, expectedUserId: 'recipient', grant });
});

for (const status of [401, 403, 503]) test(`async refusal ${status} never falls back or replays`, async () => {
  let calls = 0; const error = new ConnectorClientError(status, 'private refusal');
  await assert.rejects(requestConnectorClient({ connectorClient: forbidden,
    async asyncConnectorClient() { calls++; throw error; },
  }, request(), 'node'), value => value === error);
  assert.equal(calls, 1);
});

test('pre-cancelled request never invokes either resolver', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(requestConnectorClient({ connectorClient: forbidden, asyncConnectorClient: async () => forbidden() },
    new Request('http://fixture', { signal: abort.signal }), 'node'), { status: 499 });
});

for (const outcome of ['grant', 'deny'] as const) test(`cancelled async resolver observes late ${outcome} with no dispatch`, async () => {
  let grant!: (value: ConnectorClient) => void, deny!: (error: Error) => void, calls = 0, dispatches = 0;
  const original = new Promise<ConnectorClient>((yes, no) => { grant = yes; deny = no; });
  const abort = new AbortController();
  const pending = requestConnectorClient({ connectorClient: forbidden,
    async asyncConnectorClient() { calls++; return original; },
  }, new Request('http://fixture', { signal: abort.signal }), 'node');
  const stopped = assert.rejects(pending, { status: 499 });
  abort.abort(); await stopped;
  if (outcome === 'grant') grant(new ConnectorClient('http://fixture', 'synthetic', () => { dispatches++; return Response.json({}); }));
  else deny(Error('late private denial'));
  await tick(); assert.equal(calls, 1); assert.equal(dispatches, 0);
});

test('never-settling async resolver has a bounded HTTP wait without a retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stopped = assert.rejects(requestConnectorClient({ connectorClient: forbidden,
    asyncConnectorClient() { calls++; return new Promise<ConnectorClient>(() => {}); },
  }, request(), 'node'), { status: 503 });
  t.mock.timers.tick(45_000); await stopped; assert.equal(calls, 1);
});

for (const late of ['grant', 'deny'] as const) test(`catalog deadline preserves original evidence and observes late ${late} without dispatch`, async () => {
  const raw = request(), abort = new AbortController(); let calls = 0, dispatches = 0;
  let grant!: (client: ConnectorClient) => void, deny!: (error: Error) => void;
  const held = new Promise<ConnectorClient>((yes, no) => { grant = yes; deny = no; });
  const stopped = assert.rejects(requestConnectorClient({ connectorClient: forbidden,
    asyncConnectorClient(received) { assert.equal(received, raw); calls++; return held; },
  }, raw, 'node', false, 'owner', undefined, abort.signal), { status: 499 });
  abort.abort(); await stopped; assert.equal(raw.signal.aborted, false);
  if (late === 'grant') grant(new ConnectorClient('http://fixture', 'synthetic', () => { dispatches++; return Response.json({}); }));
  else deny(Error('PRIVATE late failure'));
  await tick(); assert.equal(calls, 1); assert.equal(dispatches, 0);
});

test('pre-expired catalog never invokes either resolver', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(requestConnectorClient({ connectorClient: forbidden,
    asyncConnectorClient: async () => forbidden() }, request(), 'node', false, 'owner', undefined, abort.signal), { status: 499 });
});
