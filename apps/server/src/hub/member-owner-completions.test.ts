import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput } from './member-owner-domain.js';
import type { HubCompletionProof, HubCompletionResult } from './member-completion-domain.js';
import { connectionCompletionTarget } from './completion-unread-store.js';
import { encodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
async function fixture(work: (f: ReturnType<typeof seed>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-completions-r49-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'completion-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const member = store.createUser('Original member');
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  store.upsertConnection({ id: 'member-node', label: 'Original node', connectorUrl: 'http://node',
    capabilities: ['events'], credentialToken: 'synthetic', ownerUserId: member.id });
  store.pinConnectionNode('member-node', member.id, store.connectionAuthority('member-node', member.id)!, 'node_00000000-0000-4000-8000-000000000001');
  const sessionKey = encodeHubSessionId('member-node', 'codex:old-session');
  const target = connectionCompletionTarget(store.getConnection('member-node', member.id)!.nodeId!, 'member-node',
    store.connectionAuthority('member-node', member.id)!, 'codex:old-session');
  store.completions.baseline(member.id, target, 'original-epoch', 10);
  store.completions.record({ owner: member.id, target, epoch: 'original-epoch', turnId: 'original-turn',
    sourceCursor: 11, provenance: 'live-successful-message' });
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }) };
  const db = (store as unknown as { db: DatabaseSync }).db;
  const kind = (p: HubCompletionProof) => p.command.action === 'summary' ? 'completionSummary' : p.command.action === 'observe' ? 'completionObserve' : 'completionRead';
  const command = (p: HubCompletionProof): HubCompletionResult => executeHubMemberCommand(store, kind(p), p);
  return { store, file, member, key, token, sessionKey, target, proof, db, command, kind };
}
test('completion owner admits only evidence/scope/session keys, never caller owner/target/authority', () => fixture(async f => {
  const input = { ...f.proof, command: { action: 'summary', sessions: [f.sessionKey] } };
  assert.equal(validHubMemberInput('completionSummary', input), true);
  for (const extra of [{ userId: f.member.id }, { target: f.target }, { authorized: true }]) {
    assert.equal(validHubMemberInput('completionSummary', { ...input, ...extra }), false);
  }
  assert.equal(validHubMemberInput('completionSummary', { ...input, command: { action: 'summary', sessions: Array(257).fill(f.sessionKey) } }), false);
}));
test('completion original transaction preserves unread, token ceilings and exact request receipt across worker reopen', () => fixture(async f => {
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'completion-fixture' }, quiet);
  try {
    await owner.open();
    const command = (input: HubCompletionProof): Promise<HubCompletionResult> => owner.command(f.kind(input), input);
    const summary = await command({ ...f.proof, command: { action: 'summary', sessions: [f.sessionKey, f.sessionKey] } });
    assert.ok(summary && 'items' in summary); assert.equal(summary.items.length, 1);
    assert.equal(summary.items[0]!.unread, true); assert.equal(summary.items[0]!.coverage, 'gap');
    assert.equal('target' in summary.items[0]!, false);
    const observed = await command({ ...f.proof, command: { action: 'observe', sessionKey: f.sessionKey } });
    assert.ok(observed && 'observation' in observed);
    const read = { ...f.proof, command: { action: 'read' as const, sessionKey: f.sessionKey, requestId: 'original-read',
      token: observed.observation.token, throughSequence: observed.observation.throughSequence } };
    assert.deepEqual(await command(read), { throughSequence: 1 });
    assert.deepEqual(await command(read), { throughSequence: 1 }, 'lost reply retry uses original durable receipt');
    assert.deepEqual(await command({ ...read, command: { ...read.command, throughSequence: 0 } }), { conflict: 'request-reused' });
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
  const original = new HubStore(f.file, 'completion-fixture');
  try {
    assert.equal(original.completions.summary(f.member.id, [f.target])[0]!.unread, false);
    assert.equal(original.completions.summary(f.member.id, [f.target])[0]!.readThrough, 1);
  } finally { await original.close(); }
}));
test('completion scope/revocation/connection authority denial has no ACK effect', () => fixture(async f => {
  const observe = { ...f.proof, command: { action: 'observe' as const, sessionKey: f.sessionKey } };
  assert.equal(f.command({ ...observe, expectedScope: '0'.repeat(64) }), null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM completion_observations').get()!.n, 0);
  assert.deepEqual(f.command({ ...observe, command: { action: 'observe', sessionKey: 'missing:YQ' } }), { error: 'missing' });
  assert.deepEqual(f.command({ ...observe, command: { action: 'summary', sessions: ['missing:YQ'] } }), { items: [] });
  assert.deepEqual(f.command({ ...observe, command: { action: 'observe', sessionKey: 'invalid' } }), { error: 'invalid' });
  f.store.identities.revokeKey(f.member.id, f.key.id);
  assert.equal(f.command(observe), null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM completion_observations').get()!.n, 0);
  assert.equal(f.db.isTransaction, false);
}));
test('completion storage failure rolls back ACK and remains an original storage error, not a replayable conflict', () => fixture(async f => {
  const observed = f.command({ ...f.proof, command: { action: 'observe', sessionKey: f.sessionKey } });
  assert.ok(observed && 'observation' in observed);
  f.db.exec("CREATE TRIGGER fail_read BEFORE UPDATE ON completion_targets BEGIN SELECT RAISE(ABORT,'private failure'); END");
  const read = { ...f.proof, command: { action: 'read' as const, sessionKey: f.sessionKey, requestId: 'read', token: observed.observation.token, throughSequence: 1 } };
  assert.throws(() => f.command(read), /private failure/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM completion_acks').get()!.n, 0);
  assert.equal(f.store.completions.summary(f.member.id, [f.target])[0]!.readThrough, 0);
  assert.equal(f.db.isTransaction, false);
}));
test('completion original methods and member commands keep rejecting caller-owned outer transactions', () => fixture(async f => {
  const observed = f.command({ ...f.proof, command: { action: 'observe', sessionKey: f.sessionKey } });
  assert.ok(observed && 'observation' in observed);
  f.db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => f.store.completions.observe(f.member.id, f.target), /outer-transaction/);
    assert.throws(() => f.store.completions.markRead(f.member.id, f.target, 'read', observed.observation.token, 1), /outer-transaction/);
    assert.throws(() => f.command({ ...f.proof, command: { action: 'read', sessionKey: f.sessionKey,
      requestId: 'read', token: observed.observation.token, throughSequence: 1 } }), /outer-transaction/);
    assert.equal(f.db.isTransaction, true, 'original caller transaction must not be adopted or committed');
    assert.equal(f.db.prepare('SELECT count(*) n FROM completion_acks').get()!.n, 0);
  } finally { f.db.exec('ROLLBACK'); }
}));
