import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { createTurnAuthorizer, type ExecutionGrantBinding } from '../connector/execution-grants.js';
import { GatewayWsClient } from '../gateway/ws-client.js';
import { DeckStore } from '../projection/deck-store.js';
import { createOpenClawDispatch } from './dispatch.js';
import { OpenClawTurnQueue } from './turn-queue.js';

const sessionKey = 'agent:main:dashboard:dispatch-authorization';
for (const scenario of ['normal', 'delegated-normal', 'token-revoked', 'grant-revoked', 'issuer-revoked', 'restarted',
  'replaced', 'revision-changed', 'revoked-after-write'] as const) {
  test(`actual Gateway dispatch and original queue: ${scenario}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-dispatch-auth-'));
    const tokens = new ConnectorTokenStore(join(directory, 'synthetic-tokens.json'));
    const credential = tokens.createTransient(['messages:send', 'execution:delegate'], 'synthetic-writer');
    const db = new ConnectorUserStore(':memory:', (id) => tokens.hasScope(id, 'messages:send'));
    const runs = db.openClawExecutions;
    const store = new DeckStore({ eventLog: db.events });
    store.upsertSession({ sessionKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
    const binding: ExecutionGrantBinding = { issuerTokenId: 'synthetic-writer', hubId: 'synthetic-hub',
      principalId: 'synthetic-user', grantKey: 'synthetic-grant', version: 1, runtime: 'openclaw', sessionKey };
    const grant = db.executionGrants.issue(binding, ['messages:send'], Date.now() + 60_000);
    const delegated = scenario === 'delegated-normal' || scenario === 'grant-revoked' || scenario === 'issuer-revoked';
    const authorizeTurn = createTurnAuthorizer(db.executionGrants, (id, scope) => tokens.hasScope(id, scope));
    const writes: string[] = [];
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    server.on('connection', socket => {
      socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
      socket.on('message', raw => {
        const request = JSON.parse(raw.toString());
        if (request.method !== 'connect') {
          writes.push(request.method);
          if (scenario === 'revoked-after-write') credential.dispose();
        }
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true,
          payload: request.method === 'agent' ? { runId: 'synthetic-native' } : {} }));
      });
    });
    const gateway = new GatewayWsClient({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
      ownerToken: undefined, password: undefined, onConnectionChange: id => {
        if (!id) return;
        if (scenario === 'token-revoked' || scenario === 'issuer-revoked') credential.dispose();
        if (scenario === 'grant-revoked') db.executionGrants.revokeVersion(binding);
        if (scenario === 'restarted') runs.recoverInterrupted();
        if (scenario === 'replaced') {
          runs.rejectBeforeRun(sessionKey, 'one');
          runs.begin(sessionKey, 'replacement');
        }
        if (scenario === 'revision-changed') runs.observe(sessionKey,
          { runId: 'earlier-run', phase: 'completed', gatewayConnectionId: id });
      } });
    let cliCalls = 0;
    const send = createOpenClawDispatch({ gateway, store, executions: runs, authorizeTurn,
      message: text => text, allowCliFallback: true,
      startCli: async () => { cliCalls++; return { ok: false, error: 'must not start' }; } });
    const queue = new OpenClawTurnQueue({ store, executions: runs, turns: db.turns, authorizeTurn, send,
      refreshSessions: async () => {}, refreshMessages: async () => {}, mirror: async () => {} });
    t.after(async () => {
      await queue.close(); gateway.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close(); credential.dispose(); await rm(directory, { recursive: true, force: true });
    });
    for (const id of ['one', 'two']) queue.enqueue({ id, sessionKey, createdAt: Date.now(), payload: {
      actorId: delegated ? grant.actorId : 'synthetic-writer',
      ...(delegated ? { executionGrant: { ...grant, issuerTokenId: binding.issuerTokenId } } : {}),
      message: id, media: [], deliveryMode: 'web-only',
    } });
    await (queue as any).reconcile(sessionKey);
    const accepted = scenario === 'normal' || scenario === 'delegated-normal' || scenario === 'revoked-after-write';
    assert.deepEqual(writes, accepted ? ['agent'] : []);
    assert.equal(cliCalls, 0);
    assert.equal(gateway.status().pending, 0);
    const turns = db.turns.list('openclaw');
    if (accepted) {
      assert.deepEqual(turns.map(turn => turn.id), ['two']);
      assert.equal(runs.get(sessionKey)?.runId, 'synthetic-native');
      assert.equal(runs.get(sessionKey)?.phase, 'starting');
    } else {
      assert.equal(turns.find(turn => turn.id === 'one')?.state,
        scenario.endsWith('revoked') ? 'blocked' : 'outcome_unknown');
      if (scenario === 'restarted') assert.equal(runs.get(sessionKey)?.reason, 'restarted');
      if (scenario === 'replaced') assert.equal(runs.get(sessionKey)?.commandId, 'replacement');
    }
    assert.equal(turns.find(turn => turn.id === 'two')?.state, 'queued');
    // A rejected/unknown head or accepted active run cannot release its successor.
    await (queue as any).reconcile(sessionKey);
    assert.deepEqual(writes, accepted ? ['agent'] : []);
  });
}
