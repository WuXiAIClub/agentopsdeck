import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { loadConfig } from '../config.js';
import { GatewayWsClient } from '../gateway/ws-client.js';
import { DeckStore } from '../projection/deck-store.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { registerConnectorRoutes } from './connector.js';
import { registerSessionRoutes } from './sessions.js';

for (const route of ['connector', 'codex', 'legacy'] as const) {
  for (const change of ['revoke', 'delete-unknown', 'delete-accepted', 'delete-rejected', 'abort', 'change-actor'] as const) {
    if (change === 'change-actor' && route !== 'legacy') continue;
    for (const phase of ['refresh', 'body'] as const) test(`${route} settings ${change} during ${phase} rechecks before local/native writes`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-settings-auth-'));
      const db = new ConnectorUserStore(':memory:');
      const store = new DeckStore({ eventLog: db.events, sessionTitlesFile: join(directory, 'titles.json'), sessionThinkingOverridesFile: join(directory, 'thinking.json') });
      const sessionKey = route === 'codex' ? 'codex:synthetic-settings' : 'agent:main:dashboard:synthetic-settings';
      store.upsertSession({ sessionKey, agentId: route === 'codex' ? 'codex' : 'main', title: 'Original', status: 'idle' });
      assert.ok(store.getSession(sessionKey));
      const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
      const credential = tokens.createTransient(['sessions:create']);
      const controller = new AbortController();
      let actor = 'synthetic-owner', effects = 0, changed = false;
      const mutate = () => {
        if (changed) return;
        changed = true;
        if (change === 'revoke') { credential.dispose(); actor = ''; }
        if (change === 'change-actor') actor = 'replacement-owner';
        if (change === 'abort') controller.abort();
        if (change.startsWith('delete-')) {
          const scope = JSON.stringify(['delete', JSON.stringify(['other-owner', sessionKey])]);
          db.commands.claim(scope, 'synthetic-delete', {});
          if (change !== 'delete-unknown') db.commands.settle(scope, 'synthetic-delete', {
            status: change === 'delete-accepted' ? 200 : 409, body: { ok: change === 'delete-accepted' },
          });
        }
      };
      const queue = new OpenClawTurnQueue({ store, turns: db.turns, executions: db.openClawExecutions,
        authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {},
        send: async () => assert.fail('settings must not dispatch turns'), mirror: async () => {} });
      const app = new Hono();
      const common = { store, gateway: { request: async () => assert.fail('settings must use the bound writer'),
        requestBound: async (_method: string, _params: unknown, _connection: unknown, authorize: () => void) => {
          authorize(); effects++; return { payload: { resolved: { model: 'gpt-5.6' } }, connectionId: 'synthetic' };
        } } as any,
        refreshSessions: async () => { if (phase === 'refresh') mutate(); }, refreshMessages: async () => {},
        normalizeError: (error: unknown) => String(error) };
      const connector = route !== 'legacy' ? registerConnectorRoutes(app, { ...common, tokens, connectorUsers: db, sessionSnapshotReady: () => true, historySnapshotReady: () => true,
        config: loadConfig({} as NodeJS.ProcessEnv), openclawQueue: queue, fallbackAgents: () => [], isAuthorizedRequest: () => true,
        codex: route === 'codex' ? { owns: () => true, updateSessionRuntime: (_key: string, _params: unknown, ack: (session: unknown) => void) => {
          effects++; const session = { ...store.getSession(sessionKey), model: 'gpt-5.5' }; ack(session); return session;
        } } as any : undefined }) : undefined;
      if (route === 'legacy') registerSessionRoutes(app, { ...common, commands: db.commands, deletionAdmission: key => db.canDeleteSession(key), settingsAdmission: key => db.canChangeSettings(key), queue,
        queueActor: () => actor || undefined, resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => {} });
      t.after(async () => { connector?.close(); await queue.close(); db.close(); credential.dispose(); await rm(directory, { recursive: true, force: true }); });
      const path = `${route === 'legacy' ? '/api' : '/api/connector/v1'}/sessions/${encodeURIComponent(sessionKey)}`;
      const headers = { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' };
      const response = await app.request(path, { method: 'PATCH', headers, signal: controller.signal,
        body: new ReadableStream({ pull(stream) {
          if (phase === 'body') mutate();
          stream.enqueue(new TextEncoder().encode(JSON.stringify({ model: 'gpt-5.5', thinking: 'high' }))); stream.close();
        } }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
      assert.equal(changed, true);
      assert.equal(response.status, change === 'delete-rejected' ? 200 : change === 'abort' ? 408 : change.startsWith('delete-') ? 409 : 403);
      assert.equal(effects, change === 'delete-rejected' ? 1 : 0);
      assert.equal(store.getSession(sessionKey)?.title, 'Original');
      assert.deepEqual(db.turns.list('openclaw'), []);
      assert.deepEqual(db.turns.list('codex'), []);
      if (change !== 'delete-rejected' && change !== 'abort') {
        const renamed = await app.request(path, { method: 'PATCH', headers, body: JSON.stringify({ title: 'Must not write' }) });
        // Changed actor is valid for a fresh request; only the stale request is forbidden.
        assert.equal(renamed.status, change === 'change-actor' ? 200 : response.status);
        assert.equal(store.getSession(sessionKey)?.title, change === 'change-actor' ? 'Must not write' : 'Original');
      }
    });
  }
}

for (const route of ['connector', 'legacy'] as const) for (const transport of ['local', 'http'] as const) {
  for (const scenario of ['revoke-connect', 'delete-connect', 'abort-connect', 'revoke-after-write'] as const) {
    if (transport === 'http' && scenario === 'abort-connect') continue;
    test(`${route}/${transport} settings ${scenario} at real Gateway handshake`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-settings-wire-'));
      const db = new ConnectorUserStore(':memory:');
      const store = new DeckStore({ eventLog: db.events, sessionTitlesFile: join(directory, 'titles.json'), sessionThinkingOverridesFile: join(directory, 'thinking.json') });
      const sessionKey = 'agent:main:dashboard:synthetic-settings-wire';
      store.upsertSession({ sessionKey, agentId: 'main', title: 'Original', status: 'idle' });
      const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
      const credential = tokens.createTransient(['sessions:create']);
      const controller = new AbortController(), writes: string[] = [];
      const native = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(native, 'listening');
      native.on('connection', socket => {
        socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
        socket.on('message', raw => {
          const request = JSON.parse(raw.toString());
          if (request.method !== 'connect') { writes.push(request.method); if (scenario === 'revoke-after-write') credential.dispose(); }
          socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { resolved: { model: 'synthetic-model' } } }));
        });
      });
      const gateway = new GatewayWsClient({ url: `ws://127.0.0.1:${(native.address() as { port: number }).port}`, ownerToken: undefined, password: undefined, onConnectionChange: id => {
        if (!id) return;
        if (scenario === 'revoke-connect') credential.dispose();
        if (scenario === 'abort-connect') controller.abort();
        if (scenario === 'delete-connect') db.commands.claim(JSON.stringify(['delete', JSON.stringify(['other-owner', sessionKey])]), 'delete', {});
      } });
      const queue = new OpenClawTurnQueue({ store, turns: db.turns, executions: db.openClawExecutions,
        authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {},
        send: async () => assert.fail('settings must not execute agents'), mirror: async () => {} });
      const app = new Hono(), common = { store, gateway, refreshSessions: async () => {}, refreshMessages: async () => {}, normalizeError: (error: unknown) => String(error) };
      const connector = route === 'connector' ? registerConnectorRoutes(app, { ...common, tokens, connectorUsers: db, sessionSnapshotReady: () => true, historySnapshotReady: () => true,
        config: loadConfig({} as NodeJS.ProcessEnv), openclawQueue: queue, fallbackAgents: () => [], isAuthorizedRequest: () => true }) : undefined;
      if (route === 'legacy') registerSessionRoutes(app, { ...common, commands: db.commands, deletionAdmission: key => db.canDeleteSession(key), settingsAdmission: key => db.canChangeSettings(key), queue,
        queueActor: request => tokens.authenticate(request)?.tokenId, resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => {} });
      const server = transport === 'http' ? serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 }) : undefined;
      t.after(async () => {
        if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        connector?.close(); await queue.close(); gateway.close(); await new Promise<void>(resolve => native.close(() => resolve()));
        db.close(); credential.dispose(); await rm(directory, { recursive: true, force: true });
      });
      if (server && !server.listening) await once(server, 'listening');
      const path = `${route === 'connector' ? '/api/connector/v1' : '/api'}/sessions/${encodeURIComponent(sessionKey)}`;
      const init = { method: 'PATCH', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
        signal: controller.signal, body: JSON.stringify({ model: 'synthetic-model', thinking: 'high' }) };
      const response = server ? await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, init) : await app.request(path, init);
      assert.equal(response.status, scenario === 'revoke-after-write' ? 200 : scenario === 'delete-connect' ? 409 : scenario === 'abort-connect' ? 408 : 403);
      await response.arrayBuffer();
      assert.deepEqual(writes, scenario === 'revoke-after-write' ? ['sessions.patch'] : []);
      assert.equal(gateway.status().pending, 0);
    });
  }
}
