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
import { AsyncHermesDeletion } from './async-hermes-deletion.js';
import { registerHermesDeletionHttp } from './hermes-deletion-http.js';

const key = 'hermes:original', path = `/sessions/${key}`, authorization = 'Bearer isolated-http-deletion';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(timeoutMs = 10_000, brokenLog = false) {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-deletion-http-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), authorization.slice(7));
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.hermesJournal.save({ key, stored: 'private-stored', title: 'private-title', started: true, messages: [] });
  const command = createConnectorOwnerCommands(store, tokens), calls: string[] = [], logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { logs.push(line); if (brokenLog) throw Error('private sink'); });
  let live: string | undefined = 'private-live', ready: boolean = true;
  const native = { available: () => true, epoch: () => 'epoch', live: () => live,
    request: async (method: string, _params: Record<string, unknown>): Promise<unknown> => {
      calls.push(method);
      if (method === 'session.activate') return { session_id: live, session_key: 'private-stored', status: 'idle', running: false };
      if (method === 'session.close') return { closed: true };
      if (method === 'session.delete') return { deleted: 'private-stored' };
      throw Error('private native');
    } };
  const lifecycle = new AsyncHermesDeletion({ owner: { command }, native, diagnostics, fence() {},
    closed() { live = undefined; }, removed() {} });
  const app = new Hono();
  registerHermesDeletionHttp(app, '/sessions/:sessionKey', { lifecycle, ready: () => ready, timeoutMs, diagnostics });
  app.all('*', c => c.json({ legacy: true }, 418));
  return { app, store, tokens, calls, logs, native, lifecycle,
    setReady(value: boolean) { ready = value; },
    remove(commandKey = 'delete-original', headers = {}) { return app.request(path, { method: 'DELETE', headers: { authorization, 'idempotency-key': commandKey, ...headers } }); },
    read(commandKey = 'delete-original') { return app.request(`${path}/deletion-commands/${commandKey}`, { headers: { authorization } }); },
    async close() { await lifecycle.close(); command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('Hermes deletion HTTP preserves legacy accepted receipt wire, read-only recovery and no duplicate effect', async () => {
  const f = fixture();
  try {
    assert.equal((await f.read()).status, 404); assert.deepEqual(f.calls, []);
    const response = await f.remove();
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'delete-original');
    const body = await response.json(); assert.equal(body.ok, true); assert.equal(body.status, 'delete_accepted');
    assert.equal(body.command.state, 'accepted');
    const calls = [...f.calls]; assert.deepEqual(calls, ['session.activate', 'session.close', 'session.delete']);
    assert.deepEqual(await (await f.remove()).json(), body);
    const recovered = (await (await f.read()).json()).command;
    const { result, ...metadata } = recovered;
    assert.deepEqual(metadata, body.command); assert.deepEqual(result.body, { ok: true, status: 'delete_accepted' });
    assert.deepEqual(f.calls, calls); assert.equal(f.store.hermesJournal.deletion(key), 'accepted');
    assert.doesNotMatch(f.logs.join('\n'), /private-|isolated-http|Bearer|hermes:original|delete-original/);
  } finally { await f.close(); }
});

test('Hermes deletion HTTP denies missing authority, delegated headers and malformed keys without native work', async () => {
  const f = fixture();
  try {
    assert.equal((await f.app.request(path, { method: 'DELETE' })).status, 401);
    assert.equal((await f.remove('delete-original', { 'x-agentopsdeck-execution-grant': 'untrusted' })).status, 403);
    assert.equal((await f.remove('invalid key')).status, 400);
    const reader = f.tokens.create({ label: 'read-only', scopes: ['messages:send'] });
    assert.equal((await f.remove('delete-original', { authorization: `Bearer ${reader.token}` })).status, 403);
    assert.equal((await f.remove('delete-original', { authorization: 'Bearer revoked' })).status, 401);
    assert.deepEqual(f.calls, []); assert.equal(f.store.hermesJournal.deletion(key), undefined);
    assert.equal((await f.app.request('/sessions/codex:original', { method: 'DELETE' })).status, 418);
  } finally { await f.close(); }
});

test('Hermes deletion HTTP requires strict ready and original maintenance admission', async () => {
  const f = fixture();
  try {
    f.setReady(undefined as unknown as boolean);
    assert.equal((await f.remove()).status, 409); assert.deepEqual(f.calls, []);
    f.setReady(true); f.store.pauseTurnStarts();
    assert.equal((await f.remove()).status, 409); assert.deepEqual(f.calls, []);
    const rejected = await f.read(); assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).command.state, 'rejected');
  } finally { await f.close(); }
});

test('Hermes deletion HTTP missing native ACK remains original unknown; GET and DELETE cannot replay', async () => {
  const f = fixture(); const invoke = f.native.request;
  f.native.request = async (method, params) => method === 'session.delete' ? (f.calls.push(method), { deleted: 'foreign' }) : invoke(method, params);
  try {
    const first = await f.remove(); const body = await first.json();
    assert.equal(body.command.state, 'outcome_unknown');
    const calls = [...f.calls];
    assert.equal((await (await f.read()).json()).command.id, body.command.id);
    assert.equal((await (await f.remove()).json()).command.id, body.command.id);
    assert.deepEqual(f.calls, calls); assert.equal(f.store.hermesJournal.deletion(key), 'pending');
  } finally { await f.close(); }
});

test('Hermes deletion HTTP deadline preserves physical task and late accepted original receipt', async () => {
  const f = fixture(30); const invoke = f.native.request;
  let release!: (v: unknown) => void;
  f.native.request = async (method, params) => {
    if (method === 'session.delete') { f.calls.push(method); return new Promise(resolve => { release = resolve; }); }
    return invoke(method, params);
  };
  try {
    const waiting = f.remove();
    for (let i = 0; i < 100 && !release; i++) await tick(); assert.ok(release);
    const response = await waiting; assert.equal(response.status, 503);
    assert.equal((await response.json()).status, 'outcome_unknown');
    const calls = [...f.calls];
    assert.equal((await (await f.remove()).json()).command.state, 'outcome_unknown');
    assert.deepEqual(f.calls, calls);
    let drained = false; const drain = f.lifecycle.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    release({ deleted: 'private-stored' }); await drain;
    assert.equal((await (await f.read()).json()).command.state, 'accepted');
    assert.deepEqual(f.calls, calls);
  } finally { release?.({ deleted: 'private-stored' }); await f.close(); }
});

test('Hermes deletion logging failures cannot change original accepted fact', async () => {
  const f = fixture(10_000, true);
  try { assert.equal((await f.remove()).status, 200); assert.equal(f.store.hermesJournal.deletion(key), 'accepted'); }
  finally { await f.close(); }
});
