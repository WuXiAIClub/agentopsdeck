import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { registerHubConnectionVerification } from './hub-connection-verification.js';

const secret = 'PRIVATE_PROBE_SENTINEL';
function fixture(t: TestContext, capabilities: unknown = {}) {
  let authorized = true, checks = 0;
  const check = async () => { checks++; if (!authorized) throw new HubMemberRequestError(403); };
  const connection = { id: 'local', connectorUrl: 'local://aod-connector' };
  const original = { principal: { userId: 'member' }, recoveryScope: 'scope', check,
    connectionDirectory: async () => ({ connections: [connection], users: [], check }) };
  const app = new Hono();
  const routes = registerHubConnectionVerification(app, {
    mode: 'async', defaultConnectionId: 'local',
    asyncConnectorClient: async () => ({ jsonOriginal: async () => capabilities }),
    createAccess: () => ({ requests: { begin: async () => original }, close: async () => {} }),
    present: () => ({ id: 'local' }),
    error: (_context: Context, error: unknown) => error instanceof HTTPException ? error.getResponse() : Response.json({ error: 'unavailable' }, { status: 503 }),
  } as unknown as Parameters<typeof registerHubConnectionVerification>[1]);
  t.after(() => routes.close());
  return { app, revoke: () => { authorized = false; }, checks: () => checks,
    send: (body: unknown) => app.request('/api/hub/v1/connections/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) };
}

test('remote probe allowlists nested success DTOs and removes query, userinfo and fragment', async t => {
  const f = fixture(t), urls: string[] = [];
  t.mock.method(ConnectorClient.prototype, 'jsonOriginal', async (path: string) => {
    urls.push(path);
    return path === '/info' ? {
      service: 'aod-connector', version: '1.0.0', environment: { idHint: 'fixture', label: 'Fixture', home: secret },
      features: { sessions: true, messages: true, arbitrary: secret }, token: secret, diagnostic: { path: secret },
    } : {
      ok: true, status: 'online', updatedAt: 1,
      gateway: { ok: true, status: 'online', gatewayWs: { configured: true, connected: true, url: secret },
        adminRpc: { configured: true, endpoint: secret }, error: secret, details: { token: secret } },
      codex: { enabled: true, sessionListReady: true, directory: secret },
      hermes: { enabled: true, ready: false, status: 'starting', diagnostic: secret }, token: secret,
    };
  });
  const probeUrl = new URL(`https://probe.invalid/base?token=${secret}#private`);
  probeUrl.username = 'synthetic-user';
  probeUrl.password = 'synthetic-password';
  const response = await f.send({ connectorUrl: probeUrl.href, token: 'synthetic' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true); assert.equal(body.connectorUrl, 'https://probe.invalid/base');
  assert.deepEqual(body.connector, { service: 'aod-connector', version: '1.0.0', environment: { idHint: 'fixture', label: 'Fixture' },
    features: { sessions: true, messages: true } });
  assert.deepEqual(body.health, { ok: true, status: 'online', updatedAt: 1,
    gateway: { ok: true, status: 'online', gatewayWs: { configured: true, connected: true }, adminRpc: { configured: true } },
    codex: { enabled: true, sessionListReady: true }, hermes: { enabled: true, ready: false, status: 'starting' } });
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PROBE_SENTINEL|password|user:/);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(urls.length, 2);
  assert.ok(f.checks() >= 2);
});

test('local capabilities project required contract fields, finite limits and known scopes only', async t => {
  const f = fixture(t, {
    protocol: { min: 1, max: 1, private: secret }, connector: { service: 'aod-connector', version: '1.0',
      build: { revision: 'abc', dirty: false, home: secret }, token: secret },
    environment: { label: 'Fixture', directory: secret }, features: { events: true, sessions: 'not boolean', unknown: true },
    runtimes: { codex: { enabled: true, ready: true, ownerOnly: true, status: 'ready', features: { text: true, arbitrary: true }, path: secret },
      unknown: { token: secret } },
    scopes: ['messages:read', secret, 'messages:read'], principal: { tokenId: secret, label: secret },
    limits: { maxMessageChars: 100000, maxRequestsPerMinute: -1, maxSseConnections: 1.5, secret },
    gateway: { statusVisible: true, opsAllowed: false, error: secret },
    update: { supported: false, currentVersion: '1.0', state: 'idle', rollbackAvailable: false, updatedAt: 2, lastError: secret },
  });
  const response = await f.send({ connectorUrl: 'local://aod-connector' });
  assert.equal(response.status, 200); const body = await response.json();
  assert.deepEqual(body.connector, { protocol: { min: 1, max: 1 },
    connector: { service: 'aod-connector', version: '1.0', build: { revision: 'abc', dirty: false } },
    environment: { label: 'Fixture' }, features: { events: true },
    runtimes: { codex: { enabled: true, ready: true, ownerOnly: true, status: 'ready', features: { text: true } } },
    limits: { maxMessageChars: 100000 }, gateway: { statusVisible: true, opsAllowed: false },
    update: { supported: false, currentVersion: '1.0', state: 'idle', rollbackAvailable: false, updatedAt: 2 }, scopes: ['messages:read'] });
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PROBE_SENTINEL/);
});

test('successful upstream reads cannot bypass final original authority', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { f.revoke(); return Response.json({ service: 'aod-connector', secret }); });
  const response = await f.send({ connectorUrl: 'https://probe.invalid', token: 'synthetic' });
  assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /PRIVATE_PROBE_SENTINEL/);
});

test('failed remote probe also redacts the submitted endpoint', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: secret }, { status: 500 }));
  const response = await f.send({ connectorUrl: `https://probe.invalid/?key=${secret}` });
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.ok, false); assert.equal(body.connectorUrl, 'https://probe.invalid');
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PROBE_SENTINEL/);
});

test('wrong types, oversized strings and array-shaped upstream DTOs are not forwarded', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async (request: Request) => Response.json(request.url.includes('/info')
    ? { service: secret, version: 'x'.repeat(257), environment: [secret], features: { sessions: secret } }
    : [secret]));
  const response = await f.send({ connectorUrl: 'https://probe.invalid' });
  const body = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(body.connector, { features: {} }); assert.deepEqual(body.health, {});
});

test('real original transport still probes both successful DTOs before projected delivery', async t => {
  const f = fixture(t), paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    paths.push(new URL(request.url).pathname);
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic');
    return Response.json(request.url.endsWith('/info') ? { service: 'aod-connector', version: '1.0', token: secret }
      : { ok: true, status: 'online', updatedAt: 1, details: secret });
  });
  const response = await f.send({ connectorUrl: 'https://probe.invalid', token: 'synthetic' });
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.ok, true);
  assert.deepEqual(paths.sort(), ['/api/connector/v1/health', '/api/connector/v1/info']);
  assert.deepEqual(body.connector, { service: 'aod-connector', version: '1.0' });
  assert.deepEqual(body.health, { ok: true, status: 'online', updatedAt: 1 });
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PROBE_SENTINEL/);
});
