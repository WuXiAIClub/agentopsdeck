import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createAsyncClaudeOwnedRuntime } from '../claude/async-owned-runtime.js';
import { createAsyncCopilotOwnedRuntime } from '../copilot/async-owned-runtime.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput, connectorOwnerSteps } from './connector-owner-domain.js';
import { registerSdkDeletionHttp, type SdkDeletionHttp } from './sdk-deletion-http.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { SdkPreflight } from './sdk-owned-runtime.js';

const token = 'isolated-sdk-deletion-http-test', authorization = `Bearer ${token}`;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const passed = (): SdkPreflight => ({ ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close() {} });
function fixture(runtime: SdkAgentId) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-deletion-http-')), tokenFile = join(root, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, token), actorId = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const key = `${runtime}:original`, path = `/api/connector/v1/sessions/${key}`;
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  journal.create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 1 });
  const owner = { command: createConnectorOwnerCommands(store, tokens) };
  const lines: string[] = []; let ready = true, calls = 0, fallbacks = 0;
  const deps: SdkDeletionHttp = { owner, ready: () => ready, diagnostics: new PerformanceDiagnostics(line => { lines.push(line); }),
    remove: async (runtime, key, commandKey, authorization) => {
      calls++;
      const result = await owner.command('sdkDeletionClaim', { runtime, key, commandKey, authorization });
      if ('error' in result || !result.intent || !result.admitted) return result;
      const ref = { runtime, key, intent: result.intent, receiptId: result.receipt.id };
      assert.equal(await owner.command('sdkDeletionReady', { ...ref, authorization }), true);
      const settled = await owner.command('sdkDeletionSettle', { ...ref, accepted: true, nativeQuiescent: true });
      assert.notEqual(settled, false); return settled as Exclude<typeof settled, false>;
    } };
  const app = new Hono(); registerSdkDeletionHttp(app, '/api/connector/v1/sessions/:sessionKey', deps);
  app.delete('/api/connector/v1/sessions/:sessionKey', async c => { fallbacks++; return c.json({ legacy: await c.req.text() }); });
  app.get('/api/connector/v1/sessions/:sessionKey/deletion-commands/:commandKey', c => { fallbacks++; return c.json({ legacy: true }); });
  const request = (commandKey?: string, credential = authorization) => app.request(path, { method: 'DELETE',
    headers: { authorization: credential, ...(commandKey === undefined ? {} : { 'idempotency-key': commandKey }) } });
  const read = (commandKey: string, credential = authorization) => app.request(`${path}/deletion-commands/${commandKey}`, { headers: { authorization: credential } });
  return { root, tokenFile, tokens, actorId, store, key, path, journal, owner, deps, lines, app, request, read,
    calls: () => calls, fallbacks: () => fallbacks, ready: (v: boolean) => { ready = v; },
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: deletion original wire, receipt isolation, maintenance recovery and single event`, async () => {
    const f = fixture(runtime);
    try {
      const cursor = f.store.events.latestEventId();
      assert.equal((await f.read('missing')).status, 404); assert.equal(f.calls(), 0); assert.equal(f.journal.deletion(f.key), undefined);
      const first = await f.request('original'); assert.equal(first.status, 200);
      const body = await first.json(); assert.equal(body.ok, true); assert.equal(body.status, 'delete_accepted');
      assert.equal(body.command.state, 'accepted'); assert.equal(body.command.result, undefined);
      assert.equal(first.headers.get('x-agentopsdeck-command-key'), 'original'); assert.equal(first.headers.get('cache-control'), 'no-store');
      f.ready(false); f.store.pauseTurnStarts();
      const duplicate = await f.request('original'); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), body);
      assert.equal((await f.request('fresh')).status, 409); assert.equal(f.calls(), 1);
      const read = await f.read('original'); assert.equal(read.status, 200); assert.equal((await read.json()).command.id, body.command.id);
      const other = f.tokens.create({ label: 'Other', scopes: ['sessions:create'] });
      assert.equal((await f.read('original', `Bearer ${other.token}`)).status, 404);
      const events = f.store.events.getEventsSince(cursor); assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'session.updated'); assert.deepEqual(events[0]!.payload, { sessionKey: f.key, status: 'deleted' });
      assert.equal(f.journal.readSnapshot(f.key).session, null); assert.equal(f.fallbacks(), 0);
      f.tokens.revoke(f.actorId); assert.equal((await f.read('original')).status, 401);
      assert.match(f.lines.join('\n'), /sdk-deletion-http/); assert.doesNotMatch(f.lines.join('\n'), /original-native|isolated-sdk-deletion-http-test|:original/);
    } finally { f.close(); }
  });

  test(`${runtime}: generated deletion key ignores body like legacy DELETE and is recoverable`, async () => {
    const f = fixture(runtime);
    try {
      const response = await f.app.request(f.path, { method: 'DELETE', headers: { authorization }, body: '{broken unused body' });
      assert.equal(response.status, 200); const key = response.headers.get('x-agentopsdeck-command-key'); assert.ok(key);
      assert.equal((await f.read(key)).status, 200); assert.equal(f.calls(), 1);
    } finally { f.close(); }
  });

  test(`${runtime}: event failure rolls back original deletion and cannot redispatch unknown`, async t => {
    const f = fixture(runtime);
    try {
      const cursor = f.store.events.latestEventId();
      t.mock.method(f.store.events, 'appendInTransaction', () => { throw Error('private-event-failure'); });
      const response = await f.request('unknown'); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-event/);
      assert.equal(f.journal.deletion(f.key)!.phase, 'pending'); assert.ok(f.journal.session(f.key));
      const receipt = (await (await f.read('unknown')).json()).command; assert.equal(receipt.state, 'outcome_unknown');
      assert.equal((await f.request('unknown')).status, 202); assert.equal(f.calls(), 1); assert.deepEqual(f.store.events.getEventsSince(cursor), []);
    } finally { f.close(); }
  });

  test(`${runtime}: real worker and original native deletion wait physical exit, survive HTTP timeout and reopen`, { timeout: 20_000 }, async () => {
    const f = fixture(runtime), file = join(f.root, 'persistent.sqlite'), homeDirectory = join(f.root, 'home');
    mkdirSync(homeDirectory, { mode: 0o700 });
    const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    const journal = runtime === 'ghcp' ? seed.copilotJournal : seed.claudeJournal;
    journal.create({ key: f.key, nativeSessionId: 'native-persistent', title: 'Original', createdAt: 1 });
    await seed.turns.enqueueAsync(runtime, { id: 'materialize', sessionKey: f.key, createdAt: 1, payload: { text: 'Original', actorId: f.actorId } });
    const ref = { key: f.key, id: 'execution', epoch: 'original-epoch' };
    journal.begin(ref, ['materialize'], seed.turns); journal.observeTerminal(ref, 'completed', seed.turns); journal.confirmSettled(ref); seed.close();
    let owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, f.deps.diagnostics); await owner.open();
    const exit = gate(), entered = gate(); let quiet = false, calls = 0;
    const config = { homeDirectory, workspace: f.root, sdkDirectory: f.root, startupTimeoutMs: 1_000,
      apiKeyFile: join(f.root, 'absent-key'), model: 'default', baseUrl: 'http://127.0.0.1:1',
      auth: { mode: 'github' as const, credentialFile: join(f.root, 'absent-key') } };
    const ports = { start: () => assert.fail('No inference in deletion test'), check: passed,
      deleteNative: () => { calls++; entered.release(); return { ready: Promise.resolve(true), finished: exit.promise,
        inspectQuiescence: () => quiet, close() { quiet = true; exit.release(); } }; } };
    const original = await (runtime === 'ghcp' ? createAsyncCopilotOwnedRuntime({ owner, config, diagnostics: f.deps.diagnostics! }, ports)
      : createAsyncClaudeOwnedRuntime({ owner, config, diagnostics: f.deps.diagnostics! }, ports));
    const pending = new Set<Promise<unknown>>();
    try {
      assert.equal(await original.initialize(), true);
      f.deps.owner = owner; f.deps.timeoutMs = 1_000;
      // Deadline is captured on registration; use one isolated HTTP app for
      // this actual worker/runtime pair, never an alternate persistence owner.
      const app = new Hono(); registerSdkDeletionHttp(app, '/api/connector/v1/sessions/:sessionKey', { ...f.deps,
        timeoutMs: 1_000, ready: () => original.ready,
        remove: (_runtime, key, commandKey, authorization, signal) => {
          const work = original.remove(key, commandKey, authorization, signal); pending.add(work);
          void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
        } });
      const response = Promise.resolve(app.request(f.path, { method: 'DELETE', headers: { authorization, 'idempotency-key': 'physical' } }));
      await entered.promise; assert.equal(calls, 1);
      const waiting = await owner.command('sdkDeletionReceiptRead', { runtime, key: f.key, commandKey: 'physical', authorization });
      assert.ok('receipt' in waiting && waiting.receipt?.state === 'outcome_unknown');
      const timedOut = await response; assert.equal(timedOut.status, 503); assert.equal((await timedOut.json()).commandKey, 'physical');
      const duplicate = await app.request(f.path, { method: 'DELETE', headers: { authorization, 'idempotency-key': 'physical' } });
      assert.equal(duplicate.status, 202); assert.equal(calls, 1);
      quiet = true; exit.release(); await Promise.all([...pending]); await original.close(); await owner.closeForShutdown();
      owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, f.deps.diagnostics); await owner.open();
      f.deps.owner = owner; f.ready(false); f.deps.remove = async () => assert.fail('Never repeat native deletion after reopen');
      const recovered = await f.read('physical'); assert.equal(recovered.status, 200); assert.equal((await recovered.json()).command.state, 'accepted');
      assert.equal((await f.request('physical')).status, 200); assert.equal(calls, 1);
      assert.equal((await owner.command('sdkLifecycleRead', { runtime, key: f.key, history: false })).snapshot.deletion?.phase, 'deleted');
    } finally { quiet = true; exit.release(); await Promise.allSettled([...pending]); await original.close().catch(() => {}); await owner.closeForShutdown(); f.close(); }
  });
}

test('deletion HTTP rejects bad identity/key/grant, keeps foreign DELETE body untouched', async () => {
  const f = fixture('ghcp');
  try {
    assert.equal((await f.request('')).status, 400); assert.equal((await f.request('bad key')).status, 400);
    assert.equal((await f.request('original', '')).status, 401);
    assert.equal((await f.app.request(f.path, { method: 'DELETE', headers: { authorization, 'x-agentopsdeck-execution-grant': 'rejected' } })).status, 403);
    const readOnly = f.tokens.create({ label: 'Read', scopes: ['messages:read'] });
    assert.equal((await f.request('original', `Bearer ${readOnly.token}`)).status, 403);
    const delegated = f.tokens.create({ label: 'Delegated', scopes: ['sessions:create', 'execution:delegate'] });
    assert.equal((await f.read('missing', `Bearer ${delegated.token}`)).status, 403);
    const other = await f.app.request('/api/connector/v1/sessions/codex:legacy', { method: 'DELETE', body: 'original bytes' });
    assert.deepEqual(await other.json(), { legacy: 'original bytes' }); assert.equal(f.fallbacks(), 1); assert.equal(f.calls(), 0);
  } finally { f.close(); }
});

test('deletion committed ACK survives revoke but HTTP does not reveal it', async () => {
  const f = fixture('ghcp'), remove = f.deps.remove;
  try {
    f.deps.remove = async (...input) => { const result = await remove(...input); f.tokens.revoke(f.actorId); return result; };
    const response = await f.request('original'); assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /delete_accepted|"accepted"/);
    assert.equal(f.store.commands.get(JSON.stringify(['delete', JSON.stringify([f.actorId, f.key])]), 'original')!.state, 'accepted');
    assert.equal(f.journal.deletion(f.key)!.phase, 'deleted'); assert.equal(f.calls(), 1);
  } finally { f.close(); }
});

test('deletion read protocol is closed and never accepts caller authority or physical proof', () => {
  const input = { runtime: 'ghcp', key: 'ghcp:original', authorization, commandKey: 'original' };
  assert.equal(connectorOwnerSteps.sdkDeletionReceiptRead, 110);
  assert.equal(validConnectorOwnerInput('sdkDeletionReceiptRead', input), true);
  for (const field of ['actorId', 'authorized', 'nativeQuiescent', 'accepted', 'ready', 'sql', 'intent']) {
    assert.equal(validConnectorOwnerInput('sdkDeletionReceiptRead', { ...input, [field]: true }), false);
  }
  assert.equal(validConnectorOwnerOutput('sdkDeletionReceiptRead', { runtime: 'ghcp', key: input.key, commandKey: 'original', receipt: null }), true);
  assert.equal(validConnectorOwnerOutput('sdkDeletionReceiptRead', { error: 409 }), false);
});
