import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { parseBoardFile, serializeBoardFile } from '../connector/workspace-board-file-format.js';
import { parseCardFile, serializeCardFile } from '../connector/workspace-file-card-format.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';

function createStrandedFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'stranded-bindings-'));
  const file = join(directory, 'hub.sqlite');
  const store = new HubStore(file, 'fixture-only');
  store.upsertConnection({ id: 'local', kind: 'local', label: 'Local', connectorUrl: 'http://127.0.0.1:8791' });
  const nodeId = 'node_72af7309-b7b3-4f16-88e8-d712fb871719';
  store.pinConnectionNode('local', 'default', store.connectionAuthority('local')!, nodeId);
  // Advance to v5 with an active issuer, simulating production v5 baseline.
  while (store.connectionAuthority('local')! < 4) {
    const cur = store.connectionAuthority('local')!;
    store.executionIssuers.installConfiguration(
      'default', 'local', `tok-${cur + 1}`, store.executionIssuers.configurationTarget('default', 'local')!, `iss-${cur + 1}`, true,
    );
  }
  store.executionIssuers.installConfiguration(
    'default', 'local', 'tok-5', store.executionIssuers.configurationTarget('default', 'local')!, 'iss-5', true,
  );
  assert.equal(store.connectionAuthority('local'), 5);

  const sessionId = encodeHubSessionId('local', 'codex:owner-session');
  const boardBindingId = randomUUID();
  const revokedBoardBindingId = randomUUID();
  const revokedBoardResourceId = randomUUID();
  const cardResourceId = workspaceFileCardResource('notebook', 'hub:default');
  const cardBindingId = randomUUID();

  assert.ok(store.boardFiles.prepare({
    bindingId: boardBindingId, userId: 'default', resourceId: 'default',
    sessionId, connectionId: 'local', authority: 5,
  }, 0));
  assert.ok(store.boardFiles.activate('default', boardBindingId));

  assert.ok(store.boardFiles.prepare({
    bindingId: revokedBoardBindingId, userId: 'default', resourceId: revokedBoardResourceId,
    sessionId, connectionId: 'local', authority: 5,
  }, 0));
  assert.ok(store.boardFiles.revoke('default', revokedBoardBindingId));

  assert.ok(store.cardFiles.prepare({
    bindingId: cardBindingId, userId: 'default', resourceId: cardResourceId,
    sessionId, connectionId: 'local', authority: 5,
  }, store.cardFileProjection.get('default', cardResourceId)!.revision));
  assert.ok(store.cardFiles.activate('default', cardBindingId));

  return { directory, file, store, nodeId, boardBindingId, revokedBoardBindingId, cardResourceId, cardBindingId };
}

test('reconcileStrandedOwnerFileBindings repairs unbroken same-node issuer chain (5 -> 8) without mutating in HubStore constructor', async () => {
  const { directory, file, store, boardBindingId, revokedBoardBindingId, cardResourceId, cardBindingId } = createStrandedFixture();
  try {
    // Simulate legacy issuer rotations (5 -> 6 install, 6 -> 7 disable, 7 -> 8 install) while stranding bindings at 5
    store.executionIssuers.installConfiguration(
      'default', 'local', 'tok-6', store.executionIssuers.configurationTarget('default', 'local')!, 'iss-6', true,
    );
    assert.equal(store.executionIssuers.disable('default', 'local'), true);
    store.executionIssuers.installConfiguration(
      'default', 'local', 'tok-8', store.executionIssuers.configurationTarget('default', 'local')!, 'iss-8', true,
    );
    assert.equal(store.connectionAuthority('local'), 8);
    await store.close();

    // Force stranded state at authority = 5 and problem = 'invalid' as in production before fix
    const db = new DatabaseSync(file);
    db.prepare(`UPDATE hub_workspace_board_file_bindings SET authority = 5, problem = 'invalid' WHERE binding_id = ?`).run(boardBindingId);
    db.prepare(`UPDATE hub_workspace_card_file_bindings SET authority = 5, problem = 'invalid' WHERE binding_id = ?`).run(cardBindingId);
    // Clear any connection.created audit emitted after binding creation? Binding was created after connection.created, verify audit_logs doesn't block normal sequence
    db.close();

    // Constructor open must NOT mutate stranded bindings
    const reopened = new HubStore(file, 'fixture-only');
    assert.equal(reopened.boardFiles.get('default', boardBindingId)?.authority, 5);
    assert.equal(reopened.boardFiles.get('default', boardBindingId)?.problem, 'invalid');
    assert.equal(reopened.cardFiles.get('default', cardBindingId)?.authority, 5);

    const repaired = reopened.reconcileStrandedOwnerFileBindings();
    assert.equal(repaired, 2);
    assert.equal(reopened.boardFiles.get('default', boardBindingId)?.authority, 8);
    assert.equal(reopened.cardFiles.get('default', cardBindingId)?.authority, 8);

    // Revoked binding must stay untouched at authority 5
    await reopened.close();
    const checkDb = new DatabaseSync(file);
    const revokedRow = checkDb.prepare('SELECT authority, state FROM hub_workspace_board_file_bindings WHERE binding_id = ?').get(revokedBoardBindingId) as { authority: number; state: string };
    assert.equal(revokedRow.authority, 5);
    assert.equal(revokedRow.state, 'revoked');
    checkDb.close();

    // Applying ready snapshots now succeeds and clears problem -> null; second reconcile is a no-op
    const finalStore = new HubStore(file, 'fixture-only');
    assert.equal(finalStore.reconcileStrandedOwnerFileBindings(), 0);
    const boardSnap = parseBoardFile(Buffer.from(serializeBoardFile({ title: 'Recovered', tasks: [] })))!;
    assert.equal(finalStore.boardFiles.apply('default', boardBindingId, { state: 'ready', value: boardSnap }), 'updated');
    assert.equal(finalStore.boardFiles.get('default', boardBindingId)?.problem ?? null, null);

    const cardSnap = parseCardFile(Buffer.from(serializeCardFile({ kind: 'notebook', content: { title: 'Note', text: 'Synced', archive: '' } })))!;
    assert.equal(finalStore.cardFiles.apply('default', cardBindingId, { state: 'ready', value: cardSnap }), 'updated');
    assert.equal(finalStore.cardFiles.get('default', cardBindingId)?.problem ?? null, null);
    await finalStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reconcileStrandedOwnerFileBindings fails closed on node mismatch, connector_url change, version gap > 2, or mutating audit log', async () => {
  for (const scenario of ['node_mismatch', 'url_mismatch', 'version_gap', 'audit_mutation'] as const) {
    const { directory, file, store, boardBindingId, cardBindingId } = createStrandedFixture();
    try {
      store.executionIssuers.installConfiguration(
        'default', 'local', 'tok-6', store.executionIssuers.configurationTarget('default', 'local')!, 'iss-6', true,
      );
      await store.close();

      const db = new DatabaseSync(file);
      db.prepare('UPDATE hub_workspace_board_file_bindings SET authority = 5 WHERE binding_id = ?').run(boardBindingId);
      db.prepare('UPDATE hub_workspace_card_file_bindings SET authority = 5 WHERE binding_id = ?').run(cardBindingId);

      if (scenario === 'node_mismatch') {
        db.prepare('UPDATE hub_execution_issuers SET node_id = ? WHERE authority_version = 5').run('node_other');
      } else if (scenario === 'url_mismatch') {
        db.prepare('UPDATE hub_execution_issuers SET connector_url = ? WHERE authority_version = 5').run('http://10.0.0.9:8791');
      } else if (scenario === 'version_gap') {
        db.prepare('UPDATE env_connections SET authority_version = 9 WHERE id = ?').run('local');
        db.prepare('UPDATE hub_execution_issuers SET authority_version = 9 WHERE authority_version = 6').run();
      } else if (scenario === 'audit_mutation') {
        db.prepare(`INSERT INTO audit_logs (id, owner_user_id, action, connection_id, detail_json, created_at)
          VALUES (?, 'default', 'credential.updated', 'local', '{}', ?)`).run(randomUUID(), Date.now() + 1000);
      }
      db.close();

      const checkStore = new HubStore(file, 'fixture-only');
      assert.equal(checkStore.reconcileStrandedOwnerFileBindings(), 0, `expected fail-closed for ${scenario}`);
      assert.equal(checkStore.boardFiles.get('default', boardBindingId)?.authority, 5);
      await checkStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
