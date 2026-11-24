import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const NODE_ID_HEADER = 'x-agentopsdeck-node-id';
export const EXPECTED_NODE_HEADER = 'x-agentopsdeck-expected-node-id';
export const isNodeId = (value: unknown): value is string => typeof value === 'string'
  && /^node_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

// Installation identity, not a hostname, address, credential or hardware claim.
// Keep with the Connector database on moves/restart; cloned databases share it.
export function loadNodeIdentity(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS connector_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), node_id TEXT NOT NULL
  )`);
  db.prepare('INSERT OR IGNORE INTO connector_identity VALUES (1, ?)').run(`node_${randomUUID()}`);
  const row = db.prepare('SELECT node_id FROM connector_identity WHERE singleton = 1').get() as { node_id: string };
  if (!isNodeId(row.node_id)) throw new Error('Invalid persisted Connector identity');
  return row.node_id;
}
