import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubSessionId } from './session-id.js';
import { executeHubMemberCommand } from './member-owner-domain.js';
import { hubGuidanceReplyExpectation, validHubGuidanceReply, validHubGuidanceResult,
  type HubGuidanceCommand } from './member-guidance-domain.js';
import type { GuidanceSubmission } from './session-guidance-store.js';

async function fixture(work: (f: ReturnType<typeof seed>) => void) {
  const store = new HubStore(':memory:', 'fixture');
  try { work(seed(store)); } finally { await store.close(); }
}
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db, user = store.createUser('Owner');
  store.upsertConnection({ id: 'environment', ownerUserId: user.id, kind: 'remote', label: 'Environment', connectorUrl: 'http://fixture.invalid' });
  store.pinConnectionNode('environment', user.id, store.connectionAuthority('environment', user.id)!, 'node_' + randomUUID());
  const nodeVersion = store.connectionAuthority('environment', user.id)!;
  const sessionId = encodeHubSessionId('environment', 'codex:' + randomUUID());
  const target = JSON.stringify([sessionId, store.getConnection('environment', user.id)!.nodeId, nodeVersion]);
  const key = store.identities.issueKey(user.id), token = store.identities.createSession(key.token)!;
  const request = new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + token } });
  const principal = store.identities.requestPrincipal(request, () => false)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope(principal)! };
  const base = { sessionId, nodeVersion }, requestId = randomUUID();
  const call = (command: HubGuidanceCommand) => executeHubMemberCommand(store, 'sessionGuidance', { ...proof, command });
  call({ ...base, action: 'save', revision: 0, text: 'Historical fixture', enabled: true });
  const prepare: HubGuidanceCommand = { ...base, action: 'prepare', requestId, revision: 1, input: 'Original input' };
  const receipt = call(prepare)!.receipt!;
  const write = (value: GuidanceSubmission) => db.prepare('UPDATE guidance_submissions SET payload=? WHERE owner=? AND request_id=?')
    .run(JSON.stringify(value), user.id, requestId);
  const snapshot = () => ['guidance_submissions', 'command_receipts', 'hub_execution_leases', 'hub_session_owners']
    .map(name => db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all());
  return { store, db, user, token, proof, call, base, requestId, target, receipt, write, prepare, snapshot };
}

for (const state of ['prepared', 'unknown', 'submitted', 'rejected'] as const) {
  test(`historical ${state} receipt crossing the five-minute sample stays readable without a new permit`, () => fixture(f => {
    const old = { ...f.receipt, state, expiresAt: f.receipt.createdAt! + 300_001,
      queueReceipt: state === 'submitted' ? 'original-queue-receipt' : null };
    f.write(old); const before = f.snapshot();
    const query: HubGuidanceCommand = { action: 'receipt', sessionId: f.base.sessionId, requestId: f.requestId };
    const observed = f.call(query);
    assert.equal(validHubGuidanceReply(hubGuidanceReplyExpectation(query), observed), true);
    assert.deepEqual(observed!.receipt, old);
    const repeated = f.call(f.prepare);
    assert.equal(validHubGuidanceReply(hubGuidanceReplyExpectation(f.prepare), repeated), true);
    assert.deepEqual(repeated!.receipt, old, 'prepare is original receipt recovery, not a renewed preview');
    const claim = f.call({ ...f.base, action: 'claim', requestId: f.requestId });
    if (state === 'prepared') assert.equal(claim!.status, 409);
    else { assert.equal(claim!.claimed, false); assert.equal(validHubGuidanceResult(claim), true); }
    assert.deepEqual(f.snapshot(), before, 'no new key, SQL effect, execution lease or dispatch permission');
    assert.equal(f.db.isTransaction, false);
  }));
}
test('historical UNKNOWN receipt reconciles only the exact original ACK even with old sampling drift', () => fixture(f => {
  const old = { ...f.receipt, state: 'unknown' as const, expiresAt: f.receipt.createdAt! + 300_001 };
  f.write(old); const before = f.snapshot();
  assert.equal(f.call({ ...f.base, action: 'reconcile', requestId: f.requestId,
    ack: { key: 'wrong-original-key', id: 'queue', state: 'accepted' } })!.status, 409);
  assert.deepEqual(f.snapshot(), before);
  const ack: HubGuidanceCommand = { ...f.base, action: 'reconcile', requestId: f.requestId,
    ack: { key: old.commandKey!, id: 'original-queue', state: 'accepted' } };
  const settled = f.call(ack);
  assert.equal(validHubGuidanceReply(hubGuidanceReplyExpectation(ack), settled), true);
  assert.deepEqual(settled!.receipt, { ...old, state: 'submitted', queueReceipt: 'original-queue' });
}));
test('new claim ACK cannot authorize an over-budget or untimed preview', () => fixture(f => {
  const claimed = f.call({ ...f.base, action: 'claim', requestId: f.requestId })!;
  assert.equal(claimed.claimed, true); assert.equal(validHubGuidanceResult(claimed), true);
  assert.equal(validHubGuidanceResult({ ...claimed, receipt: { ...claimed.receipt!, expiresAt: f.receipt.createdAt! + 300_001 } }), false);
  const untimed = { ...claimed.receipt! }; delete untimed.commandKey; delete untimed.createdAt; delete untimed.expiresAt;
  assert.equal(validHubGuidanceResult({ ...claimed, receipt: untimed }), false);
}));
test('revoked authority cannot observe or reconcile a historical UNKNOWN receipt', () => fixture(f => {
  const old = { ...f.receipt, state: 'unknown' as const, expiresAt: f.receipt.createdAt! + 300_001 };
  f.write(old); f.store.identities.revokeSession(f.token); const before = f.snapshot();
  assert.equal(f.call({ action: 'receipt', sessionId: f.base.sessionId, requestId: f.requestId }), null);
  assert.equal(f.call({ ...f.base, action: 'reconcile', requestId: f.requestId,
    ack: { key: old.commandKey!, id: 'original-queue', state: 'accepted' } }), null);
  assert.deepEqual(f.snapshot(), before);
}));
test('real async owner recovers an old over-budget UNKNOWN receipt and keeps the exact ACK across same-data reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-guidance-legacy-budget-'));
  const file = join(root, 'hub.sqlite'), quiet = new PerformanceDiagnostics(() => {});
  let store: HubStore | undefined = new HubStore(file, 'fixture');
  let owner: AsyncHubMemberOwner | undefined;
  try {
    const f = seed(store), old = { ...f.receipt, state: 'unknown' as const, expiresAt: f.receipt.createdAt! + 300_001 };
    f.write(old); await store.close(); store = undefined;
    owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, quiet);
    const query: HubGuidanceCommand = { action: 'receipt', sessionId: f.base.sessionId, requestId: f.requestId };
    const observed = await owner.command('sessionGuidance', { ...f.proof, command: query });
    assert.equal(validHubGuidanceReply(hubGuidanceReplyExpectation(query), observed), true);
    assert.deepEqual(observed!.receipt, old);
    const claim = await owner.command('sessionGuidance', { ...f.proof, command: { ...f.base, action: 'claim', requestId: f.requestId } });
    assert.equal(claim!.claimed, false); assert.deepEqual(claim!.receipt, old);
    const ack: HubGuidanceCommand = { ...f.base, action: 'reconcile', requestId: f.requestId,
      ack: { key: old.commandKey!, id: 'original-queue', state: 'accepted' } };
    const settled = await owner.command('sessionGuidance', { ...f.proof, command: ack });
    assert.equal(validHubGuidanceReply(hubGuidanceReplyExpectation(ack), settled), true);
    assert.deepEqual(settled!.receipt, { ...old, state: 'submitted', queueReceipt: 'original-queue' });
    await owner.close(); owner = undefined;
    owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, quiet);
    const recovered = await owner.command('sessionGuidance', { ...f.proof, command: query });
    assert.deepEqual(recovered!.receipt, settled!.receipt);
    assert.deepEqual((await owner.command('sessionGuidance', { ...f.proof, command: ack }))!.receipt, settled!.receipt);
  } finally { await owner?.close(); await store?.close(); rmSync(root, { recursive: true, force: true }); }
});
