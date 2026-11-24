import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncOpenClawDispatch } from './async-openclaw-dispatch.js';
import { AsyncOpenClawMessages } from './async-openclaw-messages.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { persistUploadedMedia } from '../messages/send-message.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { validConnectorOpenClawMessageInput, validConnectorOpenClawMessageOutput, type OpenClawMessageScope } from './connector-openclaw-message-domain.js';

const token = 'isolated-openclaw-message-token', authorization = `Bearer ${token}`, key = 'agent:main:dashboard:original';
const silent = new PerformanceDiagnostics(() => {}), wait = { timeoutMs: 10_000 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-message-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token, silent);
  const store = new ConnectorUserStore(':memory:', id => !!tokens.delegationHubId(id), { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens);
  const scope = { key, authorization, commandKey: 'original' };
  let effects = 0, wakes = 0, ready = true, exists = true;
  const messages = new AsyncOpenClawMessages({ owner: { command }, defaultAgentId: 'main', ready: () => ready,
    sessionExists: () => exists, admitted: () => { wakes++; }, persist: async items => {
      effects++;
      return (items ?? []).map(() => ({ filePath: '/isolated/original.txt', media: { type: 'file' as const, name: 'original.txt', url: '/api/media/inbound/original.txt', size: 1 } }));
    } });
  const claim = async (payload = { message: 'original' }, s = scope) => {
    const result = await command('openClawMessageClaim', { ...s, payloadJson: JSON.stringify(payload), defaultAgentId: 'main' });
    assert.ok('intent' in result && result.intent); return result.intent;
  };
  return { directory, tokens, store, command, scope, messages, claim,
    effects: () => effects, wakes: () => wakes, ready: (v: boolean) => { ready = v; }, exists: (v: boolean) => { exists = v; },
    async close() { await messages.close(); command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('OpenClaw revoke at second physical file prevents later artifacts and gateway queue admission', async () => {
  const f = fixture(), inboundDir = join(f.directory, 'physical-files');
  let finish!: () => void, entered!: () => void, checks = 0, revoked = false;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const commands: string[] = [];
  const authority: ApplicationCommandScope = {
    intent: { action: 'message', runtime: 'openclaw', resource: key, commandKey: f.scope.commandKey, payloadDigest: 'a'.repeat(64) },
    local() { if (revoked) throw Error('original application revoked'); },
    async authorize(stage) {
      if (stage === 'effect' && ++checks === 4) { entered(); await new Promise<void>(resolve => { finish = resolve; }); }
      if (revoked) throw Error('original application revoked');
    },
  };
  const messages = new AsyncOpenClawMessages({ owner: { command: async (kind, input) => {
    commands.push(kind); return f.command(kind, input);
  } }, defaultAgentId: 'main', ready: () => true, sessionExists: () => true,
    admitted() { assert.fail('revoked chain cannot publish'); },
    persist: (items, options) => persistUploadedMedia(items, { ...options, inboundDir }) });
  const media = ['first.txt', 'second.txt'].map(name => ({ type: 'file', name, mimeType: 'text/plain', size: 4, dataUrl: 'data:text/plain;base64,dGVzdA==' }));
  try {
    const original = messages.sendPhysical({ ...f.scope, payloadJson: JSON.stringify({ message: '', media }) }, authority);
    const rejected = assert.rejects(original, /original application revoked/);
    await enteredPromise;
    assert.ok(finish, 'second file original authorization check entered');
    assert.equal(readdirSync(inboundDir).length, 1);
    revoked = true; finish(); await rejected;
    assert.equal(readdirSync(inboundDir).length, 1);
    assert.equal(commands.includes('openClawMessageCommit'), false);
    assert.equal(f.store.turns.list('openclaw', key).length, 0);
    const saved = await f.messages.readReceipt(f.scope, wait); assert.ok('receipt' in saved);
    assert.equal(saved.receipt?.state, 'outcome_unknown');
  } finally { finish?.(); await messages.close(); await f.close(); }
});

test('message protocol rejects forged authority, foreign runtime, oversized media and coercive error output', () => {
  const scope = { key, authorization, commandKey: 'original' }, intent = { key, id: 'id', receiptId: 'receipt' };
  for (const extra of [{ actorId: 'forged' }, { authorized: true }, { key: 'hermes:foreign' }])
    assert.equal(validConnectorOpenClawMessageInput('openClawMessageClaim', { ...scope, payloadJson: '{"message":"x"}', defaultAgentId: 'main', ...extra }), false);
  assert.equal(validConnectorOpenClawMessageInput('openClawMessageCommit', { ...scope, intent, media: [{ filePath: '/private', media: { type: 'file', name: 'file', url: '/file', size: 12 * 1024 * 1024 + 1 } }] }), false);
  assert.equal(validConnectorOpenClawMessageInput('openClawMessageCommit', { ...scope, intent, media: [{ filePath: '/private', media: { type: 'file', url: '/file' } }] }), false);
  assert.equal(validConnectorOpenClawMessageOutput('openClawMessageReady', { error: '403' }), false);
});

test('original immutable receipt/fingerprint admits one queue row and one file effect; duplicates only recover', async () => {
  const f = fixture();
  try {
    const request = { ...f.scope, payloadJson: JSON.stringify({ message: ' original ', metadata: 'fingerprint' }) };
    const result = await f.messages.send(request, wait); assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    assert.equal(result.admitted, true); assert.equal(f.effects(), 1); assert.equal(f.wakes(), 1);
    const turn = f.store.turns.list<{ message: string }>('openclaw', key)[0]!; assert.equal(turn.payload.message, 'original');
    assert.equal(result.receipt.result?.body.runId, turn.id); assert.equal(result.receipt.result?.body.idempotencyKey, turn.id);
    f.ready(false); f.store.pauseTurnStarts();
    const duplicate = await f.messages.send(request, wait); assert.ok('receipt' in duplicate); assert.deepEqual(duplicate.receipt, result.receipt); assert.equal(duplicate.intent, null);
    assert.equal(f.effects(), 1); assert.equal(f.wakes(), 1); assert.equal(f.store.turns.list('openclaw', key).length, 1);
    assert.deepEqual(await f.messages.send({ ...request, payloadJson: '{"message":"different"}' }, wait), { error: 409 });
  } finally { await f.close(); }
});

test('ready is one-shot; forged and released intents never create effects or clear durable unknown', async () => {
  const f = fixture();
  try {
    const intent = await f.claim();
    assert.equal(await f.command('openClawMessageReady', { ...f.scope, intent: { ...intent, id: 'forged' } }), false);
    assert.equal(await f.command('openClawMessageReady', { ...f.scope, intent }), true);
    assert.equal(await f.command('openClawMessageReady', { ...f.scope, intent }), false);
    assert.equal(await f.command('openClawMessageRelease', { intent }), true);
    assert.equal(await f.command('openClawMessageRelease', { intent }), false);
    const result = await f.messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, wait);
    assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'outcome_unknown'); assert.equal(result.intent, null);
    assert.equal(f.effects(), 0); assert.equal(f.store.turns.list('openclaw', key).length, 0);
  } finally { await f.close(); }
});

for (const change of ['revoke', 'maintenance', 'missing'] as const) test(`current ${change} after attachment wait vetoes commit without replay`, async () => {
  const f = fixture(); let finish!: () => void, entered = false;
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true,
    sessionExists: () => change !== 'missing' || !entered, admitted() { throw Error('must not dispatch'); },
    persist: async () => { await new Promise<void>(resolve => { finish = resolve; entered = true; }); return []; } });
  try {
    const task = messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, wait);
    while (!finish) await tick();
    if (change === 'revoke') f.tokens.revoke(f.tokens.authenticateAuthorization(authorization)!.tokenId);
    if (change === 'maintenance') f.store.pauseTurnStarts();
    finish();
    if (change === 'missing') await assert.rejects(task); else assert.deepEqual(await task, { error: change === 'revoke' ? 401 : 409 });
    assert.equal(f.store.turns.list('openclaw', key).length, 0);
  } finally { finish?.(); await messages.close(); await f.close(); }
});

test('concurrent duplicate commit cannot enqueue twice or remint an intent', async () => {
  const f = fixture();
  try {
    const intent = await f.claim(); assert.equal(await f.command('openClawMessageReady', { ...f.scope, intent }), true);
    const results = await Promise.all([1, 2].map(() => f.command('openClawMessageCommit', { ...f.scope, intent, media: [] })));
    assert.ok(results.some(r => 'admitted' in r && r.admitted)); assert.equal(f.store.turns.list('openclaw', key).length, 1);
    const again = await f.command('openClawMessageCommit', { ...f.scope, intent, media: [] });
    assert.ok('receipt' in again); assert.equal(again.receipt?.state, 'accepted'); assert.equal(again.admitted, false);
  } finally { await f.close(); }
});

test('lost commit ACK reads original accepted receipt; lost claim ACK cannot repeat attachment effects', async t => {
  for (const boundary of ['claim', 'commit'] as const) await t.test(boundary, async () => {
    const f = fixture();
    try {
      if (boundary === 'commit') {
        const enqueue = f.store.turns.enqueueAsync.bind(f.store.turns);
        t.mock.method(f.store.turns, 'enqueueAsync', async (...args: Parameters<typeof enqueue>) => { await enqueue(...args); throw Error('lost ACK'); });
      } else {
        const command = f.command;
        const messages = new AsyncOpenClawMessages({ owner: { command: async (...args) => {
          const result = await command(...args); if (args[0] === 'openClawMessageClaim') throw Error('lost ACK'); return result;
        } }, defaultAgentId: 'main', ready: () => true, sessionExists: () => true, admitted() {}, persist: async () => { throw Error('no file permission'); } });
        await assert.rejects(messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, wait)); await messages.close();
      }
      const result = await f.messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, wait);
      assert.ok('receipt' in result); assert.equal(result.receipt?.state, boundary === 'commit' ? 'accepted' : 'outcome_unknown');
      assert.equal(f.effects(), boundary === 'commit' ? 1 : 0);
    } finally { await f.close(); }
  });
});

test('deadline only ends delivery; close drains attachment, original commit and admission callback', async () => {
  const f = fixture(); let finish!: () => void, notified!: () => void, effects = 0, drained = false;
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true, sessionExists: () => true,
    persist: async () => { effects++; await new Promise<void>(resolve => { finish = resolve; }); return []; },
    admitted: () => new Promise<void>(resolve => { notified = resolve; }) });
  try {
    const request = { ...f.scope, payloadJson: '{"message":"original"}' };
    const task = messages.send(request, { timeoutMs: 30 });
    const rejected = assert.rejects(task); while (!finish) await tick(); await rejected;
    const closed = messages.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    finish(); while (!notified) await tick(); assert.equal(drained, false);
    const original = await f.messages.readReceipt(f.scope, wait); assert.ok('receipt' in original); assert.equal(original.receipt?.state, 'accepted');
    await assert.rejects(messages.send(request, wait)); assert.equal(effects, 1);
    notified(); await closed; assert.equal(drained, true);
  } finally { finish?.(); notified?.(); await messages.close(); await f.close(); }
});

test('worker current delegation keeps actor, node and issuer pinned without fallback', async () => {
  const f = fixture();
  try {
    const issuer = f.tokens.create({ label: 'issuer', scopes: ['execution:delegate', 'messages:send', 'messages:read'], delegationHubId: 'hub' });
    const ref = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'policy', version: 1, runtime: 'openclaw', sessionKey: key,
      issuerTokenId: issuer.record.id, hubId: 'hub' }, ['messages:send'], Date.now() + 30_000);
    const scope: OpenClawMessageScope = { ...f.scope, authorization: `Bearer ${issuer.token}`, grantId: ref.id, expectedNode: f.store.nodeId };
    const { grantId: _grantId, ...withoutGrant } = scope;
    for (const invalid of [withoutGrant, { ...scope, expectedNode: 'foreign' }, { ...scope, grantId: 'foreign' }])
      assert.deepEqual(await f.command('openClawMessageClaim', { ...invalid, payloadJson: '{"message":"original"}', defaultAgentId: 'main' }), { error: 403 });
    const intent = await f.claim({ message: 'original' }, scope);
    assert.equal(await f.command('openClawMessageReady', { ...scope, intent }), true);
    const result = await f.command('openClawMessageCommit', { ...scope, intent, media: [] }); assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    assert.equal(f.store.turns.list<{ actorId: string }>('openclaw', key)[0]?.payload.actorId, ref.actorId);
    f.store.executionGrants.revoke(issuer.record.id, ref.id);
    const read = await f.messages.readReceipt(scope, wait);
    assert.ok('receipt' in read); assert.equal(read.receipt?.state, 'accepted'); // Original read-only recovery survives grant revocation.
    assert.deepEqual(await f.messages.readSendReceipt(scope, wait), { error: 403 });
  } finally { await f.close(); }
});

test('mirror participant failure rolls back queue and receipt together; persistent unknown stays unknown', async t => {
  const f = fixture();
  try {
    const issued = f.tokens.create({ label: 'mirror', scopes: ['messages:send', 'messages:mirror'] });
    const scope = { ...f.scope, key: 'agent:main:telegram:direct:original', authorization: `Bearer ${issued.token}` };
    const intent = await f.claim({ message: 'original', deliveryMode: 'mirror' } as { message: string }, scope);
    assert.equal(await f.command('openClawMessageReady', { ...scope, intent }), true);
    t.mock.method(f.store.mirrorOutbox, 'admitInTransaction', () => { throw Error('mirror transaction fault'); });
    await assert.rejects(f.command('openClawMessageCommit', { ...scope, intent, media: [] }));
    assert.equal(f.store.turns.list('openclaw', scope.key).length, 0);
    assert.equal(f.store.commands.get(JSON.stringify([issued.record.id, scope.key]), scope.commandKey)?.state, 'outcome_unknown');
  } finally { await f.close(); }
});

test('successful mirror stores original queue, outbox and receipt under one admission identity', async () => {
  const f = fixture();
  try {
    const issued = f.tokens.create({ label: 'mirror', scopes: ['messages:send', 'messages:mirror'] });
    const scope = { ...f.scope, key: 'agent:main:telegram:direct:original', authorization: `Bearer ${issued.token}` };
    const intent = await f.claim({ message: 'original', deliveryMode: 'mirror' } as { message: string }, scope);
    assert.equal(await f.command('openClawMessageReady', { ...scope, intent }), true);
    const result = await f.command('openClawMessageCommit', { ...scope, intent, media: [] }); assert.ok('receipt' in result);
    assert.equal(result.receipt?.state, 'accepted');
    const turn = f.store.turns.list<{ deliveryMode: string }>('openclaw', scope.key)[0]!;
    assert.equal(turn.id, intent.id); assert.equal(turn.payload.deliveryMode, 'mirror');
    assert.ok(f.store.mirrorOutbox.get(intent.id)); assert.equal(result.receipt.result?.body.runId, intent.id);
  } finally { await f.close(); }
});

test('original transient local identity stays authoritative and disposal cannot mint another attachment permission', async () => {
  const f = fixture();
  try {
    const local = f.tokens.createTransient(['messages:send', 'messages:read'], 'local:daily');
    const scope = { ...f.scope, authorization: `Bearer ${local.token}` };
    const intent = await f.claim({ message: 'original' }, scope);
    assert.equal(await f.command('openClawMessageReady', { ...scope, intent }), true);
    local.dispose();
    assert.deepEqual(await f.command('openClawMessageCommit', { ...scope, intent, media: [] }), { error: 401 });
    assert.equal(f.store.turns.list('openclaw', key).length, 0);
    assert.equal(f.store.commands.get(JSON.stringify(['local:daily', key]), 'original')?.state, 'outcome_unknown');
  } finally { await f.close(); }
});

for (const veto of ['runtime_unavailable', 'session_missing'] as const) test(`fresh ${veto} is a durable known rejection, not attachment permission`, async () => {
  const f = fixture();
  try {
    const result = await f.messages.send({ ...f.scope, payloadJson: '{"message":"original"}', rejectFresh: veto }, wait);
    assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'rejected');
    assert.equal(result.receipt.result?.status, veto === 'session_missing' ? 404 : 409); assert.equal(result.intent, null);
    assert.equal(f.effects(), 0); assert.equal(f.wakes(), 0);
    const duplicate = await f.messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, wait);
    assert.ok('receipt' in duplicate); assert.deepEqual(duplicate.receipt, result.receipt);
  } finally { await f.close(); }
});

test('original legacy control receipt is recovery-only and retains original fingerprint', async () => {
  const f = fixture();
  try {
    const scope = JSON.stringify([f.tokens.authenticateAuthorization(authorization)!.tokenId, key]);
    f.store.commands.claim(scope, f.scope.commandKey, { message: '/status' });
    f.store.commands.settle(scope, f.scope.commandKey, { status: 200, body: { ok: true, status: 'running', report: { original: true } } });
    const result = await f.messages.send({ ...f.scope, payloadJson: '{"message":"/status"}' }, wait);
    assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted'); assert.equal(result.intent, null); assert.equal(f.effects(), 0);
    assert.deepEqual(await f.messages.send({ ...f.scope, payloadJson: '{"message":"ordinary"}' }, wait), { error: 409 });
  } finally { await f.close(); }
});

test('send pins private payload before await and throwing diagnostics/notification never replace committed ACK', async () => {
  const f = fixture();
  const diagnostics = new PerformanceDiagnostics(() => {});
  diagnostics.start = () => { throw Error('diagnostic fault'); };
  const messages = new AsyncOpenClawMessages({ owner: { command: f.command }, defaultAgentId: 'main', ready: () => true, sessionExists: () => true,
    diagnostics, persist: async () => [], admitted() { throw Error('projection unavailable'); } });
  try {
    const request = { ...f.scope, payloadJson: '{"message":"original"}' };
    const task = messages.send(request, wait); request.payloadJson = '{"message":"mutated"}';
    const result = await task; assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    assert.equal(f.store.turns.list<{ message: string }>('openclaw', key)[0]?.payload.message, 'original');
  } finally { await messages.close(); await f.close(); }
});

test('real worker restart retires volatile media permission but never reclaims persistent unknown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-message-unknown-worker-'));
  const file = join(directory, 'original.sqlite'), tokenFile = join(directory, 'tokens.json');
  new ConnectorTokenStore(tokenFile, token, silent);
  let owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent);
  const scope = { key, authorization, commandKey: 'unknown-worker' }, input = { ...scope, payloadJson: '{"message":"original"}', defaultAgentId: 'main' };
  try {
    await owner.open(); const claim = await owner.command('openClawMessageClaim', input); assert.ok('intent' in claim && claim.intent);
    assert.equal(await owner.command('openClawMessageReady', { ...scope, intent: claim.intent }), true);
    await owner.close(); owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent); await owner.open();
    const duplicate = await owner.command('openClawMessageClaim', input); assert.ok('receipt' in duplicate);
    assert.equal(duplicate.receipt?.state, 'outcome_unknown'); assert.equal(duplicate.intent, null);
    assert.equal(await owner.command('openClawMessageReady', { ...scope, intent: claim.intent }), false);
    const result = await owner.command('openClawMessageCommit', { ...scope, intent: claim.intent, media: [] });
    assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'outcome_unknown'); assert.equal(result.admitted, false);
  } finally { await owner.closeForShutdown(); rmSync(directory, { recursive: true, force: true }); }
});

test('real worker ordinary message reaches existing dispatch and reopens without replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-message-worker-'));
  const file = join(directory, 'original.sqlite'), tokenFile = join(directory, 'tokens.json');
  new ConnectorTokenStore(tokenFile, token, silent);
  let owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent);
  let sends = 0, effects = 0;
  const request = { key, authorization, commandKey: 'worker-original', payloadJson: '{"message":"original"}' };
  let messages: AsyncOpenClawMessages | undefined, dispatch: AsyncOpenClawDispatch | undefined;
  try {
    await owner.open();
    dispatch = new AsyncOpenClawDispatch({ owner, gateway: { connectionId: () => 'connection', prepareWriteConnection: async () => 'connection',
      requestBound: async <T>(_method: string, _payload: Record<string, unknown>, _expected?: string, before?: () => void) => {
        before?.(); sends++; return { connectionId: 'connection', payload: { runId: 'run' } as T };
      } }, native: { available: () => true, epoch: () => 'epoch' }, allowCliFallback: false, message: x => x });
    messages = new AsyncOpenClawMessages({ owner, defaultAgentId: 'main', ready: () => true, sessionExists: () => true,
      admitted: async k => { assert.equal(await dispatch!.dispatch(k), 'admitted'); }, persist: async () => { effects++; return []; } });
    const result = await messages.send(request, wait); assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    assert.equal(sends, 1); assert.equal(effects, 1);
    await messages.close(); await dispatch.close(); await owner.close();
    owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent); await owner.open();
    const recovered = await owner.command('openClawMessageClaim', { ...request, defaultAgentId: 'main' });
    assert.ok('receipt' in recovered); assert.deepEqual(recovered.receipt, result.receipt); assert.equal(recovered.intent, null);
    const execution = (await owner.command('openClawExecutionRead', { sessionKey: key }))!;
    assert.equal(execution.phase, 'unknown'); assert.equal(execution.reason, 'restarted');
    assert.equal(execution.commandId, result.receipt!.result!.body.runId); assert.equal(execution.runId, 'run');
    assert.equal(await owner.command('openClawExecutionAcknowledge', { sessionKey: key,
      commandId: execution.commandId, transport: 'gateway', connectionId: 'connection', runId: 'run' }), false);
    assert.deepEqual(await owner.command('openClawExecutionRead', { sessionKey: key }), execution);
    assert.equal(sends, 1); assert.equal(effects, 1);
  } finally { await messages?.close(); await dispatch?.close(); await owner.closeForShutdown(); rmSync(directory, { recursive: true, force: true }); }
});
