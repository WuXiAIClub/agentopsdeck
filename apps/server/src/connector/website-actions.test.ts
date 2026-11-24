import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { validWebsiteActionReceipt, WEBSITE_ACTION_FILE_BYTES, websiteBase64Bytes } from '@agentopsdeck/shared';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { WebsiteActionExecution, parseWebsiteActions, type WebsiteActionPolicy } from './website-actions.js';
import { parseWebsiteServices } from './websites.js';
import { registerConnectorWebsiteActions } from './website-actions-http.js';

const action: WebsiteActionPolicy = { id: 'update', label: 'Update fixture', method: 'POST', path: '/api/update', contentType: 'application/json', maxBytes: 64 };
test('action policies are explicit methods and canonical exact paths, never inherited', () => {
  assert.ok(!DEFAULT_SCOPES.includes('websites:act'));
  assert.deepEqual(parseWebsiteActions([action]), [action]);
  for (const change of [{ path: '//private' }, { path: '/a/../b' }, { path: '/%2e' }, { path: '/?key=secret' }, { path: '/#secret' }, { path: '/a\\b' }, { method: 'GET' }, { method: 'CONNECT' }, { id: 4 }, { headers: { authorization: 'private' } }, { maxBytes: 65537 }, { contentType: 'text/html' }]) {
    assert.throws(() => parseWebsiteActions([{ ...action, ...change }]), e => !String(e).includes('secret'));
  }
  assert.throws(() => parseWebsiteActions([action, action]));
  assert.throws(() => parseWebsiteServices(JSON.stringify([{ id: 'dev', label: 'Dev', url: 'http://127.0.0.1:3000/sub/', actions: [action] }])));
});

test('actual website execution is once-only, no credentials or redirect, receipt preserves HTTP failures', async () => {
  const calls: { path: string | undefined; cookie: string | undefined; auth: string | undefined; body: string; method: string | undefined }[] = [];
  let mode = 'ok';
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body, method: req.method, cookie: req.headers.cookie, auth: req.headers.authorization });
    if (mode === 'redirect') { res.writeHead(302, { location: '/should-not-read' }); res.end(); }
    else { res.writeHead(mode === 'fail' ? 422 : 200, { 'content-type': 'application/json', 'set-cookie': 'private=value' }); res.end('{"saved":true}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const execution = new WebsiteActionExecution(url, action), signal = new AbortController().signal;
    await assert.rejects(execution.execute('x'.repeat(65), signal), { status: 413 });
    await assert.rejects(execution.execute('{invalid}', signal), { status: 400 });
    assert.equal(calls.length, 0);
    const pending = execution.execute('{"x":1}', signal);
    assert.deepEqual(await execution.execute('{"x":2}', signal), { state: 'pending' });
    assert.deepEqual(await pending, { state: 'completed', status: 200, text: '{"saved":true}' });
    await execution.execute('{"x":3}', signal); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { path: action.path, body: '{"x":1}', method: 'POST', cookie: undefined, auth: undefined });
    mode = 'redirect'; const redirect = new WebsiteActionExecution(url, action);
    assert.deepEqual(await redirect.execute('{}', signal), { state: 'unknown' });
    await redirect.execute('{}', signal); assert.equal(calls.length, 2);
    mode = 'fail'; assert.equal((await new WebsiteActionExecution(url, action).execute('{}', signal)).status, 422);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('interrupted and oversized action replies remain unknown and cannot replay', async () => {
  for (const fetcher of [async () => new Response('x'.repeat(65537), { headers: { 'content-type': 'text/plain' } }), async () => new Response('<b>x</b>', { headers: { 'content-type': 'text/html' } }), async () => { throw Error('private credential in upstream error'); }]) {
    const e = new WebsiteActionExecution('http://127.0.0.1:3000/', action); let calls = 0;
    const perform: typeof fetch = async () => { calls++; return fetcher(); };
    assert.deepEqual(await e.execute('{}', new AbortController().signal, perform), { state: 'unknown' });
    await e.execute('{}', new AbortController().signal, perform); assert.equal(calls, 1);
  }
});

test('configured binary upload and explicit attachment download are bounded, inert and once-only', async () => {
  const bytes = Buffer.alloc(WEBSITE_ACTION_FILE_BYTES, 255), base64 = bytes.toString('base64');
  assert.equal(websiteBase64Bytes(base64), bytes.length);
  for (const invalid of ['abc', 'aa=a', 'ab==', 'a===', '####', Buffer.alloc(bytes.length + 1).toString('base64')]) assert.equal(websiteBase64Bytes(invalid), undefined);
  const upload: WebsiteActionPolicy = { ...action, contentType: 'application/octet-stream', maxBytes: bytes.length };
  const download: WebsiteActionPolicy = { ...action, id: 'download', method: 'GET', maxBytes: 0, contentType: 'text/plain', download: { filename: 'report.html', maxBytes: bytes.length } };
  assert.deepEqual(parseWebsiteActions([upload, download]), [upload, download]);
  for (const filename of ['../secret', '/private', 'bad\r\nname', '.hidden', 'name/child']) assert.throws(() => parseWebsiteActions([{ ...download, download: { ...download.download, filename } }]));
  let uploads = 0, downloads = 0;
  const signal = new AbortController().signal;
  const u = new WebsiteActionExecution('http://127.0.0.1:3000/', upload);
  const result = await u.execute(base64, signal, async (_url, init) => {
    uploads++; assert.deepEqual(init?.body, bytes); assert.equal(new Headers(init?.headers).get('content-type'), 'application/octet-stream');
    return Response.json({ bytes: bytes.length });
  });
  assert.equal(result.status, 200); await u.execute(base64, signal); assert.equal(uploads, 1);
  const d = new WebsiteActionExecution('http://127.0.0.1:3000/', download);
  const receipt = await d.execute('', signal, async (_url, init) => {
    downloads++; assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined);
    return new Response(bytes, { headers: { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="../../private-name"', 'set-cookie': 'private=secret' } });
  });
  assert.equal(receipt.file?.filename, 'report.html'); assert.equal(receipt.file?.base64, base64); assert.equal(receipt.text, '');
  assert.ok(validWebsiteActionReceipt(receipt)); assert.equal(validWebsiteActionReceipt({ ...receipt, file: { ...receipt.file, header: 'secret' } }), false);
  await d.execute('', signal); assert.equal(downloads, 1);
  const oversized = new WebsiteActionExecution('http://127.0.0.1:3000/', { ...download, download: { filename: 'small.bin', maxBytes: 2 } });
  assert.deepEqual(await oversized.execute('', signal, async () => new Response(bytes)), { state: 'unknown' });
});

test('Connector scope/lease ownership, readonly recovery, immediate revocation and closed handles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'website-actions-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), app = new Hono();
  const reader = tokens.createTransient(['websites:read', 'websites:browse']);
  const writer = tokens.createTransient(['websites:act']);
  const other = tokens.createTransient(['websites:act']);
  let calls = 0, aborted = false;
  const routes = registerConnectorWebsiteActions(app, tokens, [{ id: 'dev', label: 'Dev', url: 'http://127.0.0.1:3000/', actions: [action] }], async (_url, init) => {
    calls++; return new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true }); });
  });
  const base = '/api/connector/v1/website-actions';
  const request = (path: string, token = writer.token, body?: unknown, method = body === undefined ? 'GET' : 'POST') => app.request(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request('/catalog/dev', reader.token)).status, 403);
    const catalog = await request('/catalog/dev'); assert.ok(!(await catalog.text()).includes('/api/update'));
    const lease = await (await request('', writer.token, { serviceId: 'dev', actionId: 'update' })).json();
    assert.equal((await request(`/${lease.accessId}`, other.token)).status, 404);
    const pending = request(`/${lease.accessId}/execute`, writer.token, { body: '{}' });
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 1);
    assert.deepEqual(await (await request(`/${lease.accessId}`)).json(), { state: 'pending' });
    assert.deepEqual(await (await request(`/${lease.accessId}/execute`, writer.token, { body: '{}' })).json(), { state: 'pending' });
    writer.dispose(); assert.equal((await pending).status, 401); assert.ok(aborted); assert.equal(calls, 1);
    assert.equal((await request(`/${lease.accessId}`)).status, 401);
  } finally { routes.close(); reader.dispose(); other.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('cookie continuation consumes a completed same-owner/site lease and never extends its deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'website-cookie-chain-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), app = new Hono();
  const owner = tokens.createTransient(['websites:act']), other = tokens.createTransient(['websites:act']);
  const service = { id: 'dev', label: 'Dev', url: 'http://127.0.0.1:3000/', actions: [action], session: { cookieNames: ['sid'] } };
  let calls = 0;
  const routes = registerConnectorWebsiteActions(app, tokens, [service, { ...service, id: 'other-site' }], async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('cookie'), calls ? 'sid=private' : null); calls++;
    return Response.json({ ok: true }, { headers: { 'set-cookie': 'sid=private; Path=/; HttpOnly' } });
  });
  const request = (path: string, input?: unknown, token = owner.token) => app.request('/api/connector/v1/website-actions' + path, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
  try {
    const first = await (await request('', { serviceId: 'dev', actionId: 'update' })).json();
    const continuation = { serviceId: 'dev', actionId: 'update', previousAccessId: first.accessId };
    assert.equal((await request('', continuation)).status, 409, 'ready is not completed');
    assert.equal((await request(`/${first.accessId}/execute`, { body: '{}' })).status, 200);
    assert.equal((await request('', continuation, other.token)).status, 404);
    assert.equal((await request('', { ...continuation, serviceId: 'other-site' })).status, 409);
    const second = await (await request('', continuation)).json();
    assert.notEqual(second.accessId, first.accessId); assert.ok(second.expiresInMs <= first.expiresInMs);
    assert.equal((await request('', continuation)).status, 404, 'consumed handles cannot branch');
    assert.equal((await request(`/${first.accessId}/execute`, { body: '{}' })).status, 404);
    assert.equal((await request(`/${second.accessId}/execute`, { body: '{}' })).status, 200);
    assert.equal(calls, 2);
    owner.dispose(); assert.equal((await request(`/${second.accessId}`)).status, 401);
  } finally { routes.close(); owner.dispose(); other.dispose(); await rm(root, { recursive: true, force: true }); }
});
