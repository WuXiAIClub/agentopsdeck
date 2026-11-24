import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { validAutomationConfigurationReceipt, validAutomationConfigurationView, type AutomationConfiguration } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncAutomationConfiguration } from './async-automation-configuration.js';
import { registerAsyncConnectorAutomation } from './async-automation-http.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorAutomationInput, validConnectorAutomationOutput } from './connector-automation-domain.js';

const silence = new PerformanceDiagnostics(() => {});
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await delay(5); }
  assert.fail('original automation boundary not reached');
}
async function fixture(t: test.TestContext, options: { timeoutMs?: number; seed?: (db: DatabaseSync) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'automation-configuration-owned-'));
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    try { for (const close of cleanup.reverse()) try { await close(); } catch (error) { errors.push(error); } }
    finally { rmSync(directory, { recursive: true, force: true }); }
    if (errors.length) throw new AggregateError(errors, 'Isolated automation cleanup failed');
  });
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'isolated-automation' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const credential = tokens.create({ label: 'original', scopes: ['automation:manage', 'messages:send'] });
  const actor = credential.record.id, authorization = `Bearer ${credential.token}`;
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  let nodeId: string;
  try { nodeId = seed.nodeId; } finally { seed.close(); }
  if (options.seed) { const db = new DatabaseSync(config.file); try { options.seed(db); } finally { db.close(); } }
  let owner: AsyncConnectorOwner, configuration: AsyncAutomationConfiguration;
  let hook: ((kind: string, run: () => Promise<any>) => Promise<any>) | undefined;
  const observations: unknown[] = [], diagnostics = new PerformanceDiagnostics(row => observations.push(row));
  const open = async () => {
    owner = new AsyncConnectorOwner(config, silence); const physicalOwner = owner;
    cleanup.push(() => physicalOwner.close()); await owner.open();
    const port = { command: (async (kind: any, input: any) => {
      const run = () => owner.command(kind, input); return hook ? hook(kind, run) : run();
    }) as AsyncConnectorOwner['command'] };
    configuration = new AsyncAutomationConfiguration(port, nodeId, diagnostics); const originalConfiguration = configuration;
    cleanup.push(() => originalConfiguration.close());
  };
  await open();
  const app = new Hono();
  // Accessors deliberately follow the current reopened instance.
  registerAsyncConnectorAutomation(app, '/automation', { configuration: {
    authority: input => configuration.authority(input), view: input => configuration.view(input),
    original: input => configuration.original(input), configure: input => configuration.configure(input),
  }, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  const save = (overrides: Record<string, unknown> = {}, expectedRevision = 0): AutomationConfiguration => ({
    kind: 'save', rule: { id: 'rule', revision: 1, authorityEpoch: 1,
      target: { ownerId: actor, connectionId: nodeId, runtime: 'codex', sessionId: 'codex:session' }, enabled: false,
      startsAt: 1000, expiresAt: 1_000_000, maxSends: 2, maxPerHour: 2, minIntervalMs: 60_000,
      mode: { kind: 'interval', intervalMs: 60_000 }, ...overrides }, template: 'PRIVATE original template', expectedRevision, confirmEnable: false,
  } as AutomationConfiguration);
  const request = (path = '', body?: unknown, auth = authorization) => app.request(`/automation${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { actor, nodeId, authorization, config, tokens, app, request, save, observations,
    get owner() { return owner; }, get configuration() { return configuration; },
    hook(value: typeof hook) { hook = value; },
    defer(close: () => unknown | Promise<unknown>) { cleanup.push(close); },
    async reopen() { await configuration.close(); await owner.close(); await open(); },
    async inspect(read: (db: DatabaseSync) => void) { await configuration.close(); await owner.close();
      const db = new DatabaseSync(config.file); try { read(db); } finally { db.close(); } },
  };
}

test('real HTTP / worker preserves view, immutable original and exact duplicate without dispatch', async t => {
  const f = await fixture(t);
  const empty = await f.request(); assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { ownerId: f.actor, connectionId: f.nodeId, rules: [] });
  const response = await f.request('/configuration/original', f.save()); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const receipt = await response.json(); assert.ok(validAutomationConfigurationReceipt(receipt));
  assert.deepEqual(await (await f.request('/configuration/original', f.save())).json(), receipt);
  assert.deepEqual(await (await f.request('/configuration/original')).json(), receipt);
  const view = await (await f.request()).json(); assert.ok(validAutomationConfigurationView(view)); assert.equal(view.rules.length, 1);
  assert.equal((await f.request('/configuration/original', { ...f.save(), template: 'different' })).status, 409);
  assert.equal((await f.request('/configuration/missing')).status, 404);
  await f.reopen(); assert.deepEqual(await (await f.request('/configuration/original')).json(), receipt);
  await f.inspect(db => {
    const reservations = db.prepare("SELECT name FROM sqlite_master WHERE name='automation_reservations'").get();
    if (reservations) assert.equal(db.prepare('SELECT count(*) n FROM automation_reservations').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM automation_configuration_receipts').get()!.n, 1);
  });
});

test('worker verifies current raw scopes, owner isolation and session target authority', async t => {
  const f = await fixture(t); assert.equal((await f.request('/configuration/original', f.save())).status, 200);
  assert.equal((await f.request('', undefined, 'Bearer wrong')).status, 401);
  for (const scopes of [[], ['automation:manage'], ['messages:send']] as const) {
    const other = await f.owner.command('tokenCreate', { label: 'insufficient', scopes: [...scopes] });
    assert.equal((await f.request('', undefined, `Bearer ${other.token}`)).status, 403);
  }
  const other = await f.owner.command('tokenCreate', { label: 'other', scopes: ['automation:manage', 'messages:send'] });
  assert.equal((await f.request('/configuration/original', undefined, `Bearer ${other.token}`)).status, 404);
  assert.deepEqual((await (await f.request('', undefined, `Bearer ${other.token}`)).json() as any).rules, []);
  const original = f.save(); assert.equal(original.kind, 'save'); if (original.kind !== 'save') return;
  for (const target of [{ ...original.rule.target, ownerId: other.record.id }, { ...original.rule.target, connectionId: 'foreign-node' },
    { ...original.rule.target, sessionId: 'claude:foreign' }, { ...original.rule.target, runtime: 'claude' }]) {
    const response = await f.request('/configuration/foreign', { ...original, rule: { ...original.rule, target } });
    assert.ok([400, 403, 409].includes(response.status));
  }
  await f.owner.command('tokenRevoke', { tokenId: f.actor }); assert.equal((await f.request()).status, 401);
});

test('explicit enable confirmation, CAS and durable revoke preserve the original frontend contract', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/configuration/enable', f.save({ enabled: true }))).status, 409);
  const enabled = { ...f.save({ enabled: true }), confirmEnable: true };
  assert.equal((await f.request('/configuration/enable', enabled)).status, 200);
  assert.equal((await f.request('/configuration/stale', f.save({ revision: 3, authorityEpoch: 3 }, 2))).status, 409);
  const action = { kind: 'revoke', ruleId: 'rule', expectedRevision: 1 };
  const response = await f.request('/configuration/revoke', action); assert.equal(response.status, 200);
  const receipt = await response.json(); assert.ok(validAutomationConfigurationReceipt(receipt)); assert.equal(receipt.result.revoked, true);
  await f.reopen(); assert.deepEqual(await (await f.request('/configuration/revoke', action)).json(), receipt);
  assert.equal((await (await f.request()).json() as any).rules[0].revoked, true);
});

test('POST rechecks authority after body consumption; a revoked caller cannot commit', async t => {
  const f = await fixture(t), started = gate(), body = gate();
  f.defer(() => body.release());
  const stream = new ReadableStream<Uint8Array>({ async start(controller) {
    await body.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify(f.save()))); controller.close();
  } });
  f.hook(async (kind, run) => { const result = await run(); if (kind === 'automationAuthority') started.release(); return result; });
  const response = f.app.request(new Request('http://localhost/automation/configuration/original', {
    method: 'POST', headers: { authorization: f.authorization }, body: stream, duplex: 'half',
  } as RequestInit));
  await started.promise; await f.owner.command('tokenRevoke', { tokenId: f.actor }); body.release(); assert.equal((await response).status, 401);
  await f.inspect(db => assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='automation_configuration_receipts'").get()!.n, 0));
});

test('revocation after commit suppresses reply, does not undo or replay the original transaction', async t => {
  const f = await fixture(t); let writes = 0;
  f.hook(async (kind, run) => { const value = await run(); if (kind === 'automationConfigure') {
    writes++; await f.owner.command('tokenRevoke', { tokenId: f.actor }); } return value; });
  const response = await f.request('/configuration/original', f.save()); assert.equal(response.status, 401);
  assert.equal(writes, 1); assert.doesNotMatch(await response.text(), /PRIVATE|templateHash/);
  await f.inspect(db => {
    const rows = db.prepare('SELECT payload FROM automation_configuration_receipts').all(); assert.equal(rows.length, 1);
    const receipt = JSON.parse(String(rows[0]!.payload)); assert.equal(receipt.requestId, 'original');
    assert.equal(db.prepare('SELECT count(*) n FROM automation_rules').get()!.n, 1);
  });
});

test('HTTP timeout does not release physical work; close drains original commit, reopen only reads it', async t => {
  const f = await fixture(t, { timeoutMs: 150 }), blocked = gate(); f.defer(() => blocked.release()); let writes = 0, reached = false;
  f.hook(async (kind, run) => { const result = await run(); if (kind === 'automationConfigure') { writes++; reached = true; await blocked.promise; } return result; });
  const response = f.request('/configuration/original', f.save()); await until(() => reached);
  assert.equal((await response).status, 503);
  let closed = false; const close = f.configuration.close().then(() => { closed = true; });
  await delay(10); assert.equal(closed, false);
  await assert.rejects(f.configuration.view({ authorization: f.authorization }), ConnectorOwnerUnavailable);
  blocked.release(); await close; assert.equal(writes, 1); f.hook(undefined); await f.reopen();
  assert.equal((await f.request('/configuration/original')).status, 200); assert.equal(writes, 1);
});

test('close drains the physical configuration read even when the public waiter then is replaced', async t => {
  const f = await fixture(t), blocked = gate(); f.defer(() => blocked.release()); let reached = false;
  f.hook(async (kind, run) => {
    const result = await run();
    if (kind === 'automationConfigurationView') { reached = true; await blocked.promise; }
    return result;
  });
  const visible = f.configuration.view({ authorization: f.authorization });
  const settled = Promise.prototype.then.call(visible, () => {}, () => {});
  await until(() => reached);
  Object.defineProperty(visible, 'then', { value: () => Promise.resolve() });
  let closed = false;
  const closing = f.configuration.close().then(() => { closed = true; });
  await delay(10); assert.equal(closed, false);
  blocked.release(); await settled; await closing; assert.equal(closed, true);
});

test('receipt insertion failure atomically rolls back configuration and leaves worker readable', async t => {
  const f = await fixture(t, { seed(db) {
    db.exec("CREATE TABLE automation_configuration_receipts(owner TEXT NOT NULL,request TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,request)); CREATE TRIGGER fixture_reject BEFORE INSERT ON automation_configuration_receipts BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;");
  } });
  assert.equal((await f.request('/configuration/original', f.save())).status, 503);
  assert.equal((await f.request('/configuration/original')).status, 404);
  const view = await (await f.request()).json(); assert.ok(validAutomationConfigurationView(view)); assert.equal(view.rules.length, 0);
});

test('legacy views larger than one MiB remain readable without changing the frontend wire format', async t => {
  const f = await fixture(t);
  // Fixtures use original worker transactions, never a main-thread live DB.
  for (let index = 0; index < 45; index++) {
    const body = { ...f.save({ id: `rule-${String(index).padStart(3, '0')}` }), template: '测'.repeat(8192) };
    const result = await f.configuration.configure({ authorization: f.authorization, requestId: `save-${index}`, configuration: body });
    assert.equal(result.ok, true);
  }
  const response = await f.request(); assert.equal(response.status, 200);
  const text = await response.text(); assert.ok(Buffer.byteLength(text) > 1024 * 1024);
  const view = JSON.parse(text); assert.ok(validAutomationConfigurationView(view)); assert.equal(view.rules.length, 45);
});

for (const corruption of ['requestId', 'ownerId', 'connectionId', 'shape'] as const) test(`configuration rejects valid-looking foreign ${corruption} reply`, async t => {
  const f = await fixture(t);
  f.hook(async (kind, run) => {
    const value = await run(); if (kind !== 'automationConfigure' || !value.ok) return value;
    if (corruption === 'shape') return { ...value, unexpected: true };
    const next = structuredClone(value);
    if (corruption === 'requestId') next.value.requestId = 'foreign';
    else next.value.result.rule.target[corruption] = 'foreign';
    return next;
  });
  const response = await f.request('/configuration/original', f.save()); assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /PRIVATE/);
  f.hook(undefined); assert.equal((await f.request('/configuration/original')).status, 200);
});

test('strict envelopes, malformed bodies and forbidden HTTP execution grants fail closed', async t => {
  const f = await fixture(t);
  assert.equal(validConnectorAutomationInput('automationConfigure', { authorization: f.authorization, requestId: 'a', configuration: f.save(), unexpected: true }), false);
  assert.equal(validConnectorAutomationOutput('automationAuthority', { ok: true, value: { ownerId: 'a', connectionId: 'b', extra: true } }), false);
  assert.equal((await f.request('/configuration/bad', { ...f.save(), arbitrary: true })).status, 400);
  assert.equal((await f.app.request('/automation/configuration/bad', { method: 'POST', headers: { authorization: f.authorization }, body: '{' })).status, 400);
  assert.equal((await f.app.request('/automation', { headers: { authorization: f.authorization, 'x-agentopsdeck-execution-grant': 'forbidden' } })).status, 403);
  assert.equal((await f.request('/configuration/too-large', { ...f.save(), template: 'x'.repeat(50 * 1024) })).status, 413);
});

test('diagnostics contain numeric stages, not raw identity, request or template', async t => {
  const f = await fixture(t); assert.equal((await f.request('/configuration/PRIVATE-REQUEST', f.save())).status, 200);
  await f.configuration.view({ authorization: f.authorization });
  const logs = JSON.stringify(f.observations); assert.match(logs, /connector-sqlite-command/); assert.match(logs, /275/);
  for (const secret of [f.authorization, f.actor, f.nodeId, 'PRIVATE-REQUEST', 'PRIVATE original template']) assert.equal(logs.includes(secret), false);
});
