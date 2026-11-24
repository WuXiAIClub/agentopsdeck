import assert from 'node:assert/strict';
import test from 'node:test';
import { AOD_MODEL_SET_ID, CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { ConnectorClient } from './connector-client.js';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from '../connector/node-identity.js';
import { connectionControlObservation, connectionControlWire, validConnectionControlOperation, validConnectionControlObservation,
  type ConnectionControlOperation, type ConnectionControlObservation } from './connection-control-contract.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() {let resolve!: (v: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise, resolve};}
const headers = {[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: 'node_control'};
const response = (body: unknown = {ok: true, state: 'succeeded'}, status = 200) => Response.json(body, {status, headers});
const commands: ConnectionControlOperation[] = [
  {operation: 'capabilities'}, {operation: 'modelSet'}, {operation: 'updateStatus'}, {operation: 'maintenanceStatus'},
  {operation: 'reconcile', request: {setId: AOD_MODEL_SET_ID, idempotencyKey: 'original', dryRun: true}},
  {operation: 'updateCheck', request: {channel: 'stable'}},
];

for (const phase of ['preflight', 'delivery'] as const) test(`original JSON retains ${phase} authority ACK after cancellation without dispatch or delivery replay`, {timeout: 5000}, async () => {
  const entered = deferred(), ack = deferred(), abort = new AbortController();
  let checks = 0, dispatches = 0, finished = false;
  const client = new ConnectorClient('http://connector.invalid', 'synthetic', () => { dispatches++; return response(); },
    4000, 1024, {authorize: async () => {
      if (++checks === (phase === 'preflight' ? 1 : 2)) { entered.resolve(); await ack.promise; }
    }});
  const rejected = assert.rejects(client.jsonOriginal('/system/metrics', {signal: abort.signal})).then(() => { finished = true; });
  try {
    await entered.promise; abort.abort(); await tick();
    assert.equal(finished, false); assert.equal(dispatches, phase === 'preflight' ? 0 : 1);
  } finally { ack.resolve(); await rejected; }
  assert.equal(dispatches, phase === 'preflight' ? 0 : 1);
});

test('original JSON retains aborted reader cancellation ACK, never mistaking HTTP cancellation for original settlement', {timeout: 5000}, async () => {
  const entered = deferred(), ack = deferred(), abort = new AbortController();
  let dispatches = 0, finished = false, cancels = 0;
  const client = new ConnectorClient('http://connector.invalid', 'synthetic', () => {
    dispatches++;
    return new Response(new ReadableStream<Uint8Array>({
      pull() { entered.resolve(); }, async cancel() { cancels++; await ack.promise; },
    }), {headers});
  });
  const rejected = assert.rejects(client.jsonOriginal('/system/metrics', {signal: abort.signal})).then(() => {finished = true;});
  try { await entered.promise; abort.abort(); await tick(); assert.equal(finished, false); assert.equal(cancels, 1); }
  finally { ack.resolve(); await rejected; }
  assert.equal(dispatches, 1); assert.equal(cancels, 1);
});

test('fixed control contract refuses arbitrary paths, methods, principals, actions, fields and channels', () => {
  for (const command of commands) {
    assert.equal(validConnectionControlOperation(command), true);
    assert.equal(validConnectionControlOperation({...command, path: '/secrets'}), false);
    assert.equal(validConnectionControlOperation({...command, ownerUserId: 'default'}), false);
  }
  for (const value of [{operation: 'arbitrary'}, {operation: 'updateCheck', request: {channel: 'nightly'}},
    {operation: 'reconcile', request: {setId: 'wrong'}}, {operation: 'reconcile', request: {setId: AOD_MODEL_SET_ID, models: []}},
    {operation: 'reconcile', request: {setId: AOD_MODEL_SET_ID, idempotencyKey: '中'.repeat(1366)}},
    {operation: 'reconcile', request: {setId: AOD_MODEL_SET_ID, idempotencyKey: 'bad\nkey'}},
  ]) assert.equal(validConnectionControlOperation(value), false);
  assert.deepEqual(connectionControlObservation(commands[0]!, 200, {ok: true, state: 'PRIVATE_SECRET', token: 'PRIVATE_TOKEN'}),
    {operation: 'capabilities', status: 200, facts: {ok: true}});
  for (const status of [199, 300, 399, 500, 599]) assert.equal(validConnectionControlObservation({operation: 'capabilities', status, facts: {}}), false);
  assert.equal(validConnectionControlObservation({operation: 'capabilities', status: 200, facts: {token: 'private'}}), false);
});

for (const command of commands) test(`fixed ${command.operation} dispatches exact wire once and settles before delivery`, async () => {
  const wire = connectionControlWire(command), events: string[] = [];
  const client = new ConnectorClient('http://connector.invalid', 'synthetic', async request => {
    events.push('dispatch'); assert.equal(request.url, 'http://connector.invalid/api/connector/v1' + wire.path);
    assert.equal(request.method, wire.method); assert.equal(request.headers.get('authorization'), 'Bearer synthetic');
    assert.equal(request.headers.get(EXPECTED_NODE_HEADER), 'node_control'); assert.equal(request.redirect, 'error');
    if ('body' in wire) assert.equal(await request.text(), wire.body);
    return response();
  }, 1000, 1024, {nodeId: 'node_control', request: (path, method) => {events.push('policy'); assert.equal(path, wire.path); assert.equal(method, wire.method);},
    authorize: () => {events.push('authority');}});
  const result = await client.connectionControlOriginal(command, async fact => {events.push('settle'); assert.deepEqual(fact, {operation: command.operation, status: 200, facts: {ok: true, state: 'succeeded'}});});
  assert.deepEqual(result, {status: 200, body: {ok: true, state: 'succeeded'}});
  assert.deepEqual(events, ['policy','authority','dispatch','settle','authority']);
});

test('post-effect revocation cannot erase original fact; revoked delivery remains denied', async () => {
  let revoked = false, dispatches = 0, settled = 0;
  const client = new ConnectorClient('http://connector.invalid', 'synthetic', () => {dispatches++; revoked = true; return response();},
    1000, 1024, {authorize: () => {if (revoked) throw Error('revoked');}});
  await assert.rejects(client.connectionControlOriginal(commands[0]!, async () => {settled++;}), /revoked/);
  assert.equal(dispatches, 1); assert.equal(settled, 1);
});

test('settlement failure prevents delivery but never retries the original effect', async () => {
  let dispatches = 0, settled = 0, authority = 0;
  const client = new ConnectorClient('http://connector.invalid', 'synthetic', () => {dispatches++; return response();},
    1000, 1024, {authorize: () => {authority++;}});
  await assert.rejects(client.connectionControlOriginal(commands[4]!, async () => {settled++; throw Error('audit failed');}), /audit failed/);
  assert.equal(dispatches, 1); assert.equal(settled, 1); assert.equal(authority, 1);
});

test('original settlement ACK is retained despite request abort after known EOF', async () => {
  const abort = new AbortController(), ack = deferred(); let entered = false, finished = false;
  const client = new ConnectorClient('http://connector.invalid', 'synthetic', () => response());
  const pending = client.connectionControlOriginal(commands[0]!, async () => {entered = true; abort.abort(Error('stopped')); await ack.promise;}, abort.signal);
  const rejected = assert.rejects(pending, /stopped/).then(() => {finished = true;});
  await tick(); assert.equal(entered, true); assert.equal(finished, false);
  ack.resolve(); await rejected;
});

for (const kind of ['protocol', 'node', 'redirect', 'server', 'json', 'oversize', 'empty', 'network'] as const) {
  test(`uncertain ${kind} cannot settle a fact or trigger redispatch`, async () => {
    let dispatches = 0, settled = 0;
    const client = new ConnectorClient('http://connector.invalid', 'synthetic', () => {
      dispatches++;
      if (kind === 'network') throw Error('lost dispatch');
      if (kind === 'protocol') return Response.json({}, {headers: {[CONNECTOR_PROTOCOL_HEADER]: '0', [NODE_ID_HEADER]: 'node_control'}});
      if (kind === 'node') return Response.json({}, {headers: {...headers, [NODE_ID_HEADER]: 'wrong'}});
      if (kind === 'redirect') return new Response('redirect', {status: 302, headers});
      if (kind === 'server') return response({}, 503);
      if (kind === 'json') return new Response('{broken', {headers});
      if (kind === 'oversize') return response({text: 'x'.repeat(1024)});
      return new Response(null, {status: 204, headers});
    }, 1000, 128, {nodeId: 'node_control'});
    await assert.rejects(client.connectionControlOriginal(commands[0]!, async () => {settled++;}));
    assert.equal(dispatches, 1); assert.equal(settled, 0);
  });
}

test('known 4xx rejection is settled before transport error delivery', async () => {
  const facts: ConnectionControlObservation[] = [];
  const client = new ConnectorClient('http://connector.invalid', 'synthetic', () => response({error: 'PRIVATE_MESSAGE'}, 403));
  await assert.rejects(client.connectionControlOriginal(commands[0]!, async fact => {facts.push(fact);}));
  assert.deepEqual(facts, [{operation: 'capabilities', status: 403, facts: {}}]);
});

test('caller mutation during preflight cannot change the pinned original operation or body', async () => {
  const gate = deferred(), command: ConnectionControlOperation = {operation: 'updateCheck', request: {channel: 'stable'}};
  const client = new ConnectorClient('http://connector.invalid', 'synthetic', async request => {
    assert.equal(request.url.endsWith('/update/check'), true); assert.deepEqual(await request.json(), {channel: 'stable'}); return response();
  }, 1000, 1024, {authorize: () => gate.promise});
  const pending = client.connectionControlOriginal(command, async () => {});
  command.request.channel = 'candidate'; gate.resolve(); await pending;
});

test('deadline waits late original dispatch cancellation ACK instead of releasing it as not executed', {timeout: 3000}, async () => {
  const source = deferred<Response>(), cancel = deferred(); let cancelled = false, finished = false, settled = 0;
  const client = new ConnectorClient('http://connector.invalid', 'synthetic', () => source.promise, 25);
  const pending = client.connectionControlOriginal(commands[0]!, async () => {settled++;});
  const rejected = assert.rejects(pending).then(() => {finished = true;});
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(finished, false);
  source.resolve(new Response(new ReadableStream({cancel: async () => {cancelled = true; await cancel.promise;}}), {headers}));
  await tick(); assert.equal(cancelled, true); assert.equal(finished, false);
  cancel.resolve(); await rejected; assert.equal(settled, 0);
});
