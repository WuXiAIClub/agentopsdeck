import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncOpenClawMessages } from './async-openclaw-messages.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { registerOpenClawMessagesHttp, type OpenClawMessagesHttp } from './openclaw-messages-http.js';

const token = 'isolated-openclaw-http-token', authorization = `Bearer ${token}`, key = 'agent:main:dashboard:original';
const path = `/sessions/${key}`, route = '/sessions/:sessionKey';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-openclaw-http-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens);
  let wakes = 0, effects = 0, ready = true, fallback = 0;
  const messages = new AsyncOpenClawMessages({ owner: { command }, defaultAgentId: 'main', ready: () => ready, sessionExists: () => true,
    admitted: () => { wakes++; }, persist: async items => { effects++; return (items ?? []).map(() => ({ filePath: '/isolated/file.txt',
      media: { type: 'file' as const, name: 'file.txt', url: '/api/media/inbound/file.txt', size: 1 } })); } });
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
  const deps: OpenClawMessagesHttp = { messages, ready: () => ready, diagnostics };
  const app = new Hono(); registerOpenClawMessagesHttp(app, route, deps);
  app.post(`${route}/messages`, async c => { fallback++; return c.json({ control: await c.req.json() }); });
  app.get(`${route}/commands/:commandKey`, c => { fallback++; return c.json({ legacy: true }); });
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request(`${path}/messages`, {
    method: 'POST', headers: { authorization, ...headers }, body: JSON.stringify(body),
  });
  const get = (commandKey: string, credential = authorization, queue = false) => app.request(`${path}/commands/${commandKey}${queue ? '/queue' : ''}`, {
    headers: { authorization: credential },
  });
  return { app, deps, store, tokens, messages, post, get, lines, command,
    ready: (v: boolean) => { ready = v; }, effects: () => effects, wakes: () => wakes, fallback: () => fallback,
    async close() { await messages.close(); command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('HTTP ordinary message preserves original wire, fingerprints and read-only queue recovery', async () => {
  const f = fixture();
  try {
    const payload = { message: ' original ', metadata: 'private-fingerprint', idempotencyKey: 'original-key' };
    const first = await f.post(payload); assert.equal(first.status, 200);
    const body = await first.json(); assert.equal(body.ok, true); assert.equal(body.status, 'queued'); assert.equal(body.command.key, 'original-key');
    assert.equal(first.headers.get('cache-control'), 'no-store'); assert.equal(first.headers.get('x-agentopsdeck-command-key'), 'original-key');
    f.ready(false); f.store.pauseTurnStarts();
    const duplicate = await f.post(payload); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), body);
    assert.equal(f.effects(), 1); assert.equal(f.wakes(), 1); assert.equal(f.fallback(), 0);
    assert.equal((await f.post({ ...payload, message: 'changed' })).status, 409);
    const read = await f.get('original-key'); assert.equal(read.status, 200);
    const { result: originalResult, ...metadata } = (await read.json()).command;
    assert.deepEqual(metadata, body.command); assert.equal(originalResult.status, 200);
    const queue = await f.get('original-key', authorization, true); assert.equal(queue.status, 200); assert.equal((await queue.json()).queue.presence, 'present');
    assert.equal((await f.post({ message: 'new', idempotencyKey: 'new' })).status, 409);
  } finally { await f.close(); }
});

for (const control of ['/stop', '/status', '/compact', ' /compact ']) test(`HTTP ${JSON.stringify(control)} retains original body for the original control authority lane`, async () => {
  const f = fixture();
  try {
    const token = f.tokens.create({ label: 'non-send', scopes: ['sessions:read'] });
    const body = { message: control, expectedRunId: 'original-run', idempotencyKey: 'control-key', metadata: 'unchanged' };
    const response = await f.post(body, { authorization: `Bearer ${token.token}` }); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).control, body); assert.equal(f.fallback(), 1); assert.equal(f.effects(), 0);
    assert.equal(f.store.commands.get(JSON.stringify([token.record.id, key]), 'control-key'), undefined);
  } finally { await f.close(); }
});

test('HTTP media-only messages persist references once and enter the original dispatch plan', async () => {
  const f = fixture();
  try {
    const payload = { media: [{ dataUrl: 'data:text/plain;base64,YQ==', name: 'private.txt' }], idempotencyKey: 'media-only' };
    const first = await f.post(payload); assert.equal(first.status, 200); const body = await first.json();
    assert.deepEqual(body.media, [{ type: 'file', name: 'file.txt', url: '/api/media/inbound/file.txt', size: 1 }]);
    assert.equal((await f.post(payload)).status, 200); assert.equal(f.effects(), 1);
    const plan = await f.command('openClawDispatchPlan', { key }); assert.ok(plan && plan !== 'blocked');
    assert.equal(plan.turn.payload.message, ''); assert.equal(plan.turn.payload.media.length, 1);
    assert.doesNotMatch(JSON.stringify(plan), /data:text|base64|private.txt/);
  } finally { await f.close(); }
});

test('media-bearing status/compact retain ordinary-message semantics; mirror controls retain legacy rejection lane', async () => {
  const f = fixture();
  try {
    for (const text of ['/status', '/compact']) {
      const payload = { message: text, media: [{ type: 'file', dataUrl: 'data:text/plain;base64,YQ==', name: 'file.txt' }], idempotencyKey: text.slice(1) };
      assert.equal((await f.post(payload)).status, 200);
      assert.equal((await f.post(payload)).status, 200);
      assert.equal(f.fallback(), text === '/status' ? 0 : 1);
      assert.equal((await f.post({ ...payload, deliveryMode: 'mirror', idempotencyKey: `mirror-${text.slice(1)}` })).status, 200);
      assert.equal(f.fallback(), text === '/status' ? 1 : 2);
    }
    assert.equal(f.effects(), 2);
  } finally { await f.close(); }
});

test('HTTP command key conflicts, invalid JSON and invalid message retain original client error contracts', async () => {
  const f = fixture();
  try {
    assert.equal((await f.post({ message: 'original', idempotencyKey: 'body' }, { 'idempotency-key': 'header' })).status, 400);
    for (const value of [null, [], {}, { message: 1 }, { message: 'original', idempotencyKey: 'invalid key' }])
      assert.equal((await f.post(value)).status, 400);
    const malformed = await f.app.request(`${path}/messages`, { method: 'POST', headers: { authorization }, body: '{' }); assert.equal(malformed.status, 400);
    assert.equal((await f.get('invalid%20key')).status, 400); assert.equal(f.effects(), 0);
    const generated = await f.post({ message: 'generated' }); assert.equal(generated.status, 200);
    const generatedBody = await generated.json(); assert.equal(generated.headers.get('x-agentopsdeck-command-key'), generatedBody.command.key);
  } finally { await f.close(); }
});

test('HTTP send-only ACK and actor-scoped reads do not widen authority', async () => {
  const f = fixture();
  try {
    const sender = f.tokens.create({ label: 'send-only', scopes: ['messages:send'] }), credential = `Bearer ${sender.token}`;
    assert.equal((await f.post({ message: 'original', idempotencyKey: 'send-only' }, { authorization: credential })).status, 200);
    assert.equal((await f.get('send-only', credential)).status, 403); assert.equal((await f.get('send-only', credential, true)).status, 403);
    assert.equal((await f.get('send-only')).status, 404);
    const reader = f.tokens.create({ label: 'read-only', scopes: ['messages:read'] });
    assert.equal((await f.post({ message: 'original' }, { authorization: `Bearer ${reader.token}` })).status, 403);
    assert.equal((await f.post({ message: 'original' }, { authorization: '' })).status, 401);
    assert.equal(f.effects(), 1);
  } finally { await f.close(); }
});

test('HTTP delivery fence rechecks current authorization after committed admission', async () => {
  const f = fixture();
  try {
    const issued = f.tokens.create({ label: 'revoke ACK', scopes: ['messages:send', 'messages:read'] });
    const send = f.messages.send.bind(f.messages);
    f.messages.send = async (...args) => { const result = await send(...args); f.tokens.revoke(issued.record.id); return result; };
    const response = await f.post({ message: 'private original', idempotencyKey: 'revoked-ack' }, { authorization: `Bearer ${issued.token}` });
    assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), /private original|runId|media/);
    assert.equal(f.store.commands.get(JSON.stringify([issued.record.id, key]), 'revoked-ack')?.state, 'accepted'); assert.equal(f.wakes(), 1);
  } finally { await f.close(); }
});

test('HTTP forwards original delegation and node evidence; issuer never downgrades without a grant', async () => {
  const f = fixture();
  try {
    const issuer = f.tokens.create({ label: 'issuer', scopes: ['execution:delegate', 'messages:send'], delegationHubId: 'hub' });
    const response = await f.post({ message: 'original' }, { authorization: `Bearer ${issuer.token}` }); assert.equal(response.status, 403); assert.equal(f.effects(), 0);
    let evidence: unknown;
    const send = f.messages.send.bind(f.messages);
    f.messages.send = async (...args) => { evidence = args[0]; return send(...args); };
    const denied = await f.post({ message: 'original' }, { 'x-agentopsdeck-execution-grant': 'original-ref', 'x-agentopsdeck-expected-node-id': 'foreign' });
    assert.equal(denied.status, 403); assert.equal((evidence as { grantId: string }).grantId, 'original-ref'); assert.equal(f.effects(), 0);
  } finally { await f.close(); }
});

test('HTTP unknown recovery and diagnostics do not leak credentials or message data', async () => {
  const f = fixture();
  try {
    const scope = JSON.stringify([f.tokens.authenticateAuthorization(authorization)!.tokenId, key]);
    f.store.commands.claim(scope, 'unknown', { message: 'private-content' });
    const response = await f.post({ message: 'private-content', idempotencyKey: 'unknown' }); assert.equal(response.status, 202);
    const body = await response.json(); assert.equal(body.command.key, 'unknown'); assert.equal(body.status, 'outcome_unknown'); assert.equal(f.effects(), 0);
    assert.equal((await f.get('unknown')).status, 200); assert.equal((await f.get('unknown', authorization, true)).status, 200);
    assert.doesNotMatch(f.lines.join('\n'), /private-content|Bearer|isolated-openclaw-http-token|agent:main/);
  } finally { await f.close(); }
});

test('HTTP non-OpenClaw traffic remains on its original lane', async () => {
  const f = fixture();
  try {
    assert.equal((await f.app.request('/sessions/hermes:original/messages', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await f.app.request('/sessions/codex:original/commands/key')).status, 200); assert.equal(f.fallback(), 2); assert.equal(f.effects(), 0);
  } finally { await f.close(); }
});
