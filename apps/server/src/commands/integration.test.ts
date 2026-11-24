import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { loadConfig } from '../config.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { CodexAppServer } from '../codex/app-server.js';
import { HubStore } from '../hub/hub-store.js';
import { createConnectorClientResolver } from '../hub/connector-client.js';
import { DeckStore } from '../projection/deck-store.js';
import { registerConnectorRoutes } from '../routes/connector.js';
import { encodeHubSessionId, registerHubRoutes } from '../routes/hub.js';

for (const transport of ['local', 'http'] as const) {
  test(`${transport}: both receipt boundaries recover lost ACK across restart without running Codex twice`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-command-integration-'));
    const config = loadConfig({ HOME: dir, AOD_SERVER_ROLE: 'all',
      AOD_HUB_DATABASE_FILE: join(dir, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'test-vault',
      AOD_SESSION_TITLES_FILE: join(dir, 'titles.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(dir, 'connector.sqlite'),
      AOD_CONNECTOR_TOKENS_FILE: join(dir, 'tokens.json'),
    });
    let users = new ConnectorUserStore(config.connector.usersDatabaseFile);
    let tokens = new ConnectorTokenStore(config.connector.tokenFile);
    let token = tokens.createTransient(undefined, 'local:daily').token;
    let sends = 0, dropAck = true;
    let queuedId = '';
    let codexInstance: CodexAppServer;
    const sessionKey = 'codex:session/with unicode 空格';
    function connector() {
      const app = new Hono();
      const store = new DeckStore({ sessionTitlesFile: config.sessionTitlesFile });
      store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic receipt test', status: 'idle' });
      const codex = new CodexAppServer({ authorizeTurn: (actorId) => tokens.hasScope(actorId, 'messages:send'), enabled: true, command: 'must-not-launch', defaultCwd: dir,
        defaultModel: 'test', approvalPolicy: 'never', turnQueue: users.turns, executions: users.codexExecutions, store });
      codexInstance = codex;
      (codex as any).connectionId = "synthetic-connection";
      (codex as any).ensureStarted = async () => { assert.fail('admission must not launch Codex'); };
      const admit = codex.send.bind(codex);
      codex.send = async (...args) => {
        sends++;
        assert.equal(typeof args[3]?.accept, 'function', 'receipt transaction hook is not a queuedId/runtime bypass');
        assert.equal(args[3]?.actorId, 'local:daily');
        const result = await admit(...args); queuedId = result.idempotencyKey; return result;
      };
      app.use('*', async (c, next) => {
        await next();
        if (dropAck && c.req.method === 'POST' && c.req.path.endsWith('/messages')) {
          dropAck = false;
          c.res = c.json({ error: 'simulated lost admission acknowledgement' }, 502);
        }
      });
      registerConnectorRoutes(app, { config, tokens, connectorUsers: users, sessionSnapshotReady: () => true, historySnapshotReady: () => true,
        store,
        gateway: { request: async () => { assert.fail('Codex send reached Gateway'); } } as any,
        codex,
        refreshSessions: async () => {}, refreshMessages: async () => {}, fallbackAgents: () => [],
        isAuthorizedRequest: () => false, normalizeError: () => 'test error',
      });
      return app;
    }
    let connectorApp = connector();
    const server = transport === 'http' ? serve({ fetch: (request) => connectorApp.fetch(request), hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server?.address();
    const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
    let hubStore = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
    function hub() {
      hubStore.upsertConnection({ id: 'node', kind: transport === 'local' ? 'local' : 'remote', label: 'node',
        status: 'enabled', capabilities: ['messages'], connectorUrl: origin, ...(transport === 'http' ? { credentialToken: token } : {}) });
      const app = new Hono();
      const routes = registerHubRoutes(app, { config, hubStore,
        connectorClient: createConnectorClientResolver(hubStore, { connectionId: 'node', token, dispatch: (request) => connectorApp.fetch(request) }),
        normalizeError: () => 'test error',
      });
      return { app, close: () => { routes?.close(); hubStore.close(); } };
    }
    let current = hub();
    const path = `/api/hub/v1/sessions/${encodeHubSessionId('node', sessionKey)}`;
    const post = (message = 'one task') => current.app.request(`${path}/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, idempotencyKey: 'stable' }) });
    try {
      const lost = await post();
      assert.equal(lost.status, 202);
      assert.equal((await lost.json() as any).command.state, 'outcome_unknown');
      assert.equal(sends, 1);
      assert.equal(users.turns.list('codex').length, 1);
      current.close(); await codexInstance!.close(); users.close();
      hubStore = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
      users = new ConnectorUserStore(config.connector.usersDatabaseFile);
      tokens = new ConnectorTokenStore(config.connector.tokenFile);
      const previousToken = token;
      token = tokens.createTransient(undefined, 'local:daily').token;
      assert.notEqual(previousToken, token, 'local secret rotates, durable actor identity does not');
      connectorApp = connector(); current = hub();
      const recovered = await (await current.app.request(`${path}/commands/stable`)).json() as any;
      assert.equal(recovered.command.state, 'accepted');
      assert.equal(recovered.command.result.body.idempotencyKey, queuedId);
      assert.equal(users.turns.head('codex', sessionKey)?.id, queuedId);
      const replay = await post(); assert.equal(replay.status, 200);
      const body = await replay.json() as any;
      assert.equal(body.idempotencyKey, queuedId); assert.equal(body.command.result, undefined, 'POST does not duplicate the response payload');
      assert.equal((await post('different task')).status, 409);
      assert.equal(sends, 1);
      const wrongActor = tokens.createTransient(['messages:read']);
      const denied = await connectorApp.request(`/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}/commands/stable`, { headers: { authorization: `Bearer ${wrongActor.token}` } });
      assert.equal(denied.status, 404);
    } finally {
      current.close(); await codexInstance!.close(); users.close();
      if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
  });
}
