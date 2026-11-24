import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createTurnAuthorizer } from './execution-grants.js';
import { createMirrorAuthorizer } from './mirror-authorization.js';
import { createMirrorDispatcher, resolveExplicitChannelRoute } from '../messages/mirror.js';
import { DeckStore } from '../projection/deck-store.js';
import { OpenClawTurnQueue, type OpenClawQueuedTurn } from '../openclaw/turn-queue.js';
import { createOpenClawDispatch } from '../openclaw/dispatch.js';

function fixture(context: TestContext, mirror = true) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-mirror-lifecycle-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
  const issuer = tokens.create({ label: 'synthetic issuer', delegationHubId: 'hub-synthetic',
    scopes: ['execution:delegate', 'messages:send', 'messages:mirror'] });
  const database = new ConnectorUserStore(':memory:', (id, action) => tokens.hasScope(id, 'execution:delegate')
    && tokens.hasScope(id, 'messages:send') && (action !== 'messages:mirror' || tokens.hasScope(id, 'messages:mirror')));
  const sessionKey = 'agent:main:feishu:direct:original';
  const binding = { issuerTokenId: issuer.record.id, hubId: 'hub-synthetic', principalId: 'user-original', grantKey: 'policy-original',
    version: 1, runtime: 'openclaw' as const, sessionKey };
  const grant = database.executionGrants.issue(binding, mirror ? ['messages:send', 'messages:mirror'] : ['messages:send'], Date.now() + 30_000);
  const params = { actorId: grant.actorId, executionGrant: { ...grant, issuerTokenId: issuer.record.id }, sessionKey,
    after: Date.now(), inputText: 'original input', idempotencyKey: 'original', explicitRoute: resolveExplicitChannelRoute(sessionKey, 'main')! };
  const authorizeTurn = createTurnAuthorizer(database.executionGrants, (id, scope) => tokens.hasScope(id, scope));
  const store = new DeckStore(), sent: unknown[] = [];
  store.upsertSession({ sessionKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
  const dispatcher = createMirrorDispatcher(database.mirrorOutbox, { store, normalizeError: String,
    authorizeTarget: createMirrorAuthorizer(authorizeTurn, 'main'), sendOutbound: async (route, text) => { sent.push({ route, text }); } });
  const turn: OpenClawQueuedTurn = { id: params.idempotencyKey, sessionKey, createdAt: params.after, state: 'queued', payload: {
    actorId: params.actorId, executionGrant: params.executionGrant, message: params.inputText, deliveryMode: 'mirror',
    explicitRoute: params.explicitRoute, media: [],
  } };
  context.mock.method(console, 'log', () => {});
  context.mock.method(console, 'warn', () => {});
  context.after(async () => { await dispatcher.close(); database.close(); rmSync(directory, { recursive: true, force: true }); });
  return { tokens, issuer, database, binding, grant, params, authorizeTurn, store, sent, dispatcher, turn };
}

for (const failure of ['none', 'grant-revoked', 'issuer-revoked', 'send-only', 'provider-unavailable'] as const) {
  test(`original delegated reply settles at actual target boundary: ${failure}`, async context => {
    const setup = fixture(context, failure !== 'send-only');
    setup.database.mirrorOutbox.upsert(setup.params);
    setup.database.openClawExecutions.begin(setup.params.sessionKey, 'original');
    setup.database.openClawExecutions.useCli(setup.params.sessionKey, 'original');
    setup.database.openClawExecutions.finishCli(setup.params.sessionKey, 'original', 'completed', database => {
      setup.database.mirrorOutbox.recordCliReplyInTransaction(database, setup.params, 'original reply');
    });
    if (failure === 'grant-revoked') {
      setup.database.executionGrants.revoke(setup.issuer.record.id, setup.grant.id);
      setup.database.executionGrants.issue({ ...setup.binding, version: 2 }, ['messages:send', 'messages:mirror'], Date.now() + 30_000);
    }
    if (failure === 'issuer-revoked') setup.tokens.revoke(setup.issuer.record.id);
    if (failure === 'provider-unavailable') context.mock.method(setup.tokens, 'hasScope', () => { throw new Error('synthetic provider unavailable'); });
    await setup.dispatcher.reconcileSession(setup.params.sessionKey).catch(() => {});
    const stored = setup.database.mirrorOutbox.get('original')!;
    assert.equal(stored.deliveryState, failure === 'none' ? 'sent' : 'blocked');
    assert.equal(stored.nativeReply?.text, 'original reply');
    assert.equal(stored.executionGrant?.id, setup.grant.id);
    assert.equal(setup.sent.length, failure === 'none' ? 1 : 0);
    await setup.dispatcher.reconcileSession(setup.params.sessionKey);
    assert.equal(setup.sent.length, failure === 'none' ? 1 : 0);
    assert.equal(setup.database.mirrorOutbox.usesExecutionGrant(setup.binding, setup.params.executionGrant), false);
  });
}

test('send-only execution grant cannot admit mirror into original FIFO or create an intent', async context => {
  const setup = fixture(context, false);
  const queue = new OpenClawTurnQueue({ turns: setup.database.turns, executions: setup.database.openClawExecutions,
    mirrorOutbox: setup.database.mirrorOutbox, store: setup.store, authorizeTurn: setup.authorizeTurn,
    refreshSessions: async () => {}, refreshMessages: async () => {}, mirror: async () => {}, send: async () => assert.fail('No native send') });
  try {
    assert.throws(() => queue.enqueue(setup.turn), /authorization/i);
    assert.deepEqual(setup.database.turns.list('openclaw'), []);
    assert.deepEqual(setup.database.mirrorOutbox.list(), []);
    queue.enqueue({ ...setup.turn, payload: { ...setup.turn.payload, deliveryMode: 'web-only' } });
    assert.equal(setup.database.turns.list('openclaw').length, 1);
  } finally { await queue.close(); }
});

test('queued mirror is blocked before native execution when original grant is revoked', async context => {
  const setup = fixture(context);
  const queue = new OpenClawTurnQueue({ turns: setup.database.turns, executions: setup.database.openClawExecutions,
    mirrorOutbox: setup.database.mirrorOutbox, store: setup.store, authorizeTurn: setup.authorizeTurn,
    refreshSessions: async () => {}, refreshMessages: async () => {}, mirror: async () => {}, send: async () => assert.fail('No native send') });
  try {
    queue.enqueue(setup.turn);
    setup.database.executionGrants.revoke(setup.issuer.record.id, setup.grant.id);
    await (queue as any).reconcile(setup.params.sessionKey);
    assert.equal(setup.database.turns.head('openclaw', setup.params.sessionKey)?.state, 'blocked');
    assert.equal(setup.database.openClawExecutions.get(setup.params.sessionKey), undefined);
    assert.equal(setup.database.mirrorOutbox.get('original')?.nativeReply, undefined);
  } finally { await queue.close(); }
});

test('original mirror authorization is rechecked after Gateway handshake and before native transmission', async context => {
  const setup = fixture(context);
  let ready!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let native = 0;
  const dispatch = createOpenClawDispatch({ store: setup.store, executions: setup.database.openClawExecutions,
    mirrorOutbox: setup.database.mirrorOutbox, authorizeTurn: setup.authorizeTurn, allowCliFallback: false, message: text => text,
    gateway: { requestBound: async (_method: string, _payload: unknown, _connection: unknown, beforeSend: () => void) => {
      ready(); await gate; beforeSend(); native += 1;
      return { connectionId: 'synthetic-socket', payload: { runId: 'synthetic-run' } };
    } } as any,
  });
  try {
    setup.database.mirrorOutbox.upsert(setup.params);
    setup.database.openClawExecutions.begin(setup.params.sessionKey, 'original');
    const pending = dispatch(setup.turn, []);
    const rejected = assert.rejects(pending, /authorization/i);
    await waiting;
    setup.database.executionGrants.revoke(setup.issuer.record.id, setup.grant.id);
    release(); await rejected;
    assert.equal(native, 0);
    assert.equal(setup.database.mirrorOutbox.get('original')?.nativeReply, undefined);
  } finally { release(); await dispatch.close(); }
});
