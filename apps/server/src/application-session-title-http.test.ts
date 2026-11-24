import assert from 'node:assert/strict';
import { awaitHttpAdmission, controlledHttpDeadline } from './lifecycle/http-deadline-test-support.js';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { originalApplicationAuthFixture } from './auth/application-transaction-test-fixture.js';
import { createApplicationTransactionClient, createApplicationTransactionLink, type ApplicationTransactionClient } from './auth/application-transaction-gate.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { ConnectorUserStore } from './connector/connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { AsyncSessionTitle } from './connector/async-session-title.js';
import { AsyncSdkLocal } from './connector/async-sdk-local.js';
import { registerSdkLocalHttp } from './connector/sdk-local-http.js';
import { DeckStore } from './projection/deck-store.js';
import { registerApplicationSessionTitleHttp } from './application-session-title-http.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';

const silent = new PerformanceDiagnostics(() => {}), session = 's'.repeat(43);
const runtimes = ['openclaw', 'hermes', 'claude-code', 'ghcp'] as const;
const sessionKey = (runtime: string) => runtime === 'openclaw' ? 'agent:main:dashboard:original' : `${runtime}:original`;
const body = { title: ' Renamed ', ignored: 'original metadata' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(t: TestContext, role: 'hub' | 'standalone' = 'hub', mode: 'json' | 'sqlite' = 'sqlite', withKey = true, timeoutMs = 15_000, withSdk = false) {
  const root = mkdtempSync(join(tmpdir(), 'application-session-title-')), link = createApplicationTransactionLink();
  const auth = originalApplicationAuthFixture(root, role, mode, withKey ? 'original-key' : undefined, silent, link.auth);
  link.connector.begin(); link.connector.data.ref();
  const client = createApplicationTransactionClient(link.connector.data);
  let allowed = true, revokePhase: 'control-claim' | 'control-ready' | undefined, ackRevoke = false, effects = 0, fallbacks = 0;
  let block: Promise<void> | undefined;
  const entered = deferred(), bindings: { phase: string; resource: string; payloadDigest: string }[] = [];
  const transaction: ApplicationTransactionClient = { async run(binding, write) {
    bindings.push({ phase: binding.phase, resource: binding.resource, payloadDigest: binding.payloadDigest });
    if (binding.phase === revokePhase) { revokePhase = undefined; await auth.revokeSession(session); }
    return client.run(binding, write);
  } };
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'original-transport', silent);
  const actor = tokens.authenticateAuthorization('Bearer original-transport')!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const db = (store as unknown as { db: DatabaseSync }).db;
  const original = createConnectorOwnerCommands(store, tokens, undefined, undefined, undefined, false, undefined, transaction);
  const command: typeof original = Object.assign(async (kind: Parameters<typeof original>[0], input: never) => {
    const result = await original(kind, input);
    if (kind === 'titleBegin' && result === true) { effects++; entered.resolve(); if (block) await block; }
    if (kind === 'titleAccept' && ackRevoke) { ackRevoke = false; await auth.revokeSession(session); allowed = false; }
    return result;
  }, { dispose: original.dispose }) as typeof original;
  const titlesFile = join(root, 'titles.json'), deck = new DeckStore({ sessionTitlesFile: titlesFile });
  for (const runtime of runtimes) deck.upsertSession({ sessionKey: sessionKey(runtime), title: 'Original', agentId: runtime, status: 'idle',
    ...(runtime === 'openclaw' ? {} : { source: runtime }) });
  const titles = new AsyncSessionTitle({ owner: { command }, deck, local() {}, writable: () => true, diagnostics: silent });
  const valid = (request: Request) => allowed && (!withKey || request.headers.get('cookie') === `agentopsdeck_session=${session}`);
  const commands = createApplicationCommandScopes({ authorize: valid, assertAvailable() {}, diagnostics: silent });
  const app = new Hono();
  if (withSdk) registerSdkLocalHttp(app, '/api', { local: new AsyncSdkLocal({ command }),
    authorization: () => 'Bearer original-transport', ready: () => true, diagnostics: silent });
  // Simulate the preceding bounded SDK settings reader forwarding title JSON.
  app.patch('/api/sessions/:sessionKey', async (c, next) => { await c.req.json(); return next(); });
  const http = registerApplicationSessionTitleHttp(app, { commands, credentials: { token: () => 'original-transport' },
    observeActor: request => valid(request) ? 'administrator' : undefined, available: () => true, transactions: true,
    titles: { titles }, timeoutMs, diagnostics: silent });
  app.all('*', async c => { fallbacks++; return c.json({ fallback: true, ...(c.req.method === 'PATCH' ? { body: await c.req.json() } : {}) }); });
  const request = (value?: unknown, commandKey = 'original', runtime = 'hermes', extra: Record<string, string> = {}) => app.request(
    `/api/sessions/${sessionKey(runtime)}` + (value === undefined ? `/settings-commands/${commandKey}` : ''), {
      method: value === undefined ? 'GET' : 'PATCH', headers: { cookie: `agentopsdeck_session=${session}`, 'content-type': 'application/json',
        'idempotency-key': commandKey, ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const receipt = (commandKey = 'original', runtime = 'hermes') => store.commands.get(JSON.stringify(['settings', JSON.stringify([actor, sessionKey(runtime)])]), commandKey);
  t.after(async () => {
    await Promise.all([http.close(), commands.close(), titles.close()]); command.dispose(); store.close();
    link.connector.data.close(); link.connector.confirmExit(); await auth.closeForShutdown(); link.closeUnused();
    rmSync(root, { recursive: true, force: true });
  });
  await auth.open(); if (withKey) await auth.issueSession(session);
  return { db, store, request, receipt, http, commands, titles, deck, bindings, entered: entered.promise,
    effects: () => effects, fallbacks: () => fallbacks, titleFile: () => readFileSync(titlesFile, 'utf8'),
    revokeAt: (phase: typeof revokePhase) => { revokePhase = phase; }, revokeOnAck: () => { ackRevoke = true; },
    block: (value: Promise<void>) => { block = value; }, command };
}

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false])
  test(`${role}/${mode}/${withKey ? 'Key' : 'no Key'}: four original runtime title chains and read-only receipts`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, role, mode, withKey);
    for (const runtime of runtimes) {
      const before = f.bindings.length, response = await f.request(body, runtime, runtime);
      assert.equal(response.status, 200); const wire = await response.json(); assert.equal(wire.command.state, 'accepted');
      assert.equal(f.deck.getSession(sessionKey(runtime))?.title, 'Renamed');
      assert.ok(f.titleFile().includes(sessionKey(runtime)));
      assert.deepEqual(await (await f.request(body, runtime, runtime)).json(), wire);
      const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      assert.ok(f.bindings.slice(before).some(b => b.phase === 'control-ready'));
      assert.ok(f.bindings.slice(before).every(b => b.resource === sessionKey(runtime) && b.payloadDigest === digest));
      assert.equal((await f.request({ ...body, ignoredConflict: true }, runtime, runtime)).status, 409);
      const effects = f.effects(); assert.deepEqual((await (await f.request(undefined, runtime, runtime)).json()).command, f.receipt(runtime, runtime));
      assert.equal(f.effects(), effects);
    }
    assert.equal(f.effects(), 4); assert.equal(f.fallbacks(), 0);
  });

for (const phase of ['control-claim', 'control-ready'] as const) test(`title original Auth revoke at ${phase} forbids file effect`, async t => {
  const f = await fixture(t); f.revokeAt(phase);
  assert.equal((await f.request(body)).status, phase === 'control-ready' ? 409 : 503);
  assert.equal(f.effects(), 0); assert.equal(f.deck.getSession('hermes:original')?.title, 'Original');
  assert.equal(f.receipt()?.state, phase === 'control-ready' ? 'rejected' : undefined);
});
test('title original durable ACK survives logout without early projection or replay', async t => {
  const f = await fixture(t); f.revokeOnAck();
  assert.equal((await f.request(body)).status, 403); assert.equal(f.receipt()?.state, 'accepted');
  assert.ok(f.titleFile().includes('Renamed')); assert.equal(f.deck.getSession('hermes:original')?.title, 'Original');
  assert.equal((await f.request()).status, 403); assert.equal(f.effects(), 1);
});
test('title SQL settlement failure keeps original unknown and never replays file effect', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER title_settle_failure BEFORE UPDATE ON command_receipts WHEN NEW.state != 'outcome_unknown' BEGIN SELECT RAISE(ABORT,'isolated settlement failure'); END");
  assert.equal((await f.request(body)).status, 202); assert.ok(f.titleFile().includes('Renamed'));
  assert.equal(f.receipt()?.state, 'outcome_unknown'); assert.equal(f.deck.getSession('hermes:original')?.title, 'Original');
  f.db.exec('DROP TRIGGER title_settle_failure');
  assert.equal((await f.request(body)).status, 202); assert.equal((await f.request()).status, 200); assert.equal(f.effects(), 1);
});
test('title deadline and close drain original physical Begin without file replay', async t => {
  const f = await fixture(t, 'standalone', 'sqlite', true, 1000), block = deferred(); f.block(block.promise);
  const clock = controlledHttpDeadline(t);
  try {
    const sending = Promise.resolve(f.request(body));
    await awaitHttpAdmission(f.entered, sending);
    assert.equal((await clock.expire(1000, sending)).status, 503);
    let drained = false; const closing = Promise.all([f.http.close(), f.commands.close(), f.titles.close()]).then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(f.commands.pending, 1);
    block.resolve(); await closing; assert.equal(f.receipt()?.state, 'outcome_unknown'); assert.equal(f.effects(), 1);
    assert.equal(f.deck.getSession('hermes:original')?.title, 'Original');
  } finally { clock.restore(); block.resolve(); }
});
test('title rejects unsupported settings without legacy fallback and forged identity or intent', async t => {
  const f = await fixture(t);
  for (const value of [{ model: 'original', title: 'Ignored' }, { goal: { action: 'pause' }, title: 'Ignored' }, { goal: {}, model: 'original' }])
    assert.equal((await f.request(value)).status, 400);
  assert.equal(f.fallbacks(), 0);
  for (const extra of [{ cookie: '' }, { 'x-agentopsdeck-execution-grant': 'forged' }, { 'x-agentopsdeck-expected-node-id': 'forged' }])
    assert.equal((await f.request(body, 'original', 'hermes', extra)).status, 403);
  const claimed = await f.command('titleClaim', { authorization: 'Bearer original-transport', key: 'hermes:original', commandKey: 'forgery', payloadJson: JSON.stringify(body) });
  assert.ok(!('error' in claimed) && claimed.intent);
  if ('error' in claimed || !claimed.intent) throw Error('original binding required');
  assert.equal(await f.command('titleBegin', { authorization: 'Bearer original-transport', intent: { ...claimed.intent, title: 'Forged' } }), false);
  assert.equal(await f.command('titleAccept', { intent: claimed.intent, title: claimed.intent.title }), false);
  assert.equal(f.effects(), 0);
});
test('SDK settings forwards mixed goal/model without authorizing a model mutation or legacy fallback', async t => {
  const f = await fixture(t, 'hub', 'sqlite', true, 15_000, true);
  for (const runtime of ['claude-code', 'ghcp']) {
    assert.equal((await f.request({ goal: { action: 'pause' }, model: 'default' }, 'mixed', runtime)).status, 400);
    assert.equal((await f.request(body, 'title', runtime)).status, 200);
    assert.equal(f.deck.getSession(`${runtime}:original`)?.title, 'Renamed');
  }
  assert.equal(f.fallbacks(), 0);
});
test('title command budget preserves escaped raw metadata and original credential evidence', () => {
  const large = { authorization: 'Bearer original-transport', key: 'hermes:original', commandKey: 'original',
    payloadJson: JSON.stringify({ title: 'Original', ignored: '\u0001'.repeat(20_000) }), application: { cookie: 'c'.repeat(65_536) } };
  assert.equal(validConnectorOwnerInput('titleClaim', large), true);
  assert.doesNotThrow(() => encodeConnectorOwnerJson(large, connectorOwnerCommandBytes('titleClaim')));
  assert.equal(validConnectorOwnerInput('titleReceipt', { ...large, payloadJson: undefined }), false);
});
