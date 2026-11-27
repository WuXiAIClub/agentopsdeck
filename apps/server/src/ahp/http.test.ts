import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { AsyncConnectorOwner } from '../connector/async-connector-owner.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createAsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { AsyncHubConnectionProxyAccess } from '../hub/async-connection-proxy-access.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { HubStore } from '../hub/hub-store.js';
import { registerConnectorAhp } from './connector-http.js';
import { registerHubAhp } from './hub-http.js';

test('AHP owner API reads one chat and never dispatches a duplicate or a delegated command', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aod-ahp-test-'));
  const quiet = new PerformanceDiagnostics(() => {});
  const worker = new AsyncConnectorOwner({ file: join(dir, 'connector.sqlite'), tokenFile: join(dir, 'tokens.json') }, quiet);
  await worker.open();
  const owner = await worker.command('tokenCreate', { label: 'Owner', scopes: ['messages:read', 'messages:send'] });
  const delegate = await worker.command('tokenCreate', { label: 'Delegate', scopes: ['messages:read', 'messages:send', 'execution:delegate'], delegationHubId: 'test-hub' });
  const file = join(dir, 'hub.sqlite'), encryptionSecret = 'synthetic-test-vault';
  const hubStore = new HubStore(file, encryptionSecret);
  const connector = new Hono();
  const hub = new Hono();
  const node = await worker.command('nodeIdentity', {});
  connector.use('*', async (c, next) => {
    c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max));
    c.header(NODE_ID_HEADER, node);
    await next();
  });
  const turnId = '11111111-1111-4111-8111-111111111111';
  let dispatched = 0;
  const transport = registerConnectorAhp(connector, { instanceId: 'synthetic-instance', sessionUri: `ahp-session:/${turnId}`, cli: 'synthetic' }, {
    command: (kind, input) => worker.command(kind, input),
    attach: async () => ({
      view: () => ({ title: 'Synthetic chat', canSend: true, turns: [{ id: 'hello', prompt: 'Test', response: 'Reply', active: false }] }),
      sendText: async text => {
        dispatched++;
        if (text === 'Disconnect') throw new Error('Synthetic transport error');
        return turnId;
      },
      close: async () => {},
    }),
  });
  const user = hubStore.createUser('Connection owner'), other = hubStore.createUser('Other Hub user');
  const userKey = hubStore.identities.issueKey(user.id), otherKey = hubStore.identities.issueKey(other.id);
  hubStore.upsertConnection({ id: 'test', ownerUserId: user.id, label: 'Test', connectorUrl: 'http://connector.invalid', credentialToken: owner.token });
  hubStore.pinConnectionNode('test', user.id, hubStore.connectionAuthority('test', user.id)!, node);
  await hubStore.close();
  const hubOwner = new AsyncHubMemberOwner({ file, encryptionSecret }, quiet);
  const resolver = createAsyncConnectorClientResolver(hubOwner, undefined, quiet);
  const gateway = registerHubAhp(hub, { mode: 'async', access: new AsyncHubConnectionProxyAccess(hubOwner, quiet), asyncConnectorClient: resolver });
  t.after(async () => {
    await gateway.close();
    await resolver.close();
    await hubOwner.close();
    await transport.close();
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).origin, 'http://connector.invalid');
    return connector.fetch(request);
  });
  const path = '/api/connector/v1/ahp';
  assert.equal((await connector.request(path, { headers: { authorization: `Bearer ${delegate.token}` } })).status, 403);
  assert.equal((await connector.request(path)).status, 403);
  let actor = userKey.token;
  const hubPath = '/api/hub/v1/connections/test/ahp';
  const read = () => hub.request(hubPath, { headers: { 'x-agentopsdeck-key': actor } });
  const get = await read();
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await get.json(), { title: 'Synthetic chat', canSend: true,
    turns: [{ id: 'hello', prompt: 'Test', response: 'Reply', active: false }] });
  const send = (key: string, text: string) => hub.request(hubPath, {
    method: 'POST', headers: { 'x-agentopsdeck-key': actor, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ text }),
  });
  for (let i = 0; i < 2; i++) assert.deepEqual(await (await send('same-command', 'Continue')).json(), { id: turnId });
  assert.equal(dispatched, 1);
  assert.equal((await send('same-command', 'Changed text')).status, 409);
  for (let i = 0; i < 2; i++) assert.equal((await send('unknown-command', 'Disconnect')).status, 502);
  assert.equal(dispatched, 2);
  actor = otherKey.token;
  assert.equal((await read()).status, 404);
  assert.equal((await send('foreign-command', 'Must not start')).status, 404);
  await worker.command('tokenRevoke', { tokenId: owner.record.id });
  actor = userKey.token;
  assert.equal((await send('revoked-command', 'Must not start')).status, 403);
  assert.equal(dispatched, 2);
});
