import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput, hubMemberFailureSteps,
  HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { fingerprintRequest } from '../auth/security.js';

const quiet = new PerformanceDiagnostics(() => {});
const request = (cookie: string) => new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + cookie } });
async function fixture(work: (f: ReturnType<typeof seed>) => Promise<void>, configured = true) {
  const root = mkdtempSync(join(tmpdir(), 'hub-key-domain-r38-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'fixture-vault', [], configured ? 'fixture-config-admin' : undefined);
  try { await work(seed(store, join(root, 'hub.sqlite'), configured)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string, configured: boolean) {
  const admin = store.createUser('Existing admin'), member = store.createUser('Existing member');
  store.roles.setHubRole({ userId: 'default', admin: true }, admin.id, 'admin', 0);
  const key = store.identities.issueKey(admin.id), other = store.identities.issueKey(member.id);
  const cookie = store.identities.createSession(key.token)!, memberCookie = store.identities.createSession(other.token)!;
  const proof = { evidence: { sessionToken: cookie }, expectedScope: store.identities.recoveryScope({ userId: admin.id, admin: true }), userId: member.id };
  const worker = () => new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault',
    ...(configured ? { administratorKey: 'fixture-config-admin' } : {}) }, quiet);
  return { store, file, admin, member, key, other, cookie, memberCookie, proof, worker };
}

test('fixed key schema rejects serialized grants, forged audit actor and failure-stage collisions', () => {
  const proof = { evidence: {}, expectedScope: 'a'.repeat(64), userId: 'default' };
  assert.equal(validHubMemberInput('memberKeyIssue', { ...proof, authorized: true }), false);
  assert.equal(validHubMemberInput('memberKeyIssue', { ...proof, fingerprint: { actorUserId: 'default' } }), false);
  assert.equal(validHubMemberInput('memberKeyIssue', { ...proof, fingerprint: { ipHash: 'private-ip' } }), false);
  assert.equal(validHubMemberInput('memberKeyIssue', { ...proof, fingerprint: fingerprintRequest(request('fixture')) }), true);
  assert.equal(validHubMemberInput('memberKeyIssue', { ...proof, fingerprint: { ipHash: 'a'.repeat(64) } }), false);
  assert.equal(validHubMemberInput('memberKeyRevoke', { ...proof, keyId: 'bad-id' }), false);
  assert.equal(validHubMemberOutput('memberKeyIssue', { error: 'configuration_required', authorized: true }), false);
  assert.equal(validHubMemberOutput('memberKeysRead', { keys: [{ id: 'a', token: 'private' }] }), false);
  assert.equal(new Set(Object.values(hubMemberFailureSteps)).size, Object.keys(hubMemberFailureSteps).length);
  assert.equal(Object.values(hubMemberFailureSteps).some(step => step === 12 || step === 13), false);
});

test('only current persisted administrator credentials can manage member keys', () => fixture(async f => {
  const execute = (proof: typeof f.proof) => executeHubMemberCommand(f.store, 'memberKeysRead', proof);
  assert.ok(execute(f.proof));
  assert.equal(execute({ ...f.proof, expectedScope: '0'.repeat(64) }), null);
  assert.equal(execute({ ...f.proof, evidence: { sessionToken: f.memberCookie } }), null);
  assert.equal(executeHubMemberCommand(f.store, 'memberKeysRead', { ...f.proof,
    evidence: { accessKey: 'fixture-config-admin' } }), null, 'no legacy configured key fallback');
  assert.equal(executeHubMemberCommand(f.store, 'memberKeysRead', { ...f.proof,
    evidence: { accessKey: 'hub_key_' + 'z'.repeat(43), sessionToken: f.cookie } }), null);
  f.store.roles.setHubRole({ userId: 'default', admin: true }, f.admin.id, 'member', 1);
  assert.equal(execute(f.proof), null, 'old scope cannot retain administrator authority');
}));

test('real worker key issue/list/revoke retains original output, actor audit and old cookies', () => fixture(async f => {
  await f.store.close(); const owner = f.worker();
  try {
    const caller = await new AsyncHubMemberRequests(owner, quiet).begin(request(f.cookie));
    const fingerprint = fingerprintRequest(request(f.cookie));
    const issued = await caller.issue(f.member.id, fingerprint);
    assert.deepEqual(Object.keys(issued).sort(), ['id', 'token']);
    const keys = await caller.keys(f.member.id);
    assert.ok(keys.keys.some(k => k.id === issued.id));
    assert.deepEqual(await caller.revoke(f.member.id, issued.id, fingerprint), { ok: true });
    assert.deepEqual(await caller.revoke(f.member.id, issued.id), { ok: false });
    assert.ok(await owner.command('memberSnapshot', { sessionToken: f.cookie }));
    await owner.close();
    const reopened = new HubStore(f.file, 'fixture-vault');
    try {
      const audit = reopened.identities.audit.list().filter(r => r.keyId === issued.id);
      assert.equal(audit.length, 2);
      assert.ok(audit.every(r => r.actorUserId === f.admin.id && r.ipHash === fingerprint.ipHash
        && r.userAgentHash === fingerprint.userAgentHash));
      assert.ok(reopened.identities.requestPrincipal(request(f.cookie), () => false));
    } finally { await reopened.close(); }
  } finally { await owner.close(); }
}));

test('constructor configuration and predictable issue refusals retain 409/400 caller statuses', async () => {
  await fixture(async f => {
    await f.store.close(); const owner = f.worker();
    try {
      const caller = await new AsyncHubMemberRequests(owner, quiet).begin(request(f.cookie));
      await assert.rejects(caller.issue(f.member.id), (e: unknown) => e instanceof HubMemberRequestError && e.status === 409);
      assert.equal((await caller.keys(f.member.id)).keys.length, 1);
    } finally { await owner.close(); }
  }, false);
  await fixture(async f => {
    await f.store.close(); const owner = f.worker();
    try {
      const caller = await new AsyncHubMemberRequests(owner, quiet).begin(request(f.cookie));
      await assert.rejects(caller.issue('missing'), (e: unknown) => e instanceof HubMemberRequestError && e.status === 400);
      assert.equal((await caller.keys(f.member.id)).keys.length, 1);
    } finally { await owner.close(); }
  });
});

test('real audit trigger rolls back issue and revoke without invalidating old cookie or fencing healthy owner', () => fixture(async f => {
  await f.store.close();
  const db = new DatabaseSync(f.file);
  try { db.exec("CREATE TRIGGER fail_member_audit BEFORE INSERT ON hub_auth_audit WHEN json_extract(NEW.record,'$.event') IN ('member_key_issued','member_key_revoked') BEGIN SELECT RAISE(ABORT,'fixture-private-audit-fault'); END"); }
  finally { db.close(); }
  const owner = f.worker();
  try {
    await assert.rejects(owner.command('memberKeyIssue', f.proof), HubMemberOwnerUnavailable);
    await assert.rejects(owner.command('memberKeyRevoke', { ...f.proof, keyId: f.other.id }), HubMemberOwnerUnavailable);
    const keys = await owner.command('memberKeysRead', f.proof);
    assert.deepEqual(keys?.keys.map(k => k.id), [f.other.id]);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: f.memberCookie }));
    assert.ok(await owner.command('memberSnapshot', { sessionToken: f.cookie }));
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
}));

test('FIFO self-revocation commits once; final response and queued old credential commands are denied', () => fixture(async f => {
  await f.store.close(); const owner = f.worker();
  try {
    const caller = await new AsyncHubMemberRequests(owner, quiet).begin(request(f.cookie));
    await assert.rejects(caller.revoke(f.admin.id, f.key.id), (e: unknown) => e instanceof HubMemberRequestError && e.status === 401);
    const a = owner.command('memberKeyIssue', f.proof), b = owner.command('memberKeysRead', f.proof);
    assert.equal(await a, null); assert.equal(await b, null);
    assert.equal(await owner.command('memberSnapshot', { sessionToken: f.cookie }), null);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: f.memberCookie }));
    await owner.close();
    const reopened = new HubStore(f.file, 'fixture-vault');
    try {
      assert.equal(reopened.identities.keyIdentity(f.key.token), undefined);
      assert.equal(reopened.identities.audit.list().filter(r => r.event === 'member_key_revoked' && r.keyId === f.key.id).length, 1);
      assert.deepEqual(reopened.identities.listKeys(f.member.id).map(r => r.id), [f.other.id]);
    } finally { await reopened.close(); }
  } finally { await owner.close(); }
}));
