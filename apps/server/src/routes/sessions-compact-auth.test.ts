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
import { registerConnectorRoutes } from './connector.js';
import { registerSessionRoutes } from './sessions.js';

for (const endpoint of ['compact', 'messages'] as const) for (const transport of ['local', 'http'] as const) {
  for (const scenario of ['valid', 'missing', 'refresh-revoke', 'refresh-replace', 'refresh-abort',
    'connect-revoke', 'connect-replace', 'connect-abort', 'lost-ack'] as const) {
    test(`legacy ${endpoint}/${transport}: compact authority ${scenario}`, async t => {
      const db = new ConnectorUserStore(':memory:'), store = new DeckStore({ eventLog: db.events });
      const sessionKey = 'agent:main:dashboard:compact-authority';
      store.upsertSession({ sessionKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
      db.turns.enqueue('openclaw', { id: 'preserved', sessionKey, createdAt: 1,
        payload: { actorId: 'owner', message: 'Preserve this queued input', media: [], deliveryMode: 'web-only' } });
      const beforeQueue = db.turns.list('openclaw'), beforeExecution = store.getSessionExecution(sessionKey);
      let actor: string | undefined = scenario === 'missing' ? undefined : 'owner';
      const controller = new AbortController(), calls: Array<{ method: string; params: any }> = [];
      const mutate = (phase: string) => {
        if (scenario === `${phase}-revoke`) actor = undefined;
        if (scenario === `${phase}-replace`) actor = 'replacement';
        if (scenario === `${phase}-abort`) controller.abort();
      };
      const send = async (method: string, params: any, authorize?: () => void) => {
        await Promise.resolve(); mutate('connect'); authorize?.();
        calls.push({ method, params });
        if (scenario === 'lost-ack') throw new Error('Synthetic lost acknowledgement');
        return { runId: 'synthetic-command-reply', status: 'started' };
      };
      const app = new Hono();
      registerSessionRoutes(app, { store, gateway: {
        request: send,
        requestBound: async (method: string, params: any, _connection: unknown, authorize: () => void) =>
          ({ payload: await send(method, params, authorize), connectionId: 'synthetic' }),
      } as any, commands: db.commands, queueActor: () => actor,
        deletionAdmission: key => db.canDeleteSession(key), settingsAdmission: key => db.canChangeSettings(key),
        queue: { enqueue: () => { throw new Error('Compact must not become an ordinary turn'); } } as any,
        refreshSessions: async () => { mutate('refresh'); }, refreshMessages: async () => {},
        resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => {},
        normalizeError: error => error instanceof Error ? error.message : String(error) });
      // Inject the same server-side cancellation signal for both transports.
      const dispatch = (request: Request) => app.fetch(new Request(request, { signal: controller.signal }));
      const server = transport === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
      t.after(async () => {
        if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        db.close();
      });
      if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
      const request = new Request(`http://127.0.0.1:${server ? (server.address() as { port: number }).port : 80}/api/sessions/${encodeURIComponent(sessionKey)}/${endpoint}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '/compact' }) });
      const response = server ? await fetch(request) : await dispatch(request);
      const body = await response.json() as any;
      const attempted = scenario === 'valid' || scenario === 'lost-ack';
      assert.equal(calls.length, attempted ? 1 : 0, 'denied compact must never reach native dispatch');
      assert.deepEqual(db.turns.list('openclaw'), beforeQueue, 'compact cannot consume queued input');
      if (attempted) {
        assert.ok(calls[0]);
        assert.equal(calls[0].method, 'chat.send');
        assert.equal(calls[0].params.sessionKey, sessionKey);
        assert.equal(calls[0].params.message, '/compact');
        assert.equal(calls[0].params.deliver, false);
      }
      assert.equal(response.status, scenario === 'valid' ? 200 : scenario === 'lost-ack' ? 202 : scenario.endsWith('abort') ? 408 : 403);
      if (scenario === 'lost-ack') {
        assert.equal(body.status, 'outcome_unknown');
        assert.equal(body.runId, undefined);
        assert.equal(store.getMessages(sessionKey).some(message => message.status === 'failed'), false);
      }
      if (!attempted) {
        assert.deepEqual(store.getMessages(sessionKey), []);
        assert.deepEqual(store.getSessionExecution(sessionKey), beforeExecution);
      }
    });
  }
}

for (const endpoint of ['compact', 'messages', 'canonical'] as const) for (const transport of ['local', 'http'] as const) {
  for (const scenario of ['valid', 'revoke-connect', 'abort-connect', 'lost-ack'] as const) {
    test(`${endpoint}/${transport}: compact guard across real loopback handshake (${scenario})`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-compact-wire-'));
      const db = new ConnectorUserStore(':memory:'), store = new DeckStore({ eventLog: db.events });
      const sessionKey = 'agent:main:dashboard:compact-wire';
      store.upsertSession({ sessionKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
      const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
      const credential = tokens.createTransient(['messages:send', 'messages:read']);
      const controller = new AbortController(), writes: string[] = [];
      const native = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(native, 'listening');
      native.on('connection', socket => {
        socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
        socket.on('message', raw => {
          const request = JSON.parse(raw.toString());
          if (request.method === 'agent' || request.method === 'chat.send') {
            writes.push(request.method);
            if (scenario === 'lost-ack') { socket.terminate(); return; }
          }
          socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true,
            payload: { runId: 'synthetic-command-reply', status: 'started' } }));
        });
      });
      const gateway = new GatewayWsClient({ url: `ws://127.0.0.1:${(native.address() as { port: number }).port}`,
        ownerToken: undefined, password: undefined, onConnectionChange: id => {
          if (!id) return;
          if (scenario === 'revoke-connect') credential.dispose();
          if (scenario === 'abort-connect') controller.abort();
        } });
      const app = new Hono(), common = { store, gateway, refreshSessions: async () => {}, refreshMessages: async () => {},
        normalizeError: (error: unknown) => error instanceof Error ? error.message : String(error) };
      const connector = endpoint === 'canonical' ? registerConnectorRoutes(app, { ...common, tokens, connectorUsers: db,
        config: loadConfig({} as NodeJS.ProcessEnv), sessionSnapshotReady: () => true, historySnapshotReady: () => true,
        fallbackAgents: () => [], isAuthorizedRequest: () => true }) : undefined;
      if (endpoint !== 'canonical') registerSessionRoutes(app, { ...common, commands: db.commands,
        queueActor: request => tokens.authenticate(request)?.tokenId,
        queue: { enqueue: () => { throw new Error('must not enqueue'); } } as any,
        deletionAdmission: key => db.canDeleteSession(key), settingsAdmission: key => db.canChangeSettings(key),
        resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => {} });
      const dispatch = (request: Request) => app.fetch(new Request(request, { signal: controller.signal }));
      const server = transport === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
      t.after(async () => {
        if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        connector?.close(); gateway.close(); await new Promise<void>(resolve => native.close(() => resolve()));
        credential.dispose(); db.close(); await rm(directory, { recursive: true, force: true });
      });
      if (server && !server.listening) await once(server, 'listening');
      const request = new Request(`http://127.0.0.1:${server ? (server.address() as { port: number }).port : 80}${endpoint === 'canonical' ? '/api/connector/v1' : '/api'}/sessions/${encodeURIComponent(sessionKey)}/${endpoint === 'compact' ? 'compact' : 'messages'}`,
        { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json',
          'idempotency-key': 'synthetic-compact' }, body: JSON.stringify({ message: '/compact' }) });
      const response = server ? await fetch(request.clone()) : await dispatch(request.clone()), body = await response.json() as any;
      if (scenario !== 'lost-ack') await gateway.request('sessions.list'); // wire barrier after a denied request
      assert.deepEqual(writes, scenario === 'valid' || scenario === 'lost-ack' ? [endpoint === 'canonical' ? 'agent' : 'chat.send'] : []);
      assert.equal(response.status, scenario === 'valid' ? 200 : scenario === 'lost-ack' ? 202 : scenario === 'abort-connect' ? 408 : 403);
      if (scenario === 'lost-ack') {
        assert.equal(body.status, 'outcome_unknown');
        if (endpoint === 'canonical') {
          const replay = server ? await fetch(request.clone()) : await dispatch(request.clone());
          assert.equal(replay.status, 202); await replay.arrayBuffer();
          assert.equal(writes.length, 1, 'same receipt must not replay an unknown native mutation');
        }
      }
      assert.equal(gateway.status().pending, 0);
      assert.deepEqual(db.turns.list('openclaw'), []);
      assert.equal(store.getMessages(sessionKey).some(message => message.status === 'failed'), false);
    });
  }
}
