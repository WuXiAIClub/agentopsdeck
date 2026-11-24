import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from './connector-user-store.js';
import { isNodeId } from './node-identity.js';

test('Connector installation identity survives database reopen and rejects corrupt persisted identity', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-node-id-')), 'connector.sqlite');
  const a = new ConnectorUserStore(file), b = new ConnectorUserStore(':memory:');
  const identity = a.nodeId;
  assert.ok(isNodeId(identity));
  assert.notEqual(identity, b.nodeId);
  a.close(); b.close();
  const reopened = new ConnectorUserStore(file);
  assert.equal(reopened.nodeId, identity);
  reopened.close();
  const db = new DatabaseSync(file);
  db.exec("UPDATE connector_identity SET node_id = 'broken'");
  db.close();
  assert.throws(() => new ConnectorUserStore(file), /Invalid persisted/);
});
