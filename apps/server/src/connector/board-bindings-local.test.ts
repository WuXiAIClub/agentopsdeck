import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { createConnectorRuntime } from './runtime.js';
import { ConnectorBoardBindings } from './board-bindings.js';
import { loadWorkerBoardTools } from '../tools/workspace-board-worker.js';
import { createApplication } from '../application.js';
import { HubStore } from '../hub/hub-store.js';
import { encodeHubSessionId } from '../hub/session-id.js';

test('local board opt-in creates a separate capability only for combined Hub/Connector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-local-board-'));
  try {
    for (const role of ['all', 'connector']) for (const enabled of [false, true]) {
      const file = join(root, `${role}-${enabled}`);
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: role,
        AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
        AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_CONNECTOR_USERS_DATABASE_FILE: `${file}.sqlite`,
        AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`, AOD_QUEUE_FILE: `${file}.queue`,
        AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
        AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates`, AOD_BOARD_LOCAL_BINDING: String(enabled),
      });
      const runtime = createConnectorRuntime(config, () => false);
      const call = (token: string, path: string) => runtime.app.request('/api/connector/v1' + path, { headers: { authorization: `Bearer ${token}` } });
      try {
        for (const agent of ['codex', 'claude-code', 'ghcp']) {
          const path = `/sessions/${agent}%3A00000000-0000-4000-8000-000000000000/board-binding`;
          assert.equal((await call(runtime.localToken, path)).status, 403);
          assert.equal((await call(runtime.localMaintenanceToken, path)).status, 403);
          if (enabled && role === 'all') {
            assert.ok(runtime.localBoardBindingToken);
            assert.equal((await call(runtime.localBoardBindingToken, path)).status, 404);
            assert.equal((await call(runtime.localBoardBindingToken, '/agents')).status, 403);
            assert.equal((await call(runtime.localBoardBindingToken, '/sessions/directory')).status, 403);
          } else assert.equal(runtime.localBoardBindingToken, undefined);
        }
      } finally { await runtime.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('combined application uses dedicated local binding transport and retains grants across restart; disabling cleans managed tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-local-binding-app-'));
  const directory = join(root, 'private'), endpoint = 'http://127.0.0.1:8791/api/workspace-agent/v1/board';
  await mkdir(directory, { mode: 0o700 });
  const config = loadConfig({ HOME: join(root, 'home'), AOD_SERVER_ROLE: 'all',
    AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_ACCESS_KEY: 'synthetic-admin', AOD_HUB_VAULT_SECRET: 'synthetic-vault',
    AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
    AOD_PASSKEYS_FILE: join(root, 'passkeys'), AOD_AUTH_SESSIONS_FILE: join(root, 'auth'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens'),
    AOD_QUEUE_FILE: join(root, 'queue'), AOD_MIRROR_OUTBOX_FILE: join(root, 'mirror'),
    AOD_ARTIFACT_INDEX_FILE: join(root, 'artifacts'), AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'updates'),
    AOD_BOARD_LOCAL_BINDING: 'true', AOD_BOARD_AGENT_ENDPOINT: endpoint,
    AOD_CODEX_BOARD_TOOLS_DIR: directory,
    AOD_BOARD_BINDINGS_JSON: JSON.stringify([{ owner: 'local:boards', runtime: 'codex', endpoint }]),
  });
  let runtime: ReturnType<typeof createConnectorRuntime>;
  const factory: typeof createConnectorRuntime = (...args) => {
    runtime = createConnectorRuntime(...args);
    // Session discovery is synthetic; actual Hub, Connector, scopes, private
    // storage and shutdown/startup reconciliation are under test.
    runtime.codex.hasBoardTools = key => key === `codex:${sessionId}`;
    return runtime;
  };
  const sessionId = randomUUID(), id = randomUUID(), task = randomUUID();
  let application = createApplication(config, factory);
  const store = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
  const connection = config.hub.defaultConnectionId;
  store.pinConnectionNode(connection, 'default', store.connectionAuthority(connection, 'default')!, runtime!.connectorUsers.nodeId);
  store.boards.save('default', 'default', { title: 'Test', revision: 0, mutationId: randomUUID(), tasks: [{ id: task, title: 'Allowed', detail: '', status: 'todo' }] });
  const path = '/api/hub/v1/workspace/boards/default/bindings';
  const request = (method: string, suffix = '', body?: object) => application.app.request(path + suffix, {
    method, headers: { authorization: 'Bearer synthetic-admin' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await (await request('GET')).json()).enabled, true);
    const response = await request('POST', '', { requestId: id, sessionId: encodeHubSessionId(connection, `codex:${sessionId}`),
      grant: { taskIds: [task], fields: ['status'], expiresAt: Date.now() + 60_000 } });
    // GET reached the real binding handler (rather than ordinary-token 403).
    // This test's native worker is intentionally disabled, so PUT is uncertain.
    assert.equal(response.status, 202);
    assert.equal((await response.json()).binding.state, 'uncertain');
    const credential = store.boardBindings.credential('default', 'default', id)!;
    assert.ok(credential);
    const bindings = new ConnectorBoardBindings({ codex: directory }, config.boardBindingPolicies!, () => true);
    await bindings.install('local:boards', { id, runtime: 'codex', sessionId, credential });
    assert.ok(await loadWorkerBoardTools(directory, 'codex', sessionId, () => true));
    const firstToken = runtime!.localBoardBindingToken;
    await application.close(); application = createApplication(config, factory);
    assert.notEqual(runtime!.localBoardBindingToken, firstToken);
    assert.ok(await loadWorkerBoardTools(directory, 'codex', sessionId, () => true));
    await application.close();
    config.boardLocalBinding = false;
    application = createApplication(config, factory);
    // Shutdown waits for startup reconciliation even with the capability off.
    await runtime!.app.request(`/api/connector/v1/sessions/codex%3A${sessionId}/board-binding`, { headers: { authorization: `Bearer ${runtime!.localToken}` } });
    await application.close();
    assert.equal(await loadWorkerBoardTools(directory, 'codex', sessionId, () => true), undefined);
  } finally { await application.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
