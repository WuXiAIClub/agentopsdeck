import test from 'node:test';
import assert from 'node:assert/strict';
import type { HubNodeGrant, HubNodeGrantPage } from '../api.js';
import { grantMemberCreation } from './member-creation-access.js';

function fixture(configured = false) {
  const page: HubNodeGrantPage = { nodeVersion: 4, verified: true, executionConfigured: configured,
    creationConfigured: configured, grants: [], nextCursor: null };
  const calls: string[] = [];
  const api = {
    hubNodeGrants: async (_connectionId: string, _after?: string) => { calls.push('read'); return structuredClone(page); },
    hubExecutionIssuer: async () => ({ hubId: 'hub', localSetupAllowed: true, issuer: null }),
    hubSetupLocalExecution: async (_connectionId: string, version: number, creation?: boolean) => {
      calls.push('setup'); assert.equal(version, 4); assert.equal(creation, true);
      page.nodeVersion = 5; page.executionConfigured = true; page.creationConfigured = true;
      return { issuer: { issuerId: 'issuer', nodeId: 'node', version: 1, creationAllowed: true } };
    },
    hubCreateNodeGrant: async (_connectionId: string, body: { userId: string; nodeVersion: number; policy: HubNodeGrant['policy'] }) => {
      calls.push('grant'); assert.equal(body.nodeVersion, page.nodeVersion);
      const grant: HubNodeGrant = { id: 'new', version: 1, revoked: false, ...body };
      page.grants.push(grant); return { grant };
    },
  };
  return { page, calls, api };
}

test('one confirmed operation enables creation then saves the new member at the new authority', async () => {
  const { api, calls } = fixture();
  const grant = await grantMemberCreation(api, 'env', 'new-member', 4, () => true);
  assert.deepEqual(calls, ['read', 'setup', 'read', 'grant']);
  assert.equal(grant.userId, 'new-member'); assert.equal(grant.nodeVersion, 5);
  assert.deepEqual(grant.policy, { runtime: 'codex', actions: ['sessions:create'] });
});

test('existing infrastructure is not rotated and an already saved full grant is reused', async () => {
  const { api, calls } = fixture(true);
  const grant = await grantMemberCreation(api, 'env', 'member', 4, () => true);
  assert.deepEqual(await grantMemberCreation(api, 'env', 'member', 4, () => true), grant);
  assert.deepEqual(calls, ['read', 'grant', 'read']);
});

test('stale authority rejects before setup or grant', async () => {
  const { api, calls } = fixture();
  await assert.rejects(grantMemberCreation(api, 'env', 'member', 3, () => true), /Environment changed/);
  assert.deepEqual(calls, ['read']);
});

test('unknown setup result never continues or retries the grant', async () => {
  const { api, calls } = fixture();
  api.hubSetupLocalExecution = async () => { calls.push('setup'); throw new Error('Lost setup ACK'); };
  await assert.rejects(grantMemberCreation(api, 'env', 'member', 4, () => true), /Lost setup ACK/);
  assert.deepEqual(calls, ['read', 'setup']);
});

test('identity change after setup prevents member authorization', async () => {
  const { api, calls } = fixture();
  await assert.rejects(grantMemberCreation(api, 'env', 'member', 4, () => !calls.includes('setup')), /Login changed/);
  assert.deepEqual(calls, ['read', 'setup']);
});

test('unknown grant result is not resent; refresh finds the persisted grant', async () => {
  const { api, calls } = fixture(true), save = api.hubCreateNodeGrant;
  api.hubCreateNodeGrant = async (...args) => { await save(...args); throw new Error('Lost grant ACK'); };
  await assert.rejects(grantMemberCreation(api, 'env', 'member', 4, () => true), /Lost grant ACK/);
  assert.equal((await grantMemberCreation(api, 'env', 'member', 4, () => true)).id, 'new');
  assert.deepEqual(calls, ['read', 'grant', 'read']);
});

test('remote environment without operator setup fails closed', async () => {
  const { api, calls } = fixture();
  api.hubExecutionIssuer = async () => ({ hubId: 'hub', localSetupAllowed: false, issuer: null });
  await assert.rejects(grantMemberCreation(api, 'env', 'member', 4, () => true), /Connector operator/);
  assert.deepEqual(calls, ['read']);
});
