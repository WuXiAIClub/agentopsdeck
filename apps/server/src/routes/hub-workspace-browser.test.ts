import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { randomUUID } from 'node:crypto';
import { AuthAuditLog } from '../auth/security.js';
import { WorkspaceBrowser } from '../hub/workspace-browser.js';
import { registerHubBrowser } from './hub-workspace-browser.js';
import type { Browser } from 'playwright-core';

test('browser routes enforce auth/owner, no-store, strict bodies, revocation and safe audit', async () => {
  let owner: string | undefined = 'alice', allowed = true, creates = 0, closes = 0;
  const config = { endpoint: 'ws://127.0.0.1/browser', users: ['alice', 'bob'], hosts: ['learn.microsoft.com'] };
  const page = { url: () => 'https://learn.microsoft.com/', title: async () => 'Private title', on() {}, screenshot: async () => Buffer.from('jpeg'), goto: async () => {} };
  const context = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, route: async () => {}, routeWebSocket: async () => {}, on() {}, newPage: async () => page, close: async () => { closes++; } };
  const service = new WorkspaceBrowser(config, async () => { creates++; return { newContext: async () => context, close: async () => {} } as unknown as Browser; });
  const app = new Hono(), audit = new AuthAuditLog();
  const routes = registerHubBrowser(app, { service, audit, principal: () => { if (!allowed || !owner) throw new HTTPException(401); return { userId: owner, admin: owner === 'admin' }; } });
  const base = '/api/hub/v1/workspace/browser', id = randomUUID();
  const req = (path: string, method = 'GET', body?: unknown) => app.request(base + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    owner = undefined; assert.equal((await req('/config')).status, 401);
    owner = 'admin'; assert.deepEqual(await (await req('/config')).json(), { enabled: false, hosts: [] });
    assert.equal((await req('/sessions', 'POST', { id })).status, 403); assert.equal(creates, 0);
    owner = 'alice';
    assert.equal((await req('/sessions', 'POST', { id, owner: 'bob' })).status, 400);
    const start = await req('/sessions', 'POST', { id }); assert.equal(start.status, 200); assert.equal(start.headers.get('cache-control'), 'no-store');
    assert.equal((await req('/sessions', 'POST', { id })).status, 200); assert.equal(creates, 1);
    owner = 'bob'; assert.equal((await req(`/sessions/${id}/frame`)).status, 404);
    await req(`/sessions/${id}`, 'DELETE'); assert.equal(closes, 0);
    owner = 'alice';
    const action = { kind: 'navigate', url: 'https://learn.microsoft.com/?secret=private-query', seq: 1 };
    assert.equal((await req(`/sessions/${id}/actions`, 'POST', action)).status, 200);
    assert.equal((await req(`/sessions/${id}/actions`, 'POST', action)).status, 409);
    assert.equal((await req(`/sessions/${id}/actions`, 'POST', { ...action, seq: 2, url: 'https://127.0.0.1/' })).status, 400);
    assert.equal((await req(`/sessions/${id}/frame?hash=invalid`)).status, 400);
    const frame = await req(`/sessions/${id}/frame`); assert.equal(frame.status, 200);
    const auditText = JSON.stringify(audit.page()); assert.ok(!auditText.includes('private-query')); assert.ok(!auditText.includes('Private title')); assert.ok(!auditText.includes(config.endpoint));
    const body = new ReadableStream({ pull(controller) { allowed = false; controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: randomUUID() }))); controller.close(); } });
    const revoked = await app.request(base + '/sessions', { method: 'POST', body, duplex: 'half' } as RequestInit);
    assert.equal(revoked.status, 403); assert.equal(creates, 1);
  } finally { routes.close(); await service.close(); }
});
