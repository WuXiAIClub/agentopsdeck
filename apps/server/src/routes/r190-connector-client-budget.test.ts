import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ConnectorClient } from '../hub/connector-client.js';
import { ConnectorResponseBudgetPool, ConnectorResponseBudgetExceeded } from '../hub/response-budget.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';

const body = JSON.stringify({ groups: [{ agentId: 'codex', sessions: [] }], sourceCursor: 'synthetic', padding: 'é'.repeat(20) });
const bytes = Buffer.byteLength(body);
const response = () => new Response(body, { headers: { [CONNECTOR_PROTOCOL_HEADER]: '1' } });

test('real client charges UTF-8 bytes before parsing and retains the successful response until route settlement', async () => {
  const pool = new ConnectorResponseBudgetPool(bytes * 2), reservation = pool.acquire(bytes);
  let reads = 0;
  const client = new ConnectorClient('http://synthetic.invalid', 'synthetic', request => {
    reads++; assert.equal(request.method, 'GET');
    assert.equal(new URL(request.url).pathname, '/api/connector/v1/sessions/state');
    return response();
  });
  assert.deepEqual(await client.sessions(undefined, reservation), JSON.parse(body));
  assert.equal(reads, 1); assert.equal(pool.retainedBytes, bytes);
  assert.equal(reservation.snapshot().closed, false);
  reservation.close(); assert.equal(pool.retainedBytes, 0);
});

test('real clients on different Connectors share an original request transport budget', async () => {
  const pool = new ConnectorResponseBudgetPool(bytes * 2), reservation = pool.acquire(bytes);
  const a = new ConnectorClient('http://first.invalid', 'synthetic', response);
  const b = new ConnectorClient('http://second.invalid', 'synthetic', response);
  await a.sessions(undefined, reservation);
  await assert.rejects(b.sessions(undefined, reservation), ConnectorResponseBudgetExceeded);
  assert.equal(pool.retainedBytes, bytes); assert.equal(reservation.snapshot().refused, true);
  reservation.close(); assert.equal(pool.retainedBytes, 0);
});

test('global collected bytes remain charged across independently completed client responses', async () => {
  const pool = new ConnectorResponseBudgetPool(bytes), a = pool.acquire(bytes), b = pool.acquire(bytes);
  const client = new ConnectorClient('http://synthetic.invalid', 'synthetic', response);
  await client.sessions(undefined, a);
  await assert.rejects(client.sessions(undefined, b), ConnectorResponseBudgetExceeded);
  a.close(); assert.equal(pool.retainedBytes, 0);
  await assert.rejects(client.sessions(undefined, b), ConnectorResponseBudgetExceeded);
  b.close();
  const fresh = pool.acquire(bytes);
  await client.sessions(undefined, fresh); fresh.close(); assert.equal(pool.retainedBytes, 0);
});

test('budget refusal cancels the body and never invokes JSON.parse on the oversized response', async () => {
  const pool = new ConnectorResponseBudgetPool(bytes), reservation = pool.acquire(bytes - 1);
  let cancelled = 0, parses = 0, acknowledge!: () => void;
  const client = new ConnectorClient('http://synthetic.invalid', 'synthetic', () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from(body)); },
    cancel() { cancelled++; return new Promise<void>(resolve => { acknowledge = resolve; }); },
  }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: '1' } }));
  const parse = JSON.parse;
  try {
    JSON.parse = (value, reviver) => { parses++; return parse(value, reviver); };
    const pending = client.sessions(undefined, reservation);
    const result = assert.rejects(pending, ConnectorResponseBudgetExceeded);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    await turn();
    assert.equal(cancelled, 1); assert.equal(settled, false);
    assert.equal(reservation.snapshot().closed, false);
    acknowledge(); await result;
  } finally { JSON.parse = parse; }
  assert.equal(parses, 0); assert.equal(cancelled, 1); assert.equal(pool.retainedBytes, 0);
  assert.equal(reservation.snapshot().closed, false); reservation.close();
});

test('abort closes client transport but never refunds already collected chunks', async () => {
  const pool = new ConnectorResponseBudgetPool(100), reservation = pool.acquire(100), signal = new AbortController();
  let collected!: () => void, acknowledge!: () => void;
  const gate = new Promise<void>(resolve => { collected = resolve; });
  const originalConsume = reservation.consume;
  reservation.consume = size => { originalConsume(size); collected(); };
  const client = new ConnectorClient('http://synthetic.invalid', 'synthetic', () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from('{"groups":')); },
    cancel() { return new Promise<void>(resolve => { acknowledge = resolve; }); },
  }), { headers: { [CONNECTOR_PROTOCOL_HEADER]: '1' } }));
  const pending = client.sessions(signal.signal, reservation), result = assert.rejects(pending);
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  await gate; signal.abort(); await turn();
  assert.equal(settled, false); assert.equal(typeof acknowledge, 'function');
  assert.equal(pool.retainedBytes, 10); assert.equal(reservation.snapshot().closed, false);
  acknowledge(); await result;
  assert.equal(pool.retainedBytes, 10); assert.equal(reservation.snapshot().closed, false);
  reservation.close(); assert.equal(pool.retainedBytes, 0);
});

test('late authority revocation does not refund transport bytes or publish the result', async () => {
  const pool = new ConnectorResponseBudgetPool(bytes), reservation = pool.acquire(bytes);
  let revoked = false;
  const originalConsume = reservation.consume;
  reservation.consume = size => { originalConsume(size); revoked = true; };
  const client = new ConnectorClient('http://synthetic.invalid', 'synthetic', response, undefined, undefined,
    { authorize() { if (revoked) throw new Error('Synthetic revoked authority'); } });
  await assert.rejects(client.sessions(undefined, reservation), /Synthetic revoked authority/);
  assert.equal(pool.retainedBytes, bytes); reservation.close();
});

test('aggregate accounting cannot weaken the original single-response size limit', async () => {
  const pool = new ConnectorResponseBudgetPool(bytes), reservation = pool.acquire(bytes);
  const client = new ConnectorClient('http://synthetic.invalid', 'synthetic', response, undefined, 10);
  await assert.rejects(client.sessions(undefined, reservation), /Connector response exceeds size limit/);
  assert.equal(pool.retainedBytes, 0); reservation.close();
});

test('malformed JSON keeps its original error and charges already collected bytes until original-work settlement', async () => {
  const pool = new ConnectorResponseBudgetPool(100), reservation = pool.acquire(100);
  const client = new ConnectorClient('http://synthetic.invalid', 'synthetic', () => new Response('not JSON', { headers: { [CONNECTOR_PROTOCOL_HEADER]: '1' } }));
  await assert.rejects(client.sessions(undefined, reservation), /Invalid Connector JSON response/);
  assert.equal(pool.retainedBytes, 8); reservation.close(); assert.equal(pool.retainedBytes, 0);
});

test('ordinary Connector JSON/session calls preserve behavior when no collector is supplied', async () => {
  const client = new ConnectorClient('http://synthetic.invalid', 'synthetic', response);
  assert.deepEqual(await client.sessions(), JSON.parse(body));
  assert.deepEqual(await client.json('/capabilities'), JSON.parse(body));
});
