import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { executeHubMemberCommand } from './member-owner-domain.js';
import type { ConnectorRole, EnvironmentAccess } from './role-access.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'role-model-')), file = join(directory, 'hub.sqlite');
  const store = new HubStore(file, 'synthetic');
  const owner = store.createUser('Owner'), alice = store.createUser('Alice'), bob = store.createUser('Bob'), admin = store.createUser('Connector admin');
  for (const ownerUserId of ['default', owner.id]) {
    store.upsertConnection({ id: 'same-alias', ownerUserId, label: 'Test', kind: 'remote', connectorUrl: 'http://unused.invalid', credentialToken: 'synthetic' });
    store.pinConnectionNode('same-alias', ownerUserId, store.connectionAuthority('same-alias', ownerUserId)!, `node_${randomUUID()}`);
  }
  const target = (userId: string, ownerUserId = owner.id) => ({ userId, ownerUserId, connectionId: 'same-alias' });
  const save = (userId: string, role: ConnectorRole, environments?: EnvironmentAccess) => {
    const scope = target(userId), previous = store.roles.snapshot(LEGACY_HUB_PRINCIPAL, scope);
    return store.roles.save(LEGACY_HUB_PRINCIPAL, scope, { ...previous, role,
      nodeVersion: store.connectionAuthority(scope.connectionId, scope.ownerUserId)!, migrateLegacy: true,
      environments: environments ?? { codex: role === 'observer' ? 'observer' : role === 'none' ? 'disabled' : 'developer', openclaw: role === 'admin' ? 'observer' : 'disabled' } });
  };
  const create = (userId: string, key = `codex:${randomUUID()}`) => {
    const proof = store.grants.authorize(target(userId), 'sessions:create', { runtime: 'codex' })!;
    assert.ok(proof); store.grants.acceptCreatedSession(proof, key, randomUUID(), randomUUID(), () => {});
    const resource = { runtime: 'codex' as const, sessionKey: key };
    return { resource, proof: store.grants.authorize(target(userId), 'sessions:share', resource)! };
  };
  return { store, file, owner, alice, bob, admin, target, save, create, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const role of ['observer', 'developer'] as const) test(`sharing candidates follow ${role} account lifecycle without restoring old grants`, () => {
  const f = fixture();
  try {
    f.save(f.alice.id, 'developer'); f.save(f.bob.id, role);
    const first = f.create(f.alice.id);
    const candidates = () => f.store.roles.sessionCandidates(f.target(f.alice.id), first.resource);
    const expected = { ...f.bob, canChat: role === 'developer' };
    assert.ok(candidates().some(user => user.id === f.bob.id));
    const shared = f.store.grants.shareSession(first.proof, f.bob.id, role === 'developer' ? 'collaborator' : 'observer');
    f.store.roles.setHubRole(LEGACY_HUB_PRINCIPAL, f.admin.id, 'admin', 0);
    const key = f.store.identities.issueKey(f.admin.id);
    const evidence = { accessKey: key.token };
    const expectedScope = f.store.identities.recoveryScope({ userId: f.admin.id, admin: true });
    const change = (status: 'disabled' | 'enabled', expectedVersion: number) => executeHubMemberCommand(f.store, 'userChange', {
      evidence, expectedScope, change: { action: 'accessChange', userId: f.bob.id, status, expectedVersion },
    });
    assert.deepEqual(change('disabled', 0), { access: { userId: f.bob.id, status: 'disabled', version: 1 } });
    assert.equal(candidates().some(user => user.id === f.bob.id), false);
    assert.throws(() => f.store.grants.shareSession(first.proof, f.bob.id, 'observer'));
    assert.deepEqual(change('enabled', 1), { access: { userId: f.bob.id, status: 'enabled', version: 2 } });
    assert.deepEqual(candidates().find(user => user.id === f.bob.id), { id: expected.id, label: expected.label, canChat: expected.canChat });
    assert.equal(f.store.grants.get(f.target(f.bob.id), shared.id)?.revoked, true);
    assert.equal(f.store.grants.authorize(f.target(f.bob.id), 'messages:read', first.resource), undefined);
    assert.ok(f.store.grants.shareSession(first.proof, f.bob.id, 'observer'));
  } finally { f.close(); }
});

test('disabled accounts cannot consume the sharing candidate limit and hide an enabled recipient', () => {
  const f = fixture();
  try {
    f.save(f.alice.id, 'developer');
    const first = f.create(f.alice.id);
    f.store.roles.setHubRole(LEGACY_HUB_PRINCIPAL, f.admin.id, 'admin', 0);
    const evidence = { accessKey: f.store.identities.issueKey(f.admin.id).token };
    const expectedScope = f.store.identities.recoveryScope({ userId: f.admin.id, admin: true });
    for (let index = 0; index < 500; index++) {
      const user = f.store.createUser(`A disabled ${String(index).padStart(3, '0')}`);
      f.save(user.id, 'observer');
      assert.deepEqual(executeHubMemberCommand(f.store, 'userChange', {
        evidence, expectedScope, change: { action: 'accessChange', userId: user.id, status: 'disabled', expectedVersion: 0 },
      }), { access: { userId: user.id, status: 'disabled', version: 1 } });
    }
    const enabled = f.store.createUser('Z enabled recipient');
    f.save(enabled.id, 'observer');
    assert.deepEqual(f.store.roles.sessionCandidates(f.target(f.alice.id), first.resource),
      [{ id: enabled.id, label: enabled.label, canChat: false }]);
  } finally { f.close(); }
});

for (const runtime of ['hermes', 'claude-code', 'ghcp'] as const) test(`${runtime} remains owner-only across legacy wildcard, managed roles and inherited admin access`, () => {
  const f = fixture();
  try {
    const actions = ['messages:read', 'messages:send', 'sessions:create', 'queue:manage'] as const;
    f.store.grants.create(f.target(f.alice.id), { actions: [...actions] });
    for (const role of [undefined, 'observer', 'developer', 'admin'] as const) {
      if (role) f.save(f.alice.id, role);
      for (const resource of [{ runtime }, { runtime, sessionKey: `${runtime}:owned` },
        { runtime: 'openclaw' as const, sessionKey: `${runtime}:owned` },
        { runtime: 'codex' as const, sessionKey: `${runtime}:owned` }]) {
        for (const action of actions) {
          assert.equal(f.store.roles.permits(f.target(f.alice.id), action, resource), false);
          assert.equal(f.store.grants.authorize(f.target(f.alice.id), action, resource), undefined);
        }
        assert.equal(f.store.roles.permitsDirectGrant(f.target(f.alice.id), { ...resource, actions: ['messages:read'] }), false);
        assert.throws(() => f.store.grants.create(f.target(f.alice.id), { ...resource, actions: ['messages:read'] }));
      }
    }
    f.store.roles.setHubRole(LEGACY_HUB_PRINCIPAL, f.admin.id, 'admin', 0);
    f.store.roles.syncAdministrator({ ...LEGACY_HUB_PRINCIPAL, userId: f.admin.id });
    for (const userId of [f.admin.id, 'default']) {
      const target = { ...f.target(userId), administrator: true };
      assert.equal(f.store.grants.authorize(target, 'messages:read', { runtime, sessionKey: `${runtime}:owned` }), undefined);
    }
  } finally { f.close(); }
});

test('developer owns only created sessions; observers require explicit sharing; hard environment ceilings', () => {
  const fixtureState = fixture(), { store, alice, bob, target, save, create } = fixtureState;
  try {
    save(alice.id, 'developer'); save(bob.id, 'observer');
    const first = create(alice.id);
    const outsider = store.createUser('No membership');
    assert.throws(() => store.grants.shareSession(first.proof, outsider.id, 'observer'));
    assert.equal(store.roles.permitsDirectGrant(target(alice.id), { runtime: 'codex', actions: ['messages:read'] }), false);
    assert.equal(store.roles.permitsDirectGrant(target(bob.id), { ...first.resource, actions: ['messages:send'] }), false);
    assert.equal(store.grants.authorize(target(bob.id), 'messages:read', first.resource), undefined);
    assert.equal(store.grants.authorize(target(bob.id), 'sessions:create', { runtime: 'codex' }), undefined);
    assert.equal(store.grants.authorize(target(alice.id), 'sessions:read', { runtime: 'codex' }), undefined);
    assert.equal(store.grants.authorize(target(alice.id, 'default'), 'messages:read', first.resource), undefined);
    assert.throws(() => store.grants.shareSession(first.proof, bob.id, 'collaborator'));
    const share = store.grants.shareSession(first.proof, bob.id, 'observer');
    const read = store.grants.authorize(target(bob.id), 'messages:read', first.resource)!;
    assert.ok(read); assert.equal(store.grants.authorize(target(bob.id), 'messages:send', first.resource), undefined);
    assert.throws(() => store.grants.updateCollaborator(first.proof, share.id, share.version, 'collaborator', {}));
    save(bob.id, 'observer', { codex: 'disabled', openclaw: 'observer' });
    assert.equal(store.grants.revalidate(read), false);
    assert.throws(() => store.grants.shareSession(first.proof, bob.id, 'observer'));
    save(bob.id, 'observer');
    assert.equal(store.grants.authorize(target(bob.id), 'messages:read', first.resource), undefined);
  } finally { fixtureState.close(); }
});

test('Connector admin inherits read but not send, queue, interrupt, node control or cross-Connector access', () => {
  const fixtureState = fixture(), { store, alice, admin, target, save, create } = fixtureState;
  try {
    save(alice.id, 'developer'); save(admin.id, 'admin');
    const first = create(alice.id);
    const read = store.grants.authorize(target(admin.id), 'messages:read', first.resource)!;
    assert.ok(read);
    for (const action of ['messages:send', 'queue:manage', 'runs:interrupt', 'runs:compact', 'node:manage', 'sessions:share'] as const) assert.equal(store.grants.authorize(target(admin.id), action, first.resource), undefined);
    assert.equal(store.grants.authorize(target(admin.id, 'default'), 'messages:read', first.resource), undefined);
    const own = create(admin.id);
    assert.ok(store.grants.authorize(target(admin.id), 'messages:send', own.resource));
    const actor = { userId: admin.id, admin: false };
    assert.equal(store.roles.canManage(actor, target(alice.id)), true);
    assert.equal(store.roles.canManage(actor, target(alice.id, 'default')), false);
    const version = store.roles.membership(target(alice.id));
    assert.throws(() => store.roles.save(actor, target(alice.id), { ...version, role: 'admin', environments: { codex: 'developer', openclaw: 'observer' }, migrateLegacy: true }));
    assert.throws(() => store.roles.setHubRole(actor, alice.id, 'admin', 0));
    save(admin.id, 'developer');
    assert.equal(store.grants.revalidate(read), false);
    assert.equal(store.roles.canManage(actor, target(alice.id)), false);
    assert.ok(store.grants.authorize(target(admin.id), 'messages:send', own.resource));
  } finally { fixtureState.close(); }
});

test('explicit Hub role works for key and cookie, global read is not global execution; default member key stays unprivileged', () => {
  const fixtureState = fixture(), { store, alice, target } = fixtureState;
  try {
    const key = store.identities.issueKey(alice.id), fallback = store.identities.issueKey('default');
    const cookie = store.identities.createSession(key.token)!;
    assert.equal(store.identities.keyPrincipal(key.token)?.admin, false);
    store.roles.setHubRole(LEGACY_HUB_PRINCIPAL, alice.id, 'admin', 0);
    const actor = store.identities.keyPrincipal(key.token)!;
    assert.equal(actor.admin, true);
    assert.equal(store.identities.requestPrincipal(new Request('http://localhost', { headers: { cookie: `agentopsdeck_session=${cookie}` } }), () => false)?.admin, true);
    store.roles.syncAdministrator(actor);
    const resource = { runtime: 'codex' as const, sessionKey: 'codex:someone-else' };
    const proof = store.grants.authorize(target(alice.id), 'messages:read', resource)!;
    assert.ok(proof);
    assert.equal(store.grants.authorize(target(alice.id), 'messages:send', resource), undefined);
    store.roles.setHubRole(LEGACY_HUB_PRINCIPAL, alice.id, 'member', 1);
    assert.equal(store.grants.revalidate(proof), false);
    assert.equal(store.identities.keyPrincipal(key.token)?.admin, false);
    store.roles.syncAdministrator(LEGACY_HUB_PRINCIPAL);
    assert.ok(store.grants.authorize({ ...target('default'), administrator: true }, 'messages:read', resource));
    assert.equal(store.identities.keyPrincipal(fallback.token)?.admin, false);
    assert.equal(store.grants.authorize(target('default'), 'messages:read', resource), undefined);
  } finally { fixtureState.close(); }
});

test('legacy migration is explicit and atomic; identical creation grants preserve ownership, stale saves fail', () => {
  const fixtureState = fixture(), { store, alice, bob, target, save, create } = fixtureState;
  try {
    store.grants.create(target(alice.id), { runtime: 'codex', actions: ['sessions:create'] });
    const own = create(alice.id);
    const previous = store.roles.snapshot(LEGACY_HUB_PRINCIPAL, target(alice.id));
    assert.equal(previous.legacyCount, 1);
    assert.throws(() => store.roles.save(LEGACY_HUB_PRINCIPAL, target(alice.id), { ...previous, role: 'developer', nodeVersion: store.connectionAuthority('same-alias', target(alice.id).ownerUserId)!, environments: { codex: 'developer', openclaw: 'disabled' }, migrateLegacy: false }));
    assert.equal(store.roles.membership(target(alice.id)).version, 0);
    save(alice.id, 'developer');
    assert.ok(store.grants.revalidate(own.proof));
    assert.equal(store.roles.snapshot(LEGACY_HUB_PRINCIPAL, target(alice.id)).legacyCount, 0);
    store.grants.create(target(bob.id), { runtime: 'codex', actions: ['sessions:read', 'messages:read', 'messages:send'] });
    const broad = store.grants.authorize(target(bob.id), 'messages:read', own.resource)!;
    save(bob.id, 'observer');
    assert.equal(store.grants.revalidate(broad), false);
    assert.throws(() => store.roles.save(LEGACY_HUB_PRINCIPAL, target(alice.id), { ...previous, role: 'none', migrateLegacy: true }));
    assert.equal(store.roles.membership(target(alice.id)).role, 'developer');
  } finally { fixtureState.close(); }
});

test('session subpermissions CAS invalidates leases; environment disable survives restart without resurrecting shares', () => {
  const fixtureState = fixture(), { store, file, alice, bob, target, save, create } = fixtureState;
  try {
    save(alice.id, 'developer'); save(bob.id, 'developer');
    const own = create(alice.id);
    const grant = store.grants.shareSession(own.proof, bob.id, 'collaborator', { live: false, queue: false, media: true });
    const send = store.grants.authorize(target(bob.id), 'messages:send', own.resource)!;
    assert.ok(send);
    assert.equal(store.grants.authorize(target(bob.id), 'queue:manage', own.resource), undefined);
    assert.equal(store.grants.authorize(target(bob.id), 'events:read', own.resource), undefined);
    assert.ok(store.grants.authorize(target(bob.id), 'media:read', own.resource));
    const lease = store.executionLeases.reserve(send, store.getConnection('same-alias', target(bob.id).ownerUserId)!.nodeId!, randomUUID(), ['messages:send']);
    store.grants.updateCollaborator(own.proof, grant.id, grant.version, 'observer', {});
    assert.equal(store.grants.revalidate(send), false);
    assert.equal(store.executionLeases.get(lease.id)?.state, 'revoking');
    assert.throws(() => store.grants.updateCollaborator(own.proof, grant.id, grant.version, 'collaborator', {}));
    save(bob.id, 'none');
    const reopened = new HubStore(file, 'synthetic');
    try {
      assert.equal(reopened.roles.membership(target(bob.id)).role, 'none');
      assert.equal(reopened.grants.authorize(target(bob.id), 'messages:read', own.resource), undefined);
      assert.equal(reopened.executionLeases.get(lease.id)?.state, 'revoking');
    } finally { reopened.close(); }
  } finally { fixtureState.close(); }
});
