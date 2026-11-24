import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationConnectorClient } from './application-connector-client.js';
import { ConnectorClient, ConnectorClientError } from './connector-client.js';
import type { AsyncConnectorOptions } from './async-connector-client.js';
import type { HubPrincipal } from './identity.js';

const request = () => new Request('http://hub/', { headers: { 'x-agentopsdeck-internal': 'true', 'x-agentopsdeck-user': 'default' } });
const client = new ConnectorClient('http://fixture.invalid', 'synthetic');

test('external requests use only the async port, forwarding the exact request and expectations', async () => {
  const internal = new WeakMap<Request, () => HubPrincipal | undefined>();
  const incoming = request(), options: AsyncConnectorOptions = { expectedUserId: 'member', maintenance: true };
  let calls = 0;
  const resolve = createApplicationConnectorClient(async (raw, id, expectation) => {
    calls++; assert.equal(raw, incoming); assert.equal(id, 'node'); assert.equal(expectation, options); return client;
  }, internal, () => { throw Error('sync fallback'); });
  assert.equal(await resolve(incoming, 'node', options), client); assert.equal(calls, 1);
});

for (const status of [401, 403, 404, 499, 503]) test(`external ${status} never falls back to internal authority`, async () => {
  const failure = new ConnectorClientError(status, 'synthetic failure');
  const resolve = createApplicationConnectorClient(async () => { throw failure; }, new WeakMap(), () => { throw Error('sync fallback'); });
  await assert.rejects(resolve(request(), 'node'), error => error === failure);
});

test('only the private exact Request selects the original internal actor, not headers or clones', async () => {
  const internal = new WeakMap<Request, () => HubPrincipal | undefined>(), incoming = request();
  let actor: HubPrincipal | undefined = { userId: 'member', admin: false }, external = 0;
  const calls: unknown[][] = [];
  internal.set(incoming, () => actor);
  const resolve = createApplicationConnectorClient(async () => { external++; throw new ConnectorClientError(401, 'external'); },
    internal, (...args) => { calls.push(args); return client; });
  assert.equal(await resolve(incoming, 'node', { expectedUserId: 'member', maintenance: true }), client);
  assert.deepEqual(calls, [['node', true, 'member', undefined]]);
  await assert.rejects(resolve(incoming.clone(), 'node'), { status: 401 });
  await assert.rejects(resolve(request(), 'node'), { status: 401 });
  actor = { userId: 'changed', admin: false };
  await assert.rejects(resolve(incoming, 'node', { expectedUserId: 'member' }), { status: 403 });
  actor = undefined;
  await assert.rejects(resolve(incoming, 'node'), { status: 401 });
  internal.delete(incoming);
  await assert.rejects(resolve(incoming, 'node'), { status: 401 });
  assert.equal(calls.length, 1); assert.equal(external, 3);
});

test('cancelled requests and narrowed internal binding modes cannot dispatch', async () => {
  let calls = 0;
  const internal = new WeakMap<Request, () => HubPrincipal | undefined>(), incoming = request();
  internal.set(incoming, () => ({ userId: 'member', admin: false }));
  const resolve = createApplicationConnectorClient(async () => { calls++; return client; }, internal, () => { calls++; return client; });
  for (const mode of [true, 'file-boards', 'card-files'] as const)
    await assert.rejects(resolve(incoming, 'node', { boardBindingsOnly: mode }), { status: 403 });
  const cancelled = new Request('http://hub/', { signal: AbortSignal.abort() });
  await assert.rejects(resolve(cancelled, 'node'), { status: 499 });
  internal.set(cancelled, () => ({ userId: 'member', admin: false }));
  await assert.rejects(resolve(cancelled, 'node'), { status: 499 });
  assert.equal(calls, 0);
});

test('an invalid asynchronous internal actor is denied without converting it into worker evidence', async () => {
  const internal = new WeakMap<Request, () => HubPrincipal | undefined>(), incoming = request();
  internal.set(incoming, (async () => ({ userId: 'default', admin: true })) as unknown as () => HubPrincipal);
  const resolve = createApplicationConnectorClient(async () => { throw Error('external'); }, internal, () => { throw Error('original'); });
  await assert.rejects(resolve(incoming, 'node'), { status: 401 });
});
