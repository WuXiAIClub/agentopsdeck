import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HermesExecution } from '../hermes/journal.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import type { ConnectorHermesStopCommands } from './connector-hermes-stop-domain.js';

const token = 'isolated-stop-token', authorization = `Bearer ${token}`, key = 'hermes:original';
const execution: HermesExecution = { id: 'original-run', key, live: 'live', epoch: 'original-epoch',
  phase: 'running', members: ['original-member'], row: 1, at: 1, updated: 1 };
const request = { key, commandKey: 'original-stop', authorization, execution,
  payloadJson: JSON.stringify({ message: '/stop', expectedRunId: execution.id }) };
function seed(store: ConnectorUserStore) {
  store.hermesJournal.save({ key, stored: 'native', title: 'Original', started: true, messages: [] });
  store.hermesJournal.update(execution);
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-stop-'));
  const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'), token);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true }); seed(store);
  const command = createConnectorOwnerCommands(store, tokens);
  return { store, tokens, actor, command,
    async claim() {
      const r = await command('hermesStopClaim', request);
      assert.ok('receipt' in r && r.receipt && r.execution);
      return { result: r, ref: { key, commandKey: request.commandKey, receiptId: r.receipt.id, execution } };
    },
    close() { command.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('stop protocol accepts only original evidence, fixed commands and strict readiness', () => {
  assert.equal(validConnectorOwnerInput('hermesStopClaim', request), true);
  for (const name of ['actorId', 'authorized', 'sql', 'callback', 'nativeReady'])
    assert.equal(validConnectorOwnerInput('hermesStopClaim', { ...request, [name]: true }), false);
  for (const bad of [{ ...execution, key: 'codex:foreign' }, { ...execution, phase: 'completed' }])
    assert.equal(validConnectorOwnerInput('hermesStopClaim', { ...request, execution: bad }), false);
  for (const bad of [1, 'true', {}, null]) assert.equal(validConnectorOwnerOutput('hermesStopReady', bad), false);
  assert.equal(validConnectorOwnerOutput('hermesStopSettle', { error: 401 }), false);
});

test('original stop claim, one-shot ready and ACK share receipt/fence; duplicate has no native handoff', async () => {
  const f = fixture();
  try {
    const { result, ref } = await f.claim();
    assert.equal(result.receipt!.state, 'outcome_unknown'); assert.equal(f.store.hermesJournal.interruptPending(key), true);
    const duplicate = await f.command('hermesStopClaim', request);
    assert.ok('execution' in duplicate); assert.equal(duplicate.execution, null); assert.deepEqual(duplicate.receipt, result.receipt);
    assert.equal(await f.command('hermesStopSettle', { ...ref, outcome: 'acknowledged' }), false);
    assert.equal(await f.command('hermesStopReady', { ...ref, authorization }), true);
    assert.equal(await f.command('hermesStopReady', { ...ref, authorization }), false);
    const settled = await f.command('hermesStopSettle', { ...ref, outcome: 'acknowledged' });
    assert.ok(settled); assert.equal(settled.receipt!.state, 'accepted');
    assert.deepEqual(settled.receipt!.result, { status: 200, body: { ok: true, status: 'interrupt_requested', runId: execution.id,
      idempotencyKey: request.commandKey, media: [] } });
    assert.equal(f.store.hermesJournal.interruptPending(key), false);
    assert.equal(f.store.hermesJournal.current(key)?.phase, 'running', 'ACK is not terminal evidence');
    assert.equal(await f.command('hermesStopSettle', { ...ref, outcome: 'acknowledged' }), false);
  } finally { f.close(); }
});

for (const fault of ['run', 'row', 'epoch', 'live', 'missing', 'media'] as const)
  test(`stop rejects ${fault} without a native handoff or successor fence`, async () => {
    const f = fixture();
    try {
      const input = structuredClone(request);
      if (fault === 'missing') input.execution = null as unknown as HermesExecution;
      else if (fault === 'media') input.payloadJson = JSON.stringify({ message: '/stop', expectedRunId: execution.id, media: [{ type: 'image', path: 'x' }] });
      else if (fault === 'run') input.payloadJson = JSON.stringify({ message: '/stop', expectedRunId: 'foreign' });
      else if (fault === 'row') input.execution.row = 2;
      else input.execution[fault] = 'foreign';
      const result = await f.command('hermesStopClaim', input);
      assert.ok('receipt' in result); assert.equal(result.execution, null); assert.equal(result.receipt?.state, 'rejected');
      assert.equal(f.store.hermesJournal.interruptPending(key), false);
    } finally { f.close(); }
  });

test('terminal-before-ACK cannot release a successor; unknown and retry preserve original fence', async () => {
  const f = fixture();
  try {
    const { ref } = await f.claim();
    assert.equal(await f.command('hermesStopReady', { ...ref, authorization }), true);
    f.store.hermesJournal.update({ ...execution, phase: 'completed', updated: 2 });
    assert.equal(f.store.hermesJournal.canStart(key), false);
    const r = await f.command('hermesStopSettle', { ...ref, outcome: 'unknown' });
    assert.ok(r); assert.equal(r.receipt?.state, 'outcome_unknown');
    assert.equal(f.store.hermesJournal.canStart(key), false);
    assert.equal(await f.command('hermesStopReady', { ...ref, authorization }), false);
    const duplicate = await f.command('hermesStopClaim', request);
    assert.ok('execution' in duplicate); assert.equal(duplicate.execution, null);
    assert.equal(f.store.hermesJournal.interruptPending(key), true);
  } finally { f.close(); }
});

test('current revoke prevents preflight but never rolls back a physical ACK', async () => {
  for (const dispatched of [false, true]) {
    const f = fixture();
    try {
      const { ref } = await f.claim();
      if (dispatched) assert.equal(await f.command('hermesStopReady', { ...ref, authorization }), true);
      f.tokens.revoke(f.actor);
      assert.equal(await f.command('hermesStopReady', { ...ref, authorization }), false);
      const r = await f.command('hermesStopSettle', { ...ref, outcome: dispatched ? 'acknowledged' : 'not_dispatched' });
      assert.ok(r); assert.equal(r.receipt?.state, dispatched ? 'accepted' : 'rejected');
      assert.equal(f.store.hermesJournal.interruptPending(key), false);
      assert.deepEqual(await f.command('hermesStopReceiptRead', { key, commandKey: request.commandKey, authorization }), { error: 401 });
    } finally { f.close(); }
  }
});

test('failed receipt settlement atomically preserves original successor fence', async () => {
  const f = fixture(), settle = f.store.commands.settle.bind(f.store.commands);
  try {
    const { ref } = await f.claim();
    assert.equal(await f.command('hermesStopReady', { ...ref, authorization }), true);
    f.store.commands.settle = () => { throw Error('isolated storage failure'); };
    await assert.rejects(f.command('hermesStopSettle', { ...ref, outcome: 'acknowledged' }));
    assert.equal(f.store.hermesJournal.interruptPending(key), true);
    f.store.commands.settle = settle;
    const r = await f.command('hermesStopSettle', { ...ref, outcome: 'acknowledged' });
    assert.ok(r); assert.equal(r.receipt?.state, 'accepted'); assert.equal(f.store.hermesJournal.interruptPending(key), false);
  } finally { f.store.commands.settle = settle; f.close(); }
});

test('post-commit admission failure rejects only original known-unsent stop instead of stranding its fence', async () => {
  const f = fixture(), claim = f.store.commands.claimAsync.bind(f.store.commands);
  try {
    f.store.commands.claimAsync = async (...args: Parameters<typeof claim>) => { await claim(...args); throw Error('isolated release failure'); };
    await assert.rejects(f.command('hermesStopClaim', request));
    assert.equal(f.store.hermesJournal.interruptPending(key), false);
    const view = await f.command('hermesStopReceiptRead', { key, commandKey: request.commandKey, authorization });
    assert.ok('receipt' in view); assert.equal(view.receipt?.state, 'rejected');
    f.store.commands.claimAsync = claim;
    const duplicate = await f.command('hermesStopClaim', request);
    assert.ok('execution' in duplicate); assert.equal(duplicate.execution, null);
  } finally { f.store.commands.claimAsync = claim; f.close(); }
});

test('read-only and delegated tokens cannot acquire original stop; full payload conflicts never replay', async () => {
  const f = fixture();
  try {
    for (const scopes of [['messages:read'], ['messages:send', 'execution:delegate']] as const) {
      const other = f.tokens.create({ label: 'isolated-limited', scopes: [...scopes] });
      assert.deepEqual(await f.command('hermesStopClaim', { ...request, authorization: `Bearer ${other.token}` }), { error: 403 });
    }
    const { result } = await f.claim();
    assert.deepEqual(await f.command('hermesStopClaim', { ...request, payloadJson: JSON.stringify({ message: '/stop', expectedRunId: 'other-run' }) }), { error: 409 });
    const duplicate = await f.command('hermesStopClaim', request);
    assert.ok('receipt' in duplicate); assert.equal(duplicate.receipt?.id, result.receipt?.id); assert.equal(duplicate.execution, null);
  } finally { f.close(); }
});

test('exclusive worker reopen preserves accepted and unknown originals without restoring stop authority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-stop-worker-')), file = join(dir, 'connector.sqlite'), tokenFile = join(dir, 'tokens.json');
  let worker: AsyncConnectorOwner | undefined;
  try {
    new ConnectorTokenStore(tokenFile, token);
    const seedStore = new ConnectorUserStore(file, undefined, { runtimeOwner: true }); seed(seedStore); seedStore.close();
    const silence = new PerformanceDiagnostics(() => {});
    worker = new AsyncConnectorOwner({ file, tokenFile }, silence); await worker.open();
    const accepted = await worker.command('hermesStopClaim', request); assert.ok('receipt' in accepted && accepted.receipt && accepted.execution);
    const ref = { key, commandKey: request.commandKey, receiptId: accepted.receipt.id, execution };
    assert.equal(await worker.command('hermesStopReady', { ...ref, authorization }), true);
    assert.ok(await worker.command('hermesStopSettle', { ...ref, outcome: 'acknowledged' }));
    const pending = await worker.command('hermesStopClaim', { ...request, commandKey: 'pending' });
    assert.ok('receipt' in pending && pending.receipt && pending.execution);
    await worker.close();
    worker = new AsyncConnectorOwner({ file, tokenFile }, silence); await worker.open();
    for (const commandKey of [request.commandKey, 'pending']) {
      const view: ConnectorHermesStopCommands['hermesStopReceiptRead']['output'] = await worker.command('hermesStopReceiptRead', { key, authorization, commandKey });
      assert.ok('receipt' in view); assert.equal(view.receipt?.state, commandKey === 'pending' ? 'outcome_unknown' : 'accepted');
      const duplicate: ConnectorHermesStopCommands['hermesStopClaim']['output'] = await worker.command('hermesStopClaim', { ...request, commandKey });
      assert.ok('execution' in duplicate); assert.equal(duplicate.execution, null);
    }
    assert.equal(await worker.command('hermesStopReady', { ...ref, commandKey: 'pending', receiptId: pending.receipt.id, authorization }), false);
    await worker.close(); worker = undefined;
    const check = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    try { assert.equal(check.hermesJournal.interruptPending(key), true); } finally { check.close(); }
  } finally { await worker?.close(); rmSync(dir, { recursive: true, force: true }); }
});
