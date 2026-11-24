import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { originalApplicationAuthFixture } from './auth/application-transaction-test-fixture.js';
import { createApplicationTransactionClient, createApplicationTransactionLink } from './auth/application-transaction-gate.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { ConnectorUserStore } from './connector/connector-user-store.js';
import { createConnectorOwnerCommands } from './connector/connector-owner-domain.js';
import { AsyncOpenClawCompact } from './connector/async-openclaw-compact.js';
import { AsyncSdkCompactDispatch } from './connector/async-sdk-compact-dispatch.js';
import type { SdkCompactAdapter, SdkCompactExecution } from './connector/sdk-compact-dispatch.js';
import { createApplicationCompactIngress, type ApplicationCompactParticipants } from './application-compact-ingress.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { NativeOperationError } from './connector/native-operation.js';

const runtimes = ['openclaw', 'claude-code', 'ghcp'] as const;
type Runtime = typeof runtimes[number];
const silent = new PerformanceDiagnostics(() => {}), session = 's'.repeat(43), wait = { timeoutMs: 15_000 };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(t: TestContext, runtime: Runtime, role: 'hub' | 'standalone' = 'hub', mode: 'json' | 'sqlite' = 'sqlite') {
  const root = mkdtempSync(join(tmpdir(), 'application-compact-')), link = createApplicationTransactionLink();
  const auth = originalApplicationAuthFixture(root, role, mode, 'original-application-key', silent, link.auth);
  link.connector.begin(); link.connector.data.ref();
  const client = createApplicationTransactionClient(link.connector.data);
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'original-transport', silent);
  const authorization = 'Bearer original-transport', actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const original = createConnectorOwnerCommands(store, tokens, undefined, undefined, undefined, false, undefined, client);
  let revokeAtReady = false, revokeAtNative = false, allowed = true, failProjection = false, effects = 0;
  let nativeWait: Promise<void> | undefined;
  const nativeEntered = deferred(), projected = new Set<string>();
  const command: typeof original = Object.assign(async (kind: Parameters<typeof original>[0], input: never) => {
    if (revokeAtReady && (kind === 'sdkCompactReady' || kind === 'openClawCompactReady')) {
      revokeAtReady = false; await auth.revokeSession(session);
    }
    return original(kind, input);
  }, { dispose: original.dispose }) as typeof original;
  const key = runtime === 'openclaw' ? 'agent:main:dashboard:compact' : `${runtime}:original`;
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  if (runtime !== 'openclaw') {
    journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
    store.turns.enqueue(runtime, { id: 'original', sessionKey: key, createdAt: 0, payload: { actorId: actor, text: 'first', images: [] } });
    const first = { key, id: 'first', epoch: 'old' };
    journal.begin(first, ['original'], store.turns); journal.observeTerminal(first, 'completed', store.turns); journal.confirmSettled(first);
  }
  async function native() {
    effects++; nativeEntered.resolve(); if (nativeWait) await nativeWait;
    if (revokeAtNative) { await auth.revokeSession(session); allowed = false; }
  }
  const openclaw = new AsyncOpenClawCompact({ owner: { command }, available: () => true,
    session: () => ({ exists: true, busy: false, totalTokens: 20, contextTokens: 100 }),
    gateway: { connectionId: () => 'original-connection', async requestBound<T>(_method: string, _params: unknown, _connection: string, before?: () => void) {
      before?.(); await native(); return { connectionId: 'original-connection', payload: { runId: 'native-compact', status: 'started' } as T };
    } },
    project: result => { if (result.projection) projected.add(result.projection.id); if (failProjection) throw Error('isolated projection failure'); }, diagnostics: silent });
  const adapter: SdkCompactAdapter = { runtime: runtime === 'ghcp' ? 'ghcp' : 'claude-code', epoch: 'epoch', ready: true,
    compact: async e => { await native(); return { ...e, nativeRequestId: 'request', completionEventId: 'boundary', outcome: 'completed' }; },
    inspectSettlement: async e => ({ ...e, completionEventId: 'boundary', historyPersisted: true, nativeQuiescent: true }) };
  const dispatch = new AsyncSdkCompactDispatch({ owner: { command }, adapter, deadlineMs: 10, models: { model: 'default' }, diagnostics: silent });
  const participants: ApplicationCompactParticipants = { openclaw, sdk: {
    compactPhysical: async (v, authority) => {
      const result = await dispatch.dispatch(v.key, v.commandKey, v.authorization, undefined, v.application, authority);
      const e = journal.current(v.key);
      if (e?.kind === 'compact' && e.phase === 'settling') await dispatch.settle(e as SdkCompactExecution, true);
      return result;
    },
    readPhysical: async (v, authority) => { const result = await command('sdkCompactReceiptRead', v); await authority.authorize('prepare'); authority.local(); return result; },
  } };
  const commands = createApplicationCommandScopes({ authorize: () => allowed, assertAvailable() {}, diagnostics: silent });
  const ingress = createApplicationCompactIngress(commands, participants, { transactions: true });
  const scope = { key, commandKey: 'original-compact', authorization };
  const request = () => new Request('http://application.invalid/', { headers: { cookie: `agentopsdeck_session=${session}` } });
  const send = (commandKey = scope.commandKey, timeoutMs = wait.timeoutMs, operation: 'compact' | 'message' = 'compact') => runtime === 'openclaw'
    ? ingress.openclaw(request(), { ...scope, commandKey, operation, payloadJson: operation === 'message' ? '{"message":"/compact"}' : '{}' }, { timeoutMs })
    : ingress.sdk(request(), { ...scope, commandKey, runtime, payloadJson: '{}' }, { timeoutMs });
  const receipt = (commandKey = scope.commandKey, operation: 'compact' | 'message' = 'compact') => store.commands.get(operation === 'message'
    ? JSON.stringify([actor, key]) : JSON.stringify(['compact', JSON.stringify([actor, key])]), commandKey);
  const recover = (operation: 'compact' | 'message' = 'compact') => commands.run(request(), { action: operation === 'message' ? 'message' : 'compact', runtime, resource: key, commandKey: scope.commandKey,
    payloadDigest: '0'.repeat(64) }, authority => ingress.readPhysical(runtime, scope, authority, operation));
  t.after(async () => {
    await commands.close(); await openclaw.close(); original.dispose(); store.close(); link.connector.data.close(); link.connector.confirmExit();
    await auth.closeForShutdown(); link.closeUnused(); rmSync(root, { recursive: true, force: true });
  });
  await auth.open(); await auth.issueSession(session);
  return { auth, store, command, scope, request, commands, participants, ingress, send, receipt, recover, journal, projected,
    effects: () => effects, readyRevoke: () => { revokeAtReady = true; }, nativeRevoke: () => { revokeAtNative = true; },
    blockNative: (value: Promise<void>) => { nativeWait = value; }, nativeEntered: nativeEntered.promise,
    allowed: (value: boolean) => { allowed = value; }, fail: (value: boolean) => { failProjection = value; } };
}

for (const runtime of runtimes) for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) {
  test(`${runtime}/${role}/${mode}: original compact transaction, immutable duplicate and read-only recovery`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, runtime, role, mode);
    const result = await f.send(); assert.ok('receipt' in result && result.receipt?.state === 'accepted');
    const receipt = structuredClone(f.receipt()); assert.equal(f.effects(), 1);
    await f.send(); await f.recover(); assert.equal(f.effects(), 1); assert.deepEqual(f.receipt(), receipt);
    if (runtime !== 'openclaw') assert.equal(f.journal.canStart(f.scope.key), true, 'native completion settles original fence');
    await f.auth.revokeSession(session);
    await assert.rejects(f.send('after-revoke')); assert.equal(f.receipt('after-revoke'), undefined); assert.equal(f.effects(), 1);
    f.allowed(false); await assert.rejects(f.recover()); assert.deepEqual(f.receipt(), receipt);
  });
}
for (const runtime of runtimes) {
  test(`${runtime}: retained original identity blocks Ready after logout`, async t => {
    const f = await fixture(t, runtime); f.readyRevoke();
    await f.send().catch(() => {}); assert.equal(f.effects(), 0); assert.ok(f.receipt());
    if (runtime !== 'openclaw') assert.equal(f.journal.canStart(f.scope.key), false);
  });
  test(`${runtime}: acknowledged native fact settles after logout but cannot be delivered`, async t => {
    const f = await fixture(t, runtime); f.nativeRevoke();
    await assert.rejects(f.send()); assert.equal(f.effects(), 1); assert.equal(f.receipt()?.state, 'accepted');
    if (runtime !== 'openclaw') assert.equal(f.journal.canStart(f.scope.key), true);
    assert.equal(f.projected.size, 0);
  });
  test(`${runtime}: waiter timeout does not abandon physical native work or close drainage`, async t => {
    const f = await fixture(t, runtime), block = deferred(); f.blockNative(block.promise);
    try {
      // Install the rejection handler before awaiting worker/native entry:
      // the HTTP waiter can expire while original SQL admission is in flight.
      const timedOut = assert.rejects(f.send(undefined, 20), NativeOperationError);
      await f.nativeEntered; await timedOut; let drained = false;
      const closing = f.commands.close().then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(f.effects(), 1);
      block.resolve(); await closing; assert.equal(f.receipt()?.state, 'accepted');
    } finally { block.resolve(); }
  });
}
test('OpenClaw message compact retains messages receipt namespace and projection recovery never resends', async t => {
  const f = await fixture(t, 'openclaw');
  await f.send(undefined, undefined, 'message'); assert.equal(f.receipt(undefined, 'message')?.state, 'accepted');
  assert.equal(f.receipt(), undefined); assert.equal(f.effects(), 1);
  f.fail(true); await assert.rejects(f.recover('message'), /isolated projection failure/);
  f.fail(false); const before = f.effects(); await f.recover('message'); assert.equal(f.effects(), before);
});
for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: receipt commit failure atomically rolls back compact intent and session fence`, async t => {
    const f = await fixture(t, runtime), db = (f.store as unknown as { db: DatabaseSync }).db;
    db.exec("CREATE TRIGGER isolated_compact_failure BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'isolated receipt failure'); END");
    // The HTTP waiter intentionally hides physical storage error details.
    await assert.rejects(f.send(), NativeOperationError);
    assert.equal(f.receipt(), undefined); assert.equal(f.effects(), 0);
    assert.equal(f.journal.current(f.scope.key)?.id, 'first'); assert.equal(f.journal.canStart(f.scope.key), true);
  });
}
test('compact rejects unpaired roots, caller evidence, extra Ready/read fields and unsupported SDK body', async t => {
  const f = await fixture(t, 'claude-code'), input = { ...f.scope, runtime: 'claude-code' as const, payloadJson: '{}' };
  await assert.rejects(createApplicationCompactIngress(f.commands, f.participants, { transactions: false }).sdk(f.request(), input, wait));
  await assert.rejects(f.ingress.sdk(f.request(), { ...input, application: { accessKey: 'forged' } }, wait));
  await assert.rejects(f.ingress.sdk(f.request(), { ...input, payloadJson: '{"message":"/compact extra"}' }, wait));
  await assert.rejects(createApplicationCompactIngress(f.commands, {}, { transactions: true }).sdk(f.request(), input, wait));
  await assert.rejects(f.command('sdkCompactReceiptRead', { ...f.scope, runtime: 'claude-code', purpose: 'read', application: {} } as never));
  await assert.rejects(f.command('sdkCompactReady', { runtime: 'claude-code', authorization: f.scope.authorization,
    ref: { key: f.scope.key, id: 'forged', epoch: 'epoch', nativeSessionId: 'native' }, action: 'dispatch', application: {} } as never));
  assert.equal(f.receipt(), undefined); assert.equal(f.effects(), 0);
});
