import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesCreation } from './async-hermes-creation.js';
import type { ConnectorHermesCreationCommands } from './connector-hermes-creation-domain.js';

const token = 'isolated-hermes-create', authorization = `Bearer ${token}`, silence = new PerformanceDiagnostics(() => {});
const request = { authorization, commandKey: 'original', payloadJson: JSON.stringify({ title: 'Private original title' }) };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-creation-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens), owner = { command };
  return { store, tokens, actor, command, owner,
    async claim() { const r = await command('hermesCreationClaim', request); assert.ok('intent' in r && r.intent && r.admitted); return r; },
    close() { command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('creation protocol is fixed and rejects SQL, caller authority, extra identity and malformed receipts', () => {
  assert.equal(validConnectorOwnerInput('hermesCreationClaim', request), true);
  for (const field of ['actorId', 'authorized', 'sql', 'callback', 'key', 'nativeReady'])
    assert.equal(validConnectorOwnerInput('hermesCreationClaim', { ...request, [field]: true }), false);
  for (const payloadJson of ['[]', '{} garbage', '{"title":true}', '{"model":{"name":"x"}}', '{"authorization":"new"}', ' '.repeat(8193)])
    assert.equal(validConnectorOwnerInput('hermesCreationClaim', { ...request, payloadJson }), false);
  assert.equal(validConnectorOwnerInput('hermesCreationReady', { intent: { key: 'codex:x', title: 'x', receiptId: 'r' }, authorization }), false);
  assert.equal(validConnectorOwnerOutput('hermesCreationClaim', { error: '401' }), false);
  assert.equal(validConnectorOwnerOutput('hermesCreationSettle', { error: 401 }), false);
});

test('claim persists original unknown, native readiness is one-shot, duplicate has no handoff', async () => {
  const f = fixture();
  try {
    const r = await f.claim(), intent = r.intent!;
    assert.equal(r.receipt.state, 'outcome_unknown'); assert.match(intent.key, /^hermes:/);
    assert.equal(f.store.hermesJournal.session(intent.key), undefined);
    const duplicate = await f.command('hermesCreationClaim', request);
    assert.ok('receipt' in duplicate); assert.deepEqual(duplicate.receipt, r.receipt);
    assert.equal(duplicate.intent, null); assert.equal(duplicate.admitted, false);
    assert.deepEqual(await f.command('hermesCreationClaim', { ...request, payloadJson: '{"title":"different"}' }), { error: 409 });
    assert.equal(await f.command('hermesCreationSettle', { intent, stored: 'native' }), false);
    assert.equal(await f.command('hermesCreationReady', { intent: { ...intent, key: 'hermes:foreign' }, authorization }), false);
    assert.equal(await f.command('hermesCreationReady', { intent, authorization }), true);
    assert.equal(await f.command('hermesCreationReady', { intent, authorization }), false);
  } finally { f.close(); }
});

for (const reason of ['revoke', 'maintenance'] as const) test(`current ${reason} prevents original handoff`, async () => {
  const f = fixture();
  try {
    const r = await f.claim();
    if (reason === 'revoke') f.tokens.revoke(f.actor); else await f.command('maintenancePause', {});
    assert.equal(await f.command('hermesCreationReady', { intent: r.intent!, authorization }), false);
    assert.equal(f.store.hermesJournal.sessions().length, 0);
    if (reason === 'revoke') assert.deepEqual(await f.command('hermesCreationReceiptRead', { authorization, commandKey: request.commandKey }), { error: 401 });
  } finally { f.close(); }
});

for (const input of [{ title: 'x'.repeat(121) }, { title: 'bad\nname' }, { model: 'forbidden' }] as const)
  test(`invalid legacy title/model cannot allocate identity (${JSON.stringify(input).slice(0, 40)})`, async () => {
    const f = fixture();
    try {
      const r = await f.command('hermesCreationClaim', { ...request, payloadJson: JSON.stringify(input) });
      assert.ok('receipt' in r); assert.equal(r.receipt.state, 'rejected'); assert.equal(r.admitted, false);
      assert.equal(r.intent, null); assert.equal(f.store.hermesJournal.sessions().length, 0);
    } finally { f.close(); }
  });

test('settlement preserves irreversible native identity after revoke, delivery stays denied', async () => {
  const f = fixture();
  try {
    const r = await f.claim(), intent = r.intent!;
    assert.equal(await f.command('hermesCreationReady', { intent, authorization }), true);
    f.tokens.revoke(f.actor);
    const settled = await f.command('hermesCreationSettle', { intent, stored: 'native-original' });
    assert.ok(settled); assert.equal(settled.receipt.state, 'accepted');
    assert.deepEqual(settled.receipt.result, { status: 201, body: { key: intent.key, agentId: 'hermes', title: intent.title } });
    assert.equal(f.store.hermesJournal.session(intent.key)?.stored, 'native-original');
    assert.equal(await f.command('hermesCreationSettle', { intent, stored: 'replacement' }), false);
    assert.deepEqual(await f.command('hermesCreationReceiptRead', { authorization, commandKey: request.commandKey }), { error: 401 });
  } finally { f.close(); }
});

test('session, 201 receipt and event roll back together on original event failure', async () => {
  const f = fixture(), append = f.store.events.appendInTransaction;
  try {
    const r = await f.claim(), intent = r.intent!;
    await f.command('hermesCreationReady', { intent, authorization });
    const cursor = f.store.events.latestEventId();
    f.store.events.appendInTransaction = () => { throw Error('original transaction failure'); };
    await assert.rejects(f.command('hermesCreationSettle', { intent, stored: 'native-original' }));
    assert.equal(f.store.hermesJournal.session(intent.key), undefined);
    assert.equal(f.store.events.latestEventId(), cursor);
    const view = await f.command('hermesCreationReceiptRead', { authorization, commandKey: request.commandKey });
    assert.ok('receipt' in view); assert.equal(view.receipt?.state, 'outcome_unknown');
    f.store.events.appendInTransaction = append;
    const unknown = await f.command('hermesCreationSettle', { intent, stored: null });
    assert.ok(unknown); assert.equal(unknown.receipt.state, 'outcome_unknown');
    assert.equal(await f.command('hermesCreationReady', { intent, authorization }), false);
  } finally { f.store.events.appendInTransaction = append; f.close(); }
});

test('legacy title normalization and original read-only namespace are preserved', async () => {
  const f = fixture();
  try {
    const r = await f.command('hermesCreationClaim', { ...request, payloadJson: '{"label":"  Legacy  "}' });
    assert.ok('intent' in r && r.intent); assert.equal(r.intent.title, 'Legacy');
    await f.command('hermesCreationReady', { intent: r.intent, authorization });
    const settled = await f.command('hermesCreationSettle', { intent: r.intent, stored: 'native' });
    assert.ok(settled);
    assert.deepEqual(f.store.commands.get(JSON.stringify(['create', JSON.stringify([f.actor, 'hermes'])]), request.commandKey), settled.receipt);
  } finally { f.close(); }
});

test('sole real worker retains accepted and unknown creation receipts after exclusive reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-create-worker-')), file = join(directory, 'connector.sqlite'), tokenFile = join(directory, 'tokens.json');
  let worker: AsyncConnectorOwner | undefined;
  try {
    new ConnectorTokenStore(tokenFile, token);
    worker = new AsyncConnectorOwner({ file, tokenFile }, silence); await worker.open();
    let effects = 0;
    const creation = new AsyncHermesCreation({ owner: worker, deadlineMs: 10_000, workspace: directory, diagnostics: silence,
      native: { available: () => true, epoch: () => 'original', create: async () => { effects++; return { session_id: 'live', stored_session_id: 'native' }; } }, created: () => {} });
    const accepted = await creation.create(request); assert.ok('receipt' in accepted); assert.equal(accepted.receipt.state, 'accepted');
    const pending = await worker.command('hermesCreationClaim', { ...request, commandKey: 'pending' });
    assert.ok('intent' in pending && pending.intent);
    await creation.close(); await worker.close();
    worker = new AsyncConnectorOwner({ file, tokenFile }, silence); await worker.open();
    const acceptedKey = String(accepted.receipt.result!.body.key);
    const snapshot = await worker.command('hermesHistorySnapshot', { key: acceptedKey });
    assert.ok(snapshot); assert.equal(snapshot.started, false); assert.equal(snapshot.nativeAllocated, true);
    // Even a caller bypassing the runtime cannot rotate an allocated empty
    // session through the original journal attachment transaction.
    assert.equal(await worker.command('hermesHistoryAttach', { key: acceptedKey, digest: snapshot.digest, stored: 'replacement' }), null);
    const attached = await worker.command('hermesHistoryAttach', { key: acceptedKey, digest: snapshot.digest, stored: 'native' });
    assert.equal(attached?.nativeAllocated, true);
    for (const commandKey of [request.commandKey, 'pending']) {
      const view: ConnectorHermesCreationCommands['hermesCreationReceiptRead']['output'] = await worker.command('hermesCreationReceiptRead', { authorization, commandKey });
      assert.ok('receipt' in view); assert.equal(view.receipt?.state, commandKey === 'pending' ? 'outcome_unknown' : 'accepted');
      const duplicate: ConnectorHermesCreationCommands['hermesCreationClaim']['output'] = await worker.command('hermesCreationClaim', { ...request, commandKey });
      assert.ok('intent' in duplicate); assert.equal(duplicate.intent, null); assert.equal(duplicate.admitted, false);
    }
    assert.equal(await worker.command('hermesCreationReady', { intent: pending.intent, authorization }), false);
    assert.equal(effects, 1);
  } finally { await worker?.close(); rmSync(directory, { recursive: true, force: true }); }
});
