import assert from 'node:assert/strict';
import { awaitHttpAdmission, controlledHttpDeadline } from './lifecycle/http-deadline-test-support.js';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { originalApplicationAuthFixture } from './auth/application-transaction-test-fixture.js';
import { createApplicationTransactionClient, createApplicationTransactionLink, type ApplicationTransactionClient } from './auth/application-transaction-gate.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { ConnectorUserStore } from './connector/connector-user-store.js';
import { createConnectorOwnerCommands } from './connector/connector-owner-domain.js';
import { AsyncSdkQueue } from './connector/async-sdk-queue.js';
import { AsyncNativeQueue } from './connector/async-native-queue.js';
import { AsyncHermesQueue } from './connector/async-hermes-queue.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { registerApplicationQueueHttp } from './application-queue-http.js';

const runtimes = ['claude-code', 'ghcp', 'hermes', 'codex', 'openclaw'] as const;
type Runtime = typeof runtimes[number];
const silent = new PerformanceDiagnostics(() => {}), session = 's'.repeat(43);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(t: TestContext, runtime: Runtime, role: 'hub' | 'standalone' = 'hub',
  mode: 'json' | 'sqlite' = 'sqlite', withKey = true, timeoutMs = 15_000) {
  const root = mkdtempSync(join(tmpdir(), 'application-queue-')), link = createApplicationTransactionLink();
  const auth = originalApplicationAuthFixture(root, role, mode, withKey ? 'original-application-key' : undefined, silent, link.auth);
  link.connector.begin(); link.connector.data.ref();
  const client = createApplicationTransactionClient(link.connector.data);
  let revokePhase: 'control-claim' | 'control-ready' | undefined, revoked = false, allowed = true, revokeOnAck = false;
  const transaction: ApplicationTransactionClient = { async run(binding, write) {
    if (binding.phase === revokePhase) { revokePhase = undefined; await auth.revokeSession(session); revoked = true; }
    return client.run(binding, write);
  } };
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'original-transport', silent);
  const authorization = 'Bearer original-transport', actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const db = (store as unknown as { db: DatabaseSync }).db, key = `${runtime}:original`;
  if (runtime === 'hermes') store.hermesJournal.save({ key, stored: 'stored', title: 'Original', started: true, messages: [] });
  else if (runtime === 'claude-code' || runtime === 'ghcp') (runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal).create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const original = createConnectorOwnerCommands(store, tokens, undefined, undefined, undefined, false, undefined, transaction);
  let blockMutation: Promise<void> | undefined, mutations = 0, changed = 0;
  const entered = deferred();
  const command: typeof original = Object.assign(async (kind: Parameters<typeof original>[0], input: never) => {
    const mutation = ['sdkQueuedEdit', 'sdkQueuedCancel', 'hermesQueuedEdit', 'hermesQueuedCancel', 'nativeQueuedEdit', 'nativeQueuedCancel'].includes(kind);
    if (mutation) { mutations++; entered.resolve(); if (blockMutation) await blockMutation; }
    const value = await original(kind, input);
    if (mutation && revokeOnAck) { revokeOnAck = false; await auth.revokeSession(session); revoked = true; allowed = false; }
    return value;
  }, { dispose: original.dispose }) as typeof original;
  const sdk = new AsyncSdkQueue({ command });
  const hermes = new AsyncHermesQueue({ owner: { command }, diagnostics: silent, changed() { changed++; } });
  const native = new AsyncNativeQueue({ owner: { command }, diagnostics: silent, changed() { changed++; } });
  const validRequest = (request: Request) => allowed && (!withKey || request.headers.get('cookie') === `agentopsdeck_session=${session}`);
  const commands = createApplicationCommandScopes({ authorize: validRequest, assertAvailable() {}, diagnostics: silent });
  const app = new Hono(); let fallbacks = 0;
  const http = registerApplicationQueueHttp(app, { commands, credentials: { token: () => 'original-transport' },
    observeActor: request => validRequest(request) ? 'administrator' : undefined, available: () => true, transactions: true,
    native: { queue: native, ready: () => true }, sdk: { queue: sdk, ready: () => true }, hermes: { queue: hermes, ready: () => true }, timeoutMs, diagnostics: silent });
  app.all('*', c => { fallbacks++; return c.json({ fallback: true }); });
  const enqueue = (id = 'message', attachments = runtime === 'claude-code' || runtime === 'ghcp') => {
    store.turns.enqueue(runtime, { id, sessionKey: key, createdAt: 0, payload: { actorId: actor, ...(runtime === 'openclaw' ? { message: 'Original', media: [], deliveryMode: 'normal' } : { text: 'Original', images: [] }), marker: 'retained',
      ...(attachments ? { attachmentCount: 1 } : {}) } }, attachments ? () => {
      store.sdkAttachments.save(key, id, [{ id: 'resource', name: 'private.txt', mimeType: 'text/plain', data: Buffer.from('private').toString('base64') }]);
    } : undefined);
    return store.turns.version(runtime, key, id)!;
  };
  const receipt = (mutationKey: string, id = 'message') => store.commands.get(JSON.stringify(['queue-mutation-v1', actor, key, id]), mutationKey);
  const request = (suffix: string, method = 'GET', message?: string, headers: Record<string, string> = {}) => app.request(
    `http://application.invalid/api/sessions/${encodeURIComponent(key)}${suffix}`, { method,
      headers: { cookie: `agentopsdeck_session=${session}`, ...headers }, ...(message !== undefined ? { body: JSON.stringify({ message }) } : {}) });
  t.after(async () => {
    await http.close(); await commands.close(); await hermes.close(); await native.close(); original.dispose(); store.close();
    link.connector.data.close(); link.connector.confirmExit(); await auth.closeForShutdown(); link.closeUnused(); rmSync(root, { recursive: true, force: true });
  });
  await auth.open(); if (withKey) await auth.issueSession(session);
  return { auth, store, db, runtime, key, actor, command, enqueue, receipt, request, http, commands, entered: entered.promise,
    mutations: () => mutations, changed: () => changed, fallbacks: () => fallbacks,
    revokeAt: (phase: typeof revokePhase) => { revokePhase = phase; }, revoked: () => revoked,
    ackRevoke: () => { revokeOnAck = true; }, block: (wait: Promise<void>) => { blockMutation = wait; } };
}

for (const runtime of runtimes) for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false]) {
  test(`${runtime}/${role}/${mode}/${withKey ? 'Key' : 'no Key'}: original queue HTTP transaction, CAS, attachments and immutable recovery`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, runtime, role, mode, withKey), version = f.enqueue();
    f.store.commands.claim(JSON.stringify([f.actor, f.key]), 'send', {});
    f.store.commands.settle(JSON.stringify([f.actor, f.key]), 'send', { status: 200, body: { idempotencyKey: 'message' } });
    assert.equal((await f.request('/queue')).status, 200);
    const page = await (await f.request('/queue/commands')).json(); assert.equal(page.items[0].commandKey, 'send');
    const headers = { 'if-match': `"${version}"`, 'idempotency-key': 'edit' };
    const response = await f.request('/commands/send/queue', 'PATCH', ' Updated ', headers); assert.equal(response.status, 200);
    const accepted = await response.json(); assert.equal(accepted.command.state, 'accepted');
    const row = f.store.turns.head<{ actorId: string; text?: string; message?: string; marker: string }>(runtime, f.key)!;
    assert.equal(runtime === 'openclaw' ? row.payload.message : row.payload.text, 'Updated'); assert.equal(row.payload.actorId, f.actor); assert.equal(row.payload.marker, 'retained');
    if (runtime === 'claude-code' || runtime === 'ghcp') assert.equal(f.store.sdkAttachments.media(f.key, 'message').length, 1);
    assert.deepEqual(await (await f.request('/queue/message', 'PATCH', 'Updated', headers)).json(), accepted);
    assert.equal((await f.request('/queue/message', 'PATCH', 'different', headers)).status, 409);
    const current = f.store.turns.version(runtime, f.key, 'message')!;
    assert.equal((await f.request('/queue/message', 'DELETE', undefined, { 'if-match': `"${current}"`, 'idempotency-key': 'cancel' })).status, 200);
    assert.equal(f.store.turns.head(runtime, f.key), undefined);
    if (runtime === 'claude-code' || runtime === 'ghcp') assert.equal(f.store.sdkAttachments.media(f.key, 'message').length, 0);
    const count = f.mutations();
    for (const suffix of ['/queue/message/commands/edit', '/commands/send/queue/commands/edit']) {
      const recovered = await f.request(suffix); assert.equal(recovered.status, 200);
      // The write wire deliberately omits result; read recovery returns the
      // complete original immutable receipt, including its stored outcome.
      assert.deepEqual((await recovered.json()).command, f.receipt('edit'));
    }
    assert.equal(f.mutations(), count); assert.equal(f.fallbacks(), 0);
  });
}
for (const runtime of runtimes) {
  for (const phase of ['control-claim', 'control-ready'] as const) test(`${runtime}: actual Auth revocation at ${phase} cannot change queued work`, async t => {
    const f = await fixture(t, runtime), version = f.enqueue(); f.revokeAt(phase);
    const response = await f.request('/queue/message', 'PATCH', 'Updated', { 'if-match': `"${version}"`, 'idempotency-key': 'edit' });
    assert.equal(response.status, 503); assert.equal(f.revoked(), true);
    assert.equal(f.store.turns.head<{ text: string; message: string }>(runtime, f.key)!.payload[runtime === 'openclaw' ? 'message' : 'text'], 'Original');
    assert.equal(f.store.turns.version(runtime, f.key, 'message'), version);
    assert.equal(f.receipt('edit')?.state, phase === 'control-ready' ? 'outcome_unknown' : undefined);
    assert.equal(f.changed(), 0);
  });
  test(`${runtime}: ACK remains authoritative after logout while delivery is denied`, async t => {
    const f = await fixture(t, runtime), version = f.enqueue(); f.ackRevoke();
    const response = await f.request('/queue/message', 'DELETE', undefined, { 'if-match': `"${version}"`, 'idempotency-key': 'cancel' });
    assert.notEqual(response.status, 200); assert.equal(f.receipt('cancel')?.state, 'accepted');
    assert.equal(f.store.turns.head(runtime, f.key), undefined);
  });
  test(`${runtime}: SQL settlement failure rolls queue/attachments/event back and leaves original unknown receipt`, async t => {
    const f = await fixture(t, runtime), version = f.enqueue();
    f.db.exec("CREATE TRIGGER isolated_queue_failure BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT, 'isolated queue failure'); END");
    const response = await f.request('/queue/message', 'DELETE', undefined, { 'if-match': `"${version}"`, 'idempotency-key': 'cancel' });
    assert.equal(response.status, 503); assert.equal(f.receipt('cancel')?.state, 'outcome_unknown');
    assert.equal(f.store.turns.version(runtime, f.key, 'message'), version);
    assert.equal(f.store.turns.head<{ text: string; message: string }>(runtime, f.key)!.payload[runtime === 'openclaw' ? 'message' : 'text'], 'Original');
    if (runtime === 'claude-code' || runtime === 'ghcp') assert.equal(f.store.sdkAttachments.media(f.key, 'message').length, 1);
    const count = f.mutations(); assert.equal((await f.request('/queue/message/commands/cancel')).status, 200); assert.equal(f.mutations(), count);
  });
  test(`${runtime}: HTTP timeout and close retain physical SQL and do not replay`, async t => {
    const f = await fixture(t, runtime, 'hub', 'sqlite', true, 100), version = f.enqueue(), block = deferred();
    f.block(block.promise);
    const clock = controlledHttpDeadline(t);
    try {
      const sending = f.request('/queue/message', 'DELETE', undefined, { 'if-match': `"${version}"`, 'idempotency-key': 'cancel' });
      await awaitHttpAdmission(f.entered, sending); const response = await clock.expire(100, sending); assert.equal(response.status, 503);
      let drained = false; const closing = Promise.all([f.http.close(), f.commands.close()]).then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(f.commands.pending, 1);
      block.resolve(); await closing; assert.equal(f.receipt('cancel')?.state, 'accepted'); assert.equal(f.mutations(), 1);
    } finally { clock.restore(); block.resolve(); }
  });
}
test('local queue authority cannot be forged with Connector headers and reads retain strict schemas', async t => {
  const f = await fixture(t, 'claude-code'); f.enqueue();
  assert.equal((await f.request('/queue', 'GET', undefined, { cookie: '' })).status, 403);
  assert.equal((await f.request('/queue', 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'forged' })).status, 403);
  assert.equal((await f.request('/queue', 'GET', undefined, { 'x-agentopsdeck-expected-node-id': 'forged' })).status, 403);
  await assert.rejects(f.command('sdkQueuePage', { runtime: 'claude-code', key: f.key, authorization: 'Bearer original-transport', after: 0, application: {} } as never));
  await assert.rejects(f.command('sdkQueueReceiptRead', { runtime: 'claude-code', key: f.key, authorization: 'Bearer original-transport',
    target: { messageId: 'message' }, mutationKey: 'edit', application: {} } as never));
  assert.equal(f.mutations(), 0);
});
