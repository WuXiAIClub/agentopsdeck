import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HubStore } from './hub-store.js';
import { executeHubConnectionChange, hubConnectionReplyExpectation, validHubConnectionChange, validHubConnectionReply } from './member-connection-change-domain.js';

test('connection creation refuses IDs that storage would rewrite before any effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aod-connection-id-'));
  const store = new HubStore(join(directory, 'hub.sqlite'), 'synthetic-vault');
  try {
    store.upsertConnection({ id: 'existing_node', label: 'Original', connectorUrl: 'https://original.example.invalid' });
    const original = store.getConnection('existing_node');
    const epoch = store.connectionAuthority('existing_node');
    for (const id of ['existing.node', ' existing_node ', 'a'.repeat(81), '中文', '']) {
      const change = { action: 'create' as const, configuration: { id, connectorUrl: 'https://replacement.example.invalid' } };
      assert.equal(validHubConnectionChange(change), false);
      assert.throws(() => executeHubConnectionChange(store, 'default', change));
      assert.deepEqual(store.getConnection('existing_node'), original);
      assert.equal(store.connectionAuthority('existing_node'), epoch);
      assert.equal(store.listConnections().length, 1);
    }
    for (const id of ['canonical-ID_1', 'a'.repeat(80)]) {
      const change = { action: 'create' as const, configuration: { id, connectorUrl: 'https://connector.example.invalid' } };
      assert.equal(validHubConnectionChange(change), true);
      const result = executeHubConnectionChange(store, 'default', change);
      assert.equal(validHubConnectionReply(hubConnectionReplyExpectation(change), result), true);
      assert.ok('connection' in result && result.connection.id === id);
    }
    const generated = { action: 'create' as const, configuration: { connectorUrl: 'https://connector.example.invalid' } };
    assert.equal(validHubConnectionReply(hubConnectionReplyExpectation(generated), executeHubConnectionChange(store, 'default', generated)), true);
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});
