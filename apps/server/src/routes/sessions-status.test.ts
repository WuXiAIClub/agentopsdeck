import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { loadConfig } from '../config.js';
import { DeckStore } from '../projection/deck-store.js';
import { registerConnectorRoutes } from './connector.js';
import { registerSessionRoutes } from './sessions.js';

for (const authoritative of [false, true]) for (const echoed of [false, true]) {
  test(`local status pair retains identity across history replacement (authoritative=${authoritative}, echo=${echoed})`, () => {
    const store = new DeckStore(), sessionKey = 'codex:status-identity';
    const query = { id: 'local-query', sessionKey, role: 'user' as const, text: '/status', status: 'sent' as const, createdAt: 1 };
    const report = { ...query, id: 'local-status:local-query', role: 'assistant' as const, text: 'Status: running' };
    const stale = { ...report, id: 'stale-native', text: 'Old native answer' }, orphan = { ...query, id: 'unpaired-query' };
    for (const message of [query, report, stale, orphan]) store.addMessage(message);
    const native = echoed ? [{ ...query, id: 'native-query' }, { ...report, id: 'native-reply' }] : [];
    store.replaceMessages(sessionKey, native, { authoritative });
    const messages = new Map(store.getMessages(sessionKey).map(message => [message.id, message]));
    for (const message of [query, report, ...native]) assert.deepEqual(messages.get(message.id), message);
    assert.equal(messages.has(stale.id), !authoritative, 'unrelated native rows still follow authoritative replacement');
    if (authoritative) assert.equal(messages.has(orphan.id), false, 'a bare /status text is not a local report identity');
  });
}

for (const runtime of ['openclaw', 'codex'] as const) for (const route of ['connector', 'legacy'] as const) for (const transport of ['local', 'http'] as const) {
  const outcomes = ['running', 'unknown', 'sync-error', 'transcript-final', 'missing', 'unauthorized',
    ...(route === 'connector' ? ['run-identity'] as const : []),
    ...(route === 'connector' && runtime === 'codex' ? ['disabled', 'unconfigured'] as const : [])] as const;
  for (const outcome of outcomes) {
    test(`${runtime}/${route}/${transport}: status reports ${outcome} without executing or completing a run`, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-status-test-'));
      const db = new ConnectorUserStore(':memory:');
      const store = new DeckStore({ eventLog: db.events });
      const sessionKey = runtime === 'codex' ? 'codex:synthetic-status' : 'agent:main:dashboard:synthetic-status';
      if (outcome !== 'missing') store.upsertSession({ sessionKey, agentId: runtime === 'codex' ? 'codex' : 'main', title: 'Status',
        status: outcome === 'running' || outcome === 'transcript-final' ? 'running' : 'unknown',
        ...(outcome === 'running' || outcome === 'transcript-final' ? { hasActiveRun: true, runStartedAt: 1 } : {}),
        ...(outcome === 'sync-error' ? { runtime: { turnId: 'finished-run', phase: 'completed',
          connection: 'disconnected', sync: 'error', threadActivity: 'unknown', lastEventAt: 1 } } : {}) });
      if (outcome === 'transcript-final') store.addMessage({ id: 'native-assistant', sessionKey, role: 'assistant',
        text: 'A transcript item is not execution proof', status: 'sent', createdAt: 2 });
      const beforeMessages = structuredClone(store.getMessages(sessionKey));
      db.turns.enqueue(runtime, { id: 'preserved', sessionKey, createdAt: 1,
        payload: { actorId: 'owner', message: 'preserve queued input', media: [], deliveryMode: 'web-only' } });
      const beforeQueue = db.turns.list(runtime);
      const snapshot = () => { const { sourceCursor: _, ...state } = store.getSessionExecution(sessionKey) ?? {}; return state; };
      const beforeState = snapshot();
      const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
      const credential = tokens.createTransient(outcome === 'unauthorized' ? ['messages:send'] : ['messages:send', 'messages:read']);
      const nativeCalls: string[] = [];
      const gateway = { request: async (method: string) => { nativeCalls.push(method); return { runId: 'wrong-agent-run' }; } };
      const codex = outcome === 'unconfigured' ? undefined : { enabled: outcome !== 'disabled', owns: (key: string) => key.startsWith('codex:'),
        send: async () => { nativeCalls.push('codex.send'); return { runId: 'wrong-codex-run' }; } } as any;
      const queue = { enqueue: () => { nativeCalls.push('enqueue'); }, hasPending: () => true } as any;
      const common = { store, gateway: gateway as any, codex, refreshSessions: async () => {},
        refreshMessages: async () => { store.replaceMessages(sessionKey, beforeMessages, { authoritative: runtime === 'codex' }); },
        normalizeError: (error: unknown) => error instanceof Error ? error.message : String(error) };
      const app = new Hono();
      const connector = route === 'connector' ? registerConnectorRoutes(app, { ...common, tokens, connectorUsers: db,
        config: loadConfig({} as NodeJS.ProcessEnv), sessionSnapshotReady: () => true, historySnapshotReady: () => true,
        openclawQueue: queue, fallbackAgents: () => [], isAuthorizedRequest: () => true }) : undefined;
      if (route === 'legacy') registerSessionRoutes(app, { ...common, queue, commands: db.commands,
        queueActor: () => outcome === 'unauthorized' ? undefined : 'owner',
        deletionAdmission: key => db.canDeleteSession(key), settingsAdmission: key => db.canChangeSettings(key),
        resolveExplicitChannelRoute: () => undefined, mirrorAssistantReplyToChannel: async () => {} });
      const server = transport === 'http' ? serve({ fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0 }) : undefined;
      t.after(async () => {
        if (server) {
          if ('closeAllConnections' in server) server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
        connector?.close(); credential.dispose(); db.close(); await rm(directory, { recursive: true, force: true });
      });
      if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
      const path = `${route === 'connector' ? '/api/connector/v1' : '/api'}/sessions/${encodeURIComponent(sessionKey)}/messages`;
      const send = () => {
        const init = { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json',
          'idempotency-key': 'synthetic-status' }, body: JSON.stringify({ message: ' /status ', media: [],
            ...(outcome === 'run-identity' ? { expectedRunId: 'not-a-stop-control' } : {}) }) };
        return server ? fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, init) : app.request(path, init);
      };
      const response = await send(), body = await response.json() as any;
      assert.equal(response.status, outcome === 'missing' ? 404 : outcome === 'unauthorized' ? 403 : outcome === 'run-identity' ? 400 : 200);
      assert.deepEqual(nativeCalls, [], 'a status query cannot invoke an Agent or enter its queue');
      assert.deepEqual(snapshot(), beforeState, 'reporting does not change execution facts');
      assert.deepEqual(db.turns.list(runtime), beforeQueue);
      if (outcome === 'missing' || outcome === 'unauthorized' || outcome === 'run-identity') {
        assert.deepEqual(store.getMessages(sessionKey), beforeMessages); return;
      }
      assert.equal(body.status, 'ok'); assert.equal(body.runId, undefined, 'a report is not a native run');
      const messages = structuredClone(store.getMessages(sessionKey));
      assert.equal(messages.length, beforeMessages.length + 2);
      const report = messages.find(message => message.id.startsWith('local-status:'))!;
      assert.match(report.text, /last known projection/);
      if (runtime === 'codex') assert.doesNotMatch(report.text, /Gateway:/, 'OpenClaw Gateway health cannot describe Codex connectivity');
      if (outcome === 'running') {
        assert.match(report.text, /Status: running/);
        assert.equal(store.getSession(sessionKey)?.status, 'running', 'the report cannot become terminal evidence');
      }
      if (outcome === 'transcript-final') assert.match(report.text, /Status: running/, 'display inference cannot replace the execution snapshot');
      if (outcome === 'unknown') assert.match(report.text, /Active run: unknown/);
      if (outcome === 'sync-error') {
        assert.match(report.text, /Execution: completed/); assert.match(report.text, /Runtime connection: disconnected/);
        assert.match(report.text, /Response sync: error/);
      }
      if (route === 'connector') {
        assert.deepEqual(await (await send()).json(), body);
        assert.deepEqual(store.getMessages(sessionKey), messages, 'receipt replay cannot insert a second report');
        assert.deepEqual(nativeCalls, []);
      }
      const readRequest = new Request(`http://127.0.0.1:${server ? (server.address() as { port: number }).port : 80}${path}`,
        { headers: { authorization: `Bearer ${credential.token}` } });
      const refreshed = server ? await fetch(readRequest) : await app.fetch(readRequest);
      assert.equal(refreshed.status, 200);
      const history = await refreshed.json() as any;
      assert.ok(history.messages.some((message: any) => message.id === report.id), 'history refresh must retain the local report');
      assert.ok(history.messages.some((message: any) => message.id === body.idempotencyKey), 'history refresh must retain its query');
      assert.deepEqual(store.getMessages(sessionKey), messages);
    });
  }
}
