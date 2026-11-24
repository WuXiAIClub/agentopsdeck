import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands, connectorOwnerSteps, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

const authorization = 'Bearer isolated-lifecycle-test';
const catalogs = { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } };
function fixture(runtime: SdkAgentId) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-lifecycle-domain-')), file = join(root, 'connector.sqlite');
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), 'isolated-lifecycle-test');
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  let store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  let owner = createConnectorOwnerCommands(store, tokens, catalogs);
  let journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  const key = `${runtime}:original`, commandKey = 'original-deletion';
  journal.create({ key, nativeSessionId: randomUUID(), title: 'Original', createdAt: 1 });
  const claim = { runtime, key, commandKey, authorization };
  return { root, tokens, actor, key, claim,
    get owner() { return owner; }, get store() { return store; }, get journal() { return journal; },
    get db() { return (store as unknown as { db: DatabaseSync }).db; },
    reopen() { store.close(); store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      owner = createConnectorOwnerCommands(store, tokens, catalogs); journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal; },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('lifecycle fixed protocol refuses caller authority, swapped scope and loose physical proofs', () => {
  const request = { runtime: 'ghcp', key: 'ghcp:original', history: true };
  assert.equal(connectorOwnerSteps.sdkLifecycleRead, 106); assert.equal(connectorOwnerSteps.sdkDeletionSettle, 109);
  assert.equal(validConnectorOwnerInput('sdkLifecycleRead', request), true);
  for (const field of ['sql', 'actorId', 'authorized', 'database', 'model']) {
    assert.equal(validConnectorOwnerInput('sdkLifecycleRead', { ...request, [field]: true }), false);
  }
  assert.equal(validConnectorOwnerInput('sdkLifecycleRead', { ...request, key: 'claude-code:original' }), false);
  assert.equal(validConnectorOwnerOutput('sdkDeletionSettle', true), false);
});

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: deletion intent and receipt share original admission rollback`, async () => {
    const f = fixture(runtime);
    try {
      f.db.exec("CREATE TRIGGER fail_deletion_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'fixture'); END");
      await assert.rejects(f.owner('sdkDeletionClaim', f.claim));
      assert.equal(f.journal.deletion(f.key), undefined);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()!.n, 0);
      f.db.exec('DROP TRIGGER fail_deletion_receipt');
      const result = await f.owner('sdkDeletionClaim', f.claim);
      assert.ok('receipt' in result && result.admitted && result.intent);
      assert.equal(result.receipt.id, result.intent.id); assert.equal(result.nativeRequired, false);
      assert.equal(result.receipt.state, 'outcome_unknown'); assert.equal(f.journal.canStart(f.key), false);
    } finally { f.close(); }
  });

  test(`${runtime}: fresh exact identity once; success survives subsequent revocation`, async () => {
    const f = fixture(runtime);
    try {
      const result = await f.owner('sdkDeletionClaim', f.claim);
      assert.ok('receipt' in result && result.intent);
      const ref = { runtime, key: f.key, intent: result.intent, receiptId: result.receipt.id };
      assert.equal(await f.owner('sdkDeletionReady', { ...ref, intent: { ...ref.intent, nativeSessionId: 'swapped' }, authorization }), false);
      assert.equal(await f.owner('sdkDeletionSettle', { ...ref, accepted: true, nativeQuiescent: true }), false);
      assert.equal(await f.owner('sdkDeletionReady', { ...ref, authorization }), true);
      assert.equal(await f.owner('sdkDeletionReady', { ...ref, authorization }), false);
      assert.equal(f.tokens.revoke(f.actor), true);
      const settled = await f.owner('sdkDeletionSettle', { ...ref, accepted: true, nativeQuiescent: true });
      assert.ok(settled !== false); assert.equal(settled.receipt.state, 'accepted');
      assert.equal(settled.receipt.id, result.receipt.id); assert.equal(f.journal.deletion(f.key)?.phase, 'deleted');
      assert.equal(await f.owner('sdkDeletionSettle', { ...ref, accepted: true, nativeQuiescent: true }), false);
      f.reopen(); assert.equal(f.journal.session(f.key), undefined);
      assert.equal(f.journal.deletion(f.key)?.phase, 'deleted');
    } finally { f.close(); }
  });

  test(`${runtime}: revoke before native handoff denies; unknown and restart never replay`, async () => {
    const f = fixture(runtime);
    try {
      const result = await f.owner('sdkDeletionClaim', f.claim);
      assert.ok('receipt' in result && result.intent);
      const ref = { runtime, key: f.key, intent: result.intent, receiptId: result.receipt.id };
      f.tokens.revoke(f.actor);
      assert.equal(await f.owner('sdkDeletionReady', { ...ref, authorization }), false);
      const settled = await f.owner('sdkDeletionSettle', { ...ref, accepted: false, nativeQuiescent: false });
      assert.ok(settled !== false); assert.equal(settled.receipt.state, 'outcome_unknown');
      assert.equal(f.journal.deletion(f.key)?.phase, 'unknown');
      f.reopen(); assert.equal(f.journal.canStart(f.key), false);
      assert.equal(await f.owner('sdkDeletionReady', { ...ref, authorization }), false);
    } finally { f.close(); }
  });

  test(`${runtime}: receipt failure rolls back tombstone and attachments; retry only observes original receipt`, async () => {
    const f = fixture(runtime);
    try {
      const attachment = { id: randomUUID(), name: 'original.txt', mimeType: 'text/plain', data: Buffer.from('original attachment').toString('base64') };
      f.db.exec('BEGIN IMMEDIATE');
      f.store.sdkAttachments.save(f.key, 'original-admission', [attachment]);
      f.db.exec('COMMIT');
      const media = f.store.sdkAttachments.media(f.key, 'original-admission');
      assert.equal(media.length, 1);
      const result = await f.owner('sdkDeletionClaim', f.claim);
      assert.ok('receipt' in result && result.intent);
      const ref = { runtime, key: f.key, intent: result.intent, receiptId: result.receipt.id };
      assert.equal(await f.owner('sdkDeletionReady', { ...ref, authorization }), true);
      f.db.exec("CREATE TRIGGER fail_deletion_settle BEFORE UPDATE ON command_receipts WHEN new.state='accepted' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
      await assert.rejects(f.owner('sdkDeletionSettle', { ...ref, accepted: true, nativeQuiescent: true }));
      assert.equal(f.journal.deletion(f.key)?.phase, 'pending'); assert.ok(f.journal.session(f.key));
      assert.deepEqual(f.store.sdkAttachments.media(f.key, 'original-admission'), media);
      f.db.exec('DROP TRIGGER fail_deletion_settle');
      const unknown = await f.owner('sdkDeletionSettle', { ...ref, accepted: false, nativeQuiescent: false });
      assert.ok(unknown !== false); assert.equal(unknown.receipt.state, 'outcome_unknown');
      assert.deepEqual(f.store.sdkAttachments.media(f.key, 'original-admission'), media);
      const resume = f.store.pauseTurnStarts();
      const duplicate = await f.owner('sdkDeletionClaim', f.claim);
      assert.ok('receipt' in duplicate && !duplicate.admitted && !duplicate.intent);
      assert.equal(duplicate.receipt.id, result.receipt.id); resume();
      f.reopen();
      assert.deepEqual(f.store.sdkAttachments.media(f.key, 'original-admission'), media);
      const reopened = await f.owner('sdkDeletionClaim', f.claim);
      assert.ok('receipt' in reopened && !reopened.admitted); assert.equal(reopened.receipt.id, result.receipt.id);
    } finally { f.close(); }
  });

  test(`${runtime}: history snapshot is bounded, scoped and tombstone authoritative`, async () => {
    const f = fixture(runtime);
    try {
      const view = await f.owner('sdkLifecycleRead', { runtime, key: f.key, history: true });
      assert.equal(view.runtime, runtime); assert.equal(view.key, f.key); assert.ok(view.snapshot.session);
      assert.ok(validConnectorOwnerOutput('sdkLifecycleRead', view));
      assert.equal(validConnectorOwnerOutput('sdkLifecycleRead', { ...view, key: `${runtime}:different` }), false);
      const noHistory = await f.owner('sdkLifecycleRead', { runtime, key: f.key, history: false });
      assert.equal(noHistory.page, null);
      const result = await f.owner('sdkDeletionClaim', f.claim); assert.ok('receipt' in result && result.intent);
      const ref = { runtime, key: f.key, receiptId: result.receipt.id, intent: result.intent };
      await f.owner('sdkDeletionReady', { ...ref, authorization });
      await f.owner('sdkDeletionSettle', { ...ref, accepted: true, nativeQuiescent: true });
      const deleted = await f.owner('sdkLifecycleRead', { runtime, key: f.key, history: true });
      assert.equal(deleted.snapshot.session, null); assert.equal(deleted.page, null);
      assert.equal(deleted.snapshot.deletion?.phase, 'deleted');
    } finally { f.close(); }
  });
}
