import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { claimOpenClawOwnerTurn } from './openclaw-owner-test-fixture.js';
import { AsyncOpenClawMessages } from './async-openclaw-messages.js';
import { AsyncOpenClawStop } from './async-openclaw-stop.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { validConnectorOpenClawStopInput, validConnectorOpenClawStopOutput } from './connector-openclaw-stop-domain.js';
import { registerOpenClawMessagesHttp } from './openclaw-messages-http.js';

const token = 'isolated-openclaw-stop-token', authorization = `Bearer ${token}`, key = 'agent:main:dashboard:original';
const silent = new PerformanceDiagnostics(() => {}), wait = { timeoutMs: 10_000 };
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Options = ConstructorParameters<typeof AsyncOpenClawStop>[0];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-stop-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token, silent);
  const store = new ConnectorUserStore(':memory:', id => !!tokens.delegationHubId(id), { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens);
  store.openClawExecutions.begin(key, 'original-command');
  store.openClawExecutions.bindGatewayConnection(key, 'original-command', 'original-connection');
  store.openClawExecutions.acknowledge(key, 'original-command', 'original-native');
  const scope = { key, authorization, commandKey: 'original-stop' };
  const request = { ...scope, payloadJson: JSON.stringify({ message: '/stop', expectedRunId: 'original-command' }) };
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  let connection: string | undefined = 'original-connection', available = true, sends = 0;
  const gateway: Options['gateway'] = {
    connectionId: () => connection,
    requestBound: async <T>(method: string, params: Record<string, unknown>, expected?: string, before?: () => void) => {
      assert.equal(method, 'chat.abort'); assert.equal(expected, 'original-connection');
      assert.deepEqual(params, { sessionKey: key, runId: 'original-native' });
      before?.(); sends++;
      return { connectionId: 'original-connection', payload: { ok: true, aborted: true, runIds: ['original-native'] } as T };
    },
  };
  const options: Options = { owner: { command }, gateway, available: () => available, diagnostics: silent };
  const stop = new AsyncOpenClawStop(options);
  const claim = async () => {
    const c = await command('openClawStopClaim', { ...request, connectionId: 'original-connection' });
    assert.ok('intent' in c && c.intent); return c.intent;
  };
  return { directory, store, tokens, command, scope, request, actor, gateway, options, stop, claim,
    sends: () => sends, connection: (v: string | undefined) => { connection = v; }, available: (v: boolean) => { available = v; },
    receipt: () => store.commands.get(JSON.stringify([actor, key]), scope.commandKey),
    async close() { await stop.close(); command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('stop protocol rejects extraneous authority, explicit undefined fields and malformed output', async () => {
  const f = fixture();
  try {
    const intent = await f.claim();
    const claim = { ...f.request, connectionId: 'original-connection' };
    assert.equal(validConnectorOpenClawStopInput('openClawStopClaim', claim), true);
    for (const extra of [{ intent: undefined }, { actorId: 'forged' }, { authorized: true }, { key: 'hermes:foreign' }, { rejectFresh: 'runtime_unavailable' }, { defaultAgentId: 'forged' }])
      assert.equal(validConnectorOpenClawStopInput('openClawStopClaim', { ...claim, ...extra }), false);
    for (const extra of [{ payloadJson: undefined }, { connectionId: undefined }, { actorId: 'forged' }])
      assert.equal(validConnectorOpenClawStopInput('openClawStopReady', { ...f.scope, intent, ...extra }), false);
    assert.equal(validConnectorOpenClawStopOutput('openClawStopSettle', { error: 403 }), false);
    assert.equal(validConnectorOpenClawStopOutput('openClawStopClaim', { result: { error: 403 }, intent: null }), false);
  } finally { await f.close(); }
});

test('original run-bound stop ACK settles receipt only; duplicate is read-only and fingerprint immutable', async () => {
  const f = fixture();
  try {
    await f.store.turns.enqueueAsync('openclaw', { id: 'successor', sessionKey: key, createdAt: 1,
      payload: { actorId: f.actor, message: 'successor', media: [], deliveryMode: 'web-only' } });
    const fact = f.store.openClawExecutions.get(key), turns = f.store.turns.list('openclaw', key);
    const result = await f.stop.stop(f.request, wait); assert.ok('receipt' in result);
    assert.equal(result.receipt?.state, 'accepted');
    assert.deepEqual(result.receipt.result?.body, { ok: true, runId: 'original-command', status: 'interrupt_requested', idempotencyKey: 'original-stop', media: [] });
    assert.deepEqual(await f.stop.stop(f.request, wait), result); assert.equal(f.sends(), 1);
    assert.deepEqual(await f.stop.stop({ ...f.request, payloadJson: '{"message":"/stop","expectedRunId":"different"}' }, wait), { error: 409 });
    assert.deepEqual(f.store.openClawExecutions.get(key), fact); assert.deepEqual(f.store.turns.list('openclaw', key), turns);
  } finally { await f.close(); }
});

for (const scenario of ['missing', 'native', 'media', 'mirror', 'ordinary', 'connection', 'unavailable', 'fenced', 'completed', 'restart'] as const)
  test(`known ${scenario} never sends or releases execution facts`, async () => {
    const f = fixture();
    try {
      const body: Record<string, unknown> = { message: '/stop', expectedRunId: 'original-command' };
      if (scenario === 'missing') delete body.expectedRunId;
      if (scenario === 'native') body.expectedRunId = 'original-native';
      if (scenario === 'ordinary') body.message = 'ordinary';
      if (scenario === 'media') body.media = [{ type: 'file', dataUrl: 'data:text/plain;base64,YQ==', name: 'file.txt' }];
      if (scenario === 'mirror') body.deliveryMode = 'mirror';
      if (scenario === 'connection') f.connection('replacement');
      if (scenario === 'unavailable') f.available(false);
      if (scenario === 'fenced') f.store.openClawExecutions.observe(key, { runId: 'foreign', phase: 'running', gatewayConnectionId: 'original-connection' });
      if (scenario === 'completed') f.store.openClawExecutions.observe(key, { runId: 'original-native', phase: 'completed', gatewayConnectionId: 'original-connection' });
      if (scenario === 'restart') f.store.openClawExecutions.recoverInterrupted();
      const fact = f.store.openClawExecutions.get(key);
      const result = await f.stop.stop({ ...f.request, payloadJson: JSON.stringify(body) }, wait);
      assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'rejected'); assert.equal(f.sends(), 0);
      assert.deepEqual(f.store.openClawExecutions.get(key), fact);
    } finally { await f.close(); }
  });

test('ready is current-authority/run bound and one-shot; forged or retired capability cannot settle', async () => {
  const f = fixture();
  try {
    const intent = await f.claim();
    assert.equal(await f.command('openClawStopReady', { ...f.scope, intent: { ...intent, id: 'forged' } }), false);
    assert.equal(await f.command('openClawStopSettle', { intent, outcome: 'acknowledged' }), false);
    assert.equal(await f.command('openClawStopReady', { ...f.scope, intent }), true);
    assert.equal(await f.command('openClawStopReady', { ...f.scope, intent }), false);
    assert.equal(await f.command('openClawStopRelease', { intent: Object.fromEntries(Object.entries(intent).reverse()) as typeof intent }), true);
    assert.equal(await f.command('openClawStopSettle', { intent, outcome: 'acknowledged' }), false);
    const result = await f.stop.stop(f.request, wait); assert.ok('receipt' in result);
    assert.equal(result.receipt?.state, 'outcome_unknown'); assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

for (const change of ['revoke', 'maintenance', 'successor', 'connection', 'freeze'] as const)
  test(`authority/connection ${change} during ready wait vetoes without native replay`, async () => {
    const f = fixture(); const entered = deferred<void>(), finish = deferred<void>();
    const stop = new AsyncOpenClawStop({ ...f.options, owner: { command: async (kind, input) => {
      if (kind === 'openClawStopReady') { entered.resolve(); await finish.promise; }
      return f.command(kind, input);
    } } });
    try {
      const task = stop.stop(f.request, wait); await entered.promise;
      if (change === 'revoke') f.tokens.revoke(f.actor);
      if (change === 'maintenance') f.store.pauseTurnStarts();
      if (change === 'successor') f.store.openClawExecutions.observe(key, { runId: 'foreign', phase: 'running', gatewayConnectionId: 'original-connection' });
      if (change === 'connection') f.connection('replacement');
      if (change === 'freeze') stop.freeze();
      finish.resolve(); const result = await task; assert.ok('receipt' in result);
      assert.equal(result.receipt?.state, 'rejected'); assert.equal(f.sends(), 0);
    } finally { finish.resolve(); await stop.close(); await f.close(); }
  });

for (const payload of [null, {}, { ok: true }, { ok: true, aborted: true, runIds: [] },
  { ok: true, aborted: true, runIds: ['wrong'] }, { ok: true, aborted: true, runIds: ['original-native', 'extra'] },
  { ok: true, aborted: false, runIds: [] }]) test(`ambiguous ACK ${JSON.stringify(payload)} preserves unknown`, async () => {
  const f = fixture(); let sends = 0;
  f.gateway.requestBound = async <T>(_m: string, _p: Record<string, unknown>, _c?: string, before?: () => void) => {
    before?.(); sends++; return { connectionId: 'original-connection', payload: payload as T };
  };
  try {
    const result = await f.stop.stop(f.request, wait); assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'outcome_unknown');
    assert.deepEqual(await f.stop.stop(f.request, wait), result); assert.equal(sends, 1);
  } finally { await f.close(); }
});

for (const lost of ['openClawStopClaim', 'openClawStopReady', 'openClawStopSettle'] as const)
  test(`lost ${lost} ACK never repeats abort and preserves committed original receipt`, async () => {
    const f = fixture(); let dropped = false;
    const stop = new AsyncOpenClawStop({ ...f.options, owner: { command: async (kind, input) => {
      const result = await f.command(kind, input);
      if (kind === lost && !dropped) { dropped = true; throw Error('lost ACK'); }
      return result;
    } } });
    try {
      if (lost === 'openClawStopClaim') await assert.rejects(stop.stop(f.request, wait));
      else { const result = await stop.stop(f.request, wait); assert.ok('receipt' in result);
        assert.equal(result.receipt?.state, lost === 'openClawStopSettle' ? 'accepted' : 'rejected'); }
      const result = await f.stop.stop(f.request, wait); assert.ok('receipt' in result);
      assert.equal(result.receipt?.state, lost === 'openClawStopClaim' ? 'outcome_unknown' : lost === 'openClawStopSettle' ? 'accepted' : 'rejected');
      assert.equal(f.sends(), lost === 'openClawStopSettle' ? 1 : 0);
    } finally { await stop.close(); await f.close(); }
  });

test('logical cancellation does not end physical abort/settlement drain; revoked caller cannot recover private ACK', async () => {
  const f = fixture(), entered = deferred<void>(), finish = deferred<void>(); let sends = 0;
  f.gateway.requestBound = async <T>(_m: string, _p: Record<string, unknown>, _c?: string, before?: () => void) => {
    before?.(); sends++; entered.resolve(); await finish.promise;
    return { connectionId: 'original-connection', payload: { ok: true, aborted: true, runIds: ['original-native'] } as T };
  };
  try {
    const controller = new AbortController(); const task = f.stop.stop(f.request, { ...wait, signal: controller.signal });
    await entered.promise; controller.abort(); await assert.rejects(task);
    let closed = false; const closing = f.stop.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    f.tokens.revoke(f.actor); finish.resolve(); await closing;
    assert.equal(f.receipt()?.state, 'accepted'); assert.equal(sends, 1);
    assert.deepEqual(await f.command('openClawMessageSendReceiptRead', f.scope), { error: 401 });
    assert.equal(f.store.openClawExecutions.get(key)?.runId, 'original-native');
  } finally { finish.resolve(); await f.close(); }
});

test('HTTP stop uses original receipt wire, no legacy middleware; duplicates/GET never repeat abort', async () => {
  const f = fixture();
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true,
    sessionExists: () => true, admitted() { throw Error('stop cannot enqueue'); } });
  const app = new Hono(); registerOpenClawMessagesHttp(app, '/sessions/:sessionKey', { messages, stop: f.stop, ready: () => true });
  app.post('/sessions/:sessionKey/messages', () => { throw Error('legacy SQL bypass'); });
  const body = { message: '/stop', expectedRunId: 'original-command', idempotencyKey: f.scope.commandKey };
  const post = () => app.request(`/sessions/${key}/messages`, { method: 'POST', headers: { authorization }, body: JSON.stringify(body) });
  try {
    const response = await post(); assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.runId, 'original-command'); assert.equal(result.command.key, f.scope.commandKey);
    assert.equal(result.command.state, 'accepted'); assert.equal(result.command.result, undefined);
    assert.deepEqual(await (await post()).json(), result); assert.equal(f.sends(), 1);
    const read = await app.request(`/sessions/${key}/commands/${f.scope.commandKey}`, { headers: { authorization } });
    assert.equal(read.status, 200); assert.equal((await read.json()).command.result.body.status, 'interrupt_requested');
  } finally { await messages.close(); await f.close(); }
});

test('HTTP never delivers a private stop ACK after authority revocation, but retains physical settlement', async () => {
  const f = fixture();
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true,
    sessionExists: () => true, admitted() {} });
  const stop = { stop: async (...args: Parameters<AsyncOpenClawStop['stop']>) => {
    const result = await f.stop.stop(...args); f.tokens.revoke(f.actor); return result;
  } };
  const app = new Hono(); registerOpenClawMessagesHttp(app, '/sessions/:sessionKey', { messages, stop, ready: () => true });
  try {
    const response = await app.request(`/sessions/${key}/messages`, { method: 'POST', headers: { authorization },
      body: JSON.stringify({ message: '/stop', expectedRunId: 'original-command', idempotencyKey: f.scope.commandKey }) });
    assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), /original-native|original-command|interrupt_requested/);
    assert.equal(f.receipt()?.state, 'accepted'); assert.equal(f.sends(), 1);
  } finally { await messages.close(); await f.close(); }
});

test('node mismatch is denied before receipt creation or effect', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.stop.stop({ ...f.request, expectedNode: 'foreign-node' }, wait), { error: 403 });
    assert.equal(f.receipt(), undefined); assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

test('delegated stop stays explicitly unsupported; issuer cannot downgrade to token authority', async () => {
  const f = fixture();
  try {
    const issuer = f.tokens.create({ label: 'issuer', scopes: ['execution:delegate', 'messages:send', 'messages:read'], delegationHubId: 'hub' });
    const ref = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'policy', version: 1, runtime: 'openclaw', sessionKey: key,
      issuerTokenId: issuer.record.id, hubId: 'hub' }, ['runs:interrupt', 'messages:send'], Date.now() + 30_000);
    const request = { ...f.request, authorization: `Bearer ${issuer.token}`, grantId: ref.id, expectedNode: f.store.nodeId };
    const { grantId: _grantId, ...withoutGrant } = request;
    for (const invalid of [withoutGrant, { ...request, expectedNode: 'foreign' }, { ...request, grantId: 'foreign' }])
      assert.deepEqual(await f.stop.stop(invalid, wait), { error: 403 });
    const rejected = await f.stop.stop(request, wait); assert.ok('receipt' in rejected);
    assert.equal(rejected.receipt?.state, 'rejected'); assert.equal(rejected.receipt.result?.status, 409); assert.equal(f.sends(), 0);
    assert.equal(f.store.commands.get(JSON.stringify([issuer.record.id, key]), f.scope.commandKey), undefined);
  } finally { await f.close(); }
});

test('connection veto at actual send boundary cannot dispatch on a replacement connection', async () => {
  const f = fixture();
  f.gateway.requestBound = async (_m: string, _p: Record<string, unknown>, _c?: string, before?: () => void) => {
    f.connection('replacement'); before?.(); throw Error('not sent');
  };
  try {
    const result = await f.stop.stop(f.request, wait); assert.ok('receipt' in result);
    assert.equal(result.receipt?.state, 'rejected'); assert.equal(f.sends(), 0);
    assert.deepEqual(await f.stop.stop(f.request, wait), result);
  } finally { await f.close(); }
});

test('foreign-connection ACK remains unknown; no replacement session control is attempted', async () => {
  const f = fixture(); let sends = 0;
  f.gateway.requestBound = async <T>(_m: string, _p: Record<string, unknown>, _c?: string, before?: () => void) => {
    before?.(); sends++; return { connectionId: 'replacement', payload: { ok: true, aborted: true, runIds: ['original-native'] } as T };
  };
  try {
    const result = await f.stop.stop(f.request, wait); assert.ok('receipt' in result);
    assert.equal(result.receipt?.state, 'outcome_unknown'); assert.deepEqual(await f.stop.stop(f.request, wait), result); assert.equal(sends, 1);
  } finally { await f.close(); }
});

test('stop pins private input before awaits; broken diagnostic sink cannot replace original result', async () => {
  const f = fixture(); const diagnostics = new PerformanceDiagnostics(() => {});
  diagnostics.start = () => { throw Error('observation only'); };
  const stop = new AsyncOpenClawStop({ ...f.options, diagnostics });
  try {
    const input = { ...f.request }; const result = stop.stop(input, wait);
    input.payloadJson = '{"message":"/stop","expectedRunId":"foreign"}'; input.commandKey = 'foreign';
    const accepted = await result; assert.ok('receipt' in accepted); assert.equal(accepted.receipt?.state, 'accepted');
    assert.equal(accepted.commandKey, f.scope.commandKey); assert.equal(f.sends(), 1);
  } finally { await stop.close(); await f.close(); }
});

test('deadline is delivery-only; admitted abort eventually settles and close drains it', async () => {
  const f = fixture(), entered = deferred<void>(), finish = deferred<void>();
  f.gateway.requestBound = async <T>(_m: string, _p: Record<string, unknown>, _c?: string, before?: () => void) => {
    before?.(); entered.resolve(); await finish.promise;
    return { connectionId: 'original-connection', payload: { ok: true, aborted: true, runIds: ['original-native'] } as T };
  };
  try {
    const task = f.stop.stop(f.request, { timeoutMs: 25 });
    const rejected = assert.rejects(task); await entered.promise; await rejected;
    assert.equal(f.receipt()?.state, 'outcome_unknown');
    finish.resolve(); await f.stop.close(); assert.equal(f.receipt()?.state, 'accepted');
  } finally { finish.resolve(); await f.close(); }
});

test('bounded stop capacity releases on physical completion, never on logical cancellation', async () => {
  const f = fixture(), finish = deferred<void>(); let claims = 0;
  const stop = new AsyncOpenClawStop({ ...f.options, owner: { command: async (kind, input) => {
    if (kind === 'openClawStopClaim') { claims++; await finish.promise; }
    return f.command(kind, input);
  } } });
  try {
    const tasks = Array.from({ length: 128 }, () => stop.stop(f.request, wait));
    while (claims < 128) await tick();
    await assert.rejects(stop.stop(f.request, wait)); assert.equal(claims, 128);
    finish.resolve(); await Promise.all(tasks);
    const result = await stop.stop(f.request, wait); assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    assert.equal(f.sends(), 1);
  } finally { finish.resolve(); await stop.close(); await f.close(); }
});

test('real worker restart drops stop capability, preserving unknown/accepted receipts without effect replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-stop-worker-'));
  const file = join(directory, 'original.sqlite'), tokenFile = join(directory, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, token, silent);
  const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  await seed.turns.enqueueAsync('openclaw', { sessionKey: key, id: 'original-command', createdAt: 1,
    payload: { actorId: tokens.authenticateAuthorization(authorization)!.tokenId,
      message: 'original input', media: [], deliveryMode: 'web-only' } });
  seed.close();
  let owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent);
  const scope = { key, authorization, commandKey: 'worker-unknown' };
  const request = { ...scope, payloadJson: '{"message":"/stop","expectedRunId":"original-command"}', connectionId: 'original-connection' };
  try {
    await owner.open();
    await claimOpenClawOwnerTurn(owner, key, 'original-connection');
    assert.equal(await owner.command('openClawExecutionAcknowledge', { sessionKey: key, commandId: 'original-command',
      transport: 'gateway', connectionId: 'original-connection', runId: 'original-native' }), true);
    const first = await owner.command('openClawStopClaim', request); assert.ok('intent' in first && first.intent);
    assert.equal(await owner.command('openClawStopReady', { ...scope, intent: first.intent }), true);
    const acceptedScope = { ...scope, commandKey: 'worker-accepted' };
    const accepted = await owner.command('openClawStopClaim', { ...request, commandKey: acceptedScope.commandKey }); assert.ok('intent' in accepted && accepted.intent);
    assert.equal(await owner.command('openClawStopReady', { ...acceptedScope, intent: accepted.intent }), true);
    const settled = await owner.command('openClawStopSettle', { intent: accepted.intent, outcome: 'acknowledged' }); assert.ok(settled);
    await owner.close(); owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent); await owner.open();
    const recovered = await owner.command('openClawStopClaim', request); assert.ok('result' in recovered);
    assert.equal(recovered.result.receipt?.state, 'outcome_unknown'); assert.equal(recovered.intent, null);
    assert.equal(await owner.command('openClawStopReady', { ...scope, intent: first.intent }), false);
    assert.equal(await owner.command('openClawStopSettle', { intent: first.intent, outcome: 'acknowledged' }), false);
    const confirmed = await owner.command('openClawStopClaim', { ...request, commandKey: acceptedScope.commandKey }); assert.ok('result' in confirmed);
    assert.deepEqual(confirmed.result.receipt, settled.receipt); assert.equal(confirmed.intent, null);
    assert.equal((await owner.command('openClawExecutionRead', { sessionKey: key }))?.runId, 'original-native');
  } finally { await owner.closeForShutdown(); rmSync(directory, { recursive: true, force: true }); }
});
