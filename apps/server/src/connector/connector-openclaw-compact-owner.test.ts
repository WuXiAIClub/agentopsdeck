import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncOpenClawCompact } from './async-openclaw-compact.js';
import { AsyncOpenClawMessages } from './async-openclaw-messages.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { validConnectorOpenClawCompactInput, validConnectorOpenClawCompactOutput,
  type OpenClawCompactResult } from './connector-openclaw-compact-domain.js';
import { registerOpenClawMessagesHttp } from './openclaw-messages-http.js';

const token = 'isolated-openclaw-compact-token', authorization = `Bearer ${token}`, key = 'agent:main:dashboard:compact';
const silent = new PerformanceDiagnostics(() => {}), wait = { timeoutMs: 10_000 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Options = ConstructorParameters<typeof AsyncOpenClawCompact>[0];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-compact-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token, silent);
  const store = new ConnectorUserStore(':memory:', id => !!tokens.delegationHubId(id), { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens);
  const scope = { key, authorization, commandKey: 'original-compact', operation: 'message' as const };
  const request = { ...scope, payloadJson: JSON.stringify({ message: '/compact' }) };
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  let connection: string | undefined = 'original-connection', available = true, sends = 0;
  const session = { exists: true, busy: false, totalTokens: 20, contextTokens: 100 };
  const projected: OpenClawCompactResult[] = [];
  const gateway: Options['gateway'] = {
    connectionId: () => connection,
    requestBound: async <T>(method: string, params: Record<string, unknown>, expected?: string, before?: () => void) => {
      assert.equal(method, 'chat.send'); assert.equal(expected, 'original-connection');
      assert.deepEqual(params, { sessionKey: key, message: '/compact', deliver: false, idempotencyKey: store.openClawExecutions.get(key)!.commandId });
      before?.(); sends++;
      return { connectionId: 'original-connection', payload: { runId: 'native-compact', status: 'started' } as T };
    },
  };
  const options: Options = { owner: { command }, gateway, available: () => available, session: () => session,
    project: result => { projected.push(result); }, diagnostics: silent };
  const compact = new AsyncOpenClawCompact(options);
  const claimInput = () => ({ ...request, connectionId: 'original-connection', veto: null, display: { totalTokens: 20, contextTokens: 100 } });
  const claim = async () => { const c = await command('openClawCompactClaim', claimInput()); assert.ok('intent' in c && c.intent); return c.intent; };
  return { directory, store, tokens, command, scope, request, actor, gateway, session, options, compact, claimInput, claim, projected,
    sends: () => sends, connection: (v: string | undefined) => { connection = v; }, available: (v: boolean) => { available = v; },
    receipt: () => store.commands.get(JSON.stringify([actor, key]), scope.commandKey),
    async close() { await compact.close(); command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('compact protocol rejects authority booleans, extra fields, mismatched intents and fabricated output', async () => {
  const f = fixture();
  try {
    const intent = await f.claim();
    assert.equal(validConnectorOpenClawCompactInput('openClawCompactClaim', f.claimInput()), true);
    for (const extra of [{ actorId: 'forged' }, { authorized: true }, { purpose: undefined }, { key: 'hermes:foreign' }, { operation: 'stop' }, { display: { totalTokens: Infinity, contextTokens: 1 } }])
      assert.equal(validConnectorOpenClawCompactInput('openClawCompactClaim', { ...f.claimInput(), ...extra }), false);
    assert.equal(validConnectorOpenClawCompactInput('openClawCompactReady', { ...f.scope, intent, connectionId: undefined }), false);
    assert.equal(validConnectorOpenClawCompactInput('openClawCompactReady', { ...f.scope, commandKey: 'foreign', intent }), false);
    assert.equal(validConnectorOpenClawCompactInput('openClawCompactSettle', { intent, outcome: 'acknowledged', runId: null, status: null }), false);
    assert.equal(validConnectorOpenClawCompactOutput('openClawCompactSettle', { error: 403 }), false);
    assert.equal(validConnectorOpenClawCompactOutput('openClawCompactClaim', { result: { error: 403 }, intent: null }), false);
  } finally { await f.close(); }
});

test('compact original claim, execution, native ACK and receipt close atomically; duplicate never sends again', async () => {
  const f = fixture();
  try {
    const result = await f.compact.compact(f.request, wait); assert.ok('receipt' in result);
    assert.equal(result.receipt?.state, 'accepted'); assert.ok(result.receipt);
    assert.deepEqual(result.receipt.result?.body, { runId: 'native-compact', status: 'started', idempotencyKey: result.receipt.id,
      deliveryMode: 'web-only', deliver: false, media: [] });
    assert.equal(f.store.openClawExecutions.get(key)?.commandId, result.receipt.id);
    assert.equal(f.store.openClawExecutions.get(key)?.runId, 'native-compact');
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting');
    assert.equal(f.projected.length, 1); assert.equal(f.projected[0]?.projection?.id, result.receipt.id);
    assert.deepEqual(await f.compact.compact(f.request, wait), result); assert.equal(f.sends(), 1);
    assert.deepEqual(await f.compact.compact({ ...f.request, payloadJson: '{"message":"/compact","extra":true}' }, wait), { error: 409 });
  } finally { await f.close(); }
});

for (const scenario of ['queue', 'blocked', 'running', 'unknown', 'settings', 'deletion', 'paused', 'unavailable', 'missing', 'busy', 'mirror', 'media', 'ordinary'] as const)
  test(`compact ${scenario} is a veto, not permission to bypass or unlock original work`, async () => {
    const f = fixture();
    try {
      if (scenario === 'queue' || scenario === 'blocked') {
        await f.store.turns.enqueueAsync('openclaw', { id: 'queued', sessionKey: key, createdAt: 1, payload: { actorId: f.actor, message: 'original', media: [], deliveryMode: 'web-only' } });
        if (scenario === 'blocked') f.store.turns.block('openclaw', 'queued');
      }
      if (scenario === 'running' || scenario === 'unknown') {
        f.store.openClawExecutions.begin(key, 'original', undefined, 'original-connection');
        if (scenario === 'unknown') f.store.openClawExecutions.uncertain(key, 'original');
      }
      if (scenario === 'settings' || scenario === 'deletion') f.store.commands.claim(JSON.stringify([scenario === 'settings' ? 'settings' : 'delete', JSON.stringify([f.actor, key])]), 'fence', {});
      if (scenario === 'paused') f.store.pauseTurnStarts();
      if (scenario === 'unavailable') f.available(false);
      if (scenario === 'missing') f.session.exists = false;
      if (scenario === 'busy') f.session.busy = true;
      const body = { message: scenario === 'ordinary' ? 'ordinary' : '/compact', ...(scenario === 'mirror' ? { deliveryMode: 'mirror' } : {}),
        ...(scenario === 'media' ? { media: [{ type: 'file', dataUrl: 'data:text/plain;base64,YQ==', name: 'file.txt' }] } : {}) };
      const fact = f.store.openClawExecutions.get(key), turns = f.store.turns.list('openclaw', key);
      const result = await f.compact.compact({ ...f.request, payloadJson: JSON.stringify(body) }, wait); assert.ok('receipt' in result);
      assert.equal(result.receipt?.state, 'rejected'); assert.equal(f.sends(), 0);
      assert.deepEqual(f.store.openClawExecutions.get(key), fact); assert.deepEqual(f.store.turns.list('openclaw', key), turns);
    } finally { await f.close(); }
  });

test('claim rollback restores both receipt and execution and publishes no uncommitted journal change', async () => {
  const f = fixture();
  const begin = f.store.openClawExecutions.beginInTransaction.bind(f.store.openClawExecutions);
  try {
    const revision = f.store.events.changes.revision;
    f.store.openClawExecutions.beginInTransaction = (...args) => { assert.equal(begin(...args), true); throw Error('injected failure after execution write'); };
    await assert.rejects(f.command('openClawCompactClaim', f.claimInput()));
    assert.equal(f.receipt(), undefined); assert.equal(f.store.openClawExecutions.get(key), undefined);
    assert.equal(f.store.events.changes.revision, revision);
    assert.throws(() => begin(key, 'outside', 'connection'), /owning transaction/);
  } finally { await f.close(); }
});

test('ACK settlement rollback retains original unknown receipt and unbound starting slot', async () => {
  const f = fixture();
  try {
    const intent = await f.claim(); assert.equal(await f.command('openClawCompactReady', { ...f.scope, intent }), true);
    const commit = f.store.commands.queueCommit.bind(f.store.commands);
    f.store.commands.queueCommit = (...args) => { const original = commit(...args); return (...values) => { original(...values); throw Error('after receipt settlement'); }; };
    await assert.rejects(f.command('openClawCompactSettle', { intent, outcome: 'acknowledged', runId: 'native', status: 'started' }));
    assert.equal(f.receipt()?.state, 'outcome_unknown'); assert.equal(f.store.openClawExecutions.get(key)?.runId, undefined);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting');
  } finally { await f.close(); }
});

test('ready is one-shot, current-authority and exact original revision bound', async () => {
  const f = fixture();
  try {
    const intent = await f.claim();
    assert.equal(await f.command('openClawCompactSettle', { intent, outcome: 'acknowledged', runId: 'native', status: 'started' }), false);
    assert.equal(await f.command('openClawCompactReady', { ...f.scope, intent: { ...intent, id: 'forged' } }), false);
    assert.equal(await f.command('openClawCompactReady', { ...f.scope, intent }), true);
    assert.equal(await f.command('openClawCompactReady', { ...f.scope, intent }), false);
    assert.equal(await f.command('openClawCompactRelease', { intent }), true);
    const duplicate = await f.compact.compact(f.request, wait); assert.ok('receipt' in duplicate);
    assert.equal(duplicate.receipt?.state, 'outcome_unknown'); assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

for (const point of ['openClawCompactClaim', 'openClawCompactReady', 'openClawCompactSettle'] as const)
  test(`lost ${point} ACK recovers only the original receipt; native call never repeats`, async () => {
    const f = fixture(); let lost = false;
    const command: typeof f.command = Object.assign(async <K extends Parameters<typeof f.command>[0]>(kind: K, input: Parameters<typeof f.command<K>>[1]) => {
      const result = await f.command(kind, input);
      if (!lost && kind === point) { lost = true; throw Error('lost owner ACK'); } return result;
    }, { dispose() {} });
    const compact = new AsyncOpenClawCompact({ ...f.options, owner: { command } });
    try {
      if (point === 'openClawCompactClaim') await assert.rejects(compact.compact(f.request, wait));
      else await compact.compact(f.request, wait);
      const duplicate = await compact.compact(f.request, wait); assert.ok('receipt' in duplicate);
      assert.equal(duplicate.receipt?.state, point === 'openClawCompactSettle' ? 'accepted' : point === 'openClawCompactReady' ? 'rejected' : 'outcome_unknown');
      assert.equal(f.sends(), point === 'openClawCompactSettle' ? 1 : 0);
    } finally { await compact.close(); await f.close(); }
  });

for (const bad of ['no-run', 'foreign-connection', 'lost-native-ack'] as const)
  test(`native ${bad} retains protected unknown, without fallback run identity or replay`, async () => {
    const f = fixture();
    f.gateway.requestBound = async <T>(_m: string, _p: Record<string, unknown>, _c?: string, before?: () => void) => {
      before?.(); if (bad === 'lost-native-ack') throw Error('sent but reply lost');
      return { connectionId: bad === 'foreign-connection' ? 'replacement' : 'original-connection', payload: (bad === 'no-run' ? { status: 'started' } : { runId: 'native' }) as T };
    };
    try {
      const result = await f.compact.compact(f.request, wait); assert.ok('receipt' in result);
      assert.equal(result.receipt?.state, 'outcome_unknown'); assert.equal(f.store.openClawExecutions.get(key)?.phase, 'unknown');
      assert.equal(f.store.openClawExecutions.get(key)?.reason, 'send_unknown');
      assert.equal(f.store.openClawExecutions.get(key)?.runId, undefined);
      assert.deepEqual(await f.compact.compact(f.request, wait), result);
    } finally { await f.close(); }
  });

test('original early terminal observation remains terminal when native ACK arrives', async () => {
  const f = fixture();
  const send = f.gateway.requestBound;
  f.gateway.requestBound = async <T>(...args: Parameters<typeof send>) => {
    const result = await send<T>(...args);
    f.store.openClawExecutions.observe(key, { runId: 'native-compact', phase: 'completed', gatewayConnectionId: 'original-connection' });
    return result;
  };
  try {
    const result = await f.compact.compact(f.request, wait); assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed'); assert.equal(f.store.openClawExecutions.get(key)?.historySync?.state, 'pending');
  } finally { await f.close(); }
});

test('revocation after native send still settles original facts but cannot deliver or project the private ACK', async () => {
  const f = fixture(), send = f.gateway.requestBound;
  f.gateway.requestBound = async <T>(...args: Parameters<typeof send>) => { const result = await send<T>(...args); f.tokens.revoke(f.actor); return result; };
  try {
    assert.deepEqual(await f.compact.compact(f.request, wait), { error: 401 });
    assert.equal(f.receipt()?.state, 'accepted'); assert.equal(f.store.openClawExecutions.get(key)?.runId, 'native-compact');
    assert.equal(f.projected.length, 0);
  } finally { await f.close(); }
});

test('connection changes at actual send boundary reject only the original unsent slot', async () => {
  const f = fixture();
  f.gateway.requestBound = async <T>(_m: string, _p: Record<string, unknown>, _c?: string, before?: () => void) => {
    f.connection('replacement'); before?.();
    assert.fail('replacement connection must never reach physical send');
    return { connectionId: 'replacement', payload: {} as T };
  };
  try {
    const result = await f.compact.compact(f.request, wait); assert.ok('receipt' in result);
    assert.equal(result.receipt?.state, 'rejected'); assert.equal(f.store.openClawExecutions.get(key)?.phase, 'failed');
    assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

test('revocation before ready rejects the original unsent claim without native dispatch', async () => {
  const f = fixture();
  try {
    const intent = await f.claim(); f.tokens.revoke(f.actor);
    assert.equal(await f.command('openClawCompactReady', { ...f.scope, intent }), false);
    const settled = await f.command('openClawCompactSettle', { intent, outcome: 'not_dispatched', runId: null, status: null });
    assert.ok(settled && settled.receipt?.state === 'rejected');
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'failed'); assert.equal(f.sends(), 0);
    assert.deepEqual(await f.compact.read({ ...f.scope }, wait), { error: 401 });
  } finally { await f.close(); }
});

for (const change of ['restart', 'successor'] as const)
  test(`late compact ACK after ${change} cannot settle or overwrite another execution`, async () => {
    const f = fixture();
    try {
      const intent = await f.claim(); assert.equal(await f.command('openClawCompactReady', { ...f.scope, intent }), true);
      if (change === 'restart') f.store.openClawExecutions.recoverInterrupted();
      else {
        f.store.openClawExecutions.acknowledge(key, intent.commandId, 'original-run');
        f.store.openClawExecutions.observe(key, { runId: 'original-run', phase: 'completed', gatewayConnectionId: intent.connectionId });
        assert.equal(f.store.openClawExecutions.begin(key, 'successor-command', undefined, 'new-connection'), true);
      }
      const before = f.store.openClawExecutions.get(key);
      for (const outcome of ['acknowledged', 'not_dispatched', 'unknown'] as const) {
        assert.equal(await f.command('openClawCompactSettle', { intent, outcome,
          runId: outcome === 'acknowledged' ? 'late-native' : null, status: null }), false);
        assert.deepEqual(f.store.openClawExecutions.get(key), before);
      }
      assert.equal(f.receipt()?.state, 'outcome_unknown');
    } finally { await f.close(); }
  });

test('projection failure recovers the accepted original receipt without repeating native compact', async () => {
  const f = fixture(); let broken = true;
  const compact = new AsyncOpenClawCompact({ ...f.options, project: result => {
    if (broken) throw Error('projection unavailable'); f.projected.push(result);
  } });
  try {
    await assert.rejects(compact.compact(f.request, wait));
    const original = f.receipt(); assert.equal(original?.state, 'accepted'); assert.equal(f.sends(), 1);
    broken = false;
    const read = await compact.read(f.scope, wait); assert.ok('receipt' in read);
    assert.deepEqual(read.receipt, original); assert.equal(f.projected[0]?.projection?.id, original?.id);
    await compact.compact(f.request, wait); assert.equal(f.sends(), 1);
  } finally { await compact.close(); await f.close(); }
});

test('caller mutation cannot change pinned input or native identity during the first await', async () => {
  const f = fixture();
  try {
    const input = { ...f.request }, pending = f.compact.compact(input, wait);
    input.key = 'agent:main:dashboard:other'; input.authorization = 'Bearer foreign';
    input.commandKey = 'replacement'; input.payloadJson = '{"message":"replacement"}';
    const result = await pending; assert.ok('receipt' in result);
    assert.equal(result.key, key); assert.equal(result.commandKey, f.scope.commandKey);
    assert.equal(f.sends(), 1); assert.equal(f.receipt()?.state, 'accepted');
  } finally { await f.close(); }
});

test('compact successor preserves the old history error independently of its new execution', async () => {
  const f = fixture();
  try {
    f.store.openClawExecutions.begin(key, 'old-command', undefined, 'original-connection');
    f.store.openClawExecutions.acknowledge(key, 'old-command', 'old-run');
    f.store.openClawExecutions.observe(key, { runId: 'old-run', phase: 'completed', gatewayConnectionId: 'original-connection' });
    const revision = f.store.openClawExecutions.get(key)!.historySync!.revision;
    f.store.openClawExecutions.setHistorySync(key, revision, 'error');
    const result = await f.compact.compact(f.request, wait); assert.ok('receipt' in result);
    assert.equal(result.receipt?.state, 'accepted');
    const fact = f.store.openClawExecutions.get(key)!;
    // ACK proves admission, not that the runtime has started or completed.
    assert.equal(fact.runId, 'native-compact'); assert.equal(fact.phase, 'starting');
    assert.deepEqual(fact.historySync, { revision, state: 'error' });
  } finally { await f.close(); }
});

test('deadline only ends delivery; close drains original send and durable settlement despite throwing diagnostics', async () => {
  const f = fixture(), entered = deferred<void>(), finish = deferred<void>();
  f.gateway.requestBound = async <T>(_m: string, _p: Record<string, unknown>, _c?: string, before?: () => void) => {
    before?.(); entered.resolve(); await finish.promise;
    return { connectionId: 'original-connection', payload: { runId: 'native-compact' } as T };
  };
  const compact = new AsyncOpenClawCompact({ ...f.options, diagnostics: new PerformanceDiagnostics(() => { throw Error('sink'); }) });
  try {
    const pending = compact.compact(f.request, { timeoutMs: 15 }); const rejected = assert.rejects(pending); await entered.promise; await rejected;
    let closed = false; const closing = compact.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    await assert.rejects(compact.compact({ ...f.request, commandKey: 'new' }, wait));
    finish.resolve(); await closing;
    assert.equal(f.receipt()?.state, 'accepted'); assert.equal(f.store.openClawExecutions.get(key)?.runId, 'native-compact');
  } finally { finish.resolve(); await compact.close(); await f.close(); }
});

test('explicit compact and message scopes remain independent and retain original successful HTTP wires', async () => {
  const f = fixture();
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true, sessionExists: () => true, admitted() {} });
  const app = new Hono(); registerOpenClawMessagesHttp(app, '/sessions/:sessionKey', { messages, compact: f.compact, ready: () => true });
  app.post('/sessions/:sessionKey/compact', () => { throw Error('legacy synchronous writer'); });
  try {
    const response = await app.request(`/sessions/${key}/compact`, { method: 'POST', headers: { authorization }, body: JSON.stringify({ idempotencyKey: f.scope.commandKey }) });
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.deliveryMode, 'web-only'); assert.equal(body.deliver, false); assert.deepEqual(body.media, []);
    assert.equal(body.runId, 'native-compact'); assert.equal(body.command.key, f.scope.commandKey); assert.equal(body.command.state, 'accepted');
    assert.match(body.estimatedSkipReason, /20%/); assert.match(body.message, /Gateway will write/);
    assert.equal(f.receipt(), undefined);
    const read = await app.request(`/sessions/${key}/compact-commands/${f.scope.commandKey}`, { headers: { authorization } });
    assert.equal(read.status, 200); assert.equal((await read.json()).command.result.body.runId, 'native-compact');
    assert.equal((await app.request(`/sessions/${key}/commands/${f.scope.commandKey}`, { headers: { authorization } })).status, 404);
    const retry = await app.request(`/sessions/${key}/compact`, { method: 'POST', headers: { authorization }, body: JSON.stringify({ idempotencyKey: f.scope.commandKey }) });
    assert.deepEqual(await retry.json(), body); assert.equal(f.sends(), 1);
  } finally { await messages.close(); await f.close(); }
});

test('message compact intercepts legacy while ordinary messages retain queue admission/read semantics', async () => {
  const f = fixture();
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true, sessionExists: () => true, admitted() {} });
  const app = new Hono(); registerOpenClawMessagesHttp(app, '/sessions/:sessionKey', { messages, compact: f.compact, ready: () => true });
  app.post('/sessions/:sessionKey/messages', () => { throw Error('legacy synchronous writer'); });
  try {
    const post = (body: object) => app.request(`/sessions/${key}/messages`, { method: 'POST', headers: { authorization }, body: JSON.stringify(body) });
    const response = await post({ message: '/compact', idempotencyKey: 'compact-http' }); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.runId, 'native-compact'); assert.equal(result.message, undefined);
    assert.equal((await app.request(`/sessions/${key}/commands/compact-http`, { headers: { authorization } })).status, 200);
    const ordinary = await post({ message: 'ordinary', idempotencyKey: 'ordinary-http' }); assert.equal(ordinary.status, 200);
    assert.equal((await ordinary.json()).status, 'queued');
    const queue = await app.request(`/sessions/${key}/commands/ordinary-http/queue`, { headers: { authorization } });
    assert.equal((await queue.json()).queue.presence, 'present'); assert.equal(f.sends(), 1);
  } finally { await messages.close(); await f.close(); }
});

test('explicit HTTP compact generates a recoverable key and rejects extra options before admission', async () => {
  const f = fixture();
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true, sessionExists: () => true, admitted() {} });
  const app = new Hono(); registerOpenClawMessagesHttp(app, '/sessions/:sessionKey', { messages, compact: f.compact, ready: () => true });
  try {
    const post = (body: object, headers: Record<string, string> = {}) => app.request(`/sessions/${key}/compact`,
      { method: 'POST', headers: { authorization, ...headers }, body: JSON.stringify(body) });
    for (const body of [{ message: 'not allowed' }, { runId: 'forged' }, { idempotencyKey: 'bad key' }]) assert.equal((await post(body)).status, 400);
    assert.equal((await post({ idempotencyKey: 'one' }, { 'idempotency-key': 'another' })).status, 400);
    assert.equal(f.sends(), 0);
    const response = await post({}); assert.equal(response.status, 200);
    const commandKey = response.headers.get('X-AgentOpsDeck-Command-Key'); assert.ok(commandKey);
    const body = await response.json();
    const { command: envelope, ...nativeBody } = body;
    const read = await app.request(`/sessions/${key}/compact-commands/${commandKey}`, { headers: { authorization } });
    assert.equal(read.status, 200);
    const recovered = (await read.json()).command;
    assert.equal(recovered.id, envelope.id); assert.equal(recovered.key, commandKey);
    assert.deepEqual(recovered.result.body, nativeBody);
    assert.deepEqual(await (await post({ idempotencyKey: commandKey })).json(), body); assert.equal(f.sends(), 1);
  } finally { await messages.close(); await f.close(); }
});

test('HTTP media compact remains an ordinary web-only message while mirror control is rejected', async () => {
  const f = fixture();
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true, sessionExists: () => true, admitted() {} });
  const app = new Hono(); registerOpenClawMessagesHttp(app, '/sessions/:sessionKey', { messages, compact: f.compact, ready: () => true });
  const media = [{ type: 'file', dataUrl: 'data:text/plain;base64,YQ==', name: 'file.txt' }];
  try {
    const post = (body: object) => app.request(`/sessions/${key}/messages`, { method: 'POST', headers: { authorization }, body: JSON.stringify(body) });
    const mirror = await post({ message: '/compact', media, deliveryMode: 'mirror', idempotencyKey: 'mirror' });
    assert.equal(mirror.status, 409); assert.equal(f.store.openClawExecutions.get(key), undefined);
    const ordinary = await post({ message: '/compact', media, idempotencyKey: 'media' });
    assert.equal(ordinary.status, 200); assert.equal((await ordinary.json()).status, 'queued');
    assert.equal(f.store.turns.list('openclaw', key).length, 1); assert.equal(f.sends(), 0);
  } finally { await messages.close(); await f.close(); }
});

test('current node, read/send scope and delegated control authority never downgrade', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.compact.compact({ ...f.request, expectedNode: 'foreign' }, wait), { error: 403 });
    const reader = f.tokens.create({ label: 'read', scopes: ['messages:read'] });
    assert.deepEqual(await f.compact.compact({ ...f.request, authorization: `Bearer ${reader.token}` }, wait), { error: 403 });
    const issuer = f.tokens.create({ label: 'issuer', scopes: ['execution:delegate', 'messages:send', 'messages:read'], delegationHubId: 'hub' });
    const ref = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'policy', version: 1, runtime: 'openclaw', sessionKey: key,
      issuerTokenId: issuer.record.id, hubId: 'hub' }, ['messages:send'], Date.now() + 30_000);
    const request = { ...f.request, authorization: `Bearer ${issuer.token}`, grantId: ref.id, expectedNode: f.store.nodeId };
    const { grantId: _grantId, ...withoutGrant } = request;
    assert.deepEqual(await f.compact.compact(withoutGrant, wait), { error: 403 });
    const denied = await f.compact.compact(request, wait); assert.ok('receipt' in denied); assert.equal(denied.receipt?.result?.status, 409);
    assert.equal(f.receipt(), undefined); assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

test('real worker close/reopen retains original unknown and never reconstructs a native permit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-compact-worker-'));
  const config = { file: join(directory, 'connector.db'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token };
  let owner = new AsyncConnectorOwner(config, silent);
  const scope = { key, authorization, commandKey: 'worker-original', operation: 'message' as const };
  try {
    const claim = { ...scope, payloadJson: '{"message":"/compact"}', connectionId: 'original-connection', veto: null,
      display: { totalTokens: null, contextTokens: null } };
    const result = await owner.command('openClawCompactClaim', claim); assert.ok('intent' in result && result.intent);
    await owner.close(); owner = new AsyncConnectorOwner(config, silent);
    const duplicate = await owner.command('openClawCompactClaim', claim); assert.ok('intent' in duplicate);
    assert.equal(duplicate.intent, null); assert.equal(duplicate.result.receipt?.id, result.intent.receiptId);
    assert.equal(duplicate.result.receipt?.state, 'outcome_unknown');
    assert.equal(await owner.command('openClawCompactReady', { ...scope, intent: result.intent }), false);
    const read = await owner.command('openClawCompactReceiptRead', { ...scope, purpose: 'read' }); assert.ok('receipt' in read);
    assert.equal(read.receipt?.id, result.intent.receiptId);
  } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real worker reopen recovers accepted compact and projection but grants no new native effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-compact-accepted-worker-'));
  const config = { file: join(directory, 'connector.db'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token };
  let owner = new AsyncConnectorOwner(config, silent);
  const scope = { key, authorization, commandKey: 'worker-accepted', operation: 'compact' as const };
  try {
    const input = { ...scope, payloadJson: '{}', connectionId: 'original-connection', veto: null,
      display: { totalTokens: null, contextTokens: null } };
    const claim = await owner.command('openClawCompactClaim', input); assert.ok('intent' in claim && claim.intent);
    assert.equal(await owner.command('openClawCompactReady', { ...scope, intent: claim.intent }), true);
    const original = await owner.command('openClawCompactSettle', { intent: claim.intent, outcome: 'acknowledged', runId: 'native-real', status: null });
    assert.ok(original && original.receipt?.state === 'accepted' && original.projection);
    await owner.close(); owner = new AsyncConnectorOwner(config, silent);
    assert.deepEqual(await owner.command('openClawCompactReceiptRead', { ...scope, purpose: 'read' }), original);
    const duplicate = await owner.command('openClawCompactClaim', input); assert.ok('intent' in duplicate);
    assert.equal(duplicate.intent, null); assert.deepEqual(duplicate.result, original);
    assert.equal(await owner.command('openClawCompactReady', { ...scope, intent: claim.intent }), false);
    assert.equal(await owner.command('openClawCompactSettle', { intent: claim.intent, outcome: 'acknowledged', runId: 'other', status: null }), false);
  } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
