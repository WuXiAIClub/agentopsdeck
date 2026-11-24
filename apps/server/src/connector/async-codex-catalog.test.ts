import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexCatalog } from './async-codex-catalog.js';
import { registerCodexCatalogHttp } from './codex-catalog-http.js';
import { validConnectorOwnerInput, validConnectorOwnerOutput, connectorOwnerSteps } from './connector-owner-domain.js';

const key = 'codex:original', silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(ok => setImmediate(ok));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok; }); return { promise, resolve }; }
async function fixture(t: TestContext, configuration: { modelChoices?: string[]; modelProvider?: string; defaultModel?: string } = {}, deletion = false) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-catalog-'));
  const cleanups: Array<() => unknown | Promise<unknown>> = [];
  t.after(async () => { try { for (const close of cleanups.reverse()) await close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const config = { file: join(directory, 'original.sqlite'), tokenFile: join(directory, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile);
  const reader = tokens.create({ label: 'original', scopes: ['models:read', 'messages:read'] });
  const denied = tokens.create({ label: 'no catalogs', scopes: ['sessions:read'] });
  const delegate = tokens.create({ label: 'delegate', scopes: ['models:read', 'messages:read', 'messages:send', 'execution:delegate'] });
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  try {
    if (deletion) {
      const scope = JSON.stringify(['delete', JSON.stringify([reader.record.id, key])]);
      await seed.commands.claimAsync(scope, 'original-delete', {});
      seed.commands.settle(scope, 'original-delete', { status: 200, body: { deleted: true } });
    }
  } finally { seed.close(); }
  const owner = new AsyncConnectorOwner(config, silence); cleanups.push(() => owner.close()); await owner.open();
  let hook: ((kind: string, run: () => Promise<any>) => Promise<any>) | undefined;
  const port = { command: (async (kind: any, input: any) => {
    const run = () => owner.command(kind, input); return hook ? hook(kind, run) : run();
  }) as AsyncConnectorOwner['command'] };
  let exists = true, nativeCalls = 0, enabled = true, nativeHook: (() => Promise<void>) | undefined;
  const logs: string[] = [];
  const catalog = new AsyncCodexCatalog({ owner: port, local() {}, sessionExists: () => exists,
    runtime: { get enabled() { return enabled; }, async listModels() { nativeCalls++; await nativeHook?.(); return [{ id: 'native', label: 'Native' }]; },
      async listSessionSkills() { nativeCalls++; await nativeHook?.(); return { skills: [], observedAt: 1, limited: false, discoveryErrors: 0, usage: 'unknown' }; } },
    defaultModel: configuration.defaultModel ?? 'default', ...configuration,
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)) });
  cleanups.push(() => catalog.close());
  const authorization = `Bearer ${reader.token}`;
  return { catalog, owner, authorization, reader, denied: `Bearer ${denied.token}`, delegate: `Bearer ${delegate.token}`, logs,
    onCleanup(fn: () => unknown | Promise<unknown>) { cleanups.push(fn); },
    nativeCalls: () => nativeCalls, remove() { exists = false; }, disable() { enabled = false; },
    hook(fn: typeof hook) { hook = fn; }, nativeHook(fn: typeof nativeHook) { nativeHook = fn; } };
}

test('fixed catalog protocol rejects authority/path injection and diagnostic steps remain unique', () => {
  const models = { authorization: '', kind: 'models' };
  assert.ok(validConnectorOwnerInput('codexCatalogAuthorize', models));
  assert.ok(!validConnectorOwnerInput('codexCatalogAuthorize', { ...models, readerId: 'forged' }));
  assert.ok(!validConnectorOwnerInput('codexCatalogAuthorize', { ...models, key }));
  assert.ok(!validConnectorOwnerInput('codexCatalogAuthorize', { ...models, authorization: 'Bearer\nsecret' }));
  assert.ok(!validConnectorOwnerInput('codexCatalogDeliver', { ...models, readerId: '' }));
  assert.ok(!validConnectorOwnerInput('codexCatalogAuthorize', { authorization: '', kind: 'skills', key: 'openclaw:other' }));
  assert.ok(!validConnectorOwnerOutput('codexCatalogDeliver', { readerId: 'reader', path: 'private' }));
  assert.equal(new Set(Object.values(connectorOwnerSteps)).size, Object.keys(connectorOwnerSteps).length);
});

test('original worker enforces endpoint scopes, owner-only skills, and original reader identity', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.catalog.models({ authorization: f.denied }), { error: 403 });
  assert.deepEqual(await f.catalog.skills({ authorization: f.delegate, key }), { error: 403 });
  assert.ok('value' in await f.catalog.models({ authorization: f.delegate })); // Original model policy permits this reader.
  assert.deepEqual(await f.owner.command('codexCatalogDeliver', { authorization: f.authorization, kind: 'models', readerId: 'forged' }), { error: 409 });
  assert.equal(f.nativeCalls(), 1);
});

test('catalog preserves discovered models without inventing a configured default', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.catalog.models({ authorization: f.authorization }), { value: [{ id: 'native', label: 'Native' }] });
  assert.ok(f.logs.length > 0);
  assert.ok(!f.logs.join('').includes(f.authorization));
});
for (const provider of [false, true]) test(`configured catalog still discovers actual runtime models provider=${provider}`, async t => {
  const choices = provider ? [] : ['configured', 'configured'];
  const f = await fixture(t, { modelChoices: choices, ...(provider ? { modelProvider: 'custom' } : {}) });
  choices.push('mutated');
  const result = await f.catalog.models({ authorization: f.authorization });
  assert.deepEqual(result, { value: [{ id: 'native', label: 'Native' }] });
  assert.equal(f.nativeCalls(), 1);
});

test('revoke during native catalog read prevents delivery without retrying native', async t => {
  const f = await fixture(t);
  f.nativeHook(async () => { assert.equal(await f.owner.command('tokenRevoke', { tokenId: f.reader.record.id }), true); });
  assert.deepEqual(await f.catalog.models({ authorization: f.authorization }), { error: 403 });
  assert.equal(f.nativeCalls(), 1);
});

test('skills delivery checks current local session after native discovery', async t => {
  const f = await fixture(t);
  f.nativeHook(async () => { f.remove(); });
  assert.deepEqual(await f.catalog.skills({ authorization: f.authorization, key }), { error: 404 });
  assert.equal(f.nativeCalls(), 1);
});

test('original worker deletion fence denies discovery without native work', async t => {
  const f = await fixture(t, {}, true);
  assert.equal(await f.owner.command('receiptDeletion', { sessionKey: key }), 'accepted');
  assert.deepEqual(await f.catalog.skills({ authorization: f.authorization, key }), { error: 404 });
  assert.equal(f.nativeCalls(), 0);
});

for (const stage of ['codexCatalogAuthorize', 'native', 'codexCatalogDeliver']) test(`close drains physical ${stage} despite public then mutation`, async t => {
  const f = await fixture(t), held = deferred(), entered = deferred();
  f.onCleanup(() => held.resolve());
  if (stage === 'native') f.nativeHook(async () => { entered.resolve(); await held.promise; });
  else f.hook(async (kind, run) => { const result = await run(); if (kind === stage) { entered.resolve(); await held.promise; } return result; });
  const work = f.catalog.models({ authorization: f.authorization });
  const settled = Promise.prototype.then.call(work, () => 'value', () => 'rejected') as Promise<string>;
  await entered.promise;
  work.then = (() => Promise.resolve()) as any;
  let closed = false; const closing = f.catalog.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  await assert.rejects(f.catalog.models({ authorization: f.authorization }));
  held.resolve(); assert.equal(await settled, 'rejected'); await closing;
  assert.equal(f.nativeCalls(), stage === 'codexCatalogAuthorize' ? 0 : 1);
});

test('catalog bounds admitted physical reads and freeze rejects without querying worker', async t => {
  const f = await fixture(t), held = deferred(), entered = deferred();
  f.onCleanup(() => held.resolve());
  let calls = 0;
  f.hook(async (kind, run) => { if (kind === 'codexCatalogAuthorize') { calls++; entered.resolve(); await held.promise; } return run(); });
  const work = Array.from({ length: 16 }, () => f.catalog.models({ authorization: f.authorization }).catch(() => null));
  await entered.promise; await assert.rejects(f.catalog.models({ authorization: f.authorization }));
  f.catalog.freeze(); await assert.rejects(f.catalog.models({ authorization: f.authorization }));
  assert.equal(calls, 16); held.resolve(); await Promise.all(work);
  assert.equal(f.nativeCalls(), 0);
});

test('HTTP deadline ends only the waiter; close still owns the original work', async t => {
  const f = await fixture(t), held = deferred(), entered = deferred();
  f.onCleanup(() => held.resolve());
  f.nativeHook(async () => { entered.resolve(); await held.promise; });
  const app = new Hono(); registerCodexCatalogHttp(app, '/connector', { catalog: f.catalog, timeoutMs: 15 });
  const response = app.request('/connector/models/codex', { headers: { authorization: f.authorization } });
  await entered.promise;
  assert.equal((await response).status, 503);
  let closed = false; const close = f.catalog.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); held.resolve(); await close;
  assert.equal(f.nativeCalls(), 1);
});

test('malformed worker reply fails closed and cannot start native discovery', async t => {
  const f = await fixture(t); f.hook(async () => ({ readerId: 'forged', unexpected: true }));
  await assert.rejects(f.catalog.models({ authorization: f.authorization }));
  assert.equal(f.nativeCalls(), 0);
});

test('disabled runtime retains original models/skills status before local session absence', async t => {
  const f = await fixture(t); f.disable(); f.remove();
  assert.deepEqual(await f.catalog.models({ authorization: f.authorization }), { error: 404 });
  assert.deepEqual(await f.catalog.skills({ authorization: f.authorization, key }), { error: 409 });
  assert.equal(f.nativeCalls(), 0);
});

test('HTTP abort does not release an already accepted native catalog read', async t => {
  const f = await fixture(t), held = deferred(), entered = deferred();
  f.onCleanup(() => held.resolve());
  f.nativeHook(async () => { entered.resolve(); await held.promise; });
  const app = new Hono(); registerCodexCatalogHttp(app, '/connector', { catalog: f.catalog });
  const controller = new AbortController();
  const response = app.request('/connector/models/codex', { headers: { authorization: f.authorization }, signal: controller.signal });
  await entered.promise; controller.abort();
  assert.equal((await response).status, 503);
  let closed = false; const closing = f.catalog.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); held.resolve(); await closing;
  assert.equal(f.nativeCalls(), 1);
});

test('input mutation cannot change original catalog authority while admission is pending', async t => {
  const f = await fixture(t), held = deferred(), entered = deferred(); f.onCleanup(() => held.resolve());
  f.hook(async (kind, run) => { if (kind === 'codexCatalogAuthorize') { entered.resolve(); await held.promise; } return run(); });
  const input = { authorization: f.authorization, key };
  const work = f.catalog.skills(input);
  await entered.promise; input.authorization = f.denied; input.key = 'codex:changed'; held.resolve();
  assert.ok('value' in await work); assert.equal(f.nativeCalls(), 1);
});
