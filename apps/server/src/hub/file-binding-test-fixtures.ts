import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { publicFileBoardBinding } from './workspace-board-files.js';
export function seedFileBindings(store: HubStore, userId = 'default') {
  const connectionId = randomUUID();
  store.upsertConnection({ id: connectionId, ownerUserId: userId, kind: 'remote', label: 'Isolated metadata',
    connectorUrl: 'http://fixture.invalid', environmentId: connectionId, environmentLabel: 'Fixture', status: 'enabled', capabilities: [] });
  assert.ok(store.pinConnectionNode(connectionId, userId, store.connectionAuthority(connectionId, userId)!, 'node_' + randomUUID()));
  const base = { userId, connectionId, authority: store.connectionAuthority(connectionId, userId)!, sessionId: encodeHubSessionId(connectionId, 'codex:' + randomUUID()) };
  const board = store.boardFiles.prepare({ ...base, bindingId: randomUUID(), resourceId: 'default' }, 0)!; assert.ok(board);
  const resourceId = workspaceFileCardResource('notebook', 'hub:default');
  const card = store.cardFiles.prepare({ ...base, bindingId: randomUUID(), resourceId }, store.cardFileProjection.get(userId, resourceId)!.revision)!; assert.ok(card);
  return { board: publicFileBoardBinding(board), card: publicFileBoardBinding(card) };
}
