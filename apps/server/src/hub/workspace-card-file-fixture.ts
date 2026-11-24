import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER, CONNECTOR_PROTOCOL, workspaceFileCardResource } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorWorkspaceFiles } from '../connector/workspace-board-files.js';
import { registerConnectorWorkspaceFiles } from '../connector/workspace-board-files-http.js';
import { cardFileCodec, parseCardFile, serializeCardFile } from '../connector/workspace-file-card-format.js';
import { HubStore } from './hub-store.js';
import { HubFileCardService } from './workspace-card-file-service.js';
import { createConnectorClientResolver } from './connector-client.js';
import { registerHubCardFiles } from '../routes/hub-workspace-card-files.js';
import { encodeHubSessionId } from './session-id.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT, emptyNativeDrawio, WORKSPACE_FILE_CARD_KINDS, workspaceFileCardContent, type WorkspaceFileCard } from '@agentopsdeck/shared';
import { writeBoundNotebook } from '../routes/hub-native-file-write.js';
import { boundNotebookMove } from '../routes/hub-bound-notebook-move.js';
import { registerHubSessionNotebookRoutes } from '../routes/hub-session-notebooks.js';
import { notebookHash, type NotebookMove } from './notebook-operations.js';
import { FILE_BOARD_RUNTIMES, type FileBoardRuntime } from '../connector/workspace-board-file-policy.js';

export async function cardFileFixture(runtime: FileBoardRuntime = 'codex', declared: readonly FileBoardRuntime[] = [runtime], legacyNotebook = false) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-card-service-')), directory = join(root, 'files');
  await mkdir(directory, { mode: 0o700 });
  const db = new DatabaseSync(':memory:');
  let store = new HubStore(join(root, 'hub.sqlite'), 'synthetic-test-vault');
  // Simulate creation before archive synchronization existed, not a new grant.
  const originalClaim = store.cardFileProjection.claim.bind(store.cardFileProjection);
  if (legacyNotebook) store.cardFileProjection.claim = (owner, resource, id) => originalClaim(owner, resource, id, false);
  store.ensureLocalConnection({ id: 'local', label: 'Local', connectorUrl: 'local://aod-connector', environmentId: 'local', environmentLabel: 'Local', status: 'enabled' });
  const nodeId = `node_${randomUUID()}`;
  store.pinConnectionNode('local', 'default', store.connectionAuthority('local', 'default')!, nodeId);
  const tokens = new ConnectorTokenStore(join(root, 'tokens')), token = tokens.createTransient(['boards:files'], 'default');
  const sessionKey = `${runtime}:${randomUUID()}`, sessionId = encodeHubSessionId('local', sessionKey);
  const remote = new ConnectorWorkspaceFiles(db, directory, owner => owner === 'default', cardFileCodec());
  const app = new Hono();
  app.use('*', async (c, next) => { c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); c.header(NODE_ID_HEADER, nodeId); await next(); });
  const routes = registerConnectorWorkspaceFiles(app, { tokens, boards: remote, session: key => ({ exists: key === sessionKey, ready: true }),
    runtimes: owner => owner === 'default' ? declared : [] });
  await routes.ready;
  let writes = 0, installs = 0, streams = 0, snapshots = 0, loseWrite = false, failSnapshot = false;
  let archiveProtocol = true, beforeCapability: (() => Promise<void> | void) | undefined;
  let beforeWrite: (() => Promise<void>) | undefined;
  // Use the exact production resolver, including its private-path allowlist.
  const makeResolver = () => createConnectorClientResolver(store, { connectionId: 'local', token: token.token, dispatch: async request => {
    assert.ok(new URL(request.url).pathname.startsWith('/api/connector/v1/workspace/card-files'),
      'file changes must not invoke session, browser, terminal, search or media execution');
    if (request.url.endsWith('/snapshot')) snapshots++;
    const capability = request.method === 'GET' && new URL(request.url).pathname.endsWith('/workspace/card-files');
    if (capability) { const before = beforeCapability; beforeCapability = undefined; await before?.(); }
    if (failSnapshot && request.url.endsWith('/snapshot')) { failSnapshot = false; throw Error('snapshot unavailable'); }
    if (request.method === 'PUT') installs++;
    if (request.url.endsWith('/subscribe')) streams++;
    if (request.url.endsWith('/writes')) { writes++; const before = beforeWrite; beforeWrite = undefined; await before?.(); }
    const response = await app.fetch(request);
    if (capability && !archiveProtocol) {
      const body = await response.json() as Record<string, unknown>;
      delete body.notebookArchiveProtocol;
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    }
    if (loseWrite && request.url.endsWith('/writes')) { loseWrite = false; await response.body?.cancel(); throw Error('lost response'); }
    return response;
  } }, 'card-files');
  let resolve = makeResolver();
  const makeService = () => new HubFileCardService(store.cardFiles, (owner, id) => {
    assert.equal(owner, 'default'); assert.equal(id, sessionId);
    return { connectionId: 'local', sessionKey, authority: store.connectionAuthority('local', owner)!, client: resolve('local', false, owner), valid() {} };
  });
  let service = makeService(), owner = 'default';
  const hub = new Hono(); registerHubCardFiles(hub, { store, service, enabled: true, principal: () => ({ userId: owner, admin: false }) });
  return { get store() { return store; }, remote, service, hub, sessionId, writes: () => writes, installs: () => installs, streams: () => streams, snapshots: () => snapshots,
    loseWrite: () => { loseWrite = true; }, failSnapshot: () => { failSnapshot = true; }, other: () => { owner = 'other'; },
    beforeWrite: (action: () => Promise<void>) => { beforeWrite = action; },
    archiveProtocol: (supported: boolean) => { archiveProtocol = supported; },
    beforeCapability: (action: () => Promise<void> | void) => { beforeCapability = action; },
    restart: async () => { await service.close(); service = makeService(); service.start(); return service; },
    reopen: async () => {
      await service.close(); store.close();
      store = new HubStore(join(root, 'hub.sqlite'), 'synthetic-test-vault');
      resolve = makeResolver(); service = makeService(); service.start();
      return { hubStore: store, fileCards: service };
    },
    close: async () => { await service.close(); await routes.close(); store.close(); db.close(); await rm(root, { recursive: true, force: true }); } };
}
