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
import { AsyncCodexSettings } from './connector/async-codex-settings.js';
import { DeckStore } from './projection/deck-store.js';
import { registerApplicationCodexSettingsHttp } from './application-codex-settings-http.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';

const silent = new PerformanceDiagnostics(() => {}), session = 's'.repeat(43), key = 'codex:original';
const snapshot = { revision: 'a'.repeat(64), goal: null };
const bodies = { title: { title: ' Renamed ', ignored: 'original metadata' }, model: { model: 'alternate', thinking: null },
  goal: { goal: { action: 'pause', expectedRevision: snapshot.revision } } } as const;
type Kind = keyof typeof bodies;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(t: TestContext, role: 'hub' | 'standalone' = 'hub', mode: 'json' | 'sqlite' = 'sqlite', withKey = true, timeoutMs = 15_000) {
  const root = mkdtempSync(join(tmpdir(), 'application-codex-settings-')), link = createApplicationTransactionLink();
  const auth = originalApplicationAuthFixture(root, role, mode, withKey ? 'original-key' : undefined, silent, link.auth);
  link.connector.begin(); link.connector.data.ref();
  const client = createApplicationTransactionClient(link.connector.data);
  let allowed = true, revokePhase: 'control-claim' | 'control-ready' | undefined, ackRevoke = false;
  let effects = 0, publications = 0, reads = 0, fallbacks = 0, failEffect = false;
  let block: Promise<void> | undefined, readHook: (() => Promise<void>) | undefined;
  const entered = deferred(), bindings: { phase: string; resource: string; payloadDigest: string }[] = [];
  const revoke = async () => { await auth.revokeSession(session); allowed = false; };
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
    if (kind === 'codexSettingsBegin' && result === true) { effects++; entered.resolve(); if (block) await block; }
    if (kind === 'codexSettingsAccept' && ackRevoke) { ackRevoke = false; await revoke(); }
    return result;
  }, { dispose: original.dispose }) as typeof original;
  const titles = join(root, 'titles.json'), deck = new DeckStore({ sessionTitlesFile: titles });
  deck.upsertSession({ sessionKey: key, title: 'Original', agentId: 'codex', status: 'idle' });
  const settings = new AsyncCodexSettings({ owner: { command }, deck, local() {}, writable: () => true, diagnostics: silent,
    runtime: {
      async readGoalControl(_key, check) { check(); reads++; await readHook?.(); check(); return snapshot; },
      async changeGoalOwned(_key, _control, local, begin, acknowledge) {
        local(); await begin(); local(); if (failEffect) throw Error('isolated native uncertainty');
        await acknowledge(); local(); publications++;
      },
      async updateSessionRuntimeOwned(_key, params, acknowledge, local) {
        local(); if (failEffect) throw Error('isolated file uncertainty');
        await acknowledge({ ...deck.getSession(key)!, model: params.model ?? 'default',
          ...(params.thinking == null ? {} : { thinkingLevel: params.thinking }) });
        local(); publications++;
      },
    } });
  const valid = (request: Request) => allowed && (!withKey || request.headers.get('cookie') === `agentopsdeck_session=${session}`);
  const commands = createApplicationCommandScopes({ authorize: valid, assertAvailable() {}, diagnostics: silent });
  const app = new Hono();
  const http = registerApplicationCodexSettingsHttp(app, { commands, credentials: { token: () => 'original-transport' },
    observeActor: request => valid(request) ? 'administrator' : undefined, available: () => true, transactions: true,
    codex: { settings }, timeoutMs, diagnostics: silent });
  app.all('*', async c => { fallbacks++; return c.json({ fallback: true, ...(c.req.method === 'PATCH' ? { body: await c.req.json() } : {}) }); });
  const request = (body?: unknown, commandKey = 'original', extra: Record<string, string> = {}, resource = key) => app.request(
    `/api/sessions/${resource}` + (body === undefined ? `/settings-commands/${commandKey}` : ''), {
      method: body === undefined ? 'GET' : 'PATCH', headers: { cookie: `agentopsdeck_session=${session}`, 'content-type': 'application/json',
        'idempotency-key': commandKey, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const goal = () => app.request(`/api/sessions/${key}/goal`, { headers: { cookie: `agentopsdeck_session=${session}` } });
  const receipt = (commandKey = 'original') => store.commands.get(JSON.stringify(['settings', JSON.stringify([actor, key])]), commandKey);
  t.after(async () => {
    await Promise.all([http.close(), commands.close(), settings.close()]); command.dispose(); store.close();
    link.connector.data.close(); link.connector.confirmExit(); await auth.closeForShutdown(); link.closeUnused();
    rmSync(root, { recursive: true, force: true });
  });
  await auth.open(); if (withKey) await auth.issueSession(session);
  return { db, store, request, goal, receipt, http, commands, settings, deck, bindings, entered: entered.promise,
    effects: () => effects, publications: () => publications, reads: () => reads, fallbacks: () => fallbacks,
    titleFile: () => readFileSync(titles, 'utf8'), revokeAt: (phase: typeof revokePhase) => { revokePhase = phase; },
    revokeOnAck: () => { ackRevoke = true; }, revokeOnRead: () => { readHook = revoke; },
    block: (value: Promise<void>) => { block = value; }, fail: () => { failEffect = true; } };
}

for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false])
  test(`${role}/${mode}/${withKey ? 'Key' : 'no Key'}: original Codex title/model/Goal, immutable receipts and read recovery`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, role, mode, withKey);
    for (const kind of Object.keys(bodies) as Kind[]) {
      const body = bodies[kind], before = f.bindings.length;
      const response = await f.request(body, kind); assert.equal(response.status, 200);
      const wire = await response.json(); assert.equal(wire.command.state, 'accepted');
      assert.deepEqual(await (await f.request(body, kind)).json(), wire);
      const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      assert.ok(f.bindings.slice(before).some(b => b.phase === 'control-ready'));
      assert.ok(f.bindings.slice(before).every(b => b.resource === key && b.payloadDigest === digest));
      assert.equal((await f.request({ ...body, ignoredConflict: true }, kind)).status, 409);
      const mutations = f.effects(); assert.deepEqual((await (await f.request(undefined, kind)).json()).command, f.receipt(kind));
      assert.equal(f.effects(), mutations);
    }
    assert.equal(f.effects(), 3); assert.equal(f.deck.getSession(key)?.title, 'Renamed');
    const before = f.bindings.length; assert.deepEqual(await (await f.goal()).json(), snapshot);
    assert.equal(f.reads(), 1); assert.equal(f.effects(), 3); assert.equal(f.bindings.length, before); assert.equal(f.fallbacks(), 0);
  });

for (const kind of Object.keys(bodies) as Kind[]) {
  for (const phase of ['control-claim', 'control-ready'] as const) test(`${kind}: original Auth revoke at ${phase} forbids effect`, async t => {
    const f = await fixture(t); f.revokeAt(phase);
    assert.equal((await f.request(bodies[kind])).status, phase === 'control-ready' ? 409 : 503); assert.equal(f.effects(), 0);
    assert.equal(f.receipt()?.state, phase === 'control-ready' ? 'rejected' : undefined);
    assert.equal(f.deck.getSession(key)?.title, 'Original'); assert.equal(f.publications(), 0);
  });
  test(`${kind}: durable original ACK survives logout and suppresses projection/delivery`, async t => {
    const f = await fixture(t); f.revokeOnAck();
    assert.equal((await f.request(bodies[kind])).status, 403); assert.equal(f.receipt()?.state, 'accepted');
    assert.equal(f.effects(), 1); assert.equal(f.publications(), 0); assert.equal(f.deck.getSession(key)?.title, 'Original');
    if (kind === 'title') assert.ok(f.titleFile().includes('Renamed'));
    assert.equal((await f.request()).status, 403); assert.equal(f.effects(), 1);
  });
}
for (const kind of ['model', 'goal'] as const) test(`${kind}: uncertain original effect never replays`, async t => {
  const f = await fixture(t); f.fail();
  assert.equal((await f.request(bodies[kind])).status, 202); assert.equal(f.receipt()?.state, 'outcome_unknown');
  assert.equal((await f.request(bodies[kind])).status, 202); assert.equal((await f.request()).status, 200);
  assert.equal(f.effects(), 1); assert.equal(f.publications(), 0);
});
test('original settings settlement SQL failure remains unknown and never repeats title file effect', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER settings_settle_failure BEFORE UPDATE ON command_receipts WHEN NEW.state != 'outcome_unknown' BEGIN SELECT RAISE(ABORT,'isolated settlement failure'); END");
  assert.equal((await f.request(bodies.title)).status, 202); assert.ok(f.titleFile().includes('Renamed'));
  assert.equal(f.receipt()?.state, 'outcome_unknown'); assert.equal(f.deck.getSession(key)?.title, 'Original');
  f.db.exec('DROP TRIGGER settings_settle_failure');
  assert.equal((await f.request(bodies.title)).status, 202); assert.equal((await f.request()).status, 200); assert.equal(f.effects(), 1);
});
test('Goal read rechecks original user after native observation without claiming a write', async t => {
  const f = await fixture(t); f.revokeOnRead();
  assert.equal((await f.goal()).status, 403); assert.equal(f.reads(), 1); assert.equal(f.effects(), 0);
  assert.equal(f.bindings.length, 0); assert.equal(f.receipt(), undefined);
});
test('settings deadline and close retain physical scope until original Begin resolves', async t => {
  const f = await fixture(t, 'standalone', 'sqlite', true, 150), block = deferred(); f.block(block.promise);
  const clock = controlledHttpDeadline(t);
  try {
    const sending = f.request(bodies.model); await awaitHttpAdmission(f.entered, sending);
    assert.equal((await clock.expire(150, sending)).status, 503);
    let drained = false; const closing = Promise.all([f.http.close(), f.commands.close()]).then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(f.commands.pending, 1);
    block.resolve(); await closing; assert.equal(f.receipt()?.state, 'outcome_unknown'); assert.equal(f.publications(), 0);
  } finally { clock.restore(); block.resolve(); }
});
test('settings preserves other runtime title-only body and rejects forged authority/read evidence', async t => {
  const f = await fixture(t), body = { title: 'Other runtime', ignored: true };
  assert.deepEqual(await (await f.request(body, 'other', {}, 'hermes:original')).json(), { fallback: true, body });
  for (const extra of [{ cookie: '' }, { 'x-agentopsdeck-execution-grant': 'forged' }, { 'x-agentopsdeck-expected-node-id': 'forged' }])
    assert.equal((await f.request(bodies.title, 'original', extra)).status, 403);
  for (const kind of ['codexSettingsAuthorize', 'codexSettingsReceipt'] as const)
    assert.equal(validConnectorOwnerInput(kind, { authorization: 'Bearer original-transport', key,
      ...(kind === 'codexSettingsReceipt' ? { commandKey: 'original' } : {}), application: {} }), false);
  const large = { authorization: 'Bearer original-transport', key, commandKey: 'original',
    payloadJson: JSON.stringify({ title: 'Original', ignored: '\u0001'.repeat(20_000) }), application: { cookie: 'c'.repeat(65_536) } };
  assert.equal(validConnectorOwnerInput('codexSettingsClaim', large), true);
  assert.doesNotThrow(() => encodeConnectorOwnerJson(large, connectorOwnerCommandBytes('codexSettingsClaim')));
  assert.equal(f.effects(), 0);
});
