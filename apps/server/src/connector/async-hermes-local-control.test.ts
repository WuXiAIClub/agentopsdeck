import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { ChatMessage } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHermesLocalControl } from './async-hermes-local-control.js';
import { AsyncHermesMessages } from './async-hermes-messages.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { registerHermesMessagesHttp, type HermesMessagesHttp } from './hermes-messages-http.js';

const token = 'isolated-local-http', authorization = `Bearer ${token}`, key = 'hermes:original';
const scope = { key, authorization, commandKey: 'original-status' }, wait = { timeoutMs: 5000 };
const input = { ...scope, payloadJson: JSON.stringify({ message: '/status', metadata: 'private fingerprint' }) };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-local-http-'));
  const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'), token), actor = tokens.authenticateAuthorization(authorization)!;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.hermesJournal.save({ key, stored: 'native', title: 'Original', started: false, messages: [] });
  const command = createConnectorOwnerCommands(store, tokens), owner = { command };
  const projected = new Map<string, ChatMessage>(), lines: string[] = [];
  let displays = 0, projections = 0, failProjection = false, fallback = 0, wakes = 0;
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const control = new AsyncHermesLocalControl(owner, () => ({ connected: false, gateway: '', session: { model: `display-${++displays}` } }),
    report => { for (const message of report) { projected.set(message.id, message); projections++; if (failProjection) throw Error('isolated projection failure'); } }, diagnostics);
  const messages = new AsyncHermesMessages(owner, () => { wakes++; });
  const deps: HermesMessagesHttp = { messages, localControl: control, ready: () => false, diagnostics };
  const app = new Hono(); registerHermesMessagesHttp(app, '/sessions/:sessionKey', deps);
  app.post('/sessions/:sessionKey/messages', c => { fallback++; return c.json({ legacy: true }); });
  const post = (payload: unknown = { ...JSON.parse(input.payloadJson), idempotencyKey: scope.commandKey }, headers: Record<string, string> = {}) =>
    app.request(`/sessions/${key}/messages`, { method: 'POST', headers: { authorization, ...headers }, body: JSON.stringify(payload) });
  const recover = (credential = authorization, commandKey = scope.commandKey) => app.request(`/sessions/${key}/commands/${commandKey}/status`, { headers: { authorization: credential } });
  return { command, owner, control, deps, app, store, tokens, actor, projected, lines, post, recover,
    counts: () => ({ displays, projections, fallback, wakes }), failProjection: (v: boolean) => { failProjection = v; },
    async close() { await control.close(); command.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Hermes local HTTP uses original wire/IDs and immutable report, with no fallback, queue or native wake', async () => {
  const f = fixture();
  try {
    const response = await f.post(); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-agentopsdeck-command-key'), scope.commandKey);
    const body = await response.json(); assert.equal(body.status, 'ok'); assert.equal(body.deliveryMode, 'web-only'); assert.equal(body.deliver, false);
    assert.equal(body.command.key, scope.commandKey); assert.equal(f.projected.size, 2);
    const original = [...f.projected.values()]; assert.match(original[1]!.text, /display-1/);
    f.store.pauseTurnStarts(); assert.equal((await f.post()).status, 200);
    assert.deepEqual([...f.projected.values()], original);
    assert.equal((await f.post({ message: '/status', idempotencyKey: scope.commandKey })).status, 409);
    f.projected.clear(); const recovered = await f.recover(); assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), body);
    assert.deepEqual([...f.projected.values()], original); assert.equal(f.counts().displays, 3);
    assert.equal(f.counts().fallback, 0); assert.equal(f.counts().wakes, 0); assert.equal(f.store.turns.maintenanceCount(), 0);
    const ordinary = await f.app.request(`/sessions/${key}/commands/${scope.commandKey}`, { headers: { authorization } });
    assert.equal(ordinary.status, 200); assert.equal((await ordinary.json()).command.state, 'accepted');
    assert.match(f.lines.join('\n'), /hermes-message-http/);
    assert.doesNotMatch(f.lines.join('\n'), /isolated-local-http|display-1|private fingerprint|hermes:original|Bearer /);
  } finally { await f.close(); }
});

test('partial projection failure recovers original report by read without resending or recomputing; revoke blocks delivery', async () => {
  const f = fixture();
  try {
    f.failProjection(true); assert.equal((await f.post()).status, 503); assert.equal(f.projected.size, 1);
    const original = await f.command('hermesLocalControlRead', scope); assert.ok('report' in original && original.report && original.receipt?.state === 'accepted');
    f.failProjection(false); assert.equal((await f.recover()).status, 200);
    assert.deepEqual([...f.projected.values()], original.report); assert.equal(f.counts().displays, 1);
    f.tokens.revoke(f.actor.tokenId); const before = f.counts().projections;
    assert.equal((await f.recover()).status, 401); assert.equal(f.counts().projections, before);
  } finally { await f.close(); }
});

test('HTTP deadline leaves original physical report admission pending; read repairs after late commit', async () => {
  const f = fixture(), hold = gate(), finished = gate(); let writes = 0;
  try {
    f.owner.command = (async (kind, args) => {
      if (kind === 'hermesLocalControl') { writes++; await hold.promise; }
      const result = await f.command(kind, args);
      if (kind === 'hermesLocalControl') finished.release(); return result;
    }) as typeof f.command;
    f.deps.localControl = { send: (args, options) => f.control.send(args, { ...options, timeoutMs: 5 }), read: f.control.read.bind(f.control) };
    assert.equal((await f.post()).status, 503); assert.equal(writes, 1); assert.equal(f.projected.size, 0);
    hold.release(); await finished.promise;
    assert.equal((await f.recover()).status, 200); assert.equal(f.projected.size, 2);
    assert.equal(writes, 1); assert.equal(f.counts().wakes, 0);
  } finally { hold.release(); await f.close(); }
});

test('close rejects new reports immediately and drains actual owner work after caller deadline without closing shared owner', async () => {
  const f = fixture(), hold = gate(), started = gate();
  try {
    f.owner.command = (async (kind, args) => { if (kind === 'hermesLocalControl') { started.release(); await hold.promise; } return f.command(kind, args); }) as typeof f.command;
    const pending = f.control.send(input, { timeoutMs: 5 }); await started.promise;
    await assert.rejects(pending);
    let drained = false; const closing = f.control.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    await assert.rejects(f.control.send(input, wait)); await assert.rejects(f.control.read(scope, wait));
    hold.release(); await closing; assert.equal(drained, true);
    const saved = await f.command('hermesLocalControlRead', scope); assert.ok('report' in saved && saved.report && saved.receipt?.state === 'accepted');
    assert.ok(await f.command('nodeIdentity', {}), 'shared owner remains open');
  } finally { hold.release(); await f.close(); }
});

test('permission rechecked after report commit prevents stale synchronous projection', async () => {
  const f = fixture();
  try {
    f.deps.localControl = { send: async (args, options) => { const result = await f.control.send(args, options); f.tokens.revoke(f.actor.tokenId); return result; }, read: f.control.read.bind(f.control) };
    assert.equal((await f.post()).status, 401); assert.equal(f.projected.size, 0); assert.equal(f.counts().fallback, 0);
    const receipt = f.store.commands.get(JSON.stringify([f.actor.tokenId, key]), scope.commandKey); assert.equal(receipt?.state, 'accepted');
  } finally { await f.close(); }
});

test('unsupported compact, mirror, attachment, missing and deleted sessions never become prompts or sync fallback', async () => {
  const f = fixture();
  try {
    for (const [i, payload] of [{ message: '/compact' }, { message: '/status', deliveryMode: 'mirror' },
      { message: '/status', media: [{ name: 'private.txt', dataUrl: 'data:text/plain;base64,cHJpdmF0ZQ==' }] }].entries()) {
      const response = await f.post({ ...payload, idempotencyKey: `invalid-${i}` }); assert.equal(response.status, 409);
      assert.equal((await response.json()).command.state, 'rejected');
    }
    const malformed = await f.post({ message: '/status', media: [{ url: 'file:///isolated' }], idempotencyKey: 'malformed-media' });
    assert.equal(malformed.status, 400, 'malformed media retains the original request validation');
    const response = await f.app.request('/sessions/hermes:missing/messages', { method: 'POST', headers: { authorization }, body: '{"message":"/status"}' });
    assert.equal(response.status, 404); assert.equal(f.projected.size, 0); assert.equal(f.counts().fallback, 0); assert.equal(f.counts().wakes, 0);
    assert.equal((await f.recover(authorization, 'absent')).status, 404);
    assert.equal((await f.recover(authorization, 'invalid%20key')).status, 400);
    assert.equal((await f.post({ message: '/status' }, { 'x-agentopsdeck-execution-grant': 'forged' })).status, 403);
    f.store.hermesJournal.beginDeletion(key);
    assert.equal((await f.post({ message: '/status', idempotencyKey: 'deleted' })).status, 409);
  } finally { await f.close(); }
});

test('pre-aborted and invalid waits cannot begin local report work', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  try {
    await assert.rejects(f.control.send(input, { ...wait, signal: abort.signal }));
    await assert.rejects(f.control.send(input, { timeoutMs: 0 }));
    assert.equal(f.counts().displays, 0); const r = await f.command('hermesLocalControlRead', scope); assert.ok('receipt' in r && !r.receipt);
  } finally { await f.close(); }
});
