import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessViewEpoch, copyCurrentAccessKey, ReviewedAccessFailure, revokeReviewedAccess, writeCurrentAccess, type AccessRevocationPort } from './reviewed-access.js';
import type { AccessConnection, ConnectorMembership } from '../api.js';

test('account mutation does not start from a stale view', async () => {
  let writes = 0;
  assert.equal(await writeCurrentAccess(() => false, async () => ++writes), null);
  assert.equal(writes, 0);
});
test('late account mutation ACK is discarded across A/B/A without replay', async () => {
  const epoch = new AccessViewEpoch(), view = epoch.enter('A'); let writes = 0;
  const result = await writeCurrentAccess(view.current, async () => {
    writes++; epoch.enter('B'); epoch.enter('A'); return { accepted: true };
  });
  assert.equal(result, null); assert.equal(writes, 1);
});
test('unknown account mutation propagates once without retry', async () => {
  let writes = 0;
  await assert.rejects(writeCurrentAccess(() => true, async () => { writes++; throw new Error('unknown acknowledgement'); }), /unknown acknowledgement/);
  assert.equal(writes, 1);
});
test('current account mutation returns its acknowledged result', async () => {
  assert.deepEqual(await writeCurrentAccess(() => true, async () => ({ accepted: true })), { accepted: true });
});
test('key copy requires current scope and a clipboard acknowledgement', async () => {
  let copies = 0;
  const clipboard = { async writeText() { copies++; } };
  assert.equal(await copyCurrentAccessKey(() => false, 'test-only', clipboard), false);
  assert.equal(copies, 0);
  assert.equal(await copyCurrentAccessKey(() => true, 'test-only', clipboard), true);
  assert.equal(copies, 1);
  await assert.rejects(copyCurrentAccessKey(() => true, 'test-only', undefined), /Clipboard unavailable/);
  await assert.rejects(copyCurrentAccessKey(() => true, 'test-only', { async writeText() { throw new Error('denied'); } }), /denied/);
});
test('late clipboard completion does not publish success into a new account', async () => {
  let current = true;
  assert.equal(await copyCurrentAccessKey(() => current, 'test-only', { async writeText() { current = false; } }), false);
});

const connection: AccessConnection = { id: 'c', ownerUserId: 'owner', label: 'Local', nodeVersion: 7,
  verified: true, creationReady: true, appointAdministrators: true, owner: true };
const membership: ConnectorMembership = { role: 'developer', version: 3, nodeVersion: 7, editable: true,
  environments: { codex: 'developer', openclaw: 'disabled' }, legacyCount: 2, legacyBroad: 1,
  inherited: null, grantSetDigest: 'a'.repeat(64) };
function fixture() {
  const calls: string[] = [], payloads: unknown[] = [];
  let current = true, confirm = true, fail = '', role: 'admin' | 'member' = 'admin';
  let mem = { ...membership };
  const visit = (name: string) => { calls.push(name); if (fail === name) throw new Error('unknown delivery'); };
  const port: AccessRevocationPort = {
    async hubLoginKeys() { visit('keys-read'); return { keys: [{ id: 'key', createdAt: 1 }] }; },
    async hubRole() { visit('role-read'); return { role, version: 8 }; },
    async connectorMembership() { visit('membership-read'); return mem; },
    async hubRevokeLoginKey() { visit('key-write'); return { ok: true }; },
    async saveConnectorMembership(_, __, input) { payloads.push(input); visit('membership-write');
      return { ...mem, role: 'none', environments: input.environments }; },
    async saveHubRole(_, input) { payloads.push(input); visit('role-write'); return input; },
  };
  const run = () => revokeReviewedAccess(port, 'member', [connection], () => current,
    async summary => { calls.push('confirm'); assert.deepEqual(summary, { keys: 1, memberships: 1, legacy: mem.legacyCount, demote: role === 'admin' }); return confirm; });
  return { port, calls, payloads, run, fail: (name: string) => { fail = name; },
    cancel: () => { confirm = false; }, change: () => { current = false; },
    member: () => { role = 'member'; }, membership: (value: ConnectorMembership) => { mem = value; } };
}

test('reviewed revocation reads before confirmation, binds exact snapshots and confirms each change without deleting users', async () => {
  const f = fixture(); assert.deepEqual(await f.run(), { confirmed: 3, total: 3 });
  assert.deepEqual(f.calls, ['keys-read', 'role-read', 'membership-read', 'confirm', 'key-write', 'membership-write', 'role-write']);
  assert.deepEqual(f.payloads, [{ role: 'none', environments: { codex: 'disabled', openclaw: 'disabled' },
    version: 3, nodeVersion: 7, migrateLegacy: true, grantSetDigest: 'a'.repeat(64) }, { role: 'member', version: 8 }]);
});
for (const failed of ['keys-read', 'role-read', 'membership-read']) test(`${failed} failure does not become an empty grant/key set or start writes`, async () => {
  const f = fixture(); f.fail(failed); await assert.rejects(f.run(), /unknown delivery/);
  assert.ok(f.calls.every(c => c.endsWith('-read'))); assert.deepEqual(f.payloads, []);
});
for (const [failed, confirmed] of [['key-write', 0], ['membership-write', 1], ['role-write', 2]] as const) {
  test(`${failed} unknown result stops remaining changes and reports partial progress without retry`, async () => {
    const f = fixture(); f.fail(failed);
    await assert.rejects(f.run(), e => e instanceof ReviewedAccessFailure && e.confirmed === confirmed && e.total === 3);
    assert.equal(f.calls.at(-1), failed); assert.equal(f.calls.filter(c => c === failed).length, 1);
    assert.equal(f.calls.filter(c => c === 'membership-read').length, 1, 'no refreshing and replaying a rejected/unknown save');
  });
}
test('cancel and a changed account during confirmation produce no writes', async () => {
  const f = fixture(); f.cancel(); assert.equal(await f.run(), null); assert.deepEqual(f.payloads, []);
  const second = fixture();
  await assert.rejects(revokeReviewedAccess(second.port, 'member', [connection], () => !second.calls.includes('confirmed-switch'),
    async () => { second.calls.push('confirmed-switch'); return true; }), /account changed/);
  assert.ok(!second.calls.some(c => c.endsWith('-write')));
});
test('missing review digest or owner/non-editable snapshot fails before any write', async () => {
  const { grantSetDigest: _digest, ...withoutDigest } = membership;
  for (const value of [withoutDigest, { ...membership, editable: false }, { ...membership, inherited: 'owner' as const }]) {
    const f = fixture(); f.membership(value); await assert.rejects(f.run());
    assert.ok(!f.calls.includes('confirm')); assert.deepEqual(f.payloads, []);
  }
  const f = fixture(); await assert.rejects(revokeReviewedAccess(f.port, 'owner', [connection], () => true, async () => true), /Owner/);
  assert.deepEqual(f.calls, []);
});
test('none membership still clears reviewed exact-session grants and never assumes no access from the role name', async () => {
  const f = fixture(); f.member(); f.membership({ ...membership, role: 'none', legacyCount: 0 });
  assert.deepEqual(await f.run(), { confirmed: 2, total: 2 }); assert.ok(f.calls.includes('membership-write'));
});
test('switch during a write retains confirmed count and stops the next mutation', async () => {
  const f = fixture(), revoke = f.port.hubRevokeLoginKey;
  f.port.hubRevokeLoginKey = async (user, key) => { const result = await revoke(user, key); f.change(); return result; };
  await assert.rejects(f.run(), e => e instanceof ReviewedAccessFailure && e.confirmed === 1);
  assert.equal(f.calls.at(-1), 'key-write');
});
test('view epoch suppresses late save/read after user, refresh and account ABA', () => {
  const epoch = new AccessViewEpoch(), first = epoch.enter('scope:A:0');
  assert.equal(first.current(), true); epoch.enter('scope:B:0'); const second = epoch.enter('scope:A:0');
  assert.equal(first.current(), false); assert.equal(second.current(), true);
  epoch.enter('scope:A:1'); assert.equal(second.current(), false);
  const third = epoch.enter('scope:A:1'); epoch.enter('other:A:1'); epoch.enter('scope:A:1');
  assert.equal(third.current(), false);
});
