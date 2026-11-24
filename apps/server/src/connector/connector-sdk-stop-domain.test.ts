import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore, type ConnectorScope } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import { validConnectorSdkStopInput, validConnectorSdkStopOutput } from './connector-sdk-stop-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { dispatchSdkMessageStop } from './async-sdk-message-stop.js';

const authorization = 'Bearer isolated-stop-domain';
async function fixture(runtime: SdkAgentId, kind: 'message' | 'compact' = 'message') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-stop-domain-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), 'isolated-stop-domain');
  const actor = tokens.authenticateAuthorization(authorization)!;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal, key = `${runtime}:original`;
  journal.create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 1 });
  const command = createConnectorOwnerCommands(store, tokens);
  store.turns.enqueue(runtime, { id: 'original-turn', sessionKey: key, createdAt: 1,
    payload: { actorId: actor.tokenId, text: 'original', images: [] } });
  const dispatch = new AsyncSdkDispatch({ runtime, owner: { command }, deadlineMs: 1_000, adapter: { ready: true, epoch: 'original-epoch',
    send: async () => ({ nativeRequestId: 'original-native-request' }), interrupt: async () => {},
    inspectSettlement: async ref => ({ ...ref, historyPersisted: true, nativeQuiescent: true }),
  } });
  assert.equal(await dispatch.dispatch(key), 'accepted');
  if (kind === 'compact') {
    const first = journal.current(key)!;
    assert.equal(journal.observeTerminal(first, 'completed', store.turns), true);
    assert.equal(journal.confirmSettled(first), true);
    assert.ok(journal.beginCompact({ key, id: 'original-compact', epoch: 'compact-epoch' }, actor.tokenId, store.turns, () => {}));
  }
  const execution = journal.current(key)!;
  const ref = { key, id: execution.id, epoch: execution.epoch, nativeSessionId: execution.nativeSessionId };
  const input = { runtime, key, authorization, commandKey: 'stop', ref,
    payloadJson: JSON.stringify({ message: '/stop', expectedRunId: execution.id }) };
  return { tokens, actor, store, journal, command, key, ref, input,
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  for (const mismatch of ['kind', 'id', 'epoch', 'nativeSessionId'] as const) {
    test(`${runtime}: stop coordinator rejects substituted original ${mismatch} before native`, async () => {
      const f = await fixture(runtime);
      let interrupts = 0, ready = 0;
      try {
        const owner = { command: (async (command, input) => {
          if (command === 'sdkMessageStopReady') ready++;
          const result = await f.command(command, input);
          if (command === 'sdkMessageStopClaim' && result && typeof result === 'object' && 'execution' in result && result.execution) {
            return { ...result, execution: mismatch === 'kind'
              ? { ...result.execution, kind: 'compact', control: { actorId: f.actor.tokenId } }
              : { ...result.execution, [mismatch]: 'substituted' } };
          }
          return result;
        }) as typeof f.command };
        await dispatchSdkMessageStop(f.input, { owner, runtime, kind: 'message', ref: f.ref,
          available: () => true, interrupt: async () => { interrupts++; } });
        assert.equal(interrupts, 0); assert.equal(ready, 0);
        assert.equal(f.store.commands.get(JSON.stringify([f.actor.tokenId, f.key]), 'stop')?.state, 'outcome_unknown');
      } finally { f.close(); }
    });
  }
  for (const kind of ['message', 'compact'] as const) {
  test(`${runtime}/${kind}: stop binding pins original receipt/run and consumes ready once`, async () => {
    const f = await fixture(runtime, kind);
    try {
      const claimed = await f.command('sdkMessageStopClaim', f.input); assert.ok('receipt' in claimed && claimed.execution);
      const binding = { runtime, key: f.key, commandKey: 'stop', receiptId: claimed.receipt.id, ref: f.ref };
      assert.equal(f.journal.current(f.key)?.stopRequested, true);
      assert.equal(await f.command('sdkMessageStopSettle', binding), false, 'settle cannot precede original native dispatch');
      for (const forged of [
        { ...binding, receiptId: 'different-receipt' },
        { ...binding, ref: { ...f.ref, id: 'different-run' } },
        { ...binding, ref: { ...f.ref, epoch: 'different-epoch' } },
        { ...binding, ref: { ...f.ref, nativeSessionId: 'different-native' } },
      ]) {
        assert.equal(await f.command('sdkMessageStopReady', { ...forged, authorization }), false);
        assert.equal(await f.command('sdkMessageStopSettle', forged), false);
      }
      const other = f.tokens.create({ label: 'different actor', scopes: ['messages:send', 'messages:read'] });
      assert.equal(await f.command('sdkMessageStopReady', { ...binding, authorization: `Bearer ${other.token}` }), false);
      assert.equal(await f.command('sdkMessageStopReady', { ...binding, authorization }), true);
      assert.equal(await f.command('sdkMessageStopReady', { ...binding, authorization }), false);
      assert.equal(await f.command('sdkMessageStopSettle', binding), true);
      assert.equal(await f.command('sdkMessageStopSettle', binding), false);
      const duplicate = await f.command('sdkMessageStopClaim', { ...f.input, ref: null });
      assert.ok('receipt' in duplicate); assert.equal(duplicate.receipt.id, claimed.receipt.id);
      assert.equal(duplicate.receipt.state, 'accepted'); assert.equal(duplicate.execution, null);
      const privateReceipt = await f.command('sdkMessageReceiptRead', { runtime, key: f.key, commandKey: 'stop', authorization: `Bearer ${other.token}` });
      assert.ok('receipt' in privateReceipt); assert.equal(privateReceipt.receipt, null);
    } finally { f.close(); }
  });

  test(`${runtime}/${kind}: receipt failure rolls back stop intent in the same transaction`, async t => {
    const f = await fixture(runtime, kind);
    try {
      const method = kind === 'compact' ? 'requestCompactStop' : 'requestStop';
      const original = f.journal[method].bind(f.journal);
      const mock = t.mock.method(f.journal, method, (ref: typeof f.ref) => { assert.equal(original(ref), true); throw Error('injected rollback'); });
      await assert.rejects(f.command('sdkMessageStopClaim', f.input), /injected rollback/);
      assert.equal(f.journal.current(f.key)?.stopRequested, false);
      assert.equal(f.store.commands.get(JSON.stringify([f.actor.tokenId, f.key]), 'stop'), undefined);
      mock.mock.restore();
      const claimed = await f.command('sdkMessageStopClaim', f.input); assert.ok('receipt' in claimed && claimed.execution);
      assert.equal(f.journal.current(f.key)?.stopRequested, true);
    } finally { f.close(); }
  });

  test(`${runtime}/${kind}: original scope, expected run and epoch mismatch never request a stop`, async () => {
    const f = await fixture(runtime, kind);
    try {
      for (const [index, ref] of [null, { ...f.ref, epoch: 'stale-epoch' }, { ...f.ref, nativeSessionId: 'stale-native' }].entries()) {
        const result = await f.command('sdkMessageStopClaim', { ...f.input, ref, commandKey: `stale-${index}` });
        assert.ok('receipt' in result); assert.equal(result.receipt.state, 'rejected'); assert.equal(result.execution, null);
        assert.equal(f.journal.current(f.key)?.stopRequested, false);
      }
      for (const scopes of [['messages:read'], ['messages:send', 'execution:delegate']] satisfies ConnectorScope[][]) {
        const denied = f.tokens.create({ label: 'scope boundary', scopes });
        assert.deepEqual(await f.command('sdkMessageStopClaim', { ...f.input, authorization: `Bearer ${denied.token}` }), { error: 403 });
      }
      assert.deepEqual(await f.command('sdkMessageStopClaim', { ...f.input, authorization: 'Bearer invalid' }), { error: 401 });
      assert.equal(f.journal.current(f.key)?.stopRequested, false);
    } finally { f.close(); }
  });
  }
}

test('stop IPC rejects SQL-shaped commands and non-boolean physical claims', () => {
  const input = { runtime: 'ghcp', key: 'ghcp:original', commandKey: 'stop', authorization, payloadJson: '{}', ref: null };
  assert.equal(validConnectorSdkStopInput('sdkMessageStopClaim', input), true);
  assert.equal(validConnectorSdkStopInput('sdkMessageStopClaim', { ...input, sql: 'SELECT 1' }), false);
  assert.equal(validConnectorSdkStopOutput('sdkMessageStopReady', Promise.resolve(true)), false);
  assert.equal(validConnectorSdkStopOutput('sdkMessageStopSettle', { accepted: true }), false);
});
