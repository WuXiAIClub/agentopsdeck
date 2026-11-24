import assert from 'node:assert/strict';
import { awaitHttpAdmission, controlledHttpDeadline } from './lifecycle/http-deadline-test-support.js';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { createConnectorOwnerCommands, validConnectorOwnerInput } from './connector/connector-owner-domain.js';
import { AsyncCodexCreation } from './connector/async-codex-creation.js';
import { AsyncHermesCreation } from './connector/async-hermes-creation.js';
import { registerApplicationNativeCreationHttp } from './application-native-creation-http.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';

const silent = new PerformanceDiagnostics(() => {}), session = 's'.repeat(43);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(t: TestContext, runtime: 'codex' | 'hermes', role: 'hub' | 'standalone' = 'hub',
  mode: 'json' | 'sqlite' = 'sqlite', withKey = true, timeoutMs = 15_000) {
  const root = mkdtempSync(join(tmpdir(), 'application-native-create-')), link = createApplicationTransactionLink();
  const auth = originalApplicationAuthFixture(root, role, mode, withKey ? 'original-key' : undefined, silent, link.auth);
  link.connector.begin(); link.connector.data.ref();
  const client = createApplicationTransactionClient(link.connector.data);
  let allowed = true, phase: 'control-claim' | 'control-ready' | undefined, readyCount = 0, revokeReady = 0;
  let afterIdentify: (() => Promise<void>) | undefined, afterReady: (() => Promise<void>) | undefined;
  let block: Promise<void> | undefined, failNative = false, effects = 0, names = 0, projections = 0, fallbacks = 0;
  const bindings: { phase: string; resource: string; payloadDigest: string }[] = [], entered = deferred();
  const revoke = async () => { await auth.revokeSession(session); allowed = false; };
  const transaction: ApplicationTransactionClient = { async run(binding, write) {
    bindings.push({ phase: binding.phase, resource: binding.resource, payloadDigest: binding.payloadDigest });
    if (binding.phase === 'control-ready') readyCount++;
    if (binding.phase === phase || binding.phase === 'control-ready' && readyCount === revokeReady) {
      phase = undefined; await auth.revokeSession(session);
    }
    return client.run(binding, write);
  } };
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'original-transport', silent);
  const actor = tokens.authenticateAuthorization('Bearer original-transport')!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const command = createConnectorOwnerCommands(store, tokens, undefined, undefined, undefined, false, undefined, transaction);
  const thread = randomUUID();
  const codex = new AsyncCodexCreation({ owner: { command }, deadlineMs: 15_000, diagnostics: silent,
    native: { available: () => true, async createSessionOwned(_intent, port) {
      await port.ready(); effects++; entered.resolve(); if (block) await block;
      if (failNative) throw Error('isolated unknown native outcome');
      await port.identify(thread); await afterIdentify?.(); await port.nameReady(); names++;
      await afterReady?.(); await port.accept(); port.local(); projections++;
      return { key: `codex:${thread}` };
    } } });
  const hermes = new AsyncHermesCreation({ owner: { command }, deadlineMs: 15_000, workspace: root, diagnostics: silent,
    native: { available: () => true, epoch: () => 'original-epoch', async create() {
      effects++; entered.resolve(); if (block) await block; if (failNative) throw Error('isolated unknown native outcome');
      await afterReady?.(); return { session_id: 'original-live', stored_session_id: 'original-stored' };
    } }, created: () => { projections++; } });
  const validRequest = (request: Request) => allowed && (!withKey || request.headers.get('cookie') === `agentopsdeck_session=${session}`);
  const commands = createApplicationCommandScopes({ authorize: validRequest, assertAvailable() {}, diagnostics: silent });
  const creation = runtime === 'codex' ? codex : hermes, app = new Hono();
  const http = registerApplicationNativeCreationHttp(app, { commands, credentials: { token: () => 'original-transport' },
    observeActor: request => validRequest(request) ? 'administrator' : undefined,
    available: () => true, transactions: true, diagnostics: silent, timeoutMs,
    [runtime]: { creation, physical: creation, ready: () => true } });
  app.all('*', c => { fallbacks++; return c.json({ fallback: true }); });
  const request = (body: unknown = undefined, key = 'original', extra: Record<string, string> = {}) => app.request(
    `/api/agents/${runtime}/sessions` + (body === undefined ? `/creation-commands/${key}` : ''), {
      method: body === undefined ? 'GET' : 'POST', headers: { cookie: `agentopsdeck_session=${session}`,
        'content-type': 'application/json', 'idempotency-key': key, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const receipt = () => store.commands.get(JSON.stringify(['create', JSON.stringify([actor, runtime])]), 'original');
  t.after(async () => {
    await Promise.all([http.close(), commands.close(), codex.close(), hermes.close()]); command.dispose(); store.close();
    link.connector.data.close(); link.connector.confirmExit(); await auth.closeForShutdown(); link.closeUnused();
    rmSync(root, { recursive: true, force: true });
  });
  await auth.open(); if (withKey) await auth.issueSession(session);
  return { store, db, request, receipt, http, commands, bindings, thread, entered: entered.promise,
    effects: () => effects, names: () => names, projections: () => projections, fallbacks: () => fallbacks,
    revokeAt: (value: typeof phase) => { phase = value; }, revokeNaming: () => { revokeReady = 2; },
    revokeAfterIdentify: () => { afterIdentify = revoke; }, revokeAfterReady: () => { afterReady = revoke; },
    fail: () => { failNative = true; }, block: (value: Promise<void>) => { block = value; } };
}

for (const runtime of ['codex', 'hermes'] as const) {
  for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false]) {
    test(`${runtime}/${role}/${mode}/${withKey ? 'Key' : 'no Key'}: original native creation, replay and read-only recovery`, { timeout: 30_000 }, async t => {
      const f = await fixture(t, runtime, role, mode, withKey), body = { title: 'Original title' };
      const response = await f.request(body); assert.equal(response.status, 201);
      const wire = await response.json(); assert.equal(wire.command.state, 'accepted');
      assert.deepEqual(await (await f.request(body)).json(), wire); assert.equal(f.effects(), 1);
      const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      assert.ok(f.bindings.some(b => b.phase === 'control-claim'));
      assert.ok(f.bindings.some(b => b.phase === 'control-ready'));
      assert.ok(f.bindings.every(b => b.resource === `${runtime}:create` && b.payloadDigest === digest));
      const beforeConflict = f.bindings.length;
      assert.equal((await f.request({ title: 'Different title' })).status, 409);
      const conflictDigest = createHash('sha256').update(JSON.stringify({ title: 'Different title' })).digest('hex');
      assert.ok(f.bindings.length > beforeConflict);
      assert.ok(f.bindings.slice(beforeConflict).every(b => b.phase === 'control-claim'
        && b.resource === `${runtime}:create` && b.payloadDigest === conflictDigest));
      assert.deepEqual((await (await f.request()).json()).command, f.receipt());
      assert.equal(f.effects(), 1); assert.equal(f.projections(), 1); assert.equal(f.fallbacks(), 0);
    });
  }
  for (const phase of ['control-claim', 'control-ready'] as const) test(`${runtime}: actual original Auth revocation at ${phase} vetoes native`, async t => {
    const f = await fixture(t, runtime); f.revokeAt(phase);
    assert.equal((await f.request({ title: 'Original' })).status, phase === 'control-ready' ? 202 : 503); assert.equal(f.effects(), 0);
    assert.equal(f.receipt()?.state, phase === 'control-ready' ? 'outcome_unknown' : undefined);
    assert.equal(f.projections(), 0);
  });
  test(`${runtime}: late native ACK survives actual logout without projection or duplicate native`, async t => {
    const f = await fixture(t, runtime); f.revokeAfterReady();
    const response = await f.request({ title: 'Original' }); assert.ok(response.status >= 400);
    assert.equal(f.receipt()?.state, 'accepted'); assert.equal(f.effects(), 1); assert.equal(f.projections(), 0);
    assert.ok((await f.request()).status >= 400); assert.equal(f.effects(), 1);
  });
  test(`${runtime}: unknown native outcome is immutable; recovery never recreates`, async t => {
    const f = await fixture(t, runtime); f.fail();
    assert.equal((await f.request({ title: 'Original' })).status, 202);
    assert.equal(f.receipt()?.state, 'outcome_unknown');
    assert.equal((await f.request({ title: 'Original' })).status, 202);
    assert.equal((await f.request()).status, 200); assert.equal(f.effects(), 1); assert.equal(f.projections(), 0);
  });
  test(`${runtime}: settlement SQL rollback cannot replay the original native effect`, async t => {
    const f = await fixture(t, runtime);
    f.db.exec("CREATE TRIGGER native_settle_failure BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT,'isolated settlement failure'); END");
    assert.equal((await f.request({ title: 'Original' })).status, 202);
    assert.equal(f.receipt()?.state, 'outcome_unknown'); f.db.exec('DROP TRIGGER native_settle_failure');
    assert.equal((await f.request()).status, 200);
    assert.equal((await f.request({ title: 'Original' })).status, 202); assert.equal(f.effects(), 1); assert.equal(f.projections(), 0);
  });
  test(`${runtime}: waiter deadline and close retain original physical work until native resolves`, async t => {
    const f = await fixture(t, runtime, 'hub', 'sqlite', true, 100), block = deferred(); f.block(block.promise);
    const clock = controlledHttpDeadline(t);
    try {
      const sending = f.request({ title: 'Original' }); await awaitHttpAdmission(f.entered, sending);
      assert.equal((await clock.expire(100, sending)).status, 503);
      let drained = false; const closing = Promise.all([f.http.close(), f.commands.close()]).then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(f.commands.pending, 1);
      block.resolve(); await closing;
      // Codex cannot name after close; Hermes has already received its complete native identity.
      assert.equal(f.receipt()?.state, runtime === 'hermes' ? 'accepted' : 'outcome_unknown');
      assert.equal(f.effects(), 1); assert.equal(f.projections(), 0);
    } finally { clock.restore(); block.resolve(); }
  });
  test(`${runtime}: local authority cannot be replaced by transport, grant or node headers`, async t => {
    const f = await fixture(t, runtime);
    for (const extra of [{ cookie: '' }, { 'x-agentopsdeck-execution-grant': 'forged' }, { 'x-agentopsdeck-expected-node-id': 'forged' }])
      assert.equal((await f.request({ title: 'Original' }, 'original', extra)).status, 403);
    assert.equal(f.effects(), 0); assert.equal(f.receipt(), undefined);
    assert.equal(validConnectorOwnerInput(`${runtime}CreationReceiptRead`, { authorization: 'Bearer original-transport', commandKey: 'original', application: {} }), false);
  });
}
test('Codex naming Ready rechecks original Auth and preserves the already identified original thread', async t => {
  const f = await fixture(t, 'codex'); f.revokeNaming();
  assert.equal((await f.request({ title: 'Original' })).status, 202);
  assert.equal(f.effects(), 1); assert.equal(f.names(), 0); assert.equal(f.receipt()?.state, 'outcome_unknown');
  assert.equal(f.store.codexCreations.get(f.receipt()!.id)?.thread, f.thread);
  // A fresh POST still rechecks current original Auth, even for a duplicate.
  assert.equal((await f.request({ title: 'Original' })).status, 503); assert.equal(f.effects(), 1);
});
test('Codex logout between identify and naming preserves ID and blocks the naming effect', async t => {
  const f = await fixture(t, 'codex'); f.revokeAfterIdentify();
  assert.ok((await f.request({ title: 'Original' })).status >= 400);
  assert.equal(f.effects(), 1); assert.equal(f.names(), 0); assert.equal(f.receipt()?.state, 'outcome_unknown');
  assert.equal(f.store.codexCreations.get(f.receipt()!.id)?.thread, f.thread);
});
