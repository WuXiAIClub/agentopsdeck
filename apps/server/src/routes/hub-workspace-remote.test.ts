import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AuthAuditLog } from '../auth/security.js';
import { registerHubRemoteRoutes } from './hub-workspace-remote.js';

test('remote routes isolate accounts, bound JSON, restrict host actions and avoid sensitive audits', async () => {
  const app = new Hono(), audit = new AuthAuditLog(); let allowed = true;
  const service = registerHubRemoteRoutes(app, { audit, principal: c => {
    if (!allowed || !c.req.header('x-user')) throw new HTTPException(401);
    return { userId: c.req.header('x-user')!, admin: true };
  } });
  const base = '/api/hub/v1/workspace/remote/devices';
  const request = (path: string, method = 'GET', body?: unknown, user = 'alice', token = '') => app.request(base + path, {
    method, headers: { 'x-user': user, 'X-Workspace-Host': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const snapshot = {
    name: 'Secret-device-title',
    targets: [{
      id: 's',
      title: 'Private-session',
      kind: 'session',
      status: 'running',
      unread: true,
      elapsedSec: 42,
      snippet: 'Investigating telemetry summary',
      tokens: 12800
    }],
    active: 's'
  };
  try {
    assert.equal((await app.request(base)).status, 401);
    assert.equal((await request('', 'POST', { ...snapshot, unknown: 1 })).status, 400);
    assert.equal((await request('', 'POST', {
      ...snapshot,
      targets: [{ ...snapshot.targets[0]!, status: 'invalid-status' }]
    })).status, 400);
    assert.equal((await request('', 'POST', {
      ...snapshot,
      targets: [{ ...snapshot.targets[0]!, unread: 3 }]
    })).status, 400);
    assert.equal((await request('', 'POST', {
      ...snapshot,
      targets: [{ ...snapshot.targets[0]!, elapsedSec: -1 }]
    })).status, 400);
    assert.equal((await request('', 'POST', { name: 'x'.repeat(70_000) })).status, 413);
    const created = await request('', 'POST', snapshot); assert.equal(created.status, 200); assert.equal(created.headers.get('cache-control'), 'no-store');
    const { device, hostToken } = await created.json() as {
      device: { id: string; targets: Array<Record<string, unknown>> };
      hostToken: string;
    };
    assert.equal(device.targets[0]?.status, 'running');
    assert.equal(device.targets[0]?.unread, true);
    assert.equal(device.targets[0]?.elapsedSec, 42);
    assert.equal(device.targets[0]?.snippet, 'Investigating telemetry summary');
    assert.equal(device.targets[0]?.tokens, 12800);
    assert.deepEqual(await (await request('', 'GET', undefined, 'bob')).json(), { devices: [] });
    assert.equal((await request(`/${device.id}`, 'PUT', snapshot)).status, 404);
    assert.equal((await request(`/${device.id}`, 'PUT', snapshot, 'bob', hostToken)).status, 404);
    assert.equal((await request(`/${device.id}`, 'PUT', snapshot, 'alice', hostToken)).status, 200);
    assert.equal((await request(`/${device.id}/ack`, 'POST', { id: 'none', result: 'unknown' }, 'alice', hostToken)).status, 409);
    assert.equal((await request(`/${device.id}/ack`, 'POST', { id: 'none', result: 'sent' }, 'alice', hostToken)).status, 400);
    const stream = new ReadableStream<Uint8Array>({ pull(c) { allowed = false; c.enqueue(new TextEncoder().encode(JSON.stringify(snapshot))); c.close(); } });
    const revoked = await app.request(new Request(`http://hub${base}/${device.id}`, { method: 'PUT', headers: { 'x-user': 'alice', 'X-Workspace-Host': hostToken }, body: stream, duplex: 'half' } as RequestInit));
    assert.equal(revoked.status, 401); allowed = true;
    assert.equal((await request(`/${device.id}`, 'DELETE')).status, 200);
    assert.equal((await request(`/${device.id}/receive`, 'GET', undefined, 'alice', hostToken)).status, 404);
    for (const secret of [hostToken, snapshot.name, snapshot.targets[0]!.title, snapshot.targets[0]!.snippet]) {
      assert.ok(!JSON.stringify(audit.page()).includes(secret));
    }
  } finally { service.close(); }
});
