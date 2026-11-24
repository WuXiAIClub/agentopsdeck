import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubSharedCommands } from './async-shared-commands.js';
import { AsyncHubExecutionLeases } from './async-execution-leases.js';
import { AsyncHubExecutionIssuers } from './async-execution-issuers.js';
import { HubExecutionSync } from './execution-sync.js';
import { encodeHubSessionId } from './session-id.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ExecutionGrants } from '../connector/execution-grants.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { resolveExecutionActor } from '../connector/execution-authority.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { CommandReceipts } from '../commands/receipts.js';
import { registerMessageReceipts } from '../commands/http.js';
import { TurnQueue, type TurnQueueCommit } from '../commands/turn-queue.js';
import { registerQueueRoutes } from '../connector/queue-http.js';
import { registerHubSharedCommandRoutes } from '../routes/hub-shared-commands.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { hubMemberEvidence, type HubMemberKind } from './member-owner-domain.js';

/** The seed is CLOSED before the worker starts. Every later fact mutation
 * closes/drains that original owner before reopening; never a second writer. */
async function fixture(ownerKind: 'worker' | 'original', transport: 'local' | 'http', runtime: 'codex' | 'openclaw') {
  const root = mkdtempSync(join(tmpdir(), 'async-shared-chain-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture-vault'), db = new DatabaseSync(':memory:');
  const alice = seed.createUser('Alice'), bob = seed.createUser('Bob');
  const administrator = seed.createUser('Lifecycle administrator');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(administrator.id);
  const administratorLogin = seed.identities.issueKey(administrator.id);
  const login = seed.identities.issueKey(bob.id), hubId = seed.identities.hubId;
  const ownerLogin = seed.identities.issueKey(alice.id);
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'));
  const token = tokens.create({ label: 'Fixture', delegationHubId: hubId, scopes: ['execution:delegate','messages:read','messages:send'] });
  const grants = new ExecutionGrants(db, id => !!tokens.delegationHubId(id));
  const receipts = new CommandReceipts(db), turns = new TurnQueue(db), nodeId = `node_${randomUUID()}`;
  const sessionKey = runtime === 'codex' ? 'codex:fixture/空 格' : 'agent:fixture/空 格';
  const connector = new Hono(), calls: string[] = [];
  let lost = false, blockedRead = false;
  let transformReply: ((request: Request, reply: Response) => Promise<Response>) | undefined;
  connector.use('*', async (c, next) => { c.header(NODE_ID_HEADER, nodeId); await next(); });
  registerExecutionGrantRoutes(connector, { nodeId, tokens, grants, turns });
  const actor = (request: Request, action?: 'messages:send') => resolveExecutionActor(request, { tokens, grants, nodeId }, { runtime, sessionKey }, action);
  const edit = (session: string, id: string, message: string, version?: string, commit?: TurnQueueCommit) =>
    turns.edit<any>(runtime, session, id, payload => ({ ...payload, message }), version, commit);
  const cancel = (session: string, id: string, version?: string, commit?: TurnQueueCommit) => turns.cancel(runtime, session, id, version, commit);
  const connectorPath = '/api/connector/v1/sessions/:sessionKey';
  registerQueueRoutes(connector, connectorPath, {
    actor: (c, action) => resolveExecutionActor(c.req.raw, { tokens, grants, nodeId }, { runtime, sessionKey }, action),
    users: { turns, commands: receipts } as any, store: { append() {} } as any,
    codex: { editQueued: edit, cancelQueued: cancel } as any, openclaw: { edit, cancel } as any,
  });
  registerMessageReceipts(connector, connectorPath, { receipts, isolatedDelivery: true,
    queue: (c, key) => turns.commandState(runtime, sessionKey, key, actor(c.req.raw).actorId),
    scope: c => {
      if (!tokens.requireScope(c.req.raw, c.req.method === 'POST' ? 'messages:send' : 'messages:read')) throw new HTTPException(403);
      return JSON.stringify([actor(c.req.raw).actorId, sessionKey]);
    },
  });
  connector.post(connectorPath + '/messages', async c => {
    const a = actor(c.req.raw, 'messages:send'), payload = await c.req.json(), key = c.get('commandDeliveryKey');
    const body = { ok: true, queued: true, idempotencyKey: key };
    turns.enqueue(runtime, { id: key, sessionKey, createdAt: Date.now(), payload: { ...payload, actorId: a.actorId, executionGrant: a.executionGrant } },
      receipts.queueCommit(JSON.stringify([a.actorId, sessionKey]), c.get('commandKey'), { status: 200, body }));
    return c.json(body);
  });
  const dispatch = async (request: Request) => {
    const path = new URL(request.url).pathname; calls.push(`${request.method} ${path}`);
    const reply = await connector.fetch(request);
    if (lost && request.method !== 'GET' && path.endsWith('/messages') || blockedRead && request.method === 'GET' && path.includes('/commands/')) {
      await reply.body?.cancel(); throw Error('fixture lost ACK');
    }
    return transformReply ? transformReply(request, reply) : reply;
  };
  const server = transport === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector.example.invalid';
  const local = server ? undefined : { connectionId: 'node', dispatch };
  const policy = { ownerUserId: alice.id, userId: bob.id, connectionId: 'node' }, resource = { runtime, sessionKey };
  seed.upsertConnection({ id: 'node', ownerUserId: alice.id, kind: server ? 'remote' : 'local', label: 'Fixture', connectorUrl: origin });
  seed.pinConnectionNode('node', alice.id, seed.connectionAuthority('node', alice.id)!, nodeId);
  await seed.executionIssuers.configure(alice.id, 'node', token.token, () => {}, local);
  const nodeVersion = seed.connectionAuthority('node', alice.id)!;
  const read = seed.grants.create(policy, { ...resource, actions: ['messages:read'] });
  const send = seed.grants.create(policy, { ...resource, actions: ['messages:send'] });
  seed.grants.create(policy, { ...resource, actions: ['queue:manage'] });
  await seed.close();
  const rows: string[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(line));
  let afterCommand: ((kind: HubMemberKind, input: unknown) => Promise<void>) | undefined;
  let original: HubStore | undefined;
  const open = () => {
    const owner = ownerKind === 'worker' ? new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault' }, diagnostics)
      : new OriginalHubAdministrativeCommands(original = new HubStore(file, 'fixture-vault'), diagnostics);
    const leases = new AsyncHubExecutionLeases(owner), issuers = new AsyncHubExecutionIssuers(owner, local);
    const sync = new HubExecutionSync(leases, hubId, lease => issuers.clientFor(lease), 32, Date.now, diagnostics);
    const sharedOwner: Pick<AsyncHubMemberOwner, 'command'> = { command: async (kind, input) => {
      const result = await owner.command(kind, input); await afterCommand?.(kind, input); return result;
    } };
    const shared = new AsyncHubSharedCommands(sharedOwner, sync, local, diagnostics);
    return { owner, sync, shared };
  };
  let services = open();
  const closeOwner = async () => {
    await services.shared.close(); await services.sync.close(); await services.owner.close(); await original?.close(); original = undefined;
  };
  const app = new Hono(), sessionId = encodeHubSessionId('node', sessionKey);
  const base = `/api/hub/v1/shared/${alice.id}/sessions/${encodeURIComponent(sessionId)}`;
  registerHubSharedCommandRoutes(app, {
    hubStore: new Proxy({} as HubStore, { get() { throw Error('synchronous route bypass'); } }),
    principal() { throw Error('synchronous HTTP principal bypass'); }, sync: undefined, local: undefined,
    asyncSharedCommands: { open: (request, target) => services.shared.open(request, target), close: () => services.shared.close() },
  });
  const request = (path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => app.request('http://hub.example.invalid' + base + path, {
    method, headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  calls.length = 0;
  return { calls, rows, policy, resource, read, send, turns, sessionKey, request, base, sessionId, login,
    shared: () => services.shared,
    reply: (transform?: typeof transformReply) => { transformReply = transform; },
    afterCommand: (hook?: typeof afterCommand) => { afterCommand = hook; },
    revokeRead: async () => {
      const evidence = hubMemberEvidence(new Request('http://hub.example.invalid', { headers: { authorization: `Bearer ${ownerLogin.token}` } }));
      const snapshot = await services.owner.command('memberSnapshot', evidence); assert.ok(snapshot);
      const result = await services.owner.command('grantChange', { evidence, expectedScope: snapshot.recoveryScope,
        command: { action: 'revoke', target: { ownerUserId: alice.id, connectionId: 'node' },
          id: read.id, version: read.version, nodeVersion } });
      assert.ok(result && !('error' in result), JSON.stringify(result));
    },
    disableMember: async () => {
      const evidence = hubMemberEvidence(new Request('http://hub.example.invalid', { headers: { authorization: `Bearer ${administratorLogin.token}` } }));
      const snapshot = await services.owner.command('memberSnapshot', evidence); assert.ok(snapshot);
      const result = await services.owner.command('userChange', { evidence, expectedScope: snapshot.recoveryScope,
        change: { action: 'accessChange', userId: bob.id, status: 'disabled', expectedVersion: 0 } });
      assert.deepEqual(result, { access: { userId: bob.id, status: 'disabled', version: 1 } });
    },
    post: (key: string, message = 'fixture') => request('/messages', 'POST', { message, idempotencyKey: key }),
    lose: () => { lost = true; blockedRead = true; }, recover: () => { lost = false; blockedRead = false; },
    mutate: async (fn: (s: HubStore) => void) => {
      await closeOwner(); const store = new HubStore(file, 'fixture-vault');
      try { fn(store); } finally { await store.close(); }
      services = open();
    },
    close: async () => {
      await closeOwner();
      if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
      db.close(); rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const owner of ['worker','original'] as const) for (const transport of ['local','http'] as const) {
  for (const revocation of ['grant', 'account'] as const) test(`${owner}/${transport}: queue projection ACK cannot deliver a page after ${revocation} revocation`, async () => {
    const f = await fixture(owner, transport, 'codex');
    try {
      assert.equal((await f.post('before-revoke', 'PRIVATE_QUEUED_TEXT')).status, 200);
      const mutations = () => f.calls.filter(call => !call.startsWith('GET ')).length;
      const before = mutations(); let projected = 0; let revokeError: unknown;
      f.afterCommand(async (kind, input) => {
        if (kind !== 'executionCommand' || (input as { command: { action: string } }).command.action !== 'pageProject') return;
        projected++;
        try { if (revocation === 'account') await f.disableMember(); else await f.revokeRead(); } catch (error) { revokeError = error; throw error; }
      });
      const response = await f.request('/queue');
      assert.equal(projected, 1);
      assert.equal(revokeError, undefined);
      assert.equal(response.status, revocation === 'account' ? 401 : 403);
      assert.equal((await response.text()).includes('PRIVATE_QUEUED_TEXT'), false);
      assert.equal(mutations(), before, 'read revocation must not dispatch a compensating write');
    } finally { f.afterCommand(); await f.close(); }
  });
}

for (const owner of ['worker','original'] as const) for (const transport of ['local','http'] as const) for (const runtime of ['codex','openclaw'] as const) {
  test(`${owner}/${transport}/${runtime}: six real shared routes use one async owner and original effects`, async () => {
    const f = await fixture(owner, transport, runtime);
    try {
      const empty = await f.request('/queue'); assert.equal(empty.status, 200);
      assert.deepEqual(await empty.json(), { availability: 'available', items: [], nextCursor: null }); assert.equal(f.calls.length, 0);
      assert.equal((await f.post('original')).status, 200);
      assert.equal((await f.post('original')).status, 200);
      assert.equal((await f.post('original', 'different')).status, 409);
      assert.equal(f.calls.filter(c => c.startsWith('POST ') && c.endsWith('/messages')).length, 1);
      const receipt = await f.request('/commands/original'); assert.equal(receipt.status, 200);
      assert.equal((await receipt.json() as any).command.key, 'original');
      const page = await f.request('/queue'); assert.equal(page.headers.get('cache-control'), 'no-store');
      const item = (await page.json() as any).items[0]; assert.equal(item.commandKey, 'original');
      const q = await f.request('/commands/original/queue'); assert.equal(q.status, 200);
      const version = (await q.json() as any).queue.version;
      const patch = () => f.request('/commands/original/queue', 'PATCH', { message: 'edited' }, { 'idempotency-key': 'edit', 'if-match': JSON.stringify(version) });
      assert.equal((await patch()).status, 200); assert.equal((await patch()).status, 200);
      assert.equal(f.calls.filter(c => c.startsWith('PATCH ')).length, 1);
      const edit = await f.request('/commands/original/queue/commands/edit'); assert.equal(edit.status, 200);
      assert.equal((await edit.json() as any).command.state, 'accepted');
      assert.equal(f.turns.head<any>(runtime, f.sessionKey)!.payload.message, 'edited');
      // Reopen the exact original database. Historical cancellation needs read
      // and queue management, but must not reacquire revoked send authority.
      await f.mutate(s => {
        s.grants.revoke(f.policy, f.send.id, 1);
        (s as unknown as { db: DatabaseSync }).db.prepare('UPDATE hub_execution_leases SET expires_at = 1').run();
      });
      const next = (await (await f.request('/commands/original/queue')).json() as any).queue.version;
      const cancel = () => f.request('/commands/original/queue', 'DELETE', undefined, { 'idempotency-key': 'cancel', 'if-match': JSON.stringify(next) });
      assert.equal((await cancel()).status, 200); assert.equal((await cancel()).status, 200);
      assert.equal(f.calls.filter(c => c.startsWith('DELETE ')).length, 1);
      assert.equal((await f.post('new')).status, 403);
      assert.ok(f.rows.some(line => JSON.parse(line).step === 89));
      assert.doesNotMatch(f.rows.join('\n'), new RegExp(f.login.token));
    } finally { await f.close(); }
  });
}

for (const owner of ['worker','original'] as const) test(`${owner}: unknown send ACK survives owner reopen; recovery is GET only`, async () => {
  const f = await fixture(owner, 'local', 'codex');
  try {
    f.lose(); assert.equal((await f.post('lost')).status, 202);
    const posts = f.calls.filter(c => c.startsWith('POST ')).length;
    await f.mutate(() => {}); f.recover();
    assert.equal((await f.post('lost')).status, 200);
    assert.equal(f.calls.filter(c => c.startsWith('POST ')).length, posts);
    const before = f.calls.length;
    await f.mutate(s => { s.grants.revoke(f.policy, f.read.id, 1); });
    assert.equal((await f.request('/commands/lost')).status, 404); assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

for (const owner of ['worker','original'] as const) for (const failure of ['oversized','malformed'] as const) {
  test(`${owner}/${failure}: untrusted send and queue ACKs stay unknown without fencing storage`, async () => {
    const f = await fixture(owner, 'local', 'codex');
    const corrupt = async (request: Request, reply: Response) => {
      const body = await reply.json() as any;
      if (body.command) {
        if (failure === 'oversized') {
          body.command.result = { status: 200, body: { ok: true, padding: 'x'.repeat(70 * 1024) } };
          // POST reconstructs its result from the top-level body. Queue writes
          // intentionally project only `ok`, so exceed the transport budget.
          if (request.method !== 'GET') body.padding = 'x'.repeat(request.method === 'POST' ? 70 * 1024 : 140 * 1024);
        }
        else body.command.createdAt = 'not-an-original-receipt';
      }
      return Response.json(body, { status: reply.status, headers: reply.headers });
    };
    try {
      f.reply(corrupt);
      assert.equal((await f.post('untrusted')).status, 202);
      assert.equal((await f.post('untrusted')).status, 202);
      assert.equal(f.calls.filter(c => c.startsWith('POST ') && c.endsWith('/messages')).length, 1);
      f.reply();
      assert.equal((await f.request('/commands/untrusted')).status, 200);
      const q = await f.request('/commands/untrusted/queue');
      const version = (await q.json() as any).queue.version;
      f.reply(corrupt);
      const patch = () => f.request('/commands/untrusted/queue', 'PATCH', { message: 'edited' }, {
        'idempotency-key': 'untrusted-edit', 'if-match': JSON.stringify(version),
      });
      assert.equal((await patch()).status, 202);
      assert.equal((await patch()).status, 202);
      assert.equal(f.calls.filter(c => c.startsWith('PATCH ')).length, 1);
      f.reply();
      assert.equal((await f.request('/commands/untrusted/queue/commands/untrusted-edit')).status, 200);
      assert.equal((await f.post('healthy')).status, 200, 'untrusted upstream ACK must not fence the database owner');
    } finally { f.reply(); await f.close(); }
  });
}

for (const owner of ['worker','original'] as const) test(`${owner}: close drains a held original effect and reopen recovers without replay`, { timeout: 30000 }, async () => {
  const f = await fixture(owner, 'local', 'codex');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  let pending: Promise<Response> | undefined, closing: Promise<void> | undefined;
  try {
    f.reply(async (request, reply) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/messages')) { entered(); await held; }
      return reply;
    });
    pending = Promise.resolve(f.post('held')); await started;
    let drained = false;
    closing = f.shared().close().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    assert.equal((await f.post('after-close')).status, 503);
    release();
    assert.equal((await pending).status, 503);
    await closing; f.reply();
    await f.mutate(() => {});
    assert.equal((await f.post('held')).status, 200);
    assert.equal(f.calls.filter(c => c.startsWith('POST ') && c.endsWith('/messages')).length, 1);
  } finally { release(); await pending; await closing; f.reply(); await f.close(); }
});

for (const owner of ['worker','original'] as const) test(`${owner}: cancelled original request cannot admit a shared mutation`, async () => {
  const f = await fixture(owner, 'local', 'codex');
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.shared().open(new Request('http://hub.example.invalid' + f.base, {
      headers: { authorization: `Bearer ${f.login.token}` }, signal: controller.signal,
    }), { ownerUserId: f.policy.ownerUserId, sessionId: f.sessionId }), (error: any) => error.status === 499);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.post('healthy')).status, 200);
  } finally { await f.close(); }
});
