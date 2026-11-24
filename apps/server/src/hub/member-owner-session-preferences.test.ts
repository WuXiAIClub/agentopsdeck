import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput } from './member-owner-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {});
async function fixture(work: (f: ReturnType<typeof seed>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-preference-owner-r50-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'preference-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const member = store.createUser('Existing member'), other = store.createUser('Other member');
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  store.upsertConnection({ id: 'connection', label: 'Existing', connectorUrl: 'http://fixture.invalid', credentialToken: 'synthetic', ownerUserId: member.id });
  const sessionKey = encodeHubSessionId('connection', 'old-session');
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }),
    change: { sessionKey, field: 'hidden' as const, value: true } };
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, file, member, other, key, token, sessionKey, proof, db };
}
test('preference owner preserves original flags and reopens with the original facade', () => fixture(async f => {
  f.store.setSessionPreference(f.sessionKey, 'archived', true, f.member.id);
  f.store.setSessionPreference(f.sessionKey, 'pinned', true, f.other.id);
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'preference-fixture' }, quiet);
  try {
    await owner.open();
    assert.deepEqual(await owner.command('sessionPreferenceSet', f.proof), { ok: true });
    assert.deepEqual(await owner.command('sessionPreferenceSet', f.proof), { ok: true });
  } finally { await owner.close(); }
  const original = new HubStore(f.file, 'preference-fixture');
  try {
    assert.deepEqual(original.sessionPreferences(f.member.id).get(f.sessionKey), { hidden: true, archived: true });
    assert.deepEqual(original.sessionPreferences(f.other.id).get(f.sessionKey), { pinned: true });
  } finally { await original.close(); }
}));
test('preference SQL checks scope and current connection before mutation, not caller owner claims', () => fixture(async f => {
  assert.equal(validHubMemberInput('sessionPreferenceSet', { ...f.proof, userId: f.other.id }), false);
  assert.equal(validHubMemberInput('sessionPreferenceSet', { ...f.proof, authorized: true }), false);
  assert.equal(executeHubMemberCommand(f.store, 'sessionPreferenceSet', { ...f.proof, expectedScope: '0'.repeat(64) }), null);
  f.store.upsertConnection({ id: 'connection', label: 'Existing', connectorUrl: 'http://fixture.invalid', status: 'disabled', ownerUserId: f.member.id }, { preserveCredential: true });
  assert.deepEqual(executeHubMemberCommand(f.store, 'sessionPreferenceSet', f.proof), { error: 'missing' });
  assert.equal(f.store.sessionPreferences(f.member.id).size, 0);
  f.store.identities.revokeKey(f.member.id, f.key.id);
  assert.equal(executeHubMemberCommand(f.store, 'sessionPreferenceSet', f.proof), null);
}));
test('preference owner preserves long canonical keys without imposing a new saved-state limit', () => fixture(async f => {
  const sessionKey = encodeHubSessionId('connection', 'long-remote-key'.repeat(2000));
  const proof = { ...f.proof, change: { ...f.proof.change, sessionKey } };
  assert.equal(validHubMemberInput('sessionPreferenceSet', proof), true);
  assert.deepEqual(executeHubMemberCommand(f.store, 'sessionPreferenceSet', proof), { ok: true });
  assert.equal(f.db.prepare('SELECT hidden FROM session_preferences WHERE user_id = ? AND session_id = ?').get(f.member.id, sessionKey)?.hidden, 1);
  // The existing bounded read refuses this old large key. Never silently
  // truncate it or manufacture an empty Map while migrating the write domain.
  assert.throws(() => f.store.sessionPreferences(f.member.id), /hub_delivery_read_unavailable/);
}));
test('preference SQL failure rolls back original write without hiding or retrying the fault', () => fixture(async f => {
  f.db.exec("CREATE TRIGGER fail_preference BEFORE INSERT ON session_preferences BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => executeHubMemberCommand(f.store, 'sessionPreferenceSet', f.proof), /synthetic failure/);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.store.sessionPreferences(f.member.id).size, 0);
}));
