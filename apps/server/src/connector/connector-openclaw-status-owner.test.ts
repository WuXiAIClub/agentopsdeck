import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncOpenClawStatus } from './async-openclaw-status.js';
import { AsyncOpenClawMessages } from './async-openclaw-messages.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { validConnectorOpenClawStatusInput, validConnectorOpenClawStatusOutput,
  type OpenClawStatusDisplay, type OpenClawStatusResult } from './connector-openclaw-status-domain.js';
import { registerOpenClawMessagesHttp } from './openclaw-messages-http.js';

const token = 'isolated-openclaw-status-token', authorization = `Bearer ${token}`, key = 'agent:main:dashboard:original';
const silent = new PerformanceDiagnostics(() => {}), wait = { timeoutMs: 10_000 };
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Options = ConstructorParameters<typeof AsyncOpenClawStatus>[0];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-status-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token, silent);
  const store = new ConnectorUserStore(':memory:', id => !!tokens.delegationHubId(id), { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens);
  store.openClawExecutions.begin(key, 'original-command');
  store.openClawExecutions.bindGatewayConnection(key, 'original-command', 'original-connection');
  store.openClawExecutions.acknowledge(key, 'original-command', 'original-native');
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId, scope = { key, authorization, commandKey: 'original-status' };
  const request = { ...scope, payloadJson: JSON.stringify({ message: ' /status ', metadata: 'original-private-fingerprint' }) };
  let display: OpenClawStatusDisplay = { gateway: 'connected', connectionId: 'original-connection', session: { model: 'original-model', totalTokens: 123 } };
  const projected = new Map<string, unknown>();
  const options: Options = { owner: { command }, display: () => display, project: messages => { for (const m of messages) projected.set(m.id, m); }, diagnostics: silent };
  const status = new AsyncOpenClawStatus(options);
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { directory, tokens, store, command, actor, scope, request, options, status, projected, db,
    display: (value: OpenClawStatusDisplay) => { display = value; },
    receipt: () => store.commands.get(JSON.stringify([actor, key]), scope.commandKey),
    async close() { await status.close(); command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function result(value: unknown): OpenClawStatusResult {
  assert.ok(validConnectorOpenClawStatusOutput('openClawStatus', value) && value && typeof value === 'object' && 'receipt' in value);
  return value as OpenClawStatusResult;
}

test('status commits immutable original report/receipt; duplicate never changes execution, queue or fingerprint', async () => {
  const f = fixture();
  try {
    const before = f.store.openClawExecutions.get(key);
    await f.store.turns.enqueueAsync('openclaw', { id: 'successor', sessionKey: key, createdAt: 1, payload: { actorId: f.actor, message: 'queued' } });
    const first = result(await f.status.send(f.request, wait));
    assert.equal(first.receipt?.state, 'accepted'); assert.ok(first.report);
    assert.match(first.report[1].text, /original-model/); assert.match(first.report[1].text, /123/);
    assert.match(first.report[1].text, /Execution: starting/); assert.match(first.report[1].text, /Active run: yes/);
    assert.equal(f.projected.size, 0);
    f.display({ gateway: 'disconnected', connectionId: null, session: { model: 'changed' } }); f.store.pauseTurnStarts();
    assert.deepEqual(await f.status.send(f.request, wait), first);
    assert.deepEqual(await f.status.readForSend(f.scope, wait), first); assert.equal(f.projected.size, 2);
    assert.deepEqual(await f.status.read(f.scope, wait), first); assert.equal(f.projected.size, 2);
    assert.deepEqual(f.store.openClawExecutions.get(key), before); assert.equal(f.store.turns.list('openclaw', key).length, 1);
    assert.deepEqual(await f.status.send({ ...f.request, payloadJson: '{"message":"/status","metadata":"changed"}' }, wait), { error: 409 });
    const other = f.tokens.create({ label: 'other', scopes: ['messages:read', 'messages:send'] });
    assert.equal(result(await f.status.read({ ...f.scope, authorization: `Bearer ${other.token}` }, wait)).receipt, null);
  } finally { await f.close(); }
});

test('current worker execution and independent history sync override any caller display status', async () => {
  const f = fixture();
  try {
    f.store.openClawExecutions.observe(key, { runId: 'original-native', phase: 'completed', gatewayConnectionId: 'original-connection' });
    const revision = f.store.openClawExecutions.get(key)!.historySync!.revision;
    f.store.openClawExecutions.setHistorySync(key, revision, 'error');
    f.store.openClawExecutions.begin(key, 'successor-command', undefined, 'original-connection');
    f.store.openClawExecutions.acknowledge(key, 'successor-command', 'successor-native');
    const first = result(await f.status.send(f.request, wait)); assert.ok(first.report);
    assert.match(first.report[1].text, /Execution: starting/); assert.match(first.report[1].text, /Response sync: error/);
    f.display({ gateway: 'connected', connectionId: 'replacement', session: {} });
    const replaced = result(await f.status.send({ ...f.request, commandKey: 'replacement' }, wait)); assert.ok(replaced.report);
    assert.match(replaced.report[1].text, /Status: unknown/); assert.match(replaced.report[1].text, /Execution: unknown/);
    const unowned = result(await f.status.send({ ...f.request, key: 'agent:main:dashboard:unmanaged', commandKey: 'unmanaged' }, wait));
    assert.ok(unowned.report); assert.match(unowned.report[1].text, /Active run: unknown/); assert.match(unowned.report[1].text, /Status: unknown/);
  } finally { await f.close(); }
});

test('schema rejects authority/display injection, undefined/extra fields, invalid payload and substituted reports', async () => {
  const f = fixture();
  try {
    const input = { ...f.request, display: f.options.display(key) };
    assert.equal(validConnectorOpenClawStatusInput('openClawStatus', input), true);
    for (const extra of [{ actorId: f.actor }, { rejectFresh: undefined }, { intent: undefined }, { sql: 'SELECT 1' }])
      assert.equal(validConnectorOpenClawStatusInput('openClawStatus', { ...input, ...extra }), false);
    for (const extra of [{ status: 'idle' }, { execution: { phase: 'completed' } }, { permissions: true }])
      assert.equal(validConnectorOpenClawStatusInput('openClawStatus', { ...input, display: { ...input.display, ...extra } }), false);
    for (const display of [{ ...input.display, session: { hasActiveRun: false } }, { ...input.display, session: [] }, { ...input.display, connectionId: '' }])
      assert.equal(validConnectorOpenClawStatusInput('openClawStatus', { ...input, display }), false);
    assert.equal(validConnectorOpenClawStatusInput('openClawStatusRead', { ...f.scope, payloadJson: undefined }), false);
    assert.equal(validConnectorOpenClawStatusInput('openClawStatus', { ...input, payloadJson: '{"idempotencyKey":"forged","message":"/status"}' }), false);
    const value = result(await f.status.send(f.request, wait)); assert.ok(value.report);
    assert.equal(validConnectorOpenClawStatusOutput('openClawStatus', { ...value, report: [value.report[0], { ...value.report[1], sessionKey: 'foreign' }] }), false);
    assert.equal(validConnectorOpenClawStatusOutput('openClawStatus', { ...value, receipt: { ...value.receipt,
      result: { status: 200, body: { ...value.receipt!.result!.body, deliver: true } } } }), false);
  } finally { await f.close(); }
});

test('current original send/read scopes and pinned node are checked before admission and delivery', async () => {
  const f = fixture();
  try {
    for (const scopes of [['messages:send'], ['messages:read'], ['messages:send', 'messages:read', 'execution:delegate']] as const) {
      const actor = f.tokens.create({ label: 'limited', scopes: [...scopes] });
      assert.deepEqual(await f.status.send({ ...f.request, authorization: `Bearer ${actor.token}` }, wait), { error: 403 });
    }
    assert.deepEqual(await f.status.send({ ...f.request, expectedNode: 'foreign-node' }, wait), { error: 403 });
    assert.equal(f.receipt(), undefined);
    await f.status.send(f.request, wait); f.tokens.revoke(f.actor);
    assert.deepEqual(await f.status.readForSend(f.scope, wait), { error: 401 });
    assert.deepEqual(await f.status.read(f.scope, wait), { error: 401 }); assert.equal(f.projected.size, 0);
    const reader = f.tokens.create({ label: 'reader', scopes: ['messages:read'] });
    assert.equal(result(await f.status.read({ ...f.scope, authorization: `Bearer ${reader.token}` }, wait)).receipt, null);
    assert.deepEqual(await f.status.readForSend({ ...f.scope, authorization: `Bearer ${reader.token}` }, wait), { error: 403 });
  } finally { await f.close(); }
});

for (const [payload, code] of [[{ message: 'ordinary' }, 400], [{ message: '/status', deliveryMode: 'mirror' }, 409],
  [{ message: '/status', media: [{ dataUrl: 'data:text/plain;base64,YQ==' }] }, 400]] as const)
test(`known local control rejection ${JSON.stringify(payload)} does not change execution`, async () => {
  const f = fixture();
  try {
    const before = f.store.openClawExecutions.get(key), value = result(await f.status.send({ ...f.request, payloadJson: JSON.stringify(payload) }, wait));
    assert.equal(value.receipt?.state, 'rejected'); assert.equal(value.receipt.result?.status, code); assert.equal(value.report, null);
    assert.deepEqual(f.store.openClawExecutions.get(key), before);
  } finally { await f.close(); }
});

test('missing session rejects without inventing idle or private report', async () => {
  const f = fixture();
  try {
    f.display({ ...f.options.display(key), session: null });
    const value = result(await f.status.send(f.request, wait)); assert.equal(value.receipt?.result?.status, 404); assert.equal(value.report, null);
  } finally { await f.close(); }
});

test('original deletion fence rejects status without changing its original execution fact', async () => {
  const f = fixture();
  try {
    const before = f.store.openClawExecutions.get(key), deletion = JSON.stringify(['delete', JSON.stringify([f.actor, key])]);
    f.store.commands.claim(deletion, 'original-delete', {});
    const value = result(await f.status.send(f.request, wait));
    assert.equal(value.receipt?.result?.status, 409); assert.equal(value.report, null);
    assert.deepEqual(f.store.openClawExecutions.get(key), before); assert.equal(f.projected.size, 0);
  } finally { await f.close(); }
});

test('receipt settlement failure rolls back report and receipt in the original transaction', async () => {
  const f = fixture();
  try {
    f.db.exec(`CREATE TRIGGER fail_status BEFORE UPDATE OF state ON command_receipts BEGIN SELECT RAISE(ABORT, 'isolated status failure'); END`);
    await assert.rejects(f.status.send(f.request, wait));
    assert.equal(result(await f.status.read(f.scope, wait)).receipt, null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n, 0);
    assert.equal(f.db.isTransaction, false);
  } finally { await f.close(); }
});

test('unknown and old accepted receipts are read-only; no replacement local report', async () => {
  const f = fixture();
  try {
    const scope = JSON.stringify([f.actor, key]), old = f.store.commands.claim(scope, f.scope.commandKey, JSON.parse(f.request.payloadJson));
    const unknown = result(await f.status.send(f.request, wait)); assert.deepEqual(unknown.receipt, old.receipt); assert.equal(unknown.report, null);
    f.store.commands.settle(scope, f.scope.commandKey, { status: 200, body: { legacy: true } });
    const accepted = result(await f.status.send(f.request, wait)); assert.deepEqual(accepted.receipt?.result?.body, { legacy: true }); assert.equal(accepted.report, null);
  } finally { await f.close(); }
});

test('projection failure and lost commit ACK recover only the original report without new execution', async () => {
  const f = fixture(); let lost = true, broken = true;
  const status = new AsyncOpenClawStatus({ ...f.options, owner: { command: async (kind, input) => {
    const value = await f.command(kind, input); if (kind === 'openClawStatus' && lost) { lost = false; throw Error('lost commit ACK'); } return value;
  } }, project: messages => { if (broken) throw Error('isolated projection failure'); f.options.project(messages); } });
  try {
    await assert.rejects(status.send(f.request, wait)); assert.equal(f.receipt()?.state, 'accepted');
    await assert.rejects(status.read(f.scope, wait)); assert.equal(f.projected.size, 0);
    broken = false; const restored = result(await status.read(f.scope, wait)); assert.ok(restored.report); assert.equal(f.projected.size, 2);
    assert.deepEqual(result(await status.send(f.request, wait)), restored);
    assert.equal(f.store.openClawExecutions.get(key)?.commandId, 'original-command');
  } finally { await status.close(); await f.close(); }
});

test('logical cancellation does not release physical capacity or close before original SQL completion', async () => {
  const f = fixture(), entered = deferred<void>(), finish = deferred<void>(), controller = new AbortController(); let calls = 0, closed = false;
  const status = new AsyncOpenClawStatus({ ...f.options, owner: { command: async (kind, input) => {
    if (kind === 'openClawStatus') { calls++; entered.resolve(); await finish.promise; } return f.command(kind, input);
  } } });
  try {
    const task = status.send(f.request, { ...wait, signal: controller.signal }), rejected = assert.rejects(task);
    await entered.promise; controller.abort(); await rejected;
    const close = status.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    await assert.rejects(status.send(f.request, wait)); assert.equal(calls, 1);
    finish.resolve(); await close; assert.equal(f.receipt()?.state, 'accepted'); assert.equal(f.projected.size, 0);
    assert.equal(result(await f.status.read(f.scope, wait)).receipt?.state, 'accepted'); assert.equal(f.projected.size, 2);
  } finally { finish.resolve(); await status.close(); await f.close(); }
});

test('bounded physical slots return only after worker completion and input is pinned before await', async () => {
  const f = fixture(), finish = deferred<void>(); let calls = 0;
  const status = new AsyncOpenClawStatus({ ...f.options, owner: { command: async (kind, input) => {
    if (kind === 'openClawStatus') { calls++; await finish.promise; } return f.command(kind, input);
  } } });
  try {
    const mutable = { ...f.request }, first = status.send(mutable, wait); mutable.payloadJson = '{"message":"changed"}';
    const rest = Array.from({ length: 127 }, () => status.send(f.request, wait));
    while (calls < 128) await tick(); await assert.rejects(status.send(f.request, wait)); assert.equal(calls, 128);
    finish.resolve(); const values = await Promise.all([first, ...rest]); assert.ok(values.every(v => result(v).receipt?.state === 'accepted'));
    assert.equal(result(await status.send(f.request, wait)).receipt?.state, 'accepted');
  } finally { finish.resolve(); await status.close(); await f.close(); }
});

test('logical deadline and throwing diagnostics cannot drop physical work or generate a second report', async () => {
  const f = fixture(), entered = deferred<void>(), finish = deferred<void>(); let closed = false;
  const status = new AsyncOpenClawStatus({ ...f.options, diagnostics: new PerformanceDiagnostics(() => { throw Error('isolated sink'); }),
    owner: { command: async (kind, input) => { entered.resolve(); await finish.promise; return f.command(kind, input); } } });
  try {
    const task = assert.rejects(status.send(f.request, { timeoutMs: 20 }), { reason: 'deadline', outcome: 'unknown' });
    await entered.promise; await task;
    const close = status.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    finish.resolve(); await close;
    const restored = result(await f.status.read(f.scope, wait)); assert.ok(restored.report); assert.equal(f.projected.size, 2);
    assert.deepEqual(result(await f.status.send(f.request, wait)), restored);
  } finally { finish.resolve(); await status.close(); await f.close(); }
});

test('HTTP status uses original wire/recovery, no legacy middleware; media controls retain original ordinary lane', async () => {
  const f = fixture(); let fallback = 0, effects = 0;
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true, sessionExists: () => true,
    admitted: () => {}, persist: async () => { effects++; return [{ filePath: '/isolated/original.txt', media: { type: 'file', name: 'original.txt', url: '/api/media/inbound/original.txt' } }]; }, diagnostics: silent });
  const app = new Hono(), route = '/api/sessions/:sessionKey', path = `/api/sessions/${encodeURIComponent(key)}`;
  registerOpenClawMessagesHttp(app, route, { messages, status: f.status, ready: () => true, diagnostics: silent });
  app.post(`${route}/messages`, c => { fallback++; return c.json({ legacy: true }); });
  const post = (body: unknown) => app.request(`${path}/messages`, { method: 'POST', headers: { authorization }, body: JSON.stringify(body) });
  try {
    const payload = { ...JSON.parse(f.request.payloadJson), idempotencyKey: f.scope.commandKey };
    const first = await post(payload); assert.equal(first.status, 200); const body = await first.json();
    assert.equal(body.status, 'ok'); assert.equal(body.deliver, false); assert.equal(body.deliveryMode, 'web-only'); assert.equal(body.command.key, f.scope.commandKey);
    assert.equal(f.projected.size, 2); assert.equal(fallback, 0); assert.equal(effects, 0);
    assert.deepEqual(await (await post(payload)).json(), body);
    f.projected.clear(); const get = await app.request(`${path}/commands/${f.scope.commandKey}`, { headers: { authorization } });
    assert.equal(get.status, 200); assert.equal((await get.json()).command.id, body.command.id); assert.equal(f.projected.size, 2);
    for (const control of ['/status', '/compact']) {
      const media = { message: control, media: [{ dataUrl: 'data:text/plain;base64,YQ==' }], idempotencyKey: control.slice(1) };
      assert.equal((await post(media)).status, 200); assert.equal((await post(media)).status, 200);
    }
    assert.equal(effects, 2); assert.equal(fallback, 0);
    const ordinaryQueue = await app.request(`${path}/commands/status/queue`, { headers: { authorization } });
    assert.equal(ordinaryQueue.status, 200); assert.equal((await ordinaryQueue.json()).queue.presence, 'present');
    assert.equal((await app.request(`${path}/commands/status`, { headers: { authorization } })).status, 200);
    assert.equal((await post({ message: '/status', deliveryMode: 'mirror', idempotencyKey: 'mirror' })).status, 409);
    assert.equal((await post({ message: '/compact', idempotencyKey: 'compact-control' })).status, 200); assert.equal(fallback, 1);
  } finally { await messages.close(); await f.close(); }
});

test('real worker restart restores immutable original status report and no execution completion is fabricated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-status-worker-')), file = join(directory, 'original.sqlite'), tokenFile = join(directory, 'tokens.json');
  new ConnectorTokenStore(tokenFile, token, silent);
  const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true }); seed.openClawExecutions.begin(key, 'original-command'); seed.close();
  let owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent);
  const scope = { key, authorization, commandKey: 'worker-status' };
  try {
    await owner.open(); const first = result(await owner.command('openClawStatus', { ...scope, payloadJson: '{"message":"/status"}',
      display: { gateway: 'disconnected', connectionId: null, session: { model: 'original-model' } } }));
    assert.ok(first.report); await owner.close();
    owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent); await owner.open();
    assert.deepEqual(await owner.command('openClawStatusRead', scope), first);
    const duplicate = await owner.command('openClawStatus', { ...scope, payloadJson: '{"message":"/status"}',
      display: { gateway: 'connected', connectionId: 'replacement', session: { model: 'changed' } } });
    assert.deepEqual(duplicate, first); assert.equal((await owner.command('openClawExecutionRead', { sessionKey: key }))?.commandId, 'original-command');
  } finally { await owner.closeForShutdown(); rmSync(directory, { recursive: true, force: true }); }
});
