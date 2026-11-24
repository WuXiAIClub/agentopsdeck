import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { HubStore } from './hub-store.js';
import { HubExecutionSync } from './execution-sync.js';
import { encodeHubSessionId } from './session-id.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ExecutionGrants } from '../connector/execution-grants.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { resolveExecutionActor } from '../connector/execution-authority.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { CommandReceipts } from '../commands/receipts.js';
import { registerMessageReceipts } from '../commands/http.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { HubExecutionUsage } from './execution-usage.js';
import { HubExecutionLeases } from './execution-leases.js';
import { HubExecutionWorker } from './execution-worker.js';
import { ConnectorNotDispatchedError } from './connector-connect.js';

async function fixture(transport: 'local' | 'http', runtime: 'codex' | 'openclaw', sendMode?: 'accept' | 'reject' | 'unknown' | 'lost-ack') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-command-authority-')), file = join(directory, 'hub.sqlite');
  let hub = new HubStore(file, 'synthetic-vault');
  const db = new DatabaseSync(file), remoteDb = new DatabaseSync(':memory:');
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
  const issuer = () => tokens.create({ label: 'Synthetic issuer', delegationHubId: hub.identities.hubId,
    scopes: ['execution:delegate', 'messages:send'] });
  const first = issuer(), second = issuer(), nodeId = `node_${randomUUID()}`;
  const grants = new ExecutionGrants(remoteDb, id => !!tokens.delegationHubId(id)), receipts = new CommandReceipts(remoteDb);
  const turns = new TurnQueue(remoteDb);
  const sessionKey = runtime === 'codex' ? 'codex:synthetic/空 格' : 'agent:synthetic/空 格';
  const app = new Hono(), calls: Array<{ method: string; path: string; actor?: string }> = [];
  let afterRead = () => {}, afterUsage: () => void | Promise<void> = () => {}, afterSend: () => void | Promise<void> = () => {}, wrongPin = false, corruptReply = false, failUsage = false;
  app.use('*', async (c, next) => { c.header(NODE_ID_HEADER, wrongPin ? `node_${randomUUID()}` : nodeId); await next(); });
  registerExecutionGrantRoutes(app, { tokens, grants, nodeId, turns });
  registerMessageReceipts(app, '/api/connector/v1/sessions/:sessionKey', {
    queue: (c, key) => {
      const actor = resolveExecutionActor(c.req.raw, { tokens, grants, nodeId }, { runtime, sessionKey: c.req.param('sessionKey')! });
      return turns.commandState(runtime, sessionKey, key, actor.actorId);
    },
    receipts, scope: (c, write) => {
      const actor = resolveExecutionActor(c.req.raw, { tokens, grants, nodeId }, { runtime, sessionKey: c.req.param('sessionKey')! }, write ? 'messages:send' : undefined);
      calls[calls.length - 1]!.actor = actor.actorId;
      return JSON.stringify([actor.actorId, c.req.param('sessionKey')]);
    },
  });
  // Optional synthetic admission, never an Agent factory or execution loop.
  if (sendMode) app.post('/api/connector/v1/sessions/:sessionKey/messages', c => {
    if (sendMode === 'reject') return c.json({ error: 'Synthetic rejection' }, 400);
    if (sendMode === 'unknown') return c.json({ command: { state: 'outcome_unknown' } }, 202);
    const actor = resolveExecutionActor(c.req.raw, { tokens, grants, nodeId }, { runtime, sessionKey }, 'messages:send');
    const body = { ok: true, queued: true, idempotencyKey: c.get('commandKey'),
      admission: { createdAt: 123, queueVersion: 'opaque-version', disposition: 'waiting' } };
    turns.enqueue(runtime, { id: c.get('commandKey'), sessionKey, createdAt: Date.now(),
      payload: { actorId: actor.actorId, executionGrant: actor.executionGrant } },
    receipts.queueCommit(JSON.stringify([actor.actorId, sessionKey]), c.get('commandKey'), { status: 200, body }));
    return c.json(body);
  });
  const dispatch = async (request: Request) => {
    calls.push({ method: request.method, path: new URL(request.url).pathname });
    const response = await app.fetch(request);
    if (sendMode && request.method === 'POST' && request.url.endsWith('/messages')) {
      await afterSend();
      if (sendMode === 'lost-ack') { await response.body?.cancel(); throw new Error('Synthetic lost send ACK'); }
    }
    if (request.url.endsWith('/usage')) {
      await afterUsage();
      if (failUsage) { await response.body?.cancel(); throw new Error('Synthetic lost usage ACK'); }
    }
    if (request.url.includes('/commands/')) {
      afterRead();
      if (corruptReply) { await response.body?.cancel(); return Response.json({ command: { key: 'wrong', state: 'accepted', result: { status: 200, body: {} } } }, { headers: response.headers }); }
    }
    return response;
  };
  const server = transport === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector.example.invalid';
  hub.upsertConnection({ id: 'node', kind: transport === 'local' ? 'local' : 'remote', label: 'Synthetic', connectorUrl: origin });
  hub.pinConnectionNode('node', 'default', hub.connectionAuthority('node')!, nodeId);
  const local = transport === 'local' ? { connectionId: 'node', dispatch } : undefined;
  await hub.executionIssuers.configure('default', 'node', first.token, () => {}, local);
  const userId = hub.createUser('Member').id;
  const target = { userId, ownerUserId: 'default', sessionId: encodeHubSessionId('node', sessionKey) };
  const policyTarget = { userId, ownerUserId: 'default', connectionId: 'node' };
  const createLease = async (issuerId = first.record.id) => {
    const resource = { runtime, sessionKey }, grant = hub.grants.create(policyTarget, { ...resource, actions: ['messages:send'] });
    const proof = hub.grants.authorize(policyTarget, 'messages:send', resource, grant.id)!;
    const sync = new HubExecutionSync(hub.executionLeases, hub.identities.hubId, lease => hub.executionIssuers.clientFor(lease, local));
    try { return await sync.acquire(proof, nodeId, issuerId, ['messages:send']); } finally { await sync.close(); }
  };
  const lease = await createLease();
  const claim = () => hub.executionCommands.claim(target, 'key', { text: 'synthetic' }, lease.id);
  const accept = () => {
    const row = db.prepare('SELECT delivery_key FROM command_receipts WHERE authority_id = ?').get(lease.id) as { delivery_key: string };
    const scope = JSON.stringify([lease.ref!.actorId, sessionKey]);
    receipts.claim(scope, row.delivery_key, {});
    receipts.settle(scope, row.delivery_key, { status: 200, body: { ok: true } });
  };
  return { get hub() { return hub; }, db, tokens, first, second, local, lease, target, calls, claim, accept, createLease, turns,
    enqueue: () => turns.enqueue(runtime, { id: 'pending', sessionKey, createdAt: 1,
      payload: { actorId: lease.ref!.actorId, executionGrant: { ...lease.ref!, issuerTokenId: first.record.id } } }),
    createUsage: (now = Date.now) => {
      const leases = new HubExecutionLeases(db, hub.grants, now);
      const client = (lease: import('./execution-leases.js').ExecutionLease) => hub.executionIssuers.clientFor(lease, local);
      const sync = new HubExecutionSync(leases, hub.identities.hubId, client, 32, now);
      const usage = new HubExecutionUsage(leases, hub.identities.hubId, sync, client, now);
      return { leases, usage, sync, close: () => Promise.all([sync.close(), usage.close()]) };
    },
    afterUsage: (fn: () => void | Promise<void>) => { afterUsage = fn; }, failUsage: () => { failUsage = true; }, afterSend: (fn: () => void | Promise<void>) => { afterSend = fn; },
    afterRead: (fn: () => void) => { afterRead = fn; }, wrongPin: () => { wrongPin = true; }, corruptReply: () => { corruptReply = true; },
    rotate: () => hub.executionIssuers.configure('default', 'node', second.token, () => {}, local),
    reopen: () => { hub.close(); hub = new HubStore(file, 'synthetic-vault'); },
    recover: (authorize = () => {}) => hub.executionCommands.recover(target, 'key', authorize, local),
    close: async () => {
      if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      hub.close(); db.close(); remoteDb.close(); rmSync(directory, { recursive: true, force: true });
    } };
}

for (const failure of ['revoked', 'closed', 'lost-release', 'revoked-release'] as const) {
  test(`direct shared claim awaits physical admission and fences ${failure}`, async () => {
    const f = await fixture('local', 'codex');
    let entered!: () => void, release!: () => void, admissions = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    (f.hub.commands as any).asyncStorageAdmission = async (_bytes: number, write: () => Promise<unknown>) => {
      admissions++; entered(); await waiting; const result = await write();
      if (failure === 'revoked-release') f.hub.executionLeases.revoke(f.lease.id);
      if (failure === 'lost-release') throw Error('synthetic-lost-release');
      return result;
    };
    const scope = JSON.stringify(['execution-v1', f.target.ownerUserId, f.target.userId, f.target.sessionId]);
    try {
      assert.throws(() => f.hub.commands.claim(scope, 'bypass', {}), /async-admission-required/);
      const pending = f.claim(), rejected = assert.rejects(pending);
      await started; assert.equal(f.hub.commands.get(scope, 'key'), undefined);
      if (failure === 'revoked') f.hub.executionLeases.revoke(f.lease.id);
      const closing = failure === 'closed' ? f.hub.executionCommands.close() : undefined;
      release(); await rejected; await closing;
      const committed = failure === 'lost-release' || failure === 'revoked-release';
      const original = f.hub.commands.get(scope, 'key');
      assert.equal(original?.state, committed ? 'outcome_unknown' : undefined);
      assert.equal(f.db.isTransaction, false); assert.equal(admissions, 1);
      if (failure === 'lost-release') {
        const retry = await f.claim(); assert.equal(retry.fresh, false);
        assert.equal(retry.receipt.id, original!.id); assert.equal(admissions, 1);
      }
      assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 0);
    } finally { release(); await f.close(); }
  });
}

test('direct shared claim snapshots target and payload before asynchronous scheduling', async () => {
  const f = await fixture('local', 'codex');
  try {
    const target = { ...f.target }, payload = { text: 'original' };
    const flight = f.hub.executionCommands.claim(target, 'snapshot', payload, f.lease.id);
    target.userId = 'changed'; payload.text = 'changed';
    assert.equal((await flight).fresh, true);
    const duplicate = await f.hub.executionCommands.claim(f.target, 'snapshot', { text: 'original' }, f.lease.id);
    assert.equal(duplicate.fresh, false);
    await assert.rejects(f.hub.executionCommands.claim(f.target, 'snapshot', payload, f.lease.id), /different content/);
  } finally { await f.close(); }
});

for (const failure of ['revoked', 'closed', 'lost-release'] as const) {
  test(`shared async receipt admission ${failure} never dispatches or replays uncertain work`, async () => {
    const f = await fixture('local', 'codex', 'accept');
    let entered!: () => void, release!: () => void, calls = 0, allowed = true;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    (f.hub.commands as any).asyncStorageAdmission = async (_bytes: number, write: () => Promise<unknown>) => {
      calls++; entered(); await waiting;
      const result = await write();
      if (failure === 'lost-release') throw Error('release acknowledgment lost');
      return result;
    };
    const send = () => f.hub.executionCommands.send(f.target, 'key', { text: 'synthetic' }, async () => f.lease,
      { read: () => {}, send: () => { if (!allowed) throw Error('send revoked'); } }, f.local);
    const pending = send();
    const rejected = assert.rejects(pending, failure === 'revoked' ? /revoked/ : failure === 'closed' ? /closed/ : /acknowledgment/);
    try {
      await started;
      assert.equal(f.db.isTransaction, false);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()?.n, 0);
      if (failure === 'revoked') allowed = false;
      const closing = failure === 'closed' ? f.hub.executionCommands.close() : undefined;
      release(); await rejected; await closing;
      assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 0);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()?.n, failure === 'lost-release' ? 1 : 0);
      if (failure === 'lost-release') {
        assert.equal((await send()).state, 'outcome_unknown');
        assert.equal(calls, 1, 'original receipt bypasses physical admission and never redispatches');
        assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 0);
      }
    } finally { release(); await pending.catch(() => {}); await f.close(); }
  });
}

for (const failure of ['revoked', 'closed', 'lost-release'] as const) {
  test(`shared queue mutation async admission ${failure} retains original recovery authority`, async () => {
    const f = await fixture('local', 'codex', 'accept');
    let entered!: () => void, release!: () => void, allowed = true, dispatches = 0, admissions = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    try {
      assert.equal((await f.hub.executionCommands.send(f.target, 'key', { text: 'synthetic' }, async () => f.lease,
        { read: () => {}, send: () => {} }, f.local)).state, 'accepted');
      (f.hub.commands as any).asyncStorageAdmission = async (_bytes: number, write: () => Promise<unknown>) => {
        admissions++; entered(); await waiting;
        const result = await write();
        if (failure === 'lost-release') throw Error('release acknowledgment lost');
        return result;
      };
      f.hub.executionIssuers.queueMutationFor = async (_lease, _commandKey, _mutationKey, change) => {
        if (change) dispatches++;
        return undefined;
      };
      const change = { method: 'PATCH' as const, version: '1:1', text: 'original edit' };
      const mutate = () => f.hub.executionCommands.mutateQueue(f.target, 'key', 'mutation', f.lease.nodeId!, change,
        { read: () => {}, write: () => { if (!allowed) throw Error('write revoked'); } }, f.local);
      const pending = mutate();
      const rejected = assert.rejects(pending, failure === 'revoked' ? /revoked/ : failure === 'closed' ? /closed/ : /acknowledgment/);
      await started; assert.equal(f.db.isTransaction, false);
      if (failure === 'revoked') allowed = false;
      const closing = failure === 'closed' ? f.hub.executionCommands.close() : undefined;
      release(); await rejected; await closing;
      assert.equal(dispatches, 0);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()?.n, failure === 'lost-release' ? 2 : 1);
      if (failure === 'lost-release') {
        allowed = false;
        assert.equal((await mutate()).state, 'outcome_unknown', 'revoked actor can read original unknown, never repeat PATCH');
        assert.equal(admissions, 1); assert.equal(dispatches, 0);
      }
    } finally { release(); await f.close(); }
  });
}

test('shared async admission sends and fingerprints the same immutable caller snapshot', async () => {
  const f = await fixture('local', 'codex', 'accept');
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  (f.hub.commands as any).asyncStorageAdmission = async (_bytes: number, write: () => Promise<unknown>) => {
    entered(); await waiting; return write();
  };
  const original = f.hub.executionIssuers.messageFor.bind(f.hub.executionIssuers);
  f.hub.executionIssuers.messageFor = async (...args) => {
    assert.deepEqual(args[2], { text: 'synthetic', nested: { value: 'original' } });
    return original(...args);
  };
  const target = { ...f.target }, payload = { text: 'synthetic', nested: { value: 'original' } };
  const pending = f.hub.executionCommands.send(target, 'key', payload, async () => f.lease,
    { read: () => {}, send: () => {} }, f.local);
  try {
    await started; payload.text = 'replacement'; payload.nested.value = 'replacement'; target.userId = 'replacement';
    release(); assert.equal((await pending).state, 'accepted');
    assert.equal((await f.hub.executionCommands.send(f.target, 'key', { text: 'synthetic', nested: { value: 'original' } },
      async () => assert.fail('must not reacquire'), { read: () => {}, send: () => assert.fail('historical read only') }, f.local)).state, 'accepted');
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
  } finally { release(); await pending.catch(() => {}); await f.close(); }
});

test('shared send proven not dispatched settles rejected and never reacquires or redispatches', async () => {
  const f = await fixture('local', 'codex', 'accept');
  let attempts = 0, acquired = 0;
  f.hub.executionIssuers.messageFor = async () => { attempts++; throw new ConnectorNotDispatchedError(); };
  const send = () => f.hub.executionCommands.send(f.target, 'key', { text: 'synthetic' },
    async () => { acquired++; return f.lease; }, { read: () => {}, send: () => {} }, f.local);
  try {
    assert.equal((await send()).state, 'rejected');
    assert.equal((await f.recover())?.state, 'rejected');
    assert.equal((await send()).state, 'rejected');
    f.reopen();
    assert.equal((await f.recover())?.state, 'rejected');
    assert.equal((await send()).state, 'rejected');
    assert.equal(attempts, 1);
    assert.equal(acquired, 1);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 0);
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: send-only lease cannot claim or dispatch a mirror command`, async () => {
    const setup = await fixture(transport, runtime, 'accept');
    const payload = { text: 'synthetic', deliveryMode: 'mirror' };
    try {
      await assert.rejects(() => setup.hub.executionCommands.claim(setup.target, 'key', payload, setup.lease.id), /mirror authority/);
      await assert.rejects(setup.hub.executionCommands.send(setup.target, 'key', payload,
        async () => setup.lease, { read: () => {}, send: () => {} }, setup.local), /mirror authority/);
      assert.equal(await setup.recover(), undefined);
      assert.equal(setup.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 0);
      const accepted = await setup.hub.executionCommands.send(setup.target, 'key', { text: 'synthetic', deliveryMode: 'web-only' },
        async () => setup.lease, { read: () => {}, send: () => {} }, setup.local);
      assert.equal(accepted.state, 'accepted');
    } finally { await setup.close(); }
  });

  test(`${transport}/${runtime}: concurrent shared sends admit once with original actor, then recover without acquiring again`, async () => {
    const f = await fixture(transport, runtime, 'accept'); let acquired = 0, sendAllowed = true;
    const guards = { read: () => {}, send: () => { if (!sendAllowed) throw new Error('send revoked'); } };
    const send = (payload = { text: 'synthetic' }) => f.hub.executionCommands.send(f.target, 'key', payload,
      async () => { acquired++; return f.lease; }, guards, f.local);
    try {
      const replies = await Promise.all([send(), send()]);
      assert.ok(replies.every(reply => ['accepted', 'outcome_unknown'].includes(reply.state)));
      const recovered = await f.recover();
      assert.equal(recovered?.state, 'accepted');
      assert.deepEqual((recovered?.result?.body as any)?.admission,
        { createdAt: 123, queueVersion: 'opaque-version', disposition: 'waiting' });
      assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
      const queued = f.turns.list<{ actorId: string; executionGrant: { id: string } }>(runtime);
      assert.equal(queued.length, 1); assert.equal(queued[0]!.payload.actorId, f.lease.ref!.actorId);
      assert.equal(queued[0]!.payload.executionGrant.id, f.lease.ref!.id);
      assert.notEqual(queued[0]!.id, 'key', 'downstream command identity is isolated');
      const before = f.calls.length, previousAcquires = acquired;
      sendAllowed = false; f.reopen();
      assert.equal((await send()).state, 'accepted');
      assert.equal(f.calls.length, before); assert.equal(acquired, previousAcquires);
      await assert.rejects(send({ text: 'different' }), /different content/);
      assert.equal(acquired, previousAcquires);
    } finally { await f.close(); }
  });
}

for (const mode of ['lost-ack', 'reject', 'unknown'] as const) test(`shared send ${mode} only queries original receipt, never redispatches`, async () => {
  const f = await fixture('local', 'codex', mode); let acquired = 0;
  const send = () => f.hub.executionCommands.send(f.target, 'key', { text: 'synthetic' },
    async () => { acquired++; return f.lease; }, { read: () => {}, send: () => {} }, f.local);
  try {
    const state = mode === 'lost-ack' ? 'accepted' : mode === 'reject' ? 'rejected' : 'outcome_unknown';
    assert.equal((await send()).state, state);
    if (mode === 'lost-ack') assert.deepEqual(((await f.recover())?.result?.body as any)?.admission,
      { createdAt: 123, queueVersion: 'opaque-version', disposition: 'waiting' });
    await f.rotate(); f.reopen();
    assert.equal((await send()).state, state);
    assert.equal(acquired, 1);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
    assert.equal(f.turns.list('codex').length, mode === 'lost-ack' ? 1 : 0);
  } finally { await f.close(); }
});

test('legacy unknown POST is never grafted to new authority or dispatched', async () => {
  const f = await fixture('local', 'codex', 'accept');
  try {
    const scope = JSON.stringify(['execution-v1', f.target.ownerUserId, f.target.userId, f.target.sessionId]);
    await f.hub.commands.claimAsync(scope, 'key', { text: 'synthetic' }, true);
    const before = f.calls.length;
    const result = await f.hub.executionCommands.send(f.target, 'key', { text: 'synthetic' },
      async () => { throw new Error('must not acquire'); }, { read: () => {}, send: () => { throw new Error('must not request send permission'); } }, f.local);
    assert.equal(result.state, 'outcome_unknown'); assert.equal(f.calls.length, before);
    assert.equal(f.hub.commands.authorityId(scope, 'key'), undefined);
    await assert.rejects(f.hub.executionCommands.queue(f.target, 'key', f.lease.nodeId, () => {}, f.local), /Historical command authority/);
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: queue reads retain the original issuer after rotation and reopen without acquiring or sending`, async () => {
  const f = await fixture(transport, 'codex', 'accept');
  try {
    await f.hub.executionCommands.send(f.target, 'key', { text: 'synthetic' }, async () => f.lease,
      { read: () => {}, send: () => {} }, f.local);
    const item = f.turns.head<any>('codex', f.lease.proof.resource.sessionKey!)!;
    await f.rotate(); f.reopen();
    const before = f.calls.length;
    const queue = () => f.hub.executionCommands.queue(f.target, 'key', f.lease.nodeId, () => {}, f.local);
    assert.deepEqual(await queue(), { presence: 'present', state: 'queued', createdAt: item.createdAt, version: f.turns.version('codex', item.sessionKey, item.id) });
    assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1)!.method, 'GET');
    f.turns.start('codex', item.sessionKey, item.id);
    assert.equal((await queue() as any).state, 'dispatching');
    f.turns.uncertain('codex', item.id);
    assert.equal((await queue() as any).state, 'outcome_unknown');
    assert.equal(f.calls.slice(before).every(call => call.method === 'GET' && call.path.endsWith('/queue')), true);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
    const beforeWrongNode = f.calls.length;
    await assert.rejects(f.hub.executionCommands.queue(f.target, 'key', `node_${randomUUID()}`, () => {}, f.local), /node changed/);
    assert.equal(f.calls.length, beforeWrongNode);
    f.tokens.revoke(f.first.record.id);
    await assert.rejects(queue());
  } finally { await f.close(); }
});

test('legacy accepted receipt without a runtime ID has unknown queue presence, not absence', async () => {
  const f = await fixture('local', 'codex');
  try {
    await f.claim(); f.accept();
    assert.deepEqual(await f.hub.executionCommands.queue(f.target, 'key', f.lease.nodeId, () => {}, f.local), { presence: 'unknown' });
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 0);
  } finally { await f.close(); }
});

test('logout after shared admission suppresses delivery while receipt and queue remain recoverable', async () => {
  const f = await fixture('local', 'openclaw', 'accept'); let loggedIn = true;
  const guard = () => { if (!loggedIn) throw new Error('login revoked'); };
  try {
    f.afterSend(() => { loggedIn = false; });
    await assert.rejects(f.hub.executionCommands.send(f.target, 'key', { text: 'synthetic' }, async () => f.lease,
      { read: guard, send: guard }, f.local), /login revoked/);
    assert.equal(f.turns.list('openclaw').length, 1);
    loggedIn = true; assert.equal((await f.recover(guard))?.state, 'accepted');
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
  } finally { await f.close(); }
});

test('shared send checks authority after acquire and invalid identity before acquiring', async () => {
  const f = await fixture('local', 'codex', 'accept');
  try {
    const before = f.calls.length;
    await assert.rejects(f.hub.executionCommands.send(f.target, 'invalid/key', {}, async () => { throw new Error('must not acquire'); },
      { read: () => {}, send: () => {} }, f.local), /Invalid command identity/);
    await assert.rejects(f.hub.executionCommands.send(f.target, 'key', {}, async () => { f.hub.executionLeases.revoke(f.lease.id); return f.lease; },
      { read: () => {}, send: () => {} }, f.local), /not current/);
    assert.equal(f.calls.length, before); assert.equal(await f.recover(), undefined);
    assert.equal(f.turns.list('codex').length, 0);
  } finally { await f.close(); }
});

test('shared command admission is bounded and shutdown cancels/drains acquiring requests without claiming', async () => {
  const f = await fixture('local', 'codex', 'accept');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const before = f.calls.length;
    const pending = Array.from({ length: 32 }, (_, index) => f.hub.executionCommands.send(f.target, 'key-' + index, {},
      async () => { await gate; return f.lease; }, { read: () => {}, send: () => {} }, f.local));
    const settled = Promise.allSettled(pending);
    await assert.rejects(f.recover(), /capacity reached/);
    const closed = f.hub.executionCommands.close(); release();
    await closed;
    assert.ok((await settled).every(result => result.status === 'rejected'));
    await assert.rejects(f.recover(), /closed/);
    assert.equal(f.calls.length, before); assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get()?.n, 0);
  } finally { release(); await f.close(); }
});

test('shared command shutdown aborts a held ACK but never cancels admitted queue work', async () => {
  const f = await fixture('local', 'codex', 'accept');
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    f.afterSend(async () => { entered(); await gate; });
    const sent = f.hub.executionCommands.send(f.target, 'key', { text: 'synthetic' }, async () => f.lease,
      { read: () => {}, send: () => {} }, f.local);
    const rejected = assert.rejects(sent, /closed/);
    await ready;
    const saved = f.db.prepare('SELECT * FROM command_receipts').get();
    const binding = f.hub.commands.binding(JSON.stringify(['execution-v1', f.target.ownerUserId, f.target.userId, f.target.sessionId]), 'key');
    let drained = false;
    const closing = f.hub.executionCommands.close().then(() => { drained = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(drained, false, 'close must not finish before the original dispatch ACK');
      assert.deepEqual(f.db.prepare('SELECT * FROM command_receipts').get(), saved);
    } finally { release(); }
    await closing; await rejected;
    assert.equal(f.turns.list('codex').length, 1);
    assert.equal(f.db.prepare('SELECT state FROM command_receipts').get()?.state, 'outcome_unknown');
    assert.deepEqual(f.db.prepare('SELECT * FROM command_receipts').get(), saved);
    f.reopen();
    const recovered = await f.recover();
    assert.equal(recovered?.state, 'accepted');
    assert.equal(recovered?.id, saved?.id);
    assert.deepEqual(f.hub.commands.binding(JSON.stringify(['execution-v1', f.target.ownerUserId, f.target.userId, f.target.sessionId]), 'key'), binding);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
  } finally { release(); await f.close(); }
});

test('usage migration backfills bound receipts once and reopen preserves quiet demand', async () => {
  const f = await fixture('local', 'codex');
  try {
    await f.claim(); f.accept(); await f.recover();
    // Reproduce the previous schema, with a historical bound receipt but no
    // usage columns. Only synthetic fixture data is altered.
    f.db.exec(`DROP TRIGGER hub_execution_command_claimed; DROP INDEX hub_execution_usage_due;
      ALTER TABLE hub_execution_leases DROP COLUMN usage_version;
      ALTER TABLE hub_execution_leases DROP COLUMN usage_pending;
      ALTER TABLE hub_execution_leases DROP COLUMN usage_after;`);
    f.reopen();
    const page = f.hub.executionLeases.usageDue();
    assert.equal(page.length, 1); assert.equal(page[0]!.lease.id, f.lease.id);
    assert.equal(f.hub.executionLeases.usageQuiet(f.lease.id, page[0]!.version), true);
    f.reopen();
    const row = f.db.prepare('SELECT usage_pending, usage_version FROM hub_execution_leases WHERE id = ?').get(f.lease.id);
    assert.equal(row?.usage_pending, 0); assert.equal(row?.usage_version, page[0]!.version);
    assert.deepEqual(f.hub.executionLeases.usageDue(), []);
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: Hub renews only actual queue use and retires quiet demand without browser activity`, async () => {
  const f = await fixture(transport, 'codex');
  let now = f.lease.expiresAt - 60_000;
  const u = f.createUsage(() => now);
  try {
    let initial = f.calls.length;
    assert.deepEqual(await u.usage.reconcile(), { examined: 0 });
    assert.equal(f.calls.length, initial, 'unused lease causes zero HTTP');
    await f.claim(); f.accept(); await f.recover(); f.enqueue(); now += 31_000; initial = f.calls.length;
    const first = u.usage.reconcile(); assert.equal(first, u.usage.reconcile()); await first;
    assert.deepEqual(f.calls.slice(initial).map(call => call.path.split('/').at(-1)), ['usage', 'execution-grants']);
    assert.equal(f.hub.executionLeases.get(f.lease.id)?.expiresAt, now + 60_000);
    assert.deepEqual(f.hub.executionLeases.get(f.lease.id)?.ref, f.lease.ref, 'renewal retains original execution authority');
    const afterRenew = f.calls.length;
    await u.usage.reconcile(); assert.equal(f.calls.length, afterRenew, 'durable probe interval');
    f.turns.complete('codex', 'pending'); now += 16_000;
    await u.usage.reconcile();
    assert.equal(f.calls.length, afterRenew + 1, 'quiet query does not renew');
    now += 16_000; await u.usage.reconcile();
    assert.equal(f.calls.length, afterRenew + 1, 'settled quiet demand is no longer polled');
  } finally { await u.close(); await f.close(); }
});

test('unknown in-transit command is probed but never renewed without queue use; expiry becomes revoking', async () => {
  const f = await fixture('local', 'openclaw');
  let now = f.lease.expiresAt - 60_000; const u = f.createUsage(() => now);
  try {
    await f.claim(); const before = f.calls.length;
    for (let i = 0; i < 3; i++) { await u.usage.reconcile(); now += 16_000; }
    assert.equal(f.calls.length, before + 3);
    assert.ok(f.calls.slice(before).every(call => call.path.endsWith('/usage')));
    assert.equal(f.hub.executionLeases.get(f.lease.id)?.expiresAt, f.lease.expiresAt);
    now = f.lease.expiresAt;
    await u.usage.reconcile();
    assert.equal(f.hub.executionLeases.get(f.lease.id)?.state, 'revoking');
    assert.equal(f.calls.length, before + 3, 'expired demand cannot be renewed/replaced');
    assert.equal((await f.recover())?.state, 'outcome_unknown');
  } finally { await u.close(); await f.close(); }
});

test('old quiet usage snapshot cannot clear a concurrently claimed command generation', async () => {
  const f = await fixture('local', 'codex');
  let now = f.lease.expiresAt - 60_000; const u = f.createUsage(() => now);
  try {
    await f.claim(); f.accept(); await f.recover();
    const scope = JSON.stringify(['execution-v1', f.target.ownerUserId, f.target.userId, f.target.sessionId]);
    f.afterUsage(async () => {
      await f.hub.commands.claimAsync(scope, 'second', {}, true, f.lease.id);
      f.hub.commands.settle(scope, 'second', { status: 200, body: {} });
      f.enqueue(); f.afterUsage(() => {});
    });
    await u.usage.reconcile(); now += 31_000;
    await u.usage.reconcile();
    assert.equal(f.hub.executionLeases.get(f.lease.id)?.expiresAt, now + 60_000);
    assert.equal(f.db.prepare('SELECT usage_version FROM hub_execution_leases WHERE id = ?').get(f.lease.id)!.usage_version, 2);
  } finally { await u.close(); await f.close(); }
});

test('failed usage and concurrent issuer rotation cannot renew or forget demand', async () => {
  const f = await fixture('local', 'codex');
  let now = f.lease.expiresAt - 29_000; const u = f.createUsage(() => now);
  try {
    await f.claim(); f.accept(); f.enqueue(); f.failUsage();
    const before = f.calls.length;
    await u.usage.reconcile();
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.hub.executionLeases.get(f.lease.id)?.expiresAt, f.lease.expiresAt);
    await u.usage.reconcile(); assert.equal(f.calls.length, before + 1);
    await f.rotate(); now += 16_000;
    const rotatedCalls = f.calls.length;
    await u.usage.reconcile();
    assert.equal(f.hub.executionLeases.get(f.lease.id)?.state, 'revoking');
    assert.equal(f.calls.length, rotatedCalls, 'retired demand does not probe or renew with new issuer');
  } finally { await u.close(); await f.close(); }
});

test('one issuer batches multiple lease probes and rechecks policy after usage response', async () => {
  const f = await fixture('local', 'codex');
  const now = f.lease.expiresAt - 29_000, u = f.createUsage(() => now);
  try {
    await f.claim(); f.accept(); f.enqueue();
    const second = await f.createLease();
    await f.hub.executionCommands.claim(f.target, 'second', {}, second.id);
    const before = f.calls.length;
    f.afterUsage(() => { f.hub.executionIssuers.disable('default', 'node'); });
    await u.usage.reconcile();
    assert.equal(f.calls.length, before + 1, 'two refs share one usage request');
    assert.equal(f.calls.at(-1)?.path.endsWith('/usage'), true);
    assert.equal(f.hub.executionLeases.get(f.lease.id)?.state, 'revoking');
    assert.equal(f.hub.executionLeases.get(second.id)?.state, 'revoking');
    assert.equal(f.hub.executionLeases.get(f.lease.id)?.expiresAt, f.lease.expiresAt);
  } finally { await u.close(); await f.close(); }
});

test('worker startup recovers persisted usage after Hub reopen without browser requests', async t => {
  const f = await fixture('local', 'openclaw');
  try {
    // Real SQLite/volume admission prepares the persisted demand. Its latency
    // is not the worker's startup latency; start the original watchdog only
    // once the reopened Hub and its persisted demand actually exist.
    await f.claim(); f.accept(); f.enqueue(); f.reopen();
    const now = f.lease.expiresAt - 29_000, u = f.createUsage(() => now);
    try {
      await t.test('startup reconciles persisted demand within the original deadline', { timeout: 3000 }, async () => {
        let complete!: () => void, deadline!: ReturnType<typeof setTimeout>;
        const finished = new Promise<void>(resolve => { complete = resolve; });
        const worker = new HubExecutionWorker(u.sync, 10, {
          reconcile: async () => { const page = await u.usage.reconcile(); complete(); return page; },
          close: () => u.usage.close(),
        });
        try {
          await Promise.race([finished, new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('Synthetic worker deadline')), 1000);
          })]);
          assert.equal(f.hub.executionLeases.get(f.lease.id)?.expiresAt, now + 60_000);
          assert.equal(f.calls.at(-1)?.path.endsWith('/execution-grants'), true);
        } finally { clearTimeout(deadline); await worker.close(); }
      });
    } finally { await u.close(); }
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: historical receipt survives issuer rotation and restart without dispatch`, async () => {
    const f = await fixture(transport, runtime);
    try {
      assert.equal((await f.claim()).fresh, true); f.accept();
      assert.equal((await f.claim()).fresh, false);
      await f.rotate();
      const fresh = await f.createLease(f.second.record.id);
      await assert.rejects(() => f.hub.executionCommands.claim(f.target, 'key', { text: 'synthetic' }, fresh.id), /cannot change/);
      f.reopen(); const before = f.calls.length;
      assert.equal((await f.recover())?.state, 'accepted');
      assert.equal(f.calls.length, before + 1);
      assert.equal(f.calls.at(-1)?.method, 'GET');
      assert.equal(f.calls.at(-1)?.actor, f.lease.ref!.actorId);
      assert.equal((await f.recover())?.state, 'accepted');
      assert.equal(f.calls.length, before + 1, 'settled receipt is local');
    } finally { await f.close(); }
  });
}

test('command provenance rejects cross-actor/owner/session claims and reads', async () => {
  const f = await fixture('local', 'codex');
  try {
    await f.claim(); f.accept(); const before = f.calls.length;
    for (const target of [{ ...f.target, userId: 'other' }, { ...f.target, ownerUserId: 'other' },
      { ...f.target, sessionId: encodeHubSessionId('other', 'codex:synthetic/空 格') },
      { ...f.target, sessionId: encodeHubSessionId('node', 'codex:other') }]) {
      await assert.rejects(() => f.hub.executionCommands.claim(target, 'key', {}, f.lease.id), /target mismatch/);
      assert.equal(await f.hub.executionCommands.recover(target, 'key', () => {}, f.local), undefined);
    }
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test('unbound historical uncertainty is never upgraded and inactive leases cannot claim new work', async () => {
  const f = await fixture('local', 'codex');
  try {
    const scope = JSON.stringify(['execution-v1', f.target.ownerUserId, f.target.userId, f.target.sessionId]);
    await f.hub.commands.claimAsync(scope, 'key', { text: 'synthetic' }, true);
    const before = f.calls.length;
    assert.equal((await f.recover())?.state, 'outcome_unknown');
    await assert.rejects(f.claim, /cannot change/);
    assert.equal(f.calls.length, before);
    f.hub.executionLeases.revoke(f.lease.id);
    await assert.rejects(() => f.hub.executionCommands.claim(f.target, 'new-key', {}, f.lease.id), /not current/);
    assert.equal(f.hub.commands.get(scope, 'new-key'), undefined);
    assert.equal(f.hub.commands.authorityId(scope, 'key'), undefined);
  } finally { await f.close(); }
});

for (const failure of ['issuer-revoked', 'wrong-pin', 'wrong-receipt', 'not-admitted', 'login-revoked'] as const) {
  test(`historical recovery stays unknown (${failure}), never dispatches or substitutes authority`, async () => {
    const f = await fixture('local', 'codex');
    try {
      await f.claim(); if (failure !== 'not-admitted') f.accept();
      if (failure === 'issuer-revoked') f.tokens.revoke(f.first.record.id);
      if (failure === 'wrong-pin') f.wrongPin();
      if (failure === 'wrong-receipt') f.corruptReply();
      let authorized = true;
      if (failure === 'login-revoked') f.afterRead(() => { authorized = false; });
      const before = f.calls.length;
      const recover = () => f.recover(() => { if (!authorized) throw new Error('login revoked'); });
      if (failure === 'login-revoked') await assert.rejects(recover, /login revoked/);
      else assert.equal((await recover())?.state, 'outcome_unknown');
      assert.equal(f.calls.length, before + 1);
      assert.equal(f.calls.at(-1)?.method, 'GET');
      assert.equal(f.db.prepare('SELECT state FROM command_receipts').get()!.state, 'outcome_unknown');
    } finally { await f.close(); }
  });
}
