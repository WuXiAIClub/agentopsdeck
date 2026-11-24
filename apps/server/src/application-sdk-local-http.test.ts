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
import { AsyncSdkLocal } from './connector/async-sdk-local.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { registerApplicationSdkLocalHttp } from './application-sdk-local-http.js';

const runtimes = ['claude-code', 'ghcp'] as const;
type Runtime = typeof runtimes[number];
const silent = new PerformanceDiagnostics(() => {}), session = 's'.repeat(43);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(t: TestContext, runtime: Runtime, role: 'hub' | 'standalone' = 'hub',
  mode: 'json' | 'sqlite' = 'sqlite', withKey = true, timeoutMs = 15_000) {
  const root = mkdtempSync(join(tmpdir(), 'application-sdk-local-')), link = createApplicationTransactionLink();
  const auth = originalApplicationAuthFixture(root, role, mode, withKey ? 'original-application-key' : undefined, silent, link.auth);
  link.connector.begin(); link.connector.data.ref();
  const client = createApplicationTransactionClient(link.connector.data);
  let revokePhase: 'control-claim' | 'control-ready' | undefined, revoked = false, allowed = true, revokeOnAck = false;
  const bindings: { phase: string; resource: string; payloadDigest: string }[] = [];
  const transaction: ApplicationTransactionClient = { async run(binding, write) {
    bindings.push({ phase: binding.phase, resource: binding.resource, payloadDigest: binding.payloadDigest });
    if (binding.phase === revokePhase) { revokePhase = undefined; await auth.revokeSession(session); revoked = true; }
    return client.run(binding, write);
  } };
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'original-transport', silent);
  const actor = tokens.authenticateAuthorization('Bearer original-transport')!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const db = (store as unknown as { db: DatabaseSync }).db, key = `${runtime}:original`;
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const catalogs = { 'claude-code': { model: 'default', modelChoices: ['default', 'alternate'] }, ghcp: { model: 'default', modelChoices: ['default', 'alternate'] } };
  const original = createConnectorOwnerCommands(store, tokens, catalogs, undefined, undefined, false, undefined, transaction);
  let blockMutation: Promise<void> | undefined, mutations = 0, publications = 0;
  const entered = deferred();
  const command: typeof original = Object.assign(async (kind: Parameters<typeof original>[0], input: never) => {
    const mutation = kind === 'sdkSessionCreate' || kind === 'sdkModelUpdate';
    if (mutation) { mutations++; entered.resolve(); if (blockMutation) await blockMutation; }
    const value = await original(kind, input);
    if (mutation && revokeOnAck) { revokeOnAck = false; await auth.revokeSession(session); revoked = true; allowed = false; }
    return value;
  }, { dispose: original.dispose }) as typeof original;
  const local = new AsyncSdkLocal({ command }, () => { publications++; });
  const validRequest = (request: Request) => allowed && (!withKey || request.headers.get('cookie') === `agentopsdeck_session=${session}`);
  const commands = createApplicationCommandScopes({ authorize: validRequest, assertAvailable() {}, diagnostics: silent });
  const app = new Hono(); let fallbacks = 0, fallbackBody: unknown;
  const http = registerApplicationSdkLocalHttp(app, { commands, credentials: { token: () => 'original-transport' },
    observeActor: request => validRequest(request) ? 'administrator' : undefined, available: () => true, transactions: true,
    sdk: { local, physical: local, ready: () => true }, timeoutMs, diagnostics: silent });
  app.all('*', async c => { fallbacks++; if (c.req.method === 'PATCH') fallbackBody = await c.req.json(); return c.json({ fallback: true }); });
  const path = (operation: 'create' | 'settings') => operation === 'create' ? `/api/agents/${runtime}/sessions` : `/api/sessions/${key}`;
  const request = (operation: 'create' | 'settings', body: unknown = undefined, commandKey = 'original', extra: Record<string, string> = {}) =>
    app.request(path(operation) + (body === undefined ? `/${operation === 'create' ? 'creation' : 'settings'}-commands/${commandKey}` : ''), {
      method: body === undefined ? 'GET' : operation === 'create' ? 'POST' : 'PATCH',
      headers: { cookie: `agentopsdeck_session=${session}`, 'content-type': 'application/json', 'idempotency-key': commandKey, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const receipt = (operation: 'create' | 'settings', commandKey = 'original') => store.commands.get(
    JSON.stringify([operation, JSON.stringify([actor, operation === 'create' ? runtime : key])]), commandKey);
  t.after(async () => {
    await Promise.all([http.close(), commands.close()]); command.dispose(); store.close();
    link.connector.data.close(); link.connector.confirmExit(); await auth.closeForShutdown(); link.closeUnused(); rmSync(root, { recursive: true, force: true });
  });
  await auth.open(); if (withKey) await auth.issueSession(session);
  return { store, db, key, journal, command, request, receipt, http, commands, bindings, entered: entered.promise,
    mutations: () => mutations, publications: () => publications, fallbacks: () => fallbacks, fallbackBody: () => fallbackBody,
    revokeAt: (phase: typeof revokePhase) => { revokePhase = phase; }, revoked: () => revoked,
    ackRevoke: () => { revokeOnAck = true; }, block: (wait: Promise<void>) => { blockMutation = wait; } };
}

for (const runtime of runtimes) for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false]) {
  test(`${runtime}/${role}/${mode}/${withKey ? 'Key' : 'no Key'}: original local creation/settings SQL and immutable recovery`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, runtime, role, mode, withKey);
    for (const operation of ['create', 'settings'] as const) {
      const body = operation === 'create' ? { title: ' Created ', metadata: 'original' } : { model: ' alternate ', thinking: null };
      const response = await f.request(operation, body); assert.equal(response.status, operation === 'create' ? 201 : 200);
      const wire = await response.json(); assert.equal(wire.command.state, 'accepted');
      assert.equal(f.receipt(operation)?.state, 'accepted');
      assert.deepEqual(await (await f.request(operation, body)).json(), wire);
      assert.equal((await f.request(operation, { ...body, extra: 'different' })).status, 409);
      const before = f.mutations(), recovered = await f.request(operation); assert.equal(recovered.status, 200);
      assert.deepEqual((await recovered.json()).command, f.receipt(operation)); assert.equal(f.mutations(), before);
    }
    assert.equal(f.journal.sessionKeys(undefined, 64).length, 2);
    assert.ok(f.bindings.some(b => b.resource === `${runtime}:create` && b.phase === 'control-ready'));
    assert.ok(f.bindings.some(b => b.resource === f.key && b.phase === 'control-ready'));
    assert.equal(f.fallbacks(), 0);
  });
}
for (const runtime of runtimes) for (const operation of ['create', 'settings'] as const) {
  const body = operation === 'create' ? { title: 'Created' } : { model: 'alternate' };
  for (const phase of ['control-claim', 'control-ready'] as const) test(`${runtime}/${operation}: actual Auth revocation at ${phase} cannot mutate original journal`, async t => {
    const f = await fixture(t, runtime); f.revokeAt(phase);
    assert.equal((await f.request(operation, body)).status, 503); assert.equal(f.revoked(), true);
    assert.equal(f.receipt(operation)?.state, phase === 'control-ready' ? 'outcome_unknown' : undefined);
    assert.equal(f.journal.sessionKeys(undefined, 64).length, 1); assert.equal(f.publications(), 0);
  });
  test(`${runtime}/${operation}: original receipt settlement failure rolls back SQL and never replays unknown`, async t => {
    const f = await fixture(t, runtime);
    const before = JSON.stringify(f.db.prepare('SELECT * FROM sdk_agent_sessions').all());
    f.db.exec("CREATE TRIGGER isolated_local_failure BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT,'isolated local failure'); END");
    assert.equal((await f.request(operation, body)).status, 503);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sdk_agent_sessions').all()), before);
    assert.equal(f.receipt(operation)?.state, 'outcome_unknown');
    f.db.exec('DROP TRIGGER isolated_local_failure');
    const count = f.mutations(); assert.equal((await f.request(operation)).status, 200); assert.equal(f.mutations(), count);
    assert.equal((await f.request(operation, body)).status, 202);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM sdk_agent_sessions').all()), before);
  });
  test(`${runtime}/${operation}: committed ACK survives logout while delivery is denied`, async t => {
    const f = await fixture(t, runtime); f.ackRevoke();
    assert.notEqual((await f.request(operation, body)).status, 200); assert.equal(f.receipt(operation)?.state, 'accepted');
    assert.equal(f.journal.sessionKeys(undefined, 64).length, operation === 'create' ? 2 : 1);
  });
  test(`${runtime}/${operation}: deadline and close retain physical SQL without replay`, async t => {
    const f = await fixture(t, runtime, 'hub', 'sqlite', true, 100), block = deferred(); f.block(block.promise);
    const clock = controlledHttpDeadline(t);
    try {
      const sending = f.request(operation, body); await awaitHttpAdmission(f.entered, sending);
      assert.equal((await clock.expire(100, sending)).status, 503);
      let drained = false; const closing = Promise.all([f.http.close(), f.commands.close()]).then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(f.commands.pending, 1);
      block.resolve(); await closing; assert.equal(f.receipt(operation)?.state, 'accepted'); assert.equal(f.mutations(), 1);
    } finally { clock.restore(); block.resolve(); }
  });
}
test('local SDK title-only PATCH preserves original body and lane; Connector authority cannot impersonate application credentials', async t => {
  const f = await fixture(t, 'ghcp');
  assert.equal((await f.request('settings', { title: ' Rename ', metadata: 'preserved' })).status, 200);
  assert.deepEqual(f.fallbackBody(), { title: ' Rename ', metadata: 'preserved' }); assert.equal(f.mutations(), 0);
  for (const extra of [{ cookie: '' }, { 'x-agentopsdeck-execution-grant': 'forged' }, { 'x-agentopsdeck-expected-node-id': 'forged' }])
    assert.equal((await f.request('create', { title: 'Created' }, 'forged', extra)).status, 403);
  await assert.rejects(f.command('sdkLocalReceiptRead', { runtime: 'ghcp', operation: 'create', authorization: 'Bearer original-transport',
    commandKey: 'original', application: {} } as never));
  assert.equal(f.mutations(), 0);
});
