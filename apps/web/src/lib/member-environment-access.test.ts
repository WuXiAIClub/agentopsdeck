import assert from 'node:assert/strict';
import test from 'node:test';
import type { HubNodeGrant, HubNodeGrantPage } from '../api.js';
import { environmentRoles, loadEnvironmentAccess, memberAccess, roleForGrant, saveEnvironmentRole } from './member-environment-access.js';

function grant(role: keyof typeof environmentRoles = 'collaborator'): HubNodeGrant {
  return { id: 'existing', userId: 'member', version: 1, nodeVersion: 5, revoked: false,
    policy: { runtime: 'codex', actions: [...environmentRoles[role].actions] } };
}
function fixture(grants: HubNodeGrant[] = [grant()]) {
  const page: HubNodeGrantPage = { nodeVersion: 5, verified: true, executionConfigured: true, creationConfigured: true, nextCursor: null, grants };
  const calls: string[] = [];
  const api = {
    hubNodeGrants: async (_connectionId: string, _after?: string): Promise<HubNodeGrantPage> => { calls.push('read'); return structuredClone(page); },
    hubUpdateNodeGrant: async (_connectionId: string, previous: HubNodeGrant, version: number, policy: HubNodeGrant['policy']) => {
      calls.push('replace'); assert.equal(version, page.nodeVersion);
      const existing = page.grants.find(item => item.id === previous.id)!;
      assert.equal(existing.version, previous.version);
      existing.version++; existing.nodeVersion = version; existing.policy = policy;
      return { grant: structuredClone(existing) };
    },
    hubCreateNodeGrant: async (_connectionId: string, body: { userId: string; nodeVersion: number; policy: HubNodeGrant['policy'] }) => {
      calls.push('create'); const created = { ...body, id: 'new', version: 1, revoked: false };
      page.grants.push(created); return { grant: created };
    },
    hubRevokeNodeGrant: async (_connectionId: string, previous: HubNodeGrant) => {
      calls.push('revoke'); const existing = page.grants.find(item => item.id === previous.id)!;
      existing.revoked = true; existing.version++; return { grant: existing };
    },
  };
  return { api, page, calls };
}

test('broad legacy access is labelled collaborator, not developer; exact custom policies stay custom', () => {
  const { page } = fixture();
  assert.equal(memberAccess(page, 'member').label, 'Environment collaborator');
  assert.equal(memberAccess(page, 'member').broad, true);
  page.grants[0]!.policy.actions.push('queue:manage');
  assert.equal(memberAccess(page, 'member').label, 'Custom access');
  assert.equal(roleForGrant({ ...grant('developer'), derived: true }), undefined);
});

test('revoked, stale, scoped and other-user grants do not produce a misleading active developer role', () => {
  const { page } = fixture([{ ...grant(), revoked: true }, { ...grant('developer'), userId: 'other' }]);
  assert.equal(memberAccess(page, 'member').label, 'No environment role');
  page.grants.push({ ...grant('developer'), id: 'stale', nodeVersion: 4 });
  assert.equal(memberAccess(page, 'member').label, 'Access needs review');
  page.grants[2]!.nodeVersion = 5; page.grants[2]!.policy.sessionKey = 'codex:one';
  assert.equal(memberAccess(page, 'member').editable, false);
  page.verified = false;
  assert.equal(memberAccess(page, 'member').label, 'Environment unavailable');
});

test('broad-to-developer replaces the same authorization without appending a grant', async () => {
  const { api, page, calls } = fixture();
  await saveEnvironmentRole(api, 'env', 'member', structuredClone(page), 'developer', () => true);
  assert.deepEqual(calls, ['read', 'replace']);
  assert.equal(page.grants.length, 1); assert.equal(page.grants[0]!.id, 'existing');
  assert.deepEqual(page.grants[0]!.policy.actions, ['sessions:create']);
  assert.equal(page.grants[0]!.version, 2);
});

test('observer is read-only and does not require execution setup', async () => {
  const { api, page } = fixture(); page.executionConfigured = false; page.creationConfigured = false;
  await saveEnvironmentRole(api, 'env', 'member', structuredClone(page), 'observer', () => true);
  assert.deepEqual(page.grants[0]!.policy.actions, ['sessions:read', 'messages:read', 'events:read']);
});

test('new developer gets create-only and unrelated grants are not replaced', async () => {
  const { api, page, calls } = fixture([{ ...grant(), userId: 'other' }]);
  await saveEnvironmentRole(api, 'env', 'member', structuredClone(page), 'developer', () => true);
  assert.deepEqual(calls, ['read', 'create']); assert.equal(page.grants.length, 2);
  assert.equal(page.grants[0]!.userId, 'other'); assert.deepEqual(page.grants[1]!.policy.actions, ['sessions:create']);
});

test('same role does not invalidate derived access by needlessly replacing its parent', async () => {
  const { api, page, calls } = fixture([grant('developer'), { ...grant('observer'), id: 'child', derived: true }]);
  await saveEnvironmentRole(api, 'env', 'member', structuredClone(page), 'developer', () => true);
  assert.deepEqual(calls, ['read']); assert.equal(memberAccess(page, 'member').derived.length, 1);
});

test('multiple or scoped direct authorizations require explicit custom review, never additive role save', async () => {
  for (const grants of [[grant(), { ...grant('developer'), id: 'second' }], [{ ...grant(), policy: { ...grant().policy, sessionKey: 'codex:one' } }]]) {
    const { api, page, calls } = fixture(grants);
    await assert.rejects(saveEnvironmentRole(api, 'env', 'member', structuredClone(page), 'developer', () => true), /custom access review/);
    assert.deepEqual(calls, ['read']);
  }
});

test('removing a role revokes its versioned grant, not an independent session share', async () => {
  const { api, page, calls } = fixture([grant(), { ...grant('observer'), id: 'shared', derived: true }]);
  await saveEnvironmentRole(api, 'env', 'member', structuredClone(page), null, () => true);
  assert.deepEqual(calls, ['read', 'revoke']); assert.equal(page.grants[1]!.revoked, false);
});

test('stale page, changed grants and new concurrent grants fail before any write', async () => {
  for (const change of [(page: HubNodeGrantPage) => { page.nodeVersion++; }, (page: HubNodeGrantPage) => { page.grants[0]!.version++; },
    (page: HubNodeGrantPage) => { page.grants.push({ ...grant(), id: 'concurrent' }); }]) {
    const { api, page, calls } = fixture(), expected = structuredClone(page); change(page);
    await assert.rejects(saveEnvironmentRole(api, 'env', 'member', expected, 'developer', () => true), /Saved access changed/);
    assert.deepEqual(calls, ['read']);
  }
});

test('stale authorization can be explicitly reauthorized with the current environment version', async () => {
  const { api, page, calls } = fixture([{ ...grant('developer'), nodeVersion: 4 }]);
  await saveEnvironmentRole(api, 'env', 'member', structuredClone(page), 'developer', () => true);
  assert.deepEqual(calls, ['read', 'replace']); assert.equal(page.grants[0]!.nodeVersion, 5);
});

test('missing execution setup never silently rotates the environment from member management', async () => {
  const { api, page, calls } = fixture([]); page.creationConfigured = false;
  await assert.rejects(saveEnvironmentRole(api, 'env', 'member', page, 'developer', () => true), /Member execution/);
  assert.deepEqual(calls, ['read']);
});

test('unknown save ACK is never retried and next read finds the changed role', async () => {
  const { api, page, calls } = fixture(), replace = api.hubUpdateNodeGrant;
  api.hubUpdateNodeGrant = async (...args) => { await replace(...args); throw new Error('Lost ACK'); };
  await assert.rejects(saveEnvironmentRole(api, 'env', 'member', structuredClone(page), 'developer', () => true), /Lost ACK/);
  assert.equal(memberAccess(await loadEnvironmentAccess(api, 'env', () => true), 'member').role, 'developer');
  assert.deepEqual(calls, ['read', 'replace', 'read']);
});

test('login expiry during read prevents writes', async () => {
  const { api, page, calls } = fixture();
  await assert.rejects(saveEnvironmentRole(api, 'env', 'member', page, 'observer', () => calls.length === 0), /Login changed/);
  assert.deepEqual(calls, ['read']);
});

test('all authorization pages are read, including another grant hidden beyond the first page', async () => {
  const { api, page } = fixture();
  api.hubNodeGrants = async (_connection, after) => ({ ...page, grants: after ? [{ ...grant('developer'), id: 'second' }] : page.grants, nextCursor: after ? null : 'next' });
  const loaded = await loadEnvironmentAccess(api, 'env', () => true);
  assert.equal(loaded.grants.length, 2); assert.equal(memberAccess(loaded, 'member').editable, false);
});

test('pagination loops and authority changes never produce a partial effective role', async () => {
  for (const changed of [false, true]) {
    const { api, page } = fixture();
    api.hubNodeGrants = async (_connection, after) => ({ ...page, nodeVersion: after && changed ? 6 : 5, nextCursor: 'repeat' });
    await assert.rejects(loadEnvironmentAccess(api, 'env', () => true), /incomplete|Environment changed/);
  }
});
