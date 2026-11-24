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
import { AsyncSdkCompactDriver } from './async-sdk-compact-driver.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { registerSdkCompactHttp, type SdkCompactHttp } from './sdk-compact-http.js';
import type { SdkAgentId, SdkCompactRef, SdkCompactResult } from './sdk-execution-journal.js';
import type { SdkPreflight } from './sdk-owned-runtime.js';

const authorization = 'Bearer isolated-compact-http';
function gate<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const passed = (): SdkPreflight => ({ ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close() {} });
function materialize(store: ConnectorUserStore, runtime: SdkAgentId, key: string) {
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  const ref = { key, id: 'original-execution', epoch: 'original-epoch' };
  journal.begin(ref, ['materialize'], store.turns); journal.observeTerminal(ref, 'completed', store.turns); journal.confirmSettled(ref);
}
function fixture(runtime: SdkAgentId) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-compact-http-')), tokenFile = join(root, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, 'isolated-compact-http'), actorId = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal, key = `${runtime}:original`;
  journal.create({ key, nativeSessionId: 'native-original', title: 'Original', createdAt: 1 });
  store.turns.enqueue(runtime, { id: 'materialize', sessionKey: key, createdAt: 1, payload: { text: 'Original', actorId } });
  materialize(store, runtime, key);
  const owner = { command: createConnectorOwnerCommands(store, tokens) }, lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
  let ready = true, calls = 0, fallbacks = 0;
  const driver = new AsyncSdkCompactDriver({ owner, runtime, epoch: 'original-compact-epoch', deadlineMs: 5_000,
    models: { model: 'default' }, ready: () => ready, occupied: () => false, drained() {}, faulted() {}, diagnostics,
    start(execution) { calls++; return { result: Promise.resolve({ ...execution, nativeRequestId: execution.id, completionEventId: 'boundary', outcome: 'completed' }),
      finished: Promise.resolve(), inspectQuiescence: async () => true,
      inspectSettlement: async () => ({ ...execution, completionEventId: 'boundary', historyPersisted: true, nativeQuiescent: true }),
      interrupt: async () => {}, close() {} }; } });
  const deps: SdkCompactHttp = { owner, ready: () => ready, diagnostics,
    compact: (_runtime, key, commandKey, authorization, signal) => driver.compact(key, commandKey, authorization, signal) };
  const app = new Hono(), path = `/api/connector/v1/sessions/${key}`;
  registerSdkCompactHttp(app, '/api/connector/v1/sessions/:sessionKey', deps);
  app.post('/api/connector/v1/sessions/:sessionKey/compact', async c => { fallbacks++; return c.json({ legacy: await c.req.text() }); });
  const request = (commandKey?: string, credential = authorization, body: unknown = {}) => app.request(`${path}/compact`, { method: 'POST',
    headers: { authorization: credential, ...(commandKey === undefined ? {} : { 'idempotency-key': commandKey }) }, body: JSON.stringify(body) });
  const read = (commandKey: string, credential = authorization) => app.request(`${path}/compact-commands/${commandKey}`, { headers: { authorization: credential } });
  return { root, tokenFile, tokens, actorId, store, journal, key, owner, diagnostics, lines, driver, deps, app, path, request, read,
    ready: (v: boolean) => { ready = v; }, calls: () => calls, fallbacks: () => fallbacks,
    async close() { await driver.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: compact original driver, wire, admission receipt and maintenance recovery`, async () => {
    const f = fixture(runtime);
    try {
      const before = f.journal.current(f.key);
      assert.equal((await f.read('missing')).status, 404); assert.deepEqual(f.journal.current(f.key), before);
      const response = await f.request('original'); assert.equal(response.status, 200);
      const body = await response.json(); assert.equal(body.ok, true); assert.equal(body.status, 'compacting');
      assert.equal(body.command.state, 'accepted'); assert.equal(body.command.result, undefined); assert.ok(body.runId);
      assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'original'); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(f.journal.current(f.key)?.phase, 'completed');
      f.ready(false); f.store.pauseTurnStarts();
      const duplicate = await f.request('original'); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), body);
      assert.equal((await f.request('fresh')).status, 409); assert.equal(f.calls(), 1); assert.equal(f.fallbacks(), 0);
      const view = await f.read('original'); assert.equal(view.status, 200); assert.equal((await view.json()).command.id, body.command.id);
      const other = f.tokens.create({ label: 'Other', scopes: ['messages:read', 'messages:send'] });
      assert.equal((await f.read('original', `Bearer ${other.token}`)).status, 404);
      assert.match(f.lines.join('\n'), /sdk-compact-http/); assert.doesNotMatch(f.lines.join('\n'), /isolated-compact-http|native-original|:original/);
      f.tokens.revoke(f.actorId); assert.equal((await f.read('original')).status, 401);
    } finally { await f.close(); }
  });

  test(`${runtime}: compact read/send purposes reject delegation and preserve scope distinction`, async () => {
    const f = fixture(runtime);
    try {
      const sender = f.tokens.create({ label: 'Sender', scopes: ['messages:send'] }), bearer = `Bearer ${sender.token}`;
      assert.equal((await f.request('sender', bearer)).status, 200);
      assert.equal((await f.read('sender', bearer)).status, 403);
      assert.equal((await f.request('sender', bearer)).status, 200); assert.equal(f.calls(), 1);
      const reader = f.tokens.create({ label: 'Reader', scopes: ['messages:read'] });
      assert.equal((await f.request('reader', `Bearer ${reader.token}`)).status, 403);
      assert.equal((await f.read('sender', `Bearer ${reader.token}`)).status, 404);
      const delegated = f.tokens.create({ label: 'Delegated', scopes: ['messages:read', 'messages:send', 'execution:delegate'] });
      const delegatedAuthorization = `Bearer ${delegated.token}`;
      assert.equal((await f.request('delegate', delegatedAuthorization)).status, 403);
      assert.equal((await f.read('sender', delegatedAuthorization)).status, 403);
      const claim = await f.owner.command('sdkCompactClaim', { runtime, key: f.key, id: 'delegated', epoch: 'epoch', commandKey: 'delegate',
        nativeSessionId: 'native-original', model: null, authorization: delegatedAuthorization });
      assert.deepEqual(claim, { error: 403 }); assert.equal(f.calls(), 1);
    } finally { await f.close(); }
  });

  test(`${runtime}: compact late ACK cannot expose original receipt after revocation`, async () => {
    const f = fixture(runtime), compact = f.deps.compact;
    try {
      f.deps.compact = async (...args) => { const result = await compact(...args); f.tokens.revoke(f.actorId); return result; };
      assert.equal((await f.request('late')).status, 401); assert.equal(f.calls(), 1);
      const scope = JSON.stringify(['compact', JSON.stringify([f.actorId, f.key])]);
      assert.equal(f.store.commands.get(scope, 'late')?.state, 'accepted');
    } finally { await f.close(); }
  });

  test(`${runtime}: compact actual worker/owned runtime keeps physical fence through timeout and reopens original receipt`, { timeout: 20_000 }, async () => {
    const f = fixture(runtime), file = join(f.root, 'persistent.sqlite'), homeDirectory = join(f.root, 'home');
    mkdirSync(homeDirectory, { mode: 0o700 });
    const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    const journal = runtime === 'ghcp' ? seed.copilotJournal : seed.claudeJournal;
    journal.create({ key: f.key, nativeSessionId: 'native-persistent', title: 'Original', createdAt: 1 });
    await seed.turns.enqueueAsync(runtime, { id: 'materialize', sessionKey: f.key, createdAt: 1, payload: { text: 'Original', actorId: f.actorId } });
    materialize(seed, runtime, f.key); seed.close();
    let owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, f.diagnostics); await owner.open();
    const entered = gate(), result = gate<SdkCompactRef & SdkCompactResult>(), exit = gate(); let quiet = false, calls = 0;
    let originalRef: SdkCompactRef | undefined;
    const config = { homeDirectory, workspace: f.root, sdkDirectory: f.root, startupTimeoutMs: 5_000,
      apiKeyFile: join(f.root, 'absent-key'), model: 'default', baseUrl: 'http://127.0.0.1:1',
      auth: { mode: 'github' as const, credentialFile: join(f.root, 'absent-key') } };
    const ports = { start: () => assert.fail('No inference during explicit compact'), check: passed,
      compact: (request: { execution: SdkCompactRef }) => {
        calls++; originalRef = request.execution; entered.resolve();
        return { result: result.promise, finished: exit.promise, inspectQuiescence: async () => quiet,
          inspectSettlement: async () => ({ ...request.execution, completionEventId: 'physical-boundary', historyPersisted: true, nativeQuiescent: true }),
          interrupt: async () => {}, close() { quiet = true; exit.resolve(); } };
      } };
    const original = await (runtime === 'ghcp' ? createAsyncCopilotOwnedRuntime({ owner, config, diagnostics: f.diagnostics }, ports)
      : createAsyncClaudeOwnedRuntime({ owner, config, diagnostics: f.diagnostics }, ports));
    const pending = new Set<Promise<unknown>>();
    try {
      assert.equal(await original.initialize(), true);
      const app = new Hono(), deps: SdkCompactHttp = { owner, ready: () => original.ready, timeoutMs: 1_000, diagnostics: f.diagnostics,
        compact: (_runtime, key, commandKey, authorization, signal) => {
          const task = original.driver.compact(key, commandKey, authorization, signal); pending.add(task);
          void task.finally(() => pending.delete(task)).catch(() => {}); return task;
        } };
      registerSdkCompactHttp(app, '/api/connector/v1/sessions/:sessionKey', deps);
      const request = () => app.request(`${f.path}/compact`, { method: 'POST', headers: { authorization, 'idempotency-key': 'physical' }, body: '{}' });
      const waiting = Promise.resolve(request()); await entered.promise;
      const receipt = await owner.command('sdkCompactReceiptRead', { runtime, key: f.key, commandKey: 'physical', authorization, purpose: 'read' });
      assert.ok('receipt' in receipt && receipt.receipt?.state === 'accepted', 'accepted certifies admission before physical completion');
      result.resolve({ ...originalRef!, nativeRequestId: 'original-request', completionEventId: 'physical-boundary', outcome: 'completed' });
      const timeout = await waiting; assert.equal(timeout.status, 503); assert.equal((await timeout.json()).commandKey, 'physical');
      assert.equal(original.driver.inspect().nativeWorkers, 1);
      const beforeExit = await owner.command('sdkSnapshotRead', { runtime, key: f.key }); assert.equal(beforeExit.execution?.phase, 'dispatching');
      assert.equal((await request()).status, 200); assert.equal(calls, 1);
      quiet = true; exit.resolve(); await Promise.all([...pending]);
      assert.equal((await owner.command('sdkSnapshotRead', { runtime, key: f.key })).execution?.phase, 'completed');
      await original.close(); await owner.closeForShutdown();
      owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, f.diagnostics); await owner.open();
      deps.owner = owner; deps.ready = () => false; deps.compact = async () => assert.fail('No replay after reopen');
      const recovered = await app.request(`${f.path}/compact-commands/physical`, { headers: { authorization } });
      assert.equal(recovered.status, 200); assert.equal((await recovered.json()).command.id, receipt.receipt.id);
      assert.equal((await request()).status, 200); assert.equal(calls, 1);
    } finally {
      if (originalRef) result.resolve({ ...originalRef, nativeRequestId: 'original-request', completionEventId: 'physical-boundary', outcome: 'completed' });
      quiet = true; exit.resolve(); await Promise.allSettled([...pending]); await original.close().catch(() => {}); await owner.closeForShutdown(); await f.close();
    }
  });
}

test('compact HTTP body/key compatibility, finite limits and foreign body untouched', async () => {
  const f = fixture('ghcp');
  try {
    for (const body of [[], null, 'text', { message: 'must not send' }, { nativeSessionId: 'fake' }]) assert.equal((await f.request('bad', authorization, body)).status, 400);
    assert.equal((await f.request('header', authorization, { idempotencyKey: 'body' })).status, 400);
    assert.equal((await f.request('')).status, 400); assert.equal((await f.request('bad key')).status, 400);
    assert.equal((await f.request('noauth', '')).status, 401);
    assert.equal((await f.app.request(`${f.path}/compact`, { method: 'POST', headers: { authorization, 'x-agentopsdeck-execution-grant': 'grant' }, body: '{}' })).status, 403);
    assert.equal((await f.app.request(`${f.path}/compact`, { method: 'POST', headers: { authorization }, body: '{broken' })).status, 400);
    assert.equal((await f.request('oversize', authorization, { extra: 'x'.repeat(4100) })).status, 413);
    const generated = await f.request(); assert.equal(generated.status, 200);
    const key = generated.headers.get('x-agentopsdeck-command-key'); assert.ok(key); assert.equal((await f.read(key)).status, 200);
    const bodyKey = await f.request(undefined, authorization, { idempotencyKey: 'body-key' }); assert.equal(bodyKey.status, 200);
    assert.equal(bodyKey.headers.get('x-agentopsdeck-command-key'), 'body-key');
    const foreign = await f.app.request('/api/connector/v1/sessions/codex:foreign/compact', { method: 'POST', body: 'unmodified' });
    assert.deepEqual(await foreign.json(), { legacy: 'unmodified' }); assert.equal(f.fallbacks(), 1);
    for (const timeoutMs of [0, Infinity, NaN, 2_147_483_648]) assert.throws(() => registerSdkCompactHttp(new Hono(), '/sessions/:sessionKey', { ...f.deps, timeoutMs }), RangeError);
  } finally { await f.close(); }
});

test('compact bounds concurrent body assembly without blocking receipt reads and releases capacity', async () => {
  const f = fixture('ghcp'), finish: Array<() => void> = [], pending: Array<Promise<Response>> = [];
  try {
    for (const commandKey of ['buffer-one', 'buffer-two']) {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { finish.push(() => {
        controller.enqueue(Buffer.from('{}')); controller.close();
      }); } });
      pending.push(Promise.resolve(f.app.fetch(new Request(`http://localhost${f.path}/compact`, {
        method: 'POST', headers: { authorization, 'idempotency-key': commandKey }, body: stream, duplex: 'half',
      } as RequestInit))));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.request('over-capacity')).status, 503);
    assert.equal((await f.read('absent')).status, 404);
    assert.equal(f.calls(), 0);
    finish.forEach(release => release());
    const responses = await Promise.all(pending);
    assert.ok(responses.every(response => response.status === 200 || response.status === 409));
    assert.equal((await f.request('capacity-restored')).status, 200);
  } finally {
    finish.forEach(release => { try { release(); } catch {} });
    await Promise.allSettled(pending); await f.close();
  }
});

test('compact receipt fixed command validates scope/purpose and never accepts caller authority or native payload', async () => {
  const f = fixture('ghcp');
  try {
    const input = { runtime: 'ghcp' as const, key: f.key, commandKey: 'read', authorization, purpose: 'read' as const };
    assert.equal(validConnectorOwnerInput('sdkCompactReceiptRead', input), true);
    for (const patch of [{ purpose: 'send' }, { key: 'claude-code:wrong' }, { actorId: 'fake' }, { authorized: true }, { sql: 'arbitrary' }, { payload: {} }]) {
      assert.equal(validConnectorOwnerInput('sdkCompactReceiptRead', { ...input, ...patch }), false);
    }
    assert.deepEqual(await f.owner.command('sdkCompactReceiptRead', input), { runtime: 'ghcp', key: f.key, commandKey: 'read', receipt: null });
    assert.equal(validConnectorOwnerOutput('sdkCompactReceiptRead', { runtime: 'ghcp', key: f.key, commandKey: 'read', receipt: { key: 'other' } }), false);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
