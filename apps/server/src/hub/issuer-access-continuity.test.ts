import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { parseBoardFile, serializeBoardFile } from '../connector/workspace-board-file-format.js';
import { parseCardFile, serializeCardFile } from '../connector/workspace-file-card-format.js';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { encodeHubSessionId } from './session-id.js';

test('stopped reviewed issuer repair retains creator/share dependencies, rejects old proofs and never restores leases', async () => {
  // Operator-only script deliberately stays outside the server's runtime graph.
  const helperCandidate = new URL('../../../../scripts/lib/issuer-access-continuity.mjs', import.meta.url);
  const helper = (existsSync(helperCandidate) ? helperCandidate : new URL('../../../../../scripts/lib/issuer-access-continuity.mjs', import.meta.url)).href;
  const { reviewIssuerAccess, continueIssuerAccess } = await import(helper);
  const directory = mkdtempSync(join(tmpdir(), 'issuer-continuity-'));
  const file = join(directory, 'hub.sqlite');
  let store: HubStore | undefined = new HubStore(file, 'fixture-only');
  let db: DatabaseSync | undefined;
  try {
    store.upsertConnection({ id: 'local', kind: 'local', label: 'Fixture', connectorUrl: 'http://connector.example.invalid' });
    const nodeId = 'node_72af7309-b7b3-4f16-88e8-d712fb871719';
    store.pinConnectionNode('local', 'default', store.connectionAuthority('local')!, nodeId);
    store.executionIssuers.installConfiguration('default', 'local', 'fixture-old-token',
      store.executionIssuers.configurationTarget('default', 'local')!, 'fixture-old-issuer', true);
    const alice = store.createUser('Creator'), bob = store.createUser('Observer');
    const target = (userId: string) => ({ ownerUserId: 'default', connectionId: 'local', userId });
    for (const [user, role] of [[alice, 'developer'], [bob, 'observer']] as const) {
      store.roles.save(LEGACY_HUB_PRINCIPAL, target(user.id), {
        ...store.roles.snapshot(LEGACY_HUB_PRINCIPAL, target(user.id)), role,
        nodeVersion: store.connectionAuthority('local')!, migrateLegacy: true,
        environments: { codex: role, openclaw: 'observer' },
      });
    }
    const originalVersion = store.connectionAuthority('local')!;
    const creation = store.grants.authorize(target(alice.id), 'sessions:create', { runtime: 'codex' })!;
    assert.ok(creation);
    const resource = { runtime: 'codex' as const, sessionKey: 'codex:fixture-session' };
    store.grants.acceptCreatedSession(creation, resource.sessionKey, 'fixture-scope', 'fixture-key', () => {});
    const creator = store.grants.authorize(target(alice.id), 'sessions:share', resource)!;
    assert.ok(creator); store.grants.shareSession(creator, bob.id, 'observer');
    const oldRead = store.grants.authorize(target(bob.id), 'messages:read', resource)!;
    const oldSend = store.grants.authorize(target(alice.id), 'messages:send', resource)!;
    assert.ok(oldRead); assert.ok(oldSend);
    const lease = store.executionLeases.reserve(oldSend, nodeId, 'fixture-old-issuer', ['messages:send']);
    const ownerSessionId = encodeHubSessionId('local', resource.sessionKey);
    const boardBindingId = randomUUID();
    const cardResourceId = workspaceFileCardResource('notebook', 'hub:default');
    const cardBindingId = randomUUID();
    assert.ok(store.boardFiles.prepare({ bindingId: boardBindingId, userId: 'default', resourceId: 'default',
      sessionId: ownerSessionId, connectionId: 'local', authority: originalVersion }, 0));
    assert.ok(store.boardFiles.activate('default', boardBindingId));
    assert.ok(store.cardFiles.prepare({ bindingId: cardBindingId, userId: 'default', resourceId: cardResourceId,
      sessionId: ownerSessionId, connectionId: 'local', authority: originalVersion },
      store.cardFileProjection.get('default', cardResourceId)!.revision));
    assert.ok(store.cardFiles.activate('default', cardBindingId));
    await store.close(); store = undefined;
    db = new DatabaseSync(file);
    const review = reviewIssuerAccess(db, { ownerId: 'default', connectionId: 'local', fromVersion: originalVersion,
      memberIds: [alice.id, bob.id] });
    db.close(); db = undefined;
    store = new HubStore(file, 'fixture-only');
    assert.equal(store.executionIssuers.disable('default', 'local'), true);
    store.executionIssuers.installConfiguration('default', 'local', 'fixture-fresh-token',
      store.executionIssuers.configurationTarget('default', 'local')!, 'fixture-fresh-issuer', true);
    assert.equal(store.grants.authorize(target(alice.id), 'messages:send', resource), undefined);
    const boardSnap = parseBoardFile(Buffer.from(serializeBoardFile({ title: 'Synced', tasks: [] })))!;
    assert.equal(store.boardFiles.apply('default', boardBindingId, { state: 'ready', value: boardSnap }), 'updated');
    await store.close(); store = undefined;
    db = new DatabaseSync(file);
    const leasesBefore = db.prepare('SELECT * FROM hub_execution_leases').all();
    const receipt = continueIssuerAccess(db, review, { stopped: true, expectedDigest: review.sha256,
      toVersion: originalVersion + 2, issuerId: 'fixture-fresh-issuer' });
    assert.equal(receipt.creatorOwnerships, 1); assert.equal(receipt.dependencies, 2);
    assert.equal(receipt.boardFileBindings, 1); assert.equal(receipt.cardFileBindings, 1);
    assert.deepEqual(db.prepare('SELECT * FROM hub_execution_leases').all(), leasesBefore);
    db.close(); db = undefined;
    store = new HubStore(file, 'fixture-only');
    assert.equal(store.grants.revalidate(oldRead), false);
    assert.equal(store.grants.revalidate(oldSend), false);
    assert.equal(store.grants.revalidate(creation), false);
    assert.equal(store.executionLeases.get(lease.id)?.state, 'revoking');
    const boardSnap2 = parseBoardFile(Buffer.from(serializeBoardFile({ title: 'Synced 2', tasks: [] })))!;
    assert.equal(store.boardFiles.apply('default', boardBindingId, { state: 'ready', value: boardSnap2 }), 'updated');
    const cardSnap = parseCardFile(Buffer.from(serializeCardFile({ kind: 'notebook', content: { title: 'Note', text: 'Updated', archive: '' } })))!;
    assert.equal(store.cardFiles.apply('default', cardBindingId, { state: 'ready', value: cardSnap }), 'updated');
    const freshCreator = store.grants.authorize(target(alice.id), 'sessions:share', resource)!;
    assert.ok(freshCreator); assert.equal(store.grants.ownedSession(freshCreator), true);
    assert.ok(store.grants.authorize(target(alice.id), 'messages:send', resource));
    assert.ok(store.grants.authorize(target(bob.id), 'messages:read', resource));
    assert.equal(store.grants.authorize(target(bob.id), 'messages:send', resource), undefined);
    assert.equal(store.grants.authorize(target(bob.id), 'sessions:create', { runtime: 'codex' }), undefined);
    const freshCreation = store.grants.authorize(target(alice.id), 'sessions:create', { runtime: 'codex' })!;
    assert.ok(freshCreation);
    assert.equal(store.grants.revoke(target(alice.id), freshCreation.grantId, freshCreation.version), true);
    assert.equal(store.grants.authorize(target(alice.id), 'messages:send', resource), undefined);
    assert.equal(store.grants.authorize(target(bob.id), 'messages:read', resource), undefined);
  } finally {
    db?.close(); await store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});
