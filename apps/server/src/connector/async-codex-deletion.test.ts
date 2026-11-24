import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import type { CodexDeletionResult } from './connector-codex-deletion-domain.js';

const key = 'codex:original';
function result(v: CodexDeletionResult | { error: number }): CodexDeletionResult { assert.ok(!('error' in v)); return v; }
async function fixture(t: TestContext, seed?: (store: ConnectorUserStore, actor: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-deletion-'));
  const config = { file: join(directory, 'original.sqlite'), tokenFile: join(directory, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile);
  const credential = tokens.create({ label: 'original', scopes: ['sessions:create'] });
  const other = tokens.create({ label: 'other', scopes: ['sessions:create'] });
  const reader = tokens.create({ label: 'reader', scopes: ['sessions:read'] });
  const delegate = tokens.create({ label: 'delegate', scopes: ['sessions:create', 'execution:delegate'] });
  if (seed) { const store = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
    try { await seed(store, credential.record.id); } finally { store.close(); } }
  let owner = new AsyncConnectorOwner(config, new PerformanceDiagnostics(() => {})); await owner.open();
  const scope = { key, authorization: `Bearer ${credential.token}`, commandKey: 'original' };
  t.after(async () => { try { await owner.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  return { get owner() { return owner; }, scope, tokens, credential,
    other: `Bearer ${other.token}`, reader: `Bearer ${reader.token}`, delegate: `Bearer ${delegate.token}`,
    claim: () => owner.command('codexDeletionClaim', scope).then(result),
    async restart() { await owner.close(); owner = new AsyncConnectorOwner(config, new PerformanceDiagnostics(() => {})); await owner.open(); } };
}

test('deletion DTOs reject authority substitution, arbitrary result, SQL and cross-runtime intent', () => {
  const scope = { authorization: 'Bearer original', key, commandKey: 'original' };
  assert.equal(validConnectorOwnerInput('codexDeletionClaim', scope), true);
  for (const extra of [{ actor: 'forged' }, { sql: 'SELECT 1' }, { key: 'hermes:original' }, { authorization: 'Bearer\nsecret' }])
    assert.equal(validConnectorOwnerInput('codexDeletionClaim', { ...scope, ...extra }), false);
  const intent = { id: 'private', key, commandKey: 'original', receiptId: 'original-receipt' };
  assert.equal(validConnectorOwnerInput('codexDeletionBegin', { intent }), false);
  assert.equal(validConnectorOwnerInput('codexDeletionAccept', { intent, result: {} }), false);
  assert.equal(validConnectorOwnerOutput('codexDeletionAccept', { key, commandKey: 'original', intent: null,
    receipt: { id: 'receipt', key: 'original', state: 'accepted', createdAt: 1, updatedAt: 1,
      result: { status: 200, body: { ok: true, status: 'forged' } } } }), false);
});

test('worker claims original receipt once, fences cross-actor deletion and consumes private intent once', async t => {
  const f = await fixture(t), claim = await f.claim(); assert.ok(claim.intent);
  assert.equal(claim.receipt.state, 'outcome_unknown');
  const duplicate = await f.claim(); assert.equal(duplicate.receipt.id, claim.receipt.id); assert.equal(duplicate.intent, null);
  const foreign = await f.owner.command('codexDeletionReceipt', { ...f.scope, authorization: f.other });
  assert.ok(!('error' in foreign)); assert.equal(foreign.receipt, null);
  const competing = await f.owner.command('codexDeletionClaim', { ...f.scope, authorization: f.other, commandKey: 'other' });
  assert.ok('error' in competing || competing.receipt.state === 'rejected');
  assert.equal(await f.owner.command('codexDeletionBegin', { intent: { ...claim.intent, receiptId: 'forged' }, authorization: f.scope.authorization }), false);
  assert.equal(await f.owner.command('codexDeletionAccept', { intent: claim.intent }), false);
  assert.equal(await f.owner.command('codexDeletionBegin', { intent: claim.intent, authorization: f.scope.authorization }), true);
  assert.equal(await f.owner.command('codexDeletionBegin', { intent: claim.intent, authorization: f.scope.authorization }), false);
  const accepted = await f.owner.command('codexDeletionAccept', { intent: claim.intent }); assert.ok(accepted);
  assert.deepEqual(accepted.receipt.result, { status: 200, body: { ok: true, status: 'delete_accepted' } });
  assert.equal(await f.owner.command('codexDeletionAccept', { intent: claim.intent }), false);
  assert.equal((await f.claim()).receipt.state, 'accepted');
});

test('deletion rejects untrusted, read-only and delegated identity without consuming a receipt', async t => {
  const f = await fixture(t);
  for (const [authorization, error] of [['Bearer unknown', 401], [f.reader, 403], [f.delegate, 403]] as const) {
    assert.deepEqual(await f.owner.command('codexDeletionClaim', { ...f.scope, authorization }), { error });
    assert.deepEqual(await f.owner.command('codexDeletionReceipt', { ...f.scope, authorization }), { error });
  }
  assert.ok((await f.claim()).intent);
});

test('revocation before begin vetoes effect; proven preflight failure rejects and releases deletion fence', async t => {
  const f = await fixture(t), claimed = await f.claim(); assert.ok(claimed.intent);
  f.tokens.revoke(f.credential.record.id);
  assert.equal(await f.owner.command('codexDeletionBegin', { intent: claimed.intent, authorization: f.scope.authorization }), false);
  const abandoned = await f.owner.command('codexDeletionAbandon', { intent: claimed.intent }); assert.ok(abandoned);
  assert.equal(abandoned.receipt.state, 'rejected');
  assert.deepEqual(abandoned.receipt.result, { status: 409, body: { error: 'Command rejected' } });
  // An external credential-file write retires the old token owner, not just
  // the revoked credential. Never bypass that fail-closed ownership fence.
  assert.deepEqual(await f.owner.command('codexDeletionClaim', { ...f.scope, authorization: f.other, commandKey: 'next' }), { error: 401 });
  await f.restart();
  assert.deepEqual(await f.owner.command('codexDeletionClaim', f.scope), { error: 401 });
  const next = await f.owner.command('codexDeletionClaim', { ...f.scope, authorization: f.other, commandKey: 'next' });
  assert.ok(!('error' in next) && next.intent);
});

test('revocation after begin hides result but does not erase the original late native ACK', async t => {
  const f = await fixture(t), claimed = await f.claim(); assert.ok(claimed.intent);
  assert.equal(await f.owner.command('codexDeletionBegin', { intent: claimed.intent, authorization: f.scope.authorization }), true);
  f.tokens.revoke(f.credential.record.id);
  const unknown = await f.owner.command('codexDeletionAbandon', { intent: claimed.intent }); assert.ok(unknown);
  assert.equal(unknown.receipt.state, 'outcome_unknown');
  const accepted = await f.owner.command('codexDeletionAccept', { intent: claimed.intent }); assert.ok(accepted);
  assert.equal(accepted.receipt.state, 'accepted');
  assert.deepEqual(await f.owner.command('codexDeletionReceipt', f.scope), { error: 401 });
});

test('worker restart preserves uncertain receipt but cannot reconstruct effect capability', async t => {
  const f = await fixture(t), claimed = await f.claim(); assert.ok(claimed.intent);
  await f.restart();
  const duplicate = await f.claim(); assert.equal(duplicate.receipt.id, claimed.receipt.id);
  assert.equal(duplicate.receipt.state, 'outcome_unknown'); assert.equal(duplicate.intent, null);
  assert.equal(await f.owner.command('codexDeletionBegin', { intent: claimed.intent, authorization: f.scope.authorization }), false);
  assert.equal(await f.owner.command('codexDeletionAccept', { intent: claimed.intent }), false);
});

test('original legacy accepted deletion receipt is observed without a new intent', async t => {
  const f = await fixture(t, async (store, actor) => {
    const scope = JSON.stringify(['delete', JSON.stringify([actor, key])]);
    await store.commands.claimAsync(scope, 'original', {});
    store.commands.settle(scope, 'original', { status: 200, body: { ok: true, status: 'delete_accepted' } });
  });
  const duplicate = await f.claim(); assert.equal(duplicate.intent, null); assert.equal(duplicate.receipt.state, 'accepted');
});

test('original queued work and pending settings each prevent deletion', async t => {
  const f = await fixture(t, async (store, actor) => {
    await store.turns.enqueueAsync('codex', { id: 'original-queued', sessionKey: key, createdAt: 1, state: 'queued',
      payload: { text: 'original input', actorId: actor, images: [] } });
  });
  const denied = await f.owner.command('codexDeletionClaim', f.scope);
  assert.ok('error' in denied || denied.receipt.state === 'rejected');
  const settingsKey = 'codex:settings';
  const settings = await f.owner.command('codexSettingsClaim', { ...f.scope, key: settingsKey, payloadJson: '{"title":"Original"}' });
  assert.ok(!('error' in settings) && settings.intent);
  const conflicting = await f.owner.command('codexDeletionClaim', { ...f.scope, key: settingsKey });
  assert.ok('error' in conflicting || conflicting.receipt.state === 'rejected');
});
