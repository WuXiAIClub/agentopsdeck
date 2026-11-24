import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncHermesQueue } from './async-hermes-queue.js';
import { registerHermesQueueHttp, type HermesQueueHttp } from './hermes-queue-http.js';

const key = 'hermes:original', authorization = 'Bearer isolated-hermes-queue-http';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(timeoutMs = 10_000) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-queue-http-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'isolated-hermes-queue-http');
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.hermesJournal.save({ key, stored: 'stored', title: 'Original', started: true, messages: [] });
  store.turns.enqueue('hermes', { id: 'message', sessionKey: key, createdAt: 0, payload: { actorId: actor, text: 'Original', images: [] } });
  const execute = createConnectorOwnerCommands(store, tokens), lines: string[] = [];
  const queue = new AsyncHermesQueue({ owner: { command: execute }, changed: () => {} });
  let ready = true, fallbacks = 0;
  const deps: HermesQueueHttp = { queue, ready: () => ready, timeoutMs, diagnostics: new PerformanceDiagnostics(line => { lines.push(line); }) };
  const app = new Hono(); registerHermesQueueHttp(app, '/sessions/:sessionKey', deps);
  app.all('/sessions/:sessionKey/*', c => { fallbacks++; return c.json({ legacy: true }); });
  const request = (suffix: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`/sessions/${key}${suffix}`, {
    method, headers: { authorization, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const headers = { 'if-match': `"${store.turns.version('hermes', key, 'message')}"`, 'idempotency-key': 'edit' };
  return { store, tokens, actor, queue, execute, deps, request, app, headers, lines,
    setReady(v: boolean) { ready = v; }, fallbacks: () => fallbacks,
    close() { execute.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Hermes queue HTTP keeps original wire/CAS/read-only receipts and no legacy bypass', async () => {
  const f = fixture();
  try {
    const page = await f.request('/queue'); assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal((await page.json()).items[0].id, 'message');
    const response = await f.request('/queue/message', 'PATCH', { message: ' Updated ' }, f.headers);
    assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.command.state, 'accepted');
    f.setReady(false);
    const replay = await f.request('/queue/message', 'PATCH', { message: 'Updated' }, f.headers);
    assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), body);
    const read = await f.request('/queue/message/commands/edit'); assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { command: { ...body.command, result: { status: 200, body: { ok: true } } } });
    assert.equal((await f.request('/queue/message', 'PATCH', { message: 'Other' }, f.headers)).status, 409);
    assert.equal(f.fallbacks(), 0);
  } finally { f.close(); }
});

test('Hermes queue HTTP legacy unkeyed reply remains plain and foreign runtime falls through', async () => {
  const f = fixture();
  try {
    const response = await f.request('/queue/message', 'PATCH', { message: 'Updated' }, { 'if-match': f.headers['if-match'] });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    assert.ok(response.headers.get('x-agentopsdeck-command-key'));
    assert.equal((await f.app.request('/sessions/codex:original/queue')).status, 200); assert.equal(f.fallbacks(), 1);
  } finally { f.close(); }
});

test('Hermes queue HTTP manager DELETE receipt probe and replay do not require messages:send', async () => {
  const f = fixture();
  try {
    const manager = f.tokens.create({ label: 'manager', scopes: ['queue:manage'] });
    const headers = { ...f.headers, authorization: `Bearer ${manager.token}` };
    const result = await f.request('/queue/message', 'DELETE', undefined, headers); assert.equal(result.status, 200);
    const replay = await f.request('/queue/message', 'DELETE', undefined, headers); assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), await result.json());
  } finally { f.close(); }
});

test('Hermes queue HTTP rejects grants, malformed version and unavailable fresh PATCH without touching original payload', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/queue', 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'foreign' })).status, 403);
    assert.equal((await f.request('/queue/message', 'PATCH', { message: 'Updated' }, { ...f.headers, 'if-match': 'invalid' })).status, 400);
    f.setReady(false);
    assert.equal((await f.request('/queue/message', 'PATCH', { message: 'Updated' }, f.headers)).status, 409);
    assert.equal(f.store.turns.head<{ text: string }>('hermes', key)!.payload.text, 'Original');
  } finally { f.close(); }
});

test('Hermes queue HTTP timeout never cancels physical publication and close waits original work', async () => {
  const f = fixture(10);
  try {
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const queue = new AsyncHermesQueue({ owner: { command: f.execute }, changed: async () => { await wait; } });
    const app = new Hono(); registerHermesQueueHttp(app, '/sessions/:sessionKey', { ...f.deps, queue });
    const response = await app.request(`/sessions/${key}/queue/message`, { method: 'PATCH', headers: { authorization, ...f.headers }, body: JSON.stringify({ message: 'Updated' }) });
    assert.equal(response.status, 503); assert.equal((await response.json()).status, 'outcome_unknown');
    let closed = false; const closing = queue.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    assert.equal(f.store.turns.head<{ text: string }>('hermes', key)!.payload.text, 'Updated');
    release(); await closing;
    const receipt = await f.request('/queue/message/commands/edit'); assert.equal(receipt.status, 200);
    assert.equal((await receipt.json()).command.state, 'accepted');
  } finally { f.close(); }
});
