import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncCodexStop } from './async-codex-stop.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { validConnectorCodexStopInput, validConnectorCodexStopOutput } from './connector-codex-stop-domain.js';

const token = 'isolated-stop-token', authorization = `Bearer ${token}`, key = 'codex:original';
const wait = { timeoutMs: 10_000 };
function fixture(persisted = true) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-stop-owner-'));
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token, diagnostics);
  const store = new ConnectorUserStore(':memory:', id => !!tokens.delegationHubId(id), { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens);
  if (persisted) {
    store.codexExecutions.begin(key, 'original-command', 'connection');
    store.codexExecutions.acknowledge(key, 'original-command', 'connection', 'native-turn', () => {});
  }
  const scope = { authorization, key, commandKey: 'stop-key' };
  const request = { ...scope, payloadJson: JSON.stringify({ message: '/stop', expectedRunId: 'native-turn' }) };
  let sends = 0, ready = true;
  const hooks: { before?: () => void | Promise<void>; after?: () => void | Promise<void> } = {};
  const runtime = { stopConnectionId: 'connection' as string | null,
    interruptOwned: async (...args: Parameters<import('../codex/app-server.js').CodexAppServer['interruptOwned']>) => {
      const [intent, port] = args;
      assert.equal(intent.runId, 'native-turn');
      await port.check(false); await hooks.before?.(); await port.check(false);
      port.dispatched(); sends++; await port.acknowledged(); await hooks.after?.(); await port.check(true);
    } };
  const stop = new AsyncCodexStop({ owner: { command }, runtime, available: () => ready, diagnostics });
  const claim = async (payloadJson = request.payloadJson) => {
    const value = await command('codexStopClaim', { ...request, payloadJson, connectionId: 'connection' });
    assert.ok('intent' in value && value.intent); return value.intent;
  };
  return { store, tokens, command, scope, request, runtime, hooks, stop, claim, diagnostics, logs,
    sends: () => sends, ready: (v: boolean) => { ready = v; },
    async close() { await stop.close(); command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('stop ACK preserves execution protection and exact frontend receipt; duplicate cannot resend', async () => {
  const f = fixture(), before = structuredClone(f.store.codexExecutions.get(key));
  try {
    const first = await f.stop.stop(f.request, wait); assert.ok('receipt' in first);
    assert.equal(first.receipt?.state, 'accepted');
    assert.deepEqual(first.receipt?.result?.body, { ok: true, runId: 'native-turn', status: 'interrupt_requested', idempotencyKey: 'stop-key', media: [] });
    assert.deepEqual(await f.stop.stop(f.request, wait), first); assert.equal(f.sends(), 1);
    assert.deepEqual(await f.stop.stop({ ...f.request, payloadJson: JSON.stringify({ message: ' /stop ', expectedRunId: 'native-turn' }) }, wait), { error: 409 });
    assert.deepEqual(f.store.codexExecutions.get(key), before);
    assert.equal(f.store.codexExecutions.canStart(key), false);
    assert.equal(f.store.turns.list('codex', key).length, 0);
    assert.ok(f.logs.some(line => line.includes('codex-stop')));
    assert.doesNotMatch(f.logs.join('\n'), /isolated-stop-token|native-turn|original-command|stop-key/);
  } finally { await f.close(); }
});

for (const payload of [{ message: '/stop' }, { message: '/stop', expectedRunId: 'original-command' },
  { message: '/stop', expectedRunId: 'native-turn', deliveryMode: 'mirror' }, { message: '/status', expectedRunId: 'native-turn' }])
test(`invalid stop intent has no native effect: ${JSON.stringify(payload)}`, async () => {
  const f = fixture();
  try { const value = await f.stop.stop({ ...f.request, payloadJson: JSON.stringify(payload) }, wait);
    assert.ok('receipt' in value); assert.equal(value.receipt?.state, 'rejected'); assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

test('worker exact intent, one-shot ready, unknown ACK and release never free original execution', async () => {
  const f = fixture();
  try {
    const intent = await f.claim();
    assert.equal(await f.command('codexStopReady', { ...f.scope, intent: { ...intent, runId: 'forged' } }), false);
    assert.equal(await f.command('codexStopCheck', { ...f.scope, intent, afterInterrupt: false }), false);
    assert.equal(await f.command('codexStopReady', { ...f.scope, intent }), true);
    assert.equal(await f.command('codexStopReady', { ...f.scope, intent }), false);
    await f.command('codexStopSettle', { intent, outcome: 'unknown' });
    await f.command('codexStopRelease', { intent });
    const duplicate = await f.stop.stop(f.request, wait); assert.ok('receipt' in duplicate);
    assert.equal(duplicate.receipt?.state, 'outcome_unknown'); assert.equal(f.sends(), 0);
    assert.equal(f.store.codexExecutions.canStart(key), false);
  } finally { await f.close(); }
});

test('maintenance pause does not prohibit stopping an existing turn', async () => {
  const f = fixture();
  try { f.store.pauseTurnStarts(); const value = await f.stop.stop(f.request, wait);
    assert.ok('receipt' in value); assert.equal(value.receipt?.state, 'accepted'); assert.equal(f.sends(), 1);
  } finally { await f.close(); }
});

for (const afterAck of [false, true]) test(`current revoke ${afterAck ? 'after' : 'before'} native ACK never replays or unlocks`, async () => {
  const f = fixture();
  try {
    const tokenId = f.tokens.authenticateAuthorization(authorization)!.tokenId;
    const revoke = () => { f.tokens.revoke(f.tokens.authenticateAuthorization(authorization)!.tokenId); };
    f.hooks[afterAck ? 'after' : 'before'] = revoke;
    assert.deepEqual(await f.stop.stop(f.request, wait), { error: 401 });
    const receipt = f.store.commands.get(JSON.stringify([tokenId, key]), 'stop-key');
    assert.equal(receipt?.state, afterAck ? 'accepted' : 'rejected');
    assert.equal(f.sends(), afterAck ? 1 : 0); assert.equal(f.store.codexExecutions.canStart(key), false);
  } finally { await f.close(); }
});

for (const boundary of ['codexStopClaim', 'codexStopReady', 'codexStopSettle', 'codexStopRelease'] as const)
for (const after of [false, true]) test(`lost ${boundary} ${after ? 'after' : 'before'} delivery retains original receipt without replay`, async () => {
  const f = fixture(); let injected = false;
  const stop = new AsyncCodexStop({ runtime: f.runtime, available: () => true, diagnostics: f.diagnostics,
    owner: { command: async (kind, input) => {
      if (kind === boundary && !injected) { injected = true;
        if (after) await f.command(kind, input); throw Error('lost delivery'); }
      return f.command(kind, input);
    } } });
  try {
    try { await stop.stop(f.request, wait); } catch { /* A lost claim has no locally known intent. */ }
    const before = f.sends(); const saved = await f.stop.readReceipt(f.scope, wait); assert.ok('receipt' in saved);
    const expected = boundary === 'codexStopSettle' ? after ? 'accepted' : 'outcome_unknown'
      : boundary === 'codexStopRelease' ? 'accepted' : boundary === 'codexStopClaim' ? after ? 'outcome_unknown' : undefined : 'rejected';
    assert.equal(saved.receipt?.state, expected);
    if (saved.receipt) await f.stop.stop(f.request, wait);
    assert.equal(f.sends(), before); assert.equal(f.store.codexExecutions.canStart(key), false);
  } finally { await stop.close(); await f.close(); }
});

test('post-ACK cleanup failure returns accepted receipt, never terminal or retry', async () => {
  const f = fixture();
  try { f.hooks.after = () => { throw Error('cleanup failed'); };
    const value = await f.stop.stop(f.request, wait); assert.ok('receipt' in value);
    assert.equal(value.receipt?.state, 'accepted'); await f.stop.stop(f.request, wait); assert.equal(f.sends(), 1);
    assert.equal(f.store.codexExecutions.canStart(key), false);
  } finally { await f.close(); }
});

test('waiter timeout retains physical operation through drain, settles ACK once', async () => {
  const f = fixture(); let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  f.hooks.before = async () => { enter(); await held; };
  try {
    const waiting = f.stop.stop(f.request, { timeoutMs: 15 });
    await entered; await assert.rejects(waiting);
    let drained = false; const draining = f.stop.drain().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
    finish(); await draining;
    const value = await f.stop.readReceipt(f.scope, wait); assert.ok('receipt' in value);
    assert.equal(value.receipt?.state, 'accepted'); assert.equal(f.sends(), 1);
  } finally { finish?.(); await f.close(); }
});

test('protocol rejects forged fields, partial intents and foreign receipt output', () => {
  assert.equal(validConnectorCodexStopInput('codexStopReceiptRead', { authorization, key, commandKey: 'key', authorized: true }), false);
  assert.equal(validConnectorCodexStopInput('codexStopReady', { authorization, key, commandKey: 'key', intent: {} }), false);
  assert.equal(validConnectorCodexStopOutput('codexStopCheck', { pendingCommandTools: [], cleanupRecovered: Promise.resolve(true) }), false);
});

test('same native run observations may advance revision but terminal/blocked facts cannot start interrupt', async () => {
  const f = fixture();
  try {
    const intent = await f.claim();
    f.store.codexExecutions.observeCommandTool(key, 'connection', 'native-turn', 'owned-tool');
    assert.equal(await f.command('codexStopReady', { ...f.scope, intent }), true);
    assert.deepEqual(await f.command('codexStopCheck', { ...f.scope, intent, afterInterrupt: false }),
      { pendingCommandTools: ['owned-tool'], cleanupRecovered: false });
    f.store.codexExecutions.observe(key, 'connection', 'native-turn', 'interrupted');
    assert.equal(await f.command('codexStopCheck', { ...f.scope, intent, afterInterrupt: false }), false);
    assert.ok(await f.command('codexStopCheck', { ...f.scope, intent, afterInterrupt: true }));
    f.store.codexExecutions.invalidateNativeHistory(key);
    assert.equal(await f.command('codexStopCheck', { ...f.scope, intent, afterInterrupt: true }), false);
  } finally { await f.close(); }
});

test('stop-only execution grant works without messages:send grant, current revocation vetoes cleanup', async () => {
  const f = fixture();
  try {
    const issuer = f.tokens.create({ label: 'issuer', scopes: ['execution:delegate', 'messages:send'], delegationHubId: 'hub' });
    const grant = f.store.executionGrants.issue({ principalId: 'member', grantKey: 'stop-policy', version: 1,
      runtime: 'codex', sessionKey: key, issuerTokenId: issuer.record.id, hubId: 'hub' }, ['runs:interrupt'], Date.now() + 30_000);
    const scope = { ...f.scope, authorization: `Bearer ${issuer.token}`, grantId: grant.id, expectedNode: f.store.nodeId };
    const value = await f.stop.stop({ ...scope, payloadJson: f.request.payloadJson }, wait);
    assert.ok('receipt' in value); assert.equal(value.receipt?.state, 'accepted'); assert.equal(f.sends(), 1);
    assert.deepEqual(await f.stop.readReceipt(scope, wait), value);
    f.store.executionGrants.revoke(issuer.record.id, grant.id);
    assert.deepEqual(await f.stop.readReceipt(scope, wait), { error: 403 });
    assert.deepEqual(await f.stop.stop({ ...scope, payloadJson: f.request.payloadJson }, wait), { error: 403 });
    assert.equal(f.sends(), 1);
  } finally { await f.close(); }
});

test('absent execution Goal intent cannot survive a new persisted execution', async () => {
  const f = fixture(false);
  try {
    const intent = await f.claim(); assert.equal(intent.commandId, null);
    f.store.codexExecutions.begin(key, 'successor', 'connection');
    assert.equal(await f.command('codexStopReady', { ...f.scope, intent }), false);
    assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

test('close freezes physical pre-dispatch operation, waits it and never calls native', async () => {
  const f = fixture(); let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  f.hooks.before = async () => { enter(); await held; };
  try {
    const waiting = f.stop.stop(f.request, wait); await entered;
    let closed = false; const closing = f.stop.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    finish(); await waiting; await closing; assert.equal(f.sends(), 0);
    await assert.rejects(f.stop.stop(f.request, wait));
  } finally { finish?.(); await f.close(); }
});

for (const acknowledged of [false, true]) test(`real worker reopen preserves ${acknowledged ? 'accepted' : 'unknown'} stop without replay`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-stop-reopen-'));
  const file = join(directory, 'connector.sqlite'), tokenFile = join(directory, 'tokens.json');
  const diagnostics = new PerformanceDiagnostics(() => {});
  const seed = new ConnectorUserStore(file);
  seed.codexExecutions.begin(key, 'original-command', 'connection');
  seed.codexExecutions.acknowledge(key, 'original-command', 'connection', 'native-turn', () => {}); seed.close();
  let owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, diagnostics);
  let stop: AsyncCodexStop | undefined, effects = 0;
  const request = { key, authorization, commandKey: 'original-stop', payloadJson: '{"message":"/stop","expectedRunId":"native-turn"}' };
  try {
    await owner.open();
    stop = new AsyncCodexStop({ owner, diagnostics, available: () => true,
      runtime: { stopConnectionId: 'connection', interruptOwned: async (_intent, port) => {
        await port.check(false); port.dispatched(); effects++;
        if (acknowledged) await port.acknowledged();
        throw Error('native ACK or post-ACK cleanup lost');
      } } });
    const first = await stop.stop(request, wait); assert.ok('receipt' in first);
    assert.equal(first.receipt?.state, acknowledged ? 'accepted' : 'outcome_unknown');
    await stop.close(); await owner.closeForShutdown();
    owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, diagnostics); await owner.open();
    stop = new AsyncCodexStop({ owner, diagnostics, available: () => true,
      runtime: { stopConnectionId: 'connection', interruptOwned: async () => assert.fail('reopen cannot resend native interrupt') } });
    const duplicate = await stop.stop(request, wait); assert.ok('receipt' in duplicate);
    assert.equal(duplicate.receipt?.id, first.receipt?.id); assert.equal(duplicate.receipt?.state, first.receipt?.state);
    assert.equal(effects, 1);
  } finally { await stop?.close(); await owner.closeForShutdown(); rmSync(directory, { recursive: true, force: true }); }
});

test('connection changes after native ACK preserve accepted receipt and stop further cleanup', async () => {
  const f = fixture();
  try {
    f.hooks.after = () => { f.runtime.stopConnectionId = 'successor-connection'; };
    const value = await f.stop.stop(f.request, wait); assert.ok('receipt' in value);
    assert.equal(value.receipt?.state, 'accepted'); assert.equal(f.sends(), 1);
    assert.equal(f.store.codexExecutions.canStart(key), false);
  } finally { await f.close(); }
});
