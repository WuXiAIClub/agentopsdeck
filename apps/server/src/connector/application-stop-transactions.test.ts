import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originalApplicationAuthFixture } from '../auth/application-transaction-test-fixture.js';
import { createApplicationTransactionClient, createApplicationTransactionLink } from '../auth/application-transaction-gate.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import type { HermesExecution } from '../hermes/journal.js';

const runtimes = ['codex', 'openclaw', 'hermes', 'claude-code', 'ghcp'] as const;
type Runtime = typeof runtimes[number];
const applicationKey = 'original-stop-application-key', session = 's'.repeat(43);
const authorization = 'Bearer isolated-stop-transport';
const silent = new PerformanceDiagnostics(() => {});

async function fixture(t: TestContext, runtime: Runtime, role: 'hub' | 'standalone', mode: 'json' | 'sqlite') {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-application-stop-')), link = createApplicationTransactionLink();
  const auth = originalApplicationAuthFixture(root, role, mode, applicationKey, silent, link.auth);
  link.connector.begin(); link.connector.data.ref();
  const client = createApplicationTransactionClient(link.connector.data);
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'isolated-stop-transport', silent);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens, undefined, undefined, undefined, false, undefined, client);
  t.after(async () => {
    command.dispose(); store.close(); link.connector.data.close(); link.connector.confirmExit();
    await auth.closeForShutdown(); link.closeUnused(); rmSync(root, { recursive: true, force: true });
  });
  await auth.open(); await auth.issueSession(session);
  const key = runtime === 'openclaw' ? 'agent:main:dashboard:original' : `${runtime}:original`;
  const scope = { key, commandKey: 'original-stop', authorization };
  const application = { cookie: `agentopsdeck_session=${session}` };
  let claim!: () => Promise<void>, ready!: () => Promise<boolean>, settle!: () => Promise<unknown>;
  const currentReceipt = () => store.commands.get(JSON.stringify([actor, key]), scope.commandKey);
  if (runtime === 'codex') {
    store.codexExecutions.begin(key, 'original-command', 'connection');
    store.codexExecutions.acknowledge(key, 'original-command', 'connection', 'original-native', () => {});
    let intent: import('./connector-codex-stop-domain.js').CodexStopIntent;
    claim = async () => {
      const r = await command('codexStopClaim', { ...scope, application, connectionId: 'connection',
        payloadJson: JSON.stringify({ message: '/stop', expectedRunId: 'original-native' }) });
      assert.ok('intent' in r); if (r.intent) intent = r.intent;
    };
    ready = () => command('codexStopReady', { ...scope, intent });
    settle = () => command('codexStopSettle', { intent, outcome: 'acknowledged' });
  } else if (runtime === 'openclaw') {
    store.openClawExecutions.begin(key, 'original-command');
    store.openClawExecutions.bindGatewayConnection(key, 'original-command', 'connection');
    store.openClawExecutions.acknowledge(key, 'original-command', 'original-native');
    let intent: import('./connector-openclaw-stop-domain.js').OpenClawStopIntent;
    claim = async () => {
      const r = await command('openClawStopClaim', { ...scope, application, connectionId: 'connection',
        payloadJson: JSON.stringify({ message: '/stop', expectedRunId: 'original-command' }) });
      assert.ok('intent' in r); if (r.intent) intent = r.intent;
    };
    ready = () => command('openClawStopReady', { ...scope, intent });
    settle = () => command('openClawStopSettle', { intent, outcome: 'acknowledged' });
  } else if (runtime === 'hermes') {
    const execution: HermesExecution = { key, id: 'original-run', live: 'live', epoch: 'original-epoch',
      phase: 'running', members: ['original-member'], row: 1, at: 1, updated: 1 };
    store.hermesJournal.save({ key, stored: 'native', title: 'Original', started: true, messages: [] });
    store.hermesJournal.update(execution);
    let receiptId: string;
    claim = async () => {
      const r = await command('hermesStopClaim', { ...scope, application, execution,
        payloadJson: JSON.stringify({ message: '/stop', expectedRunId: execution.id }) });
      assert.ok('receipt' in r && r.receipt); receiptId = r.receipt.id;
    };
    ready = () => command('hermesStopReady', { ...scope, receiptId, execution });
    settle = () => command('hermesStopSettle', { key, commandKey: scope.commandKey, receiptId, execution, outcome: 'acknowledged' });
  } else {
    const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
    journal.create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 1 });
    store.turns.enqueue(runtime, { id: 'original-turn', sessionKey: key, createdAt: 1,
      payload: { actorId: actor, text: 'original', images: [] } });
    const dispatch = new AsyncSdkDispatch({ runtime, owner: { command }, deadlineMs: 1000,
      adapter: { ready: true, epoch: 'original-epoch', send: async () => ({ nativeRequestId: 'original-native-request' }),
        interrupt: async () => {}, inspectSettlement: async ref => ({ ...ref, historyPersisted: true, nativeQuiescent: true }) } });
    assert.equal(await dispatch.dispatch(key), 'accepted');
    const e = journal.current(key)!, ref = { key, id: e.id, epoch: e.epoch, nativeSessionId: e.nativeSessionId };
    let receiptId: string;
    claim = async () => {
      const r = await command('sdkMessageStopClaim', { ...scope, runtime, application, ref,
        payloadJson: JSON.stringify({ message: '/stop', expectedRunId: e.id }) });
      assert.ok('receipt' in r); receiptId = r.receipt.id;
    };
    ready = () => command('sdkMessageStopReady', { ...scope, runtime, receiptId, ref });
    settle = () => command('sdkMessageStopSettle', { key, commandKey: scope.commandKey, runtime, receiptId, ref });
  }
  return { claim, ready, settle, currentReceipt, revoke: () => auth.revokeSession(session),
    revokeTransport: () => tokens.revoke(actor) };
}

for (const runtime of runtimes) for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) {
  test(`${runtime}/${role}/${mode}: revoked original application identity cannot claim stop`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, runtime, role, mode); await f.revoke();
    await assert.rejects(f.claim()); assert.equal(f.currentReceipt(), undefined);
  });
  test(`${runtime}/${role}/${mode}: Ready rechecks retained original identity without replacement evidence`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, runtime, role, mode); await f.claim();
    assert.equal(f.currentReceipt()?.state, 'outcome_unknown'); await f.revoke();
    await assert.rejects(f.ready()); assert.equal(f.currentReceipt()?.state, 'outcome_unknown');
    assert.equal(await f.settle(), false, 'no ACK settlement before original one-shot dispatch');
  });
  test(`${runtime}/${role}/${mode}: one-shot Ready and late original ACK survive both authority revocations`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, runtime, role, mode); await f.claim();
    assert.equal(await f.ready(), true); assert.equal(await f.ready(), false);
    await f.revoke(); f.revokeTransport();
    assert.notEqual(await f.settle(), false); assert.equal(f.currentReceipt()?.state, 'accepted');
    const accepted = structuredClone(f.currentReceipt());
    const repeated = await f.settle();
    // Codex retains its immutable ACK for the post-interrupt Check; the other
    // owners retire this binding immediately. Neither path hands off native work.
    if (runtime === 'codex') assert.notEqual(repeated, false);
    else assert.equal(repeated, false);
    assert.deepEqual(f.currentReceipt(), accepted, 'ACK recovery cannot rewrite the original receipt');
  });
}
