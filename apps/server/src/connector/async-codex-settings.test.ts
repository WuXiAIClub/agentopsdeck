import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { DeckStore } from '../projection/deck-store.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexSettings } from './async-codex-settings.js';
import { registerCodexSettingsHttp } from './codex-settings-http.js';
import { validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import type { CodexSettingsResult } from './connector-codex-settings-domain.js';

const key = 'codex:original';
const tick = () => new Promise<void>(ok => setImmediate(ok));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok; }); return { promise, resolve }; }
function result(value: CodexSettingsResult | { error: number }): CodexSettingsResult { assert.ok(!('error' in value)); return value; }
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-settings-'));
  const config = { file: join(directory, 'original.sqlite'), tokenFile: join(directory, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile);
  const reader = tokens.create({ label: 'original', scopes: ['sessions:create'] });
  const denied = tokens.create({ label: 'read only', scopes: ['sessions:read'] });
  const delegate = tokens.create({ label: 'delegate', scopes: ['sessions:create', 'execution:delegate', 'messages:send'] });
  const authorization = `Bearer ${reader.token}`, scope = { authorization, key };
  const owner = new AsyncConnectorOwner(config, new PerformanceDiagnostics(() => {})); await owner.open();
  let hook: ((kind: string, run: () => Promise<any>) => Promise<any>) | undefined;
  const port = { command: (async (kind: any, input: any) => {
    const run = () => owner.command(kind, input); return hook ? hook(kind, run) : run();
  }) as AsyncConnectorOwner['command'] };
  const deck = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  deck.upsertSession({ sessionKey: key, title: 'Original', agentId: 'codex', status: 'idle' });
  let writable = true;
  const logs: string[] = [];
  const settings = new AsyncCodexSettings({ owner: port, deck, local() {}, writable: () => writable,
    runtime: { readGoalControl() { assert.fail('not a native Goal fixture'); }, changeGoalOwned() { assert.fail('not a native Goal fixture'); },
      updateSessionRuntimeOwned() { assert.fail('not a model writer fixture'); } },
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)) });
  const releases: Array<() => void> = [];
  t.after(async () => { try { for (const release of releases) release(); await settings.close(); await owner.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const claim = async (commandKey: string, body: unknown = { title: 'Renamed' }, sessionKey = key) => result(await owner.command('codexSettingsClaim',
    { ...scope, key: sessionKey, commandKey, payloadJson: JSON.stringify(body) }));
  const receipt = async (commandKey: string, sessionKey = key) => result(await owner.command('codexSettingsReceipt', { ...scope, key: sessionKey, commandKey }));
  const change = (commandKey: string, body: unknown = { title: 'Renamed' }, sessionKey = key) => settings.change({ ...scope, key: sessionKey, commandKey, payloadJson: JSON.stringify(body) });
  return { owner, config, reader, authorization, scope, deck, settings, logs, claim, receipt, change,
    denied: `Bearer ${denied.token}`, delegate: `Bearer ${delegate.token}`, hook(fn: typeof hook) { hook = fn; }, freezeWrites() { writable = false; },
    onCleanup(release: () => void) { releases.push(release); },
    http(timeoutMs = 1000) { const app = new Hono(); registerCodexSettingsHttp(app, '/sessions/:sessionKey', { settings, timeoutMs });
      app.all('*', c => c.json({ error: 'legacy route' }, 418)); return app; } };
}

test('settings fixed DTO refuses authority, SQL, arbitrary results, and cross-runtime intent injection', () => {
  const claim = { authorization: '', key, commandKey: 'original', payloadJson: '{"title":"Renamed"}' };
  assert.ok(validConnectorOwnerInput('codexSettingsClaim', claim));
  for (const injected of [{ actor: 'forged' }, { scope: 'admin' }, { sql: 'SELECT 1' }, { key: 'hermes:other' }, { authorization: 'Bearer\nprivate' }]) {
    assert.equal(validConnectorOwnerInput('codexSettingsClaim', { ...claim, ...injected }), false);
  }
  assert.equal(validConnectorOwnerInput('codexSettingsClaim', { ...claim, payloadJson: '{"idempotencyKey":"other"}' }), false);
  assert.equal(validConnectorOwnerOutput('codexSettingsAccept', { status: 200, body: {} }), false);
});

test('worker preserves original scope, fingerprint, duplicate id and settings mutual exclusion', async t => {
  const f = await fixture(t), first = await f.claim('original'); assert.ok(first.intent);
  const duplicate = await f.claim('original'); assert.equal(duplicate.intent, null); assert.equal(duplicate.receipt?.id, first.receipt?.id);
  assert.deepEqual(await f.owner.command('codexSettingsClaim', { ...f.scope, commandKey: 'original', payloadJson: '{"title":"Changed"}' }), { error: 409 });
  const blocked = await f.claim('second');
  assert.equal(blocked.intent, null);
  assert.equal(blocked.receipt?.state, 'rejected');
  assert.equal(blocked.receipt?.result?.status, 409);
  assert.deepEqual(await f.claim('second'), blocked, 'a rejected key retains its original durable receipt');
  assert.equal(await f.owner.command('codexSettingsBegin', { authorization: f.authorization, intent: { ...first.intent, receiptId: 'forged' } }), false);
  // Object property order is not part of the private capability identity.
  const { change, commandKey, key: boundKey, receiptId, id } = first.intent;
  const intent = { change, commandKey, key: boundKey, receiptId, id };
  assert.equal(await f.owner.command('codexSettingsBegin', { authorization: f.authorization, intent }), true);
  assert.equal(await f.owner.command('codexSettingsBegin', { authorization: f.authorization, intent }), false);
  assert.equal(await f.owner.command('codexSettingsAccept', { intent, settings: { title: 'Forged' } }), false);
  const accepted = await f.owner.command('codexSettingsAccept', { intent, settings: { title: 'Renamed' } }); assert.ok(accepted);
  assert.equal(accepted.receipt?.state, 'accepted');
  await f.owner.close();
  const original = new ConnectorUserStore(f.config.file, undefined, { runtimeOwner: true });
  try { assert.equal(original.commands.get(JSON.stringify(['settings', JSON.stringify([f.reader.record.id, key])]), 'original')?.id, first.receipt?.id); }
  finally { original.close(); }
});

test('worker rejects read-only/delegated identity and current revocation before begin', async t => {
  const f = await fixture(t);
  for (const authorization of [f.denied, f.delegate]) assert.deepEqual(await f.owner.command('codexSettingsAuthorize', { authorization, key }), { error: 403 });
  const claimed = await f.claim('original'); assert.ok(claimed.intent);
  assert.equal(await f.owner.command('tokenRevoke', { tokenId: f.reader.record.id }), true);
  assert.equal(await f.owner.command('codexSettingsBegin', { authorization: f.authorization, intent: claimed.intent }), false);
  const abandoned = await f.owner.command('codexSettingsAbandon', { intent: claimed.intent }); assert.ok(abandoned);
  assert.equal(abandoned.receipt?.state, 'rejected');
});

test('original ACK settles after revocation; delivery still requires current identity', async t => {
  const f = await fixture(t), claimed = await f.claim('original'); assert.ok(claimed.intent);
  await f.owner.command('codexSettingsBegin', { authorization: f.authorization, intent: claimed.intent });
  await f.owner.command('tokenRevoke', { tokenId: f.reader.record.id });
  const accepted = await f.owner.command('codexSettingsAccept', { intent: claimed.intent, settings: { title: 'Renamed' } }); assert.ok(accepted);
  assert.equal(accepted.receipt?.state, 'accepted');
  assert.deepEqual(await f.owner.command('codexSettingsReceipt', { ...f.scope, commandKey: 'original' }), { error: 403 });
});

for (const dispatched of [false, true]) test(`worker restart preserves ${dispatched ? 'unknown dispatch' : 'proven prewrite rejection'} without re-execution`, async t => {
  const f = await fixture(t), claimed = await f.claim('original'); assert.ok(claimed.intent);
  if (dispatched) await f.owner.command('codexSettingsBegin', { authorization: f.authorization, intent: claimed.intent });
  await f.owner.close();
  const reopened = new AsyncConnectorOwner(f.config, new PerformanceDiagnostics(() => {}));
  try {
    await reopened.open();
    const r = result(await reopened.command('codexSettingsReceipt', { ...f.scope, commandKey: 'original' }));
    assert.equal(r.receipt?.id, claimed.receipt?.id); assert.equal(r.receipt?.state, dispatched ? 'outcome_unknown' : 'rejected');
    const duplicate = result(await reopened.command('codexSettingsClaim', { ...f.scope, commandKey: 'original', payloadJson: '{"title":"Renamed"}' }));
    assert.equal(duplicate.intent, null);
    assert.equal(await reopened.command('codexSettingsAccept', { intent: claimed.intent, settings: { title: 'Renamed' } }), false);
  } finally { await reopened.close(); }
});

test('abandon after begin stays unknown and original late ACK remains usable', async t => {
  const f = await fixture(t), claimed = await f.claim('original'); assert.ok(claimed.intent);
  await f.owner.command('codexSettingsBegin', { authorization: f.authorization, intent: claimed.intent });
  const abandoned = await f.owner.command('codexSettingsAbandon', { intent: claimed.intent, reason: 'session_missing' }); assert.ok(abandoned);
  assert.equal(abandoned.receipt?.state, 'outcome_unknown');
  const accepted = await f.owner.command('codexSettingsAccept', { intent: claimed.intent, settings: { title: 'Renamed' } }); assert.ok(accepted);
  assert.equal(accepted.receipt?.state, 'accepted');
});

test('title effect awaits durable ACK before projection, keeps newer fields, and duplicate does not rewrite', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); f.onCleanup(release.resolve);
  let effects = 0;
  const rename = f.deck.renameSessionOwned.bind(f.deck);
  f.deck.renameSessionOwned = (...args) => { effects++; return rename(...args); };
  f.hook(async (kind, run) => { if (kind === 'codexSettingsAccept') { entered.resolve(); await release.promise; } return run(); });
  const before = f.deck.getEventsSince().length, changing = f.change('original'); await entered.promise;
  assert.equal(f.deck.getEventsSince().length, before, 'no projection event before durable ACK');
  assert.equal((await f.receipt('original')).receipt?.state, 'outcome_unknown');
  f.deck.upsertSession({ ...f.deck.getSession(key)!, status: 'running' });
  release.resolve(); assert.equal(result(await changing).receipt?.state, 'accepted');
  assert.equal(f.deck.getSession(key)?.status, 'running'); assert.equal(f.deck.getSession(key)?.title, 'Renamed');
  assert.equal(result(await f.change('original')).receipt?.state, 'accepted'); assert.equal(effects, 1);
  assert.ok(f.logs.length); assert.equal(f.logs.some(line => line.includes(f.authorization) || line.includes('Renamed')), false);
});

test('missing session is durable 404, invalid settings 400, and read/retry never execute', async t => {
  const f = await fixture(t);
  const missing = result(await f.change('missing', { title: 'Renamed' }, 'codex:missing'));
  assert.equal(missing.receipt?.state, 'rejected'); assert.equal(missing.receipt?.result?.status, 404);
  assert.equal(result(await f.change('invalid', { title: '' })).receipt?.result?.status, 400);
  assert.equal(result(await f.change('invalid', { title: '' })).intent, null);
  assert.equal(f.deck.getSession(key)?.title, 'Original');
});

test('lost acceptance reply recovers accepted receipt without executing or settling twice', async t => {
  const f = await fixture(t); let accepts = 0;
  f.hook(async (kind, run) => { const value = await run(); if (kind === 'codexSettingsAccept') { accepts++; throw Error('reply lost'); } return value; });
  assert.equal(result(await f.change('original')).receipt?.state, 'accepted');
  assert.equal(result(await f.change('original')).receipt?.state, 'accepted'); assert.equal(accepts, 1);
});

test('close owns held claim despite tampered public then and does not write after freeze', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); f.onCleanup(release.resolve);
  f.hook(async (kind, run) => { const value = await run(); if (kind === 'codexSettingsClaim') { entered.resolve(); await release.promise; } return value; });
  const changing = f.change('original'); await entered.promise;
  Object.defineProperty(changing, 'then', { value: () => { throw Error('public then must not own physical drain'); } });
  let closed = false; const closing = f.settings.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  release.resolve(); await closing;
  assert.equal((await f.receipt('original')).receipt?.state, 'rejected'); assert.equal(f.deck.getSession(key)?.title, 'Original');
  await assert.rejects(f.change('new'));
});

test('owned HTTP preserves settings body, key conflicts, receipt shape, and non-Codex fallback', async t => {
  const f = await fixture(t), app = f.http(), path = `/sessions/${encodeURIComponent(key)}`;
  const patch = (body: unknown, headers: Record<string, string> = {}) => app.request(path, { method: 'PATCH', headers: {
    authorization: f.authorization, 'content-type': 'application/json', 'idempotency-key': 'original', ...headers }, body: JSON.stringify(body) });
  assert.equal((await patch({ title: 'Renamed', idempotencyKey: 'different' })).status, 400);
  assert.equal((await patch({ title: 'Renamed' }, { 'x-agentopsdeck-execution-grant': 'forged' })).status, 403);
  const accepted = await patch({ title: 'Renamed' }); assert.equal(accepted.status, 200); assert.equal(accepted.headers.get('cache-control'), 'no-store');
  const body = await accepted.json() as any;
  assert.equal(body.sessionKey, key); assert.deepEqual(body.settings, { title: 'Renamed' }); assert.equal(body.command.state, 'accepted');
  const read = await app.request(`${path}/settings-commands/original`, { headers: { authorization: f.authorization } });
  assert.equal(read.status, 200); assert.equal((await read.json() as any).command.state, 'accepted');
  assert.equal((await app.request('/sessions/hermes%3Aother', { method: 'PATCH' })).status, 418);
});

test('HTTP timeout releases waiter only; original command completes once and is read-only recoverable', async t => {
  const f = await fixture(t), app = f.http(100), entered = deferred(), release = deferred(); f.onCleanup(release.resolve);
  let accepts = 0;
  f.hook(async (kind, run) => { if (kind === 'codexSettingsAccept') { accepts++; entered.resolve(); await release.promise; } return run(); });
  const path = `/sessions/${encodeURIComponent(key)}`;
  const request = app.request(path, { method: 'PATCH', headers: { authorization: f.authorization, 'idempotency-key': 'original', 'content-type': 'application/json' }, body: '{"title":"Renamed"}' });
  await entered.promise; const timedOut = await request; assert.equal(timedOut.status, 503);
  assert.equal((await timedOut.json() as any).commandKey, 'original');
  assert.equal((await f.receipt('original')).receipt?.state, 'outcome_unknown');
  release.resolve(); await f.settings.drain();
  assert.equal((await f.receipt('original')).receipt?.state, 'accepted'); assert.equal(accepts, 1);
});
