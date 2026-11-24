import assert from 'node:assert/strict';
import { awaitHttpAdmission, controlledHttpDeadline } from './lifecycle/http-deadline-test-support.js';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { originalApplicationAuthFixture } from './auth/application-transaction-test-fixture.js';
import { createApplicationTransactionClient, createApplicationTransactionLink, type ApplicationTransactionClient } from './auth/application-transaction-gate.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { ConnectorUserStore } from './connector/connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import type { AsyncConnectorOwner } from './connector/async-connector-owner.js';
import { AsyncCodexDeletion } from './connector/async-codex-deletion.js';
import { AsyncHermesDeletion } from './connector/async-hermes-deletion.js';
import { createAsyncClaudeOwnedRuntime } from './claude/async-owned-runtime.js';
import { createAsyncCopilotOwnedRuntime } from './copilot/async-owned-runtime.js';
import { DeckStore } from './projection/deck-store.js';
import { registerApplicationDeletionHttp } from './application-deletion-http.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';

const silent = new PerformanceDiagnostics(() => {}), session = 's'.repeat(43);
const runtimes = ['codex', 'hermes', 'claude-code', 'ghcp'] as const;
type Runtime = typeof runtimes[number];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes; }); return { promise, release }; }
async function fixture(t: TestContext, role: 'hub' | 'standalone' = 'hub', mode: 'json' | 'sqlite' = 'sqlite', withKey = true, timeoutMs = 15_000,
  beforeRuntimeCreate?: (runtime: 'claude-code' | 'ghcp', home: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'application-deletion-')), link = createApplicationTransactionLink();
  // Register before any asynchronous initialization: a rejected private HOME
  // must not leave the original auth worker/transaction ports alive.
  const cleanup: (() => void | Promise<void>)[] = [() => link.closeUnused()];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Deletion fixture cleanup failed; private state retained');
    rmSync(root, { recursive: true, force: true });
  });
  const auth = originalApplicationAuthFixture(root, role, mode, withKey ? 'original-key' : undefined, silent, link.auth);
  cleanup.push(() => auth.closeForShutdown());
  link.connector.begin(); link.connector.data.ref();
  cleanup.push(() => { link.connector.data.close(); link.connector.confirmExit(); });
  const client = createApplicationTransactionClient(link.connector.data);
  let allowed = true, phase: 'control-claim' | 'control-ready' | undefined, readyNumber = 1, readySeen = 0, ackRevoke = false;
  let block: Promise<void> | undefined, effects = 0, published = 0, fallbacks = 0;
  const entered = gate(), bindings: { phase: string; resource: string; payloadDigest: string }[] = [];
  const transaction: ApplicationTransactionClient = { async run(binding, write) {
    bindings.push({ phase: binding.phase, resource: binding.resource, payloadDigest: binding.payloadDigest });
    if (binding.phase === phase && (phase !== 'control-ready' || ++readySeen === readyNumber)) {
      phase = undefined; await auth.revokeSession(session);
    }
    return client.run(binding, write);
  } };
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'original-transport', silent);
  const actor = tokens.authenticateAuthorization('Bearer original-transport')!.tokenId;
  const store = new ConnectorUserStore(join(root, 'connector.sqlite'), undefined, { runtimeOwner: true });
  cleanup.push(() => store.close());
  const db = (store as unknown as { db: DatabaseSync }).db;
  store.hermesJournal.save({ key: 'hermes:original', stored: 'stored', title: 'Original', started: true, messages: [] });
  for (const runtime of ['claude-code', 'ghcp'] as const) {
    const key = `${runtime}:original`, journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
    journal.create({ key, nativeSessionId: randomUUID(), title: 'Original', createdAt: 1 });
    await store.turns.enqueueAsync(runtime, { id: runtime, sessionKey: key, createdAt: 1, payload: { text: 'Original', actorId: 'fixture' } });
    const ref = { key, id: randomUUID(), epoch: randomUUID() };
    journal.begin(ref, [runtime], store.turns); journal.observeTerminal(ref, 'completed', store.turns); journal.confirmSettled(ref);
  }
  const original = createConnectorOwnerCommands(store, tokens, undefined, undefined, undefined, false, undefined, transaction);
  cleanup.push(() => original.dispose());
  const command: typeof original = Object.assign(async (kind: Parameters<typeof original>[0], input: never) => {
    const result = await original(kind, input);
    if (ackRevoke && (kind === 'codexDeletionAccept' || kind === 'hermesDeletionSettle' || kind === 'sdkDeletionSettle')
      && result && typeof result === 'object' && 'receipt' in result && result.receipt?.state === 'accepted') {
      ackRevoke = false; await auth.revokeSession(session); allowed = false;
    }
    return result;
  }, { dispose: original.dispose }) as typeof original;
  const owner: Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'> = { command, runtimeOwnerFile: store.runtimeOwnerFile! };
  const deck = new DeckStore();
  const effect = async () => { effects++; entered.release(); if (block) await block; };
  const codex = new AsyncCodexDeletion({ owner, writable: () => true, local() {}, diagnostics: silent,
    runtime: { async removeOwned(_key, local, begin, acknowledged) {
      await begin(); local(); await effect(); await acknowledged(); published++;
    } } });
  cleanup.push(() => codex.close());
  let live: string | undefined = 'live';
  const hermes = new AsyncHermesDeletion({ owner, diagnostics: silent, fence() {}, closed() { live = undefined; }, removed() { published++; },
    native: { available: () => true, epoch: () => 'epoch', live: () => live,
      async request(method) {
        if (method === 'session.activate') return { session_id: live, session_key: 'stored', status: 'idle', running: false };
        await effect(); return method === 'session.close' ? { closed: true } : { deleted: 'stored' };
      } } });
  cleanup.push(() => hermes.close());
  const sdk = new Map<string, Awaited<ReturnType<typeof createAsyncClaudeOwnedRuntime>> | Awaited<ReturnType<typeof createAsyncCopilotOwnedRuntime>>>();
  for (const runtime of ['claude-code', 'ghcp'] as const) {
    const homeDirectory = join(root, runtime); mkdirSync(homeDirectory, { mode: 0o700 });
    beforeRuntimeCreate?.(runtime, homeDirectory);
    const config = { homeDirectory, workspace: root, sdkDirectory: root, startupTimeoutMs: 1000, model: 'default',
      apiKeyFile: join(root, 'absent'), baseUrl: 'http://127.0.0.1:1', auth: { mode: 'github' as const, credentialFile: join(root, 'absent') } };
    const ports = { check: () => ({ ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close() {} }),
      start: () => assert.fail('Deletion cannot start inference'), deleteNative: () => {
        const work = effect(); return { ready: work.then(() => true), finished: work, inspectQuiescence: () => true, close() {} };
      } };
    const options = { owner, config, projection: deck, diagnostics: silent, changed() { published++; } };
    const value = runtime === 'ghcp' ? await createAsyncCopilotOwnedRuntime(options, ports) : await createAsyncClaudeOwnedRuntime(options, ports);
    cleanup.push(() => value.close());
    assert.equal(await value.initialize(), true); sdk.set(runtime, value);
  }
  const valid = (request: Request) => allowed && (!withKey || request.headers.get('cookie') === `agentopsdeck_session=${session}`);
  const commands = createApplicationCommandScopes({ authorize: valid, assertAvailable() {}, diagnostics: silent });
  cleanup.push(() => commands.close());
  const app = new Hono();
  const http = registerApplicationDeletionHttp(app, { commands, credentials: { token: () => 'original-transport' },
    observeActor: request => valid(request) ? 'administrator' : undefined, available: () => true, transactions: true,
    codex: { deletion: codex, ready: () => true }, hermes: { lifecycle: hermes, ready: () => true },
    sdk: { owner, ready: runtime => sdk.get(runtime)?.ready === true,
      remove: (runtime, key, commandKey, authorization, signal) => sdk.get(runtime)!.remove(key, commandKey, authorization, signal),
      removePhysical: (input, authority) => sdk.get(input.runtime)!.remove(input.key, input.commandKey, input.authorization, undefined, input.application, authority) },
    timeoutMs, diagnostics: silent });
  cleanup.push(() => http.close());
  app.all('*', c => { fallbacks++; return c.json({ fallback: true }, 418); });
  const request = (runtime: Runtime, read = false, commandKey = 'original', extra: Record<string, string> = {}) => app.request(
    `/api/sessions/${runtime}:original` + (read ? `/deletion-commands/${commandKey}` : ''), {
      method: read ? 'GET' : 'DELETE', headers: { cookie: `agentopsdeck_session=${session}`, 'idempotency-key': commandKey, ...extra },
    });
  const receipt = (runtime: Runtime) => store.commands.get(JSON.stringify(['delete', JSON.stringify([actor, `${runtime}:original`])]), 'original');
  await auth.open(); if (withKey) await auth.issueSession(session);
  return { request, receipt, bindings, deck, db, command, http, commands, entered: entered.promise,
    effects: () => effects, published: () => published, fallbacks: () => fallbacks,
    revokeAt(value: typeof phase, nth = 1) { phase = value; readyNumber = nth; readySeen = 0; },
    revokeOnAck() { ackRevoke = true; }, block(value: Promise<void>) { block = value; } };
}

test('partial deletion fixture initialization rejects an insecure HOME and drains earlier resources', { skip: process.platform !== 'linux' }, async t => {
  let root: string | undefined;
  await t.test('second runtime rejection preserves the ownership guard', async child => {
    await assert.rejects(fixture(child, 'hub', 'sqlite', true, 15_000, (runtime, home) => {
      root = dirname(home);
      if (runtime === 'ghcp') {
        assert.ok(existsSync(join(root, 'claude-code', '.agentopsdeck-claude-owner')));
        chmodSync(home, 0o755);
      }
    }), /Private Agent home ownership is unconfirmed/);
  });
  assert.ok(root);
  assert.equal(existsSync(root), false, 'Failed initialization must close the first runtime, original auth and transaction ports before removing its private fixture');
});

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false])
  test(`${role}/${mode}/${withKey ? 'Key' : 'no-Key'} deletion uses original identity and physical runtimes`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, role, mode, withKey), digest = createHash('sha256').update('{}').digest('hex');
    for (const runtime of runtimes) {
      assert.equal((await f.request(runtime, true)).status, 404);
      const response = await f.request(runtime); assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      assert.equal((await response.json()).status, 'delete_accepted'); assert.equal(f.receipt(runtime)?.state, 'accepted');
      const effects = f.effects(), before = f.bindings.length;
      assert.equal((await f.request(runtime)).status, 200); assert.equal((await f.request(runtime, true)).status, 200);
      assert.equal(f.effects(), effects); assert.equal(f.bindings.length, before, 'Reads and duplicates cannot get another execution permit');
      assert.ok(f.bindings.some(binding => binding.resource === `${runtime}:original` && binding.phase === 'control-ready'));
    }
    assert.equal(f.effects(), 5); assert.equal(f.fallbacks(), 0); assert.ok(f.bindings.every(binding => binding.payloadDigest === digest));
  });

for (const runtime of runtimes) for (const phase of ['control-claim', 'control-ready'] as const)
  test(`${runtime}: ${phase} rechecks original Auth and forbids effects`, async t => {
    const f = await fixture(t); f.revokeAt(phase);
    assert.notEqual((await f.request(runtime)).status, 200); assert.equal(f.effects(), 0);
    if (phase === 'control-claim') assert.equal(f.receipt(runtime), undefined);
    const before = f.effects(); await f.request(runtime); assert.equal(f.effects(), before);
  });
for (const runtime of runtimes) test(`${runtime}: logout on original ACK preserves acceptance without publication`, async t => {
  const f = await fixture(t); f.revokeOnAck(); const before = f.published();
  assert.equal((await f.request(runtime)).status, 403); assert.equal(f.receipt(runtime)?.state, 'accepted');
  assert.equal(f.published(), before); assert.equal((await f.request(runtime, true)).status, 403);
});
test('Hermes rechecks original Auth before the second irreversible native stage', async t => {
  const f = await fixture(t); f.revokeAt('control-ready', 2);
  assert.notEqual((await f.request('hermes')).status, 200); assert.equal(f.effects(), 1);
  assert.equal(f.receipt('hermes')?.state, 'outcome_unknown');
  assert.equal((await f.request('hermes')).status, 202); assert.equal(f.effects(), 1);
});
for (const runtime of runtimes) test(`${runtime}: SQL settlement failure retains unknown and never replays`, async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER deletion_settle_failure BEFORE UPDATE ON command_receipts WHEN NEW.state != 'outcome_unknown' BEGIN SELECT RAISE(ABORT,'isolated settlement failure'); END");
  assert.notEqual((await f.request(runtime)).status, 200); assert.equal(f.receipt(runtime)?.state, 'outcome_unknown');
  const before = f.effects(); assert.ok(before > 0);
  f.db.exec('DROP TRIGGER deletion_settle_failure');
  assert.equal((await f.request(runtime)).status, 202); assert.equal((await f.request(runtime, true)).status, 200); assert.equal(f.effects(), before);
});
test('deletion HTTP deadline and close retain original physical ACK and scope', async t => {
  const f = await fixture(t, 'standalone', 'sqlite', true, 1000), block = gate(); f.block(block.promise);
  const clock = controlledHttpDeadline(t);
  try {
    const sending = Promise.resolve(f.request('codex'));
    await awaitHttpAdmission(f.entered, sending);
    assert.equal((await clock.expire(1000, sending)).status, 503); assert.equal(f.receipt('codex')?.state, 'outcome_unknown');
    let drained = false; const closing = Promise.all([f.http.close(), f.commands.close()]).then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(f.commands.pending, 1);
    block.release(); await closing; assert.equal(f.receipt('codex')?.state, 'accepted'); assert.equal(f.effects(), 1);
  } finally { clock.restore(); block.release(); }
});
test('deletion rejects forged application authority and keeps bounded evidence on claims only', async t => {
  const f = await fixture(t);
  for (const headers of [{ cookie: '' }, { 'x-agentopsdeck-execution-grant': 'forged' }, { 'x-agentopsdeck-expected-node-id': 'forged' }])
    assert.equal((await f.request('codex', false, 'original', headers)).status, 403);
  assert.equal(f.effects(), 0);
  for (const runtime of runtimes) {
    const kind = runtime === 'codex' ? 'codexDeletionClaim' : runtime === 'hermes' ? 'hermesDeletionClaim' : 'sdkDeletionClaim';
    const input = { authorization: 'Bearer original-transport', key: `${runtime}:original`, commandKey: 'bounded',
      ...(runtime === 'claude-code' || runtime === 'ghcp' ? { runtime } : {}), application: { cookie: 'c'.repeat(65_536) } };
    assert.equal(validConnectorOwnerInput(kind, input), true);
    assert.doesNotThrow(() => encodeConnectorOwnerJson(input, connectorOwnerCommandBytes(kind)));
    assert.equal(validConnectorOwnerInput(kind, { ...input, application: { actorId: 'forged' } }), false);
    const read = runtime === 'codex' ? 'codexDeletionReceipt' : runtime === 'hermes' ? 'hermesDeletionReceiptRead' : 'sdkDeletionReceiptRead';
    assert.equal(validConnectorOwnerInput(read, input), false);
  }
});
