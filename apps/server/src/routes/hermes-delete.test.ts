import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { loadConfig } from '../config.js';
import { DeckStore } from '../projection/deck-store.js';
import { HermesRuntime, type HermesTransport } from '../hermes/runtime.js';
import { registerConnectorRoutes } from './connector.js';

for (const outcome of ['accepted', 'lost-close', 'lost-delete', 'projection-failed', 'queued', 'unavailable', 'forbidden'] as const) {
  test(`Connector Hermes deletion: ${outcome}; receipt replay never repeats native mutation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-hermes-delete-http-'));
    const db = new ConnectorUserStore(':memory:');
    const store = new DeckStore({ eventLog: db.events });
    const tokens = new ConnectorTokenStore(join(directory, 'synthetic-tokens.json'));
    const credential = tokens.createTransient(outcome === 'forbidden' ? ['sessions:read'] : ['sessions:create']);
    const calls: string[] = [];
    const native: HermesTransport = { ready: false, epoch: 'synthetic', async start() { this.ready = true; }, async close() { this.ready = false; },
      async request(method, params) {
        calls.push(method);
        if (method === 'session.create') return { session_id: 'live', stored_session_id: 'stored' };
        if (method === 'session.activate') return { session_id: 'live', session_key: 'stored', running: false, status: 'idle' };
        if (method === 'session.close') { if (outcome === 'lost-close') throw new Error('lost'); return { closed: true }; }
        if (method === 'session.delete') { assert.deepEqual(params, { session_id: 'stored' }); if (outcome === 'lost-delete') throw new Error('lost'); return { deleted: 'stored' }; }
        assert.fail(`Unexpected native method ${method}`);
      } };
    const runtime = new HermesRuntime({ config: { enabled: true, executable: '/fixture/python', sourceDirectory: '/fixture/source',
      homeDirectory: '/fixture/home', workspace: '/fixture/work', startupTimeoutMs: 1000 },
      journal: db.hermesJournal, turns: db.turns, store, authorize: () => true }, () => native);
    const app = new Hono();
    const connector = registerConnectorRoutes(app, { config: loadConfig({} as NodeJS.ProcessEnv), tokens, connectorUsers: db, store,
      gateway: { requestBound: () => assert.fail('Hermes deletion must never fall back to OpenClaw') } as any,
      ...(outcome === 'unavailable' ? {} : { hermes: runtime }), refreshSessions: async () => {}, refreshMessages: async () => {},
      sessionSnapshotReady: () => true, historySnapshotReady: () => true, fallbackAgents: () => [], isAuthorizedRequest: () => true,
      normalizeError: error => error instanceof Error ? error.message : String(error) });
    try {
      await runtime.start(); const { key } = await runtime.createSession('HTTP fixture', () => {}, () => {});
      if (outcome === 'queued') { await runtime.pauseQueueWorker().drained;
        await runtime.send(key, 'preserve me', { actorId: 'owner', accept: () => () => {} }); }
      if (outcome === 'projection-failed') store.removeSession = () => { throw new Error('projection failure'); };
      const path = `/api/connector/v1/sessions/${encodeURIComponent(key)}`;
      const headers = { authorization: `Bearer ${credential.token}`, 'idempotency-key': 'hermes-delete' };
      const response = await app.request(path, { method: 'DELETE', headers });
      if (outcome === 'forbidden') { assert.equal(response.status, 403); assert.deepEqual(calls, ['session.create']); return; }
      const body = await response.json() as any;
      const accepted = outcome === 'accepted' || outcome === 'projection-failed';
      const rejected = outcome === 'queued' || outcome === 'unavailable';
      assert.equal(response.status, accepted ? 200 : rejected ? 409 : 202);
      assert.equal(body.command.state, accepted ? 'accepted' : rejected ? 'rejected' : 'outcome_unknown');
      const before = [...calls];
      assert.deepEqual(await (await app.request(path, { method: 'DELETE', headers })).json(), body);
      const receipt = await (await app.request(path + '/deletion-commands/hermes-delete', { headers })).json() as any;
      assert.equal(receipt.command.state, body.command.state); assert.deepEqual(calls, before);
      if (!rejected) {
        assert.equal((await app.request(path, { method: 'DELETE', headers: { ...headers, 'idempotency-key': 'another' } })).status, 409);
        await assert.rejects(runtime.send(key, 'never redispatch', { actorId: 'owner', accept: () => () => {} }));
      }
      assert.equal(db.hermesJournal.deletion(key), accepted ? 'accepted' : rejected ? undefined : 'pending');
      assert.equal(calls.filter(method => method === 'session.delete').length, rejected || outcome === 'lost-close' ? 0 : 1);
    } finally { connector.close(); await runtime.close(); db.close(); credential.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
}
