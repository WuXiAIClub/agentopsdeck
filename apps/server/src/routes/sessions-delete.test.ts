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
import { CodexAppServer } from '../codex/app-server.js';
import { loadConfig } from '../config.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';
import { GatewayWsClient } from '../gateway/ws-client.js';
import { DeckStore } from '../projection/deck-store.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { registerConnectorRoutes } from './connector.js';
import { registerSessionRoutes } from './sessions.js';

for (const route of ['connector', 'legacy'] as const) for (const transport of ['local', 'http'] as const) {
  for (const outcome of ['accepted', 'already-absent', 'lost-ack', 'forbidden', 'unsupported', 'projection-failure', 'queued', 'busy-refresh',
    'alias', 'missing-target', 'invalid-target', 'busy-describe', 'negative-ack', 'foreign-ack', 'missing-ack', 'invalid-deleted'] as const) {
    test(`${route}/${transport} deletion: ${outcome} never tries another mutation method`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-delete-test-'));
      const db = new ConnectorUserStore(':memory:');
      const store = new DeckStore({ eventLog: db.events });
      const canonicalKey = 'agent:main:dashboard:synthetic-delete';
      const sessionKey = outcome === 'alias' ? ` ${canonicalKey} ` : canonicalKey;
      store.upsertSession({ sessionKey: canonicalKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
      store.addMessage({ id: 'preserved-reply', sessionKey: canonicalKey, role: 'assistant', text: 'Original reply', createdAt: 1 });
      const beforeMessages = store.getMessages(canonicalKey);
      assert.ok(store.getSession(canonicalKey));
      const queue = new OpenClawTurnQueue({ store, turns: db.turns, executions: db.openClawExecutions,
        authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {},
        send: async () => assert.fail('deletion cannot dispatch a turn'), mirror: async () => {} });
      queue.enqueue({ id: 'preserved', sessionKey: outcome === 'queued' ? sessionKey : 'unrelated-session', createdAt: 1,
        payload: { actorId: 'synthetic-owner', message: 'preserved', media: [], deliveryMode: 'web-only' } });
      if (outcome === 'alias') {
        queue.enqueue({ id: 'canonical-queued', sessionKey: canonicalKey, createdAt: 2,
          payload: { actorId: 'synthetic-owner', message: 'must not be deleted through an alias', media: [], deliveryMode: 'web-only' } });
        assert.equal(db.canDeleteSession(canonicalKey), false);
        assert.equal(db.canDeleteSession(sessionKey), true, 'raw alias must not bypass canonical lifecycle exclusion');
      }
      const beforeQueue = db.turns.list('openclaw');
      if (outcome === 'busy-refresh' || outcome === 'busy-describe') {
        db.openClawExecutions.begin(sessionKey, 'old-command');
        db.openClawExecutions.acknowledge(sessionKey, 'old-command', 'old-run');
        db.openClawExecutions.observe(sessionKey, { runId: 'old-run', phase: 'completed' });
        db.openClawExecutions.setHistorySync(sessionKey, db.openClawExecutions.get(sessionKey)!.historySync!.revision, 'current');
        assert.equal(db.canDeleteSession(sessionKey), true);
      }
      const tokens = new ConnectorTokenStore(join(directory, 'synthetic-tokens.json'));
      const credential = tokens.createTransient(['sessions:create']);
      const calls: string[] = [];
      const reads: string[] = [];
      const requests: Array<{ method: string; params: unknown; connection: unknown }> = [];
      let effects = 0;
      const gateway = { requestBound: async (method: string, _params: unknown, _connection: unknown, authorize: () => void) => {
        authorize();
        requests.push({ method, params: _params, connection: _connection });
        if (method === 'sessions.describe') {
          reads.push(method);
          if (outcome === 'busy-describe') db.openClawExecutions.unownedActivity(sessionKey);
          return { payload: outcome === 'invalid-target' ? {} : { session: outcome === 'missing-target' ? null
            : { key: canonicalKey } }, connectionId: 'synthetic-connection' };
        }
        calls.push(method);
        if (outcome === 'forbidden') throw new GatewayRpcError(method, 'INVALID_REQUEST', 'missing scope: operator.admin');
        if (outcome === 'unsupported') throw new GatewayRpcError(method, 'INVALID_REQUEST', 'unknown method');
        effects++;
        if (outcome === 'lost-ack') throw new Error('synthetic connection lost after mutation');
        return { payload: outcome === 'missing-ack' ? {} : {
          ok: outcome !== 'negative-ack', key: outcome === 'foreign-ack' ? 'agent:main:other' : sessionKey,
          deleted: outcome === 'invalid-deleted' ? 'yes' : outcome !== 'already-absent', archived: [] }, connectionId: 'synthetic-connection' };
      } };
      if (outcome === 'projection-failure') store.removeSession = () => { throw new Error('synthetic projection failure'); };
      const app = new Hono();
      const common = { store, gateway: gateway as any, refreshSessions: async () => {
        if (outcome === 'busy-refresh') db.openClawExecutions.unownedActivity(sessionKey);
      }, refreshMessages: async () => {},
        normalizeError: (error: unknown) => error instanceof Error ? error.message : String(error) };
      const connector = route === 'connector' ? registerConnectorRoutes(app, { ...common, tokens, connectorUsers: db, sessionSnapshotReady: () => true, historySnapshotReady: () => true,
        config: loadConfig({} as NodeJS.ProcessEnv), openclawQueue: queue, fallbackAgents: () => [], isAuthorizedRequest: () => true }) : undefined;
      if (route === 'legacy') registerSessionRoutes(app, { ...common, commands: db.commands, deletionAdmission: key => db.canDeleteSession(key), settingsAdmission: key => db.canChangeSettings(key), queue, queueActor: () => 'synthetic-owner',
        resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => {} });
      const server = transport === 'http' ? serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 }) : undefined;
      t.after(async () => {
        if (server) {
          if ('closeAllConnections' in server) server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
        connector?.close(); await queue.close(); db.close(); credential.dispose();
        await rm(directory, { recursive: true, force: true });
      });
      if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
      const path = `${route === 'connector' ? '/api/connector/v1' : '/api'}/sessions/${encodeURIComponent(sessionKey)}`;
      const init = { method: 'DELETE', headers: { authorization: `Bearer ${credential.token}`, 'idempotency-key': 'synthetic-delete' } };
      const response = server ? await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, init)
        : await app.request(path, init);
      const body = await response.json() as any;
      const acknowledged = outcome === 'accepted' || outcome === 'already-absent' || outcome === 'projection-failure';
      const conflict = outcome === 'queued' || outcome === 'busy-refresh' || outcome === 'busy-describe' || outcome === 'alias' || outcome === 'missing-target';
      assert.equal(response.status, acknowledged ? 200 : conflict ? 409 : 202);
      {
        assert.equal(body.command.state, acknowledged ? 'accepted' : conflict ? 'rejected' : 'outcome_unknown');
        const repeated = server ? await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, init)
          : await app.request(path, init);
        assert.deepEqual(await repeated.json(), body, 'same command must not replay deletion, including after projection failure');
        const readPath = `${path}/deletion-commands/synthetic-delete`;
        const read = server ? await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${readPath}`, { headers: init.headers })
          : await app.request(readPath, { headers: init.headers });
        assert.equal((await read.json() as any).command.state, body.command.state);
      }
      assert.deepEqual(reads, outcome === 'queued' || outcome === 'busy-refresh' ? [] : ['sessions.describe']);
      assert.deepEqual(calls, conflict || outcome === 'invalid-target' ? [] : ['sessions.delete']);
      assert.deepEqual(requests, [
        ...reads.map(method => ({ method, params: { key: sessionKey, includeDerivedTitles: false, includeLastMessage: false }, connection: undefined })),
        ...calls.map(method => ({ method, params: { key: sessionKey }, connection: 'synthetic-connection' })),
      ]);
      assert.equal(effects, outcome === 'forbidden' || outcome === 'unsupported' || conflict || outcome === 'invalid-target' ? 0 : 1);
      const removed = outcome === 'accepted' || outcome === 'already-absent';
      assert.equal(!!store.getSession(canonicalKey), !removed);
      assert.deepEqual(store.getMessages(canonicalKey), removed ? [] : beforeMessages);
      // Deleting one idle session never erases another session's admissions.
      assert.deepEqual(db.turns.list('openclaw'), beforeQueue);
    });
  }
}

for (const transport of ['local', 'http'] as const) {
  for (const scenario of ['accepted', 'revoke-startup', 'revoke-after-write', 'lost-ack', 'no-rollout', 'misleading-error', 'abort-startup', 'projection-failure', 'queued'] as const) {
    if (transport === 'http' && scenario === 'abort-startup') continue;
    test(`connector/${transport} Codex deletion binds current token authority: ${scenario}`, async t => {
      const controller = new AbortController();
      const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-codex-delete-auth-'));
      const db = new ConnectorUserStore(':memory:');
      const store = new DeckStore({ eventLog: db.events });
      const sessionKey = 'codex:synthetic-delete-auth';
      const tokens = new ConnectorTokenStore(join(directory, 'synthetic-tokens.json'));
      const credential = tokens.createTransient(['sessions:create']);
      const config = loadConfig({ HOME: directory });
      const codex = new CodexAppServer({ ...config.codex, store, turnQueue: db.turns, executions: db.codexExecutions,
        authorizeTurn: () => assert.fail('archive is not messages:send authority') });
      store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic', status: 'idle' });
      assert.ok(store.getSession(sessionKey));
      await db.turns.enqueueAsync('codex', { id: 'preserved', sessionKey: scenario === 'queued' ? sessionKey : 'unrelated-session', createdAt: 1,
        payload: { actorId: 'synthetic-owner', text: 'preserved', images: [] } });
      const beforeQueue = db.turns.list('codex');
      if (scenario === 'projection-failure') store.removeSession = () => { throw new Error('synthetic projection failure'); };
      const writes: string[] = [];
      (codex as any).ensureStarted = async () => {
        if (scenario === 'revoke-startup') credential.dispose();
        if (scenario === 'abort-startup') controller.abort();
      };
      (codex as any).request = async (method: string) => {
        writes.push(method);
        if (scenario === 'revoke-after-write') credential.dispose();
        if (scenario === 'lost-ack') throw new Error('synthetic connection lost after archive');
        if (scenario === 'no-rollout') throw new Error('no rollout found');
        if (scenario === 'misleading-error') throw new Error('permission denied while reading metadata: no rollout found');
        return {};
      };
      const app = new Hono();
      const connector = registerConnectorRoutes(app, { config, tokens, connectorUsers: db, store, codex, sessionSnapshotReady: () => true, historySnapshotReady: () => true,
        gateway: {} as any, refreshSessions: async () => assert.fail('Codex deletion cannot refresh OpenClaw'),
        refreshMessages: async () => {}, fallbackAgents: () => [], isAuthorizedRequest: () => true,
        normalizeError: () => 'synthetic failure' });
      const server = transport === 'http' ? serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 }) : undefined;
      t.after(async () => {
        if (server) {
          if ('closeAllConnections' in server) server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
        connector.close(); await codex.close(); db.close(); credential.dispose();
        await rm(directory, { recursive: true, force: true });
      });
      if (server && !server.listening) await once(server, 'listening');
      const path = `/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}`;
      const init = { method: 'DELETE', headers: { authorization: `Bearer ${credential.token}`, 'idempotency-key': 'synthetic-archive' }, signal: controller.signal };
      const response = server ? await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, init)
        : await app.request(path, init);
      const body = await response.json() as any;
      const removed = scenario === 'accepted' || scenario === 'revoke-after-write';
      const accepted = removed || scenario === 'projection-failure';
      assert.deepEqual(writes, scenario === 'revoke-startup' || scenario === 'abort-startup' || scenario === 'queued' ? [] : ['thread/archive']);
      assert.equal(response.status, accepted ? 200 : scenario === 'revoke-startup' ? 403 : scenario === 'queued' ? 409 : 202);
      assert.equal(!!store.getSession(sessionKey), !removed);
      if (!scenario.startsWith('revoke-') && !scenario.startsWith('abort-')) {
        const retried = server ? await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, init)
          : await app.request(path, init);
        assert.deepEqual(await retried.json(), body);
        assert.equal(writes.length, scenario === 'queued' ? 0 : 1);
      }
      assert.deepEqual(db.turns.list('codex'), beforeQueue);
    });
  }
}

for (const route of ['connector', 'legacy'] as const) for (const transport of ['local', 'http'] as const) {
  for (const scenario of ['accepted', 'revoke-refresh', 'revoke-connect', 'revoke-describe', 'revoke-after-write',
    'abort-refresh', 'abort-connect', 'abort-describe', 'abort-after-write', 'disconnect-describe'] as const) {
    if (transport === 'http' && scenario.startsWith('abort-')) continue;
    test(`${route}/${transport} deletion checks live authority: ${scenario}`, async t => {
      const controller = new AbortController();
      const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-delete-auth-'));
      const db = new ConnectorUserStore(':memory:');
      const store = new DeckStore({ eventLog: db.events });
      const sessionKey = 'agent:main:dashboard:synthetic-delete-auth';
      store.upsertSession({ sessionKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
      assert.ok(store.getSession(sessionKey));
      const tokens = new ConnectorTokenStore(join(directory, 'synthetic-tokens.json'));
      const credential = tokens.createTransient(['sessions:create'], 'synthetic-owner');
      const writes: string[] = [];
      const reads: unknown[] = [];
      const parameters: unknown[] = [];
      const native = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(native, 'listening');
      native.on('connection', socket => {
        socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
        socket.on('message', raw => {
          const request = JSON.parse(raw.toString());
          if (request.method === 'sessions.describe') {
            reads.push(request.params);
            if (scenario === 'revoke-describe') credential.dispose();
            if (scenario === 'abort-describe') controller.abort();
          } else if (request.method !== 'connect') {
            writes.push(request.method);
            parameters.push(request.params);
            if (scenario === 'revoke-after-write') credential.dispose();
            if (scenario === 'abort-after-write') controller.abort();
          }
          // OpenClaw 2026.6.11 SessionsDeleteParamsSchema requires key and
          // additionalProperties:false. No opt-in transcript/lifecycle flags.
          const valid = request.method === 'connect' || (request.method === 'sessions.delete'
            && request.params?.key === sessionKey && Object.keys(request.params).length === 1)
            || (request.method === 'sessions.describe' && request.params?.key === sessionKey
              && request.params.includeDerivedTitles === false && request.params.includeLastMessage === false && Object.keys(request.params).length === 3);
          socket.send(JSON.stringify(valid
            ? { type: 'res', id: request.id, ok: true, payload: request.method === 'connect' ? {}
              : request.method === 'sessions.describe' ? { session: { key: sessionKey } } : { ok: true, key: sessionKey, deleted: true, archived: [] } }
            : { type: 'res', id: request.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'invalid sessions.delete params' } }));
        });
      });
      const gateway = new GatewayWsClient({ url: `ws://127.0.0.1:${(native.address() as { port: number }).port}`,
        ownerToken: undefined, password: undefined, onConnectionChange: id => {
          if (id && scenario === 'revoke-connect') credential.dispose();
          if (id && scenario === 'abort-connect') controller.abort();
        } });
      const requestBound = gateway.requestBound.bind(gateway);
      gateway.requestBound = async (...args) => {
        const reply = await requestBound(...args);
        if (args[0] === 'sessions.describe' && scenario === 'disconnect-describe') gateway.close();
        return reply as never;
      };
      const queue = new OpenClawTurnQueue({ store, turns: db.turns, executions: db.openClawExecutions,
        authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {},
        send: async () => assert.fail('deletion cannot send'), mirror: async () => {} });
      queue.enqueue({ id: 'preserved', sessionKey: 'unrelated-session', createdAt: 1,
        payload: { actorId: 'synthetic-owner', message: 'preserved', media: [], deliveryMode: 'web-only' } });
      const beforeQueue = db.turns.list('openclaw');
      const app = new Hono();
      const common = { store, gateway, refreshSessions: async () => {
        if (scenario === 'revoke-refresh') credential.dispose();
        if (scenario === 'abort-refresh') controller.abort();
      },
        refreshMessages: async () => {}, normalizeError: () => 'synthetic failure' };
      const connector = route === 'connector' ? registerConnectorRoutes(app, { ...common, tokens, connectorUsers: db, sessionSnapshotReady: () => true, historySnapshotReady: () => true,
        config: loadConfig({} as NodeJS.ProcessEnv), openclawQueue: queue, fallbackAgents: () => [], isAuthorizedRequest: () => true }) : undefined;
      if (route === 'legacy') registerSessionRoutes(app, { ...common, commands: db.commands, deletionAdmission: key => db.canDeleteSession(key), settingsAdmission: key => db.canChangeSettings(key), queue,
        queueActor: request => tokens.authenticate(request)?.tokenId,
        resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => {} });
      const server = transport === 'http' ? serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 }) : undefined;
      t.after(async () => {
        if (server) {
          if ('closeAllConnections' in server) server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
        connector?.close(); await queue.close(); gateway.close();
        await new Promise<void>(resolve => native.close(() => resolve()));
        db.close(); credential.dispose(); await rm(directory, { recursive: true, force: true });
      });
      if (server && !server.listening) await once(server, 'listening');
      const path = `${route === 'connector' ? '/api/connector/v1' : '/api'}/sessions/${encodeURIComponent(sessionKey)}`;
      const init = { method: 'DELETE', headers: { authorization: `Bearer ${credential.token}` }, signal: controller.signal };
      const response = server ? await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, init)
        : await app.request(path, init);
      await response.arrayBuffer();
      const accepted = scenario === 'accepted' || scenario === 'revoke-after-write' || scenario === 'abort-after-write';
      assert.deepEqual(reads, accepted || scenario.endsWith('-describe')
        ? [{ key: sessionKey, includeDerivedTitles: false, includeLastMessage: false }] : []);
      assert.deepEqual(writes, accepted ? ['sessions.delete'] : []);
      assert.deepEqual(parameters, accepted ? [{ key: sessionKey }] : []);
      assert.equal(response.status, accepted ? 200 : scenario.startsWith('abort-') || scenario === 'disconnect-describe' ? 202 : 403);
      assert.equal(!!store.getSession(sessionKey), !accepted);
      assert.deepEqual(db.turns.list('openclaw'), beforeQueue);
      assert.equal(gateway.status().pending, 0);
    });
  }
}
