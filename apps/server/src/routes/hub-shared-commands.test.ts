import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { MAX_MESSAGE_CHARS, MAX_TEXT_MESSAGE_BODY_BYTES } from '@agentopsdeck/shared';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { HubStore } from '../hub/hub-store.js';
import { HubExecutionSync } from '../hub/execution-sync.js';
import { createConnectorClientResolver } from '../hub/connector-client.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ExecutionGrants } from '../connector/execution-grants.js';
import { registerExecutionGrantRoutes } from '../connector/execution-grant-http.js';
import { resolveExecutionActor } from '../connector/execution-authority.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { CommandReceipts } from '../commands/receipts.js';
import { registerMessageReceipts } from '../commands/http.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { registerQueueRoutes } from '../connector/queue-http.js';
import type { TurnQueueCommit } from '../commands/turn-queue.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubConnectorReadServices } from '../hub/connector-read-services.js';

for (const ownerKind of ['sync-compatibility', 'async-original-production'] as const) describe(ownerKind, () => {

async function fixture(transport: 'local' | 'http' = 'local', runtime: 'codex' | 'openclaw' = 'codex', mirror = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-shared-api-'));
  const store = new HubStore(join(directory, 'hub.sqlite'), 'synthetic-vault'), remoteDb = new DatabaseSync(':memory:');
  const alice = store.createUser('Alice'), bob = store.createUser('Bob'), charlie = store.createUser('Charlie');
  const login = store.identities.issueKey(bob.id), otherLogin = store.identities.issueKey(charlie.id);
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'));
  const issuer = tokens.create({ label: 'Synthetic issuer', delegationHubId: store.identities.hubId,
    scopes: ['execution:delegate', 'messages:send', 'messages:read', ...(mirror ? ['messages:mirror' as const] : [])] });
  const grants = new ExecutionGrants(remoteDb, id => !!tokens.delegationHubId(id)), receipts = new CommandReceipts(remoteDb), turns = new TurnQueue(remoteDb);
  const nodeId = `node_${randomUUID()}`, sessionKey = runtime === 'codex' ? 'codex:synthetic/空 格'
    : mirror ? 'agent:synthetic:feishu:direct:original' : 'agent:synthetic/空 格';
  const connector = new Hono(), calls: string[] = [];
  let afterSend = () => {}, afterIssue = () => {}, lostSend = false, failedRead = false;
  let afterQueue = (response: Response) => response;
  let afterQueuePage: (response: Response) => Response | Promise<Response> = response => response;
  let lostMutation = false, afterMutation = () => {};
  let mutationReply = async (reply: Response) => reply;
  connector.use('*', async (c, next) => { c.header(NODE_ID_HEADER, nodeId); await next(); });
  registerExecutionGrantRoutes(connector, { tokens, grants, nodeId, turns });
  const edit = (session: string, id: string, message: string, version?: string, commit?: TurnQueueCommit) =>
    turns.edit<any>(runtime, session, id, payload => ({ ...payload, message }), version, commit);
  const cancel = (session: string, id: string, version?: string, commit?: TurnQueueCommit) => turns.cancel(runtime, session, id, version, commit);
  registerQueueRoutes(connector, '/api/connector/v1/sessions/:sessionKey', {
    actor: (c, action) => resolveExecutionActor(c.req.raw, { tokens, grants, nodeId }, { runtime, sessionKey: c.req.param('sessionKey')! }, action),
    users: { turns, commands: receipts } as any, store: { append() {} } as any,
    codex: { editQueued: edit, cancelQueued: cancel } as any, openclaw: { edit, cancel } as any,
  });
  registerMessageReceipts(connector, '/api/connector/v1/sessions/:sessionKey', { receipts, isolatedDelivery: true,
    queue: (c, key) => {
      const actor = resolveExecutionActor(c.req.raw, { tokens, grants, nodeId }, { runtime, sessionKey: c.req.param('sessionKey')! });
      return turns.commandState(runtime, sessionKey, key, actor.actorId);
    }, scope: c => {
    if (!tokens.requireScope(c.req.raw, c.req.method === 'POST' ? 'messages:send' : 'messages:read')) throw new HTTPException(403);
    const actor = resolveExecutionActor(c.req.raw, { tokens, grants, nodeId }, { runtime, sessionKey: c.req.param('sessionKey')! });
    return JSON.stringify([actor.actorId, c.req.param('sessionKey')]);
  } });
  connector.post('/api/connector/v1/sessions/:sessionKey/messages', async c => {
    const actor = resolveExecutionActor(c.req.raw, { tokens, grants, nodeId }, { runtime, sessionKey: c.req.param('sessionKey') }, 'messages:send');
    const body = { ok: true, queued: true, idempotencyKey: c.get('commandDeliveryKey') }, payload = await c.req.json();
    if (payload.deliveryMode === 'mirror') resolveExecutionActor(c.req.raw, { tokens, grants, nodeId }, { runtime, sessionKey }, 'messages:mirror');
    turns.enqueue(runtime, { id: c.get('commandDeliveryKey'), sessionKey, createdAt: Date.now(),
      payload: { ...payload, actorId: actor.actorId, executionGrant: actor.executionGrant } },
    receipts.queueCommit(JSON.stringify([actor.actorId, sessionKey]), c.get('commandKey'), { status: 200, body }));
    return c.json(body);
  });
  const dispatch = async (request: Request) => {
    const path = new URL(request.url).pathname; calls.push(`${request.method} ${path}`);
    let response = await connector.fetch(request);
    if (request.method === 'POST' && path.endsWith('/messages')) {
      afterSend(); if (lostSend) { await response.body?.cancel(); throw new Error('Synthetic lost ACK'); }
    }
    if (path.endsWith('/execution-grants')) afterIssue();
    if (path.endsWith('/queue')) response = afterQueue(response);
    if (path.endsWith('/queue/commands')) response = await afterQueuePage(response);
    if (['PATCH', 'DELETE'].includes(request.method) && path.endsWith('/queue')) {
      afterMutation(); if (lostMutation) { await response.body?.cancel(); throw new Error('Synthetic lost mutation ACK'); }
    }
    if (['PATCH', 'DELETE'].includes(request.method) && path.endsWith('/queue') || path.includes('/queue/commands/')) response = await mutationReply(response);
    if (failedRead && path.includes('/commands/')) { await response.body?.cancel(); throw new Error('Synthetic lost receipt'); }
    return response;
  };
  const remote = transport === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (remote && !remote.listening) await new Promise<void>(resolve => remote.once('listening', resolve));
  const connectorUrl = remote ? `http://127.0.0.1:${(remote.address() as { port: number }).port}` : 'http://connector.example.invalid';
  const connection = { id: 'node', ownerUserId: alice.id, kind: transport === 'local' ? 'local' as const : 'remote' as const, label: 'Synthetic', connectorUrl };
  store.upsertConnection(connection); store.pinConnectionNode('node', alice.id, store.connectionAuthority('node', alice.id)!, nodeId);
  const local = transport === 'local' ? { connectionId: 'node', dispatch } : undefined;
  await store.executionIssuers.configure(alice.id, 'node', issuer.token, () => {}, local);
  const sync = new HubExecutionSync(store.executionLeases, store.identities.hubId, lease => store.executionIssuers.clientFor(lease, local));
  const policyTarget = { ownerUserId: alice.id, connectionId: 'node', userId: bob.id }, resource = { runtime, sessionKey };
  const read = store.grants.create(policyTarget, { ...resource, actions: ['messages:read'] });
  const send = store.grants.create(policyTarget, { ...resource, actions: ['messages:send', ...(mirror ? ['messages:mirror' as const] : [])] });
  const owner = ownerKind === 'async-original-production' ? new OriginalHubAdministrativeCommands(store) : undefined;
  const services = owner ? createHubConnectorReadServices(owner, local ? { ...local, token: 'synthetic-local' } : undefined, undefined, sync) : undefined;
  const app = new Hono(), routes = registerHubRoutes(app, {
    config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: store, connectorClient: createConnectorClientResolver(store),
    normalizeError: () => 'Synthetic', principal: request => store.identities.keyPrincipal(request.headers.get('authorization')?.slice(7)),
    executionSync: sync, ...(local ? { localIssuerTransport: local } : {}),
    ...(services ? { asyncSharedCommands: services.sharedCommands, asyncSharedReads: services.sharedReads,
      asyncSharedDirectory: services.directory, asyncConnectorClient: services.connector } : {}),
  });
  const server = transport === 'http' ? serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://hub.example.invalid';
  const sessionId = encodeHubSessionId('node', sessionKey), base = `/api/hub/v1/shared/${alice.id}/sessions/${encodeURIComponent(sessionId)}`;
  const request = async (path: string, method = 'GET', body?: unknown, token = login.token, headers?: Record<string, string>) => {
    const init = { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    try { return await (server ? fetch(origin + path, init) : app.request(origin + path, init)); }
    catch (error) {
      // No URL, token or arbitrary exception text in evidence; preserve the
      // original error and nested transport cause for the test reporter.
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'unknown';
      throw new Error(`Fixture ${method} failed (body=${body !== undefined}, transport=${/^[A-Z0-9_]{1,64}$/.test(code) ? code : 'unknown'})`, { cause: error });
    }
  };
  calls.length = 0;
  return { store, turns, grants, tokens, issuer, nodeId, app, base, sessionKey, sessionId, runtime, connection, policyTarget, resource, read, send, alice, bob, charlie, login, otherLogin, calls,
    request, post: (key = 'key', message = 'synthetic') => request(base + '/messages', 'POST', { idempotencyKey: key, message }),
    afterSend: (fn: typeof afterSend) => { afterSend = fn; }, afterIssue: (fn: typeof afterIssue) => { afterIssue = fn; },
    afterQueue: (fn: typeof afterQueue) => { afterQueue = fn; },
    afterQueuePage: (fn: typeof afterQueuePage) => { afterQueuePage = fn; },
    async rotateIssuer() {
      const next = tokens.create({ label: 'Rotated synthetic issuer', delegationHubId: store.identities.hubId,
        scopes: ['execution:delegate', 'messages:read', 'messages:send'] });
      await store.executionIssuers.configure(alice.id, 'node', next.token, () => {}, local);
      return next;
    },
    async queueReopened(cursor?: string) {
      const reopened = new HubStore(join(directory, 'hub.sqlite'), 'synthetic-vault');
      try {
        return await reopened.executionCommands.queuePage({ ownerUserId: alice.id, userId: bob.id, sessionId }, nodeId, cursor,
          () => { assert.ok(reopened.grants.authorize(policyTarget, 'messages:read', resource)); }, local);
      } finally { await reopened.executionCommands.close(); await reopened.executionIssuers.close(); reopened.close(); }
    },
    afterMutation: (fn: typeof afterMutation) => { afterMutation = fn; },
    mutationReply: (fn: typeof mutationReply) => { mutationReply = fn; },
    loseMutationAck: () => { lostMutation = true; failedRead = true; },
    async recoverReopened(commandKey: string, mutationKey: string) {
      const reopened = new HubStore(join(directory, 'hub.sqlite'), 'synthetic-vault');
      try {
        return await reopened.executionCommands.recoverQueueMutation({ ownerUserId: alice.id, userId: bob.id, sessionId }, commandKey, mutationKey, nodeId,
          () => { assert.ok(reopened.grants.authorize(policyTarget, 'messages:read', resource)); }, local);
      } finally { await reopened.executionCommands.close(); await reopened.executionIssuers.close(); reopened.close(); }
    },
    loseAck: () => { lostSend = true; failedRead = true; }, allowRead: () => { failedRead = false; },
    async close() {
      await routes?.close(); await services?.close(); await owner?.close();
      await Promise.all([sync.close(), store.executionCommands.close()]); await store.executionIssuers.close();
      for (const listener of [server, remote]) if (listener) {
        if ('closeAllConnections' in listener) listener.closeAllConnections();
        await new Promise<void>(resolve => listener.close(() => resolve()));
      }
      store.close(); remoteDb.close(); rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: shared queue pages cover historical issuers with GET-only bounded actor reads`, async () => {
    const f = await fixture(transport, runtime);
    const queuePath = f.base + '/queue';
    const all = async () => {
      const pages: any[] = []; let cursor: string | null = null;
      do {
        assert.ok(pages.length < 5, 'bounded fixture must terminate');
        const response = await f.request(queuePath + (cursor === null ? '' : `?cursor=${cursor}`));
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        const page = await response.json() as any; pages.push(page); cursor = page.nextCursor;
      } while (cursor !== null);
      return pages;
    };
    try {
      assert.deepEqual(await all(), [{ availability: 'available', items: [], nextCursor: null }]);
      assert.equal(f.calls.length, 0, 'no acknowledged authority is not a reason to acquire one');
      assert.equal((await f.post('old')).status, 200);
      const stranger = { ...f.policyTarget, userId: f.charlie.id };
      f.store.grants.create(stranger, { ...f.resource, actions: ['messages:read', 'messages:send'] });
      assert.equal((await f.request(f.base + '/messages', 'POST', { message: 'other actor', idempotencyKey: 'old' }, f.otherLogin.token)).status, 200);
      await f.rotateIssuer();
      assert.equal((await f.post('new')).status, 404, 'credential rotation requires explicit owner reauthorization');
      assert.ok(f.store.grants.replace(f.policyTarget, f.read.id, 1, { ...f.resource, actions: ['messages:read'] }));
      assert.ok(f.store.grants.replace(f.policyTarget, f.send.id, 1, { ...f.resource, actions: ['messages:send'] }));
      f.store.grants.create(stranger, { ...f.resource, actions: ['messages:read'] });
      assert.equal((await f.post('new')).status, 200);
      const before = f.calls.length, pages = await all();
      assert.equal(pages.length, 2);
      assert.deepEqual(pages.flatMap(page => page.items.map((item: any) => item.commandKey)).sort(), ['new', 'old']);
      assert.ok(pages.every(page => page.availability === 'available' && page.items.length === 1 && page.items[0].commandState === 'accepted'));
      assert.equal(f.calls.length - before, 2, 'one upstream GET per historical actor page, not one per command');
      assert.ok(f.calls.slice(before).every(call => call.startsWith('GET ') && call.endsWith('/queue/commands')));
      assert.doesNotMatch(JSON.stringify(pages), /cmd_|actor_|idempotencyKey|issuer|synthetic|other actor/);
      assert.deepEqual(await f.queueReopened(), pages[0]);
      const foreign = await f.request(queuePath + `?cursor=${pages[0].nextCursor}`, 'GET', undefined, f.otherLogin.token);
      assert.notEqual(foreign.status, 200, 'cursor cannot cross an authenticated actor');
      for (const cursor of ['1:-1', '0:0', '1:01', '9007199254740992:0', 'garbage']) assert.equal((await f.request(queuePath + `?cursor=${cursor}`)).status, 400);
      f.tokens.revoke(f.issuer.record.id);
      const afterRevoke = f.calls.length, partial = await all();
      assert.equal(partial.filter(page => page.availability === 'unavailable').length, 1);
      assert.deepEqual(partial.flatMap(page => page.items.map((item: any) => item.commandKey)), ['new']);
      assert.equal(f.calls.length - afterRevoke, 2, 'unavailable old issuer does not hide another actor page or trigger renewal');
    } finally { await f.close(); }
  });

  test(`${transport}/${runtime}: shared queue pagination preserves unknown admission and strips untrusted metadata`, async () => {
    const f = await fixture(transport, runtime);
    try {
      // These responses are intentionally status-only, but still own real
      // HTTP bodies. Drain before the next request rather than relying on GC.
      for (let index = 0; index < 65; index++) {
        const response = await f.post(`page-${index}`);
        assert.equal(response.status, 200); await response.arrayBuffer();
      }
      f.loseAck(); const unknown = await f.post('unknown');
      assert.equal(unknown.status, 202); await unknown.arrayBuffer();
      const before = f.calls.length, first = await (await f.request(f.base + '/queue')).json() as any;
      assert.equal(first.items.length, 64); assert.equal(first.items[0].commandKey, 'page-0');
      const second = await (await f.request(f.base + `/queue?cursor=${first.nextCursor}`)).json() as any;
      assert.equal(second.nextCursor, null);
      assert.deepEqual(second.items.map((item: any) => [item.commandKey, item.commandState]), [['page-64', 'accepted'], ['unknown', 'outcome_unknown']]);
      assert.equal(f.calls.length - before, 2, 'listing does not recover or fabricate the original unknown receipt');
      f.allowRead();
      assert.deepEqual(await f.queueReopened(first.nextCursor), second);
      f.afterQueuePage(async response => {
        const body = await response.json() as any;
        return Response.json({ ...body, secret: 'private', items: body.items.map((item: any) => ({ ...item, secret: 'private' })) }, { headers: { [NODE_ID_HEADER]: f.nodeId } });
      });
      assert.deepEqual(await (await f.request(f.base + '/queue')).json(), first);
      for (const corrupt of [(body: any) => { body.nextCursor = '0'; }, (body: any) => { body.items.push(body.items[0]); },
        (body: any) => { body.items[1].commandKey = body.items[0].commandKey; }, (body: any) => { body.items[0].version = '0:1'; },
        (body: any) => { body.items[0].createdAt = 1.5; }, (body: any) => { body.items[0].state = 'idle'; }]) {
        f.afterQueuePage(async response => {
          const body = await response.json() as any; corrupt(body);
          return Response.json(body, { headers: { [NODE_ID_HEADER]: f.nodeId } });
        });
        assert.deepEqual(await (await f.request(f.base + '/queue')).json(), { availability: 'unavailable', items: [], nextCursor: null });
      }
      f.afterQueuePage(async response => {
        const body = await response.json() as any; body.items[0].commandKey = 'foreign_downstream';
        return Response.json(body, { headers: { [NODE_ID_HEADER]: f.nodeId } });
      });
      const unmapped = await (await f.request(f.base + '/queue')).json() as any;
      assert.deepEqual(unmapped.items[0], { ...first.items[0], commandKey: null, commandState: null });
      assert.doesNotMatch(JSON.stringify(unmapped), /foreign_downstream/);
      f.afterQueuePage(response => { f.store.grants.revoke(f.policyTarget, f.read.id, 1); return response; });
      assert.equal((await f.request(f.base + '/queue')).status, 403, 'post-await read revocation prevents delivery');
    } finally { await f.close(); }
  });

  test(`${transport}/${runtime}: shared queue mutations retain original authority, isolate keys and recover lost ACK without redispatch`, async () => {
    const f = await fixture(transport, runtime);
    try {
      assert.equal((await f.post('original')).status, 200);
      const original = f.turns.head<any>(runtime, f.sessionKey)!, version = f.turns.version(runtime, f.sessionKey, original.id)!;
      const base = `${f.base}/commands/original/queue`;
      const mutation = (key: string, observed = version, method = 'PATCH') => f.request(base, method, method === 'PATCH' ? { message: 'edited' } : undefined,
        f.login.token, { 'idempotency-key': key, 'if-match': JSON.stringify(observed) });
      assert.equal((await mutation('denied')).status, 403, 'issuer messages:send does not confer queue management');
      const manage = f.store.grants.create(f.policyTarget, { ...f.resource, actions: ['queue:manage'] });
      assert.equal((await f.request(base, 'PATCH', { message: 'bad', messageId: 'forged' }, f.login.token,
        { 'idempotency-key': 'bad', 'if-match': JSON.stringify(version) })).status, 400);
      assert.equal((await f.request(base, 'DELETE', undefined, f.login.token, { 'idempotency-key': 'missing-version' })).status, 428);
      f.loseMutationAck();
      const changed = await mutation('edit'); assert.equal(changed.status, 202);
      assert.equal(changed.headers.get('cache-control'), 'no-store');
      assert.equal((await changed.json() as any).command.state, 'outcome_unknown');
      assert.equal(f.turns.head<any>(runtime, f.sessionKey)!.payload.message, 'edited');
      const current = f.turns.version(runtime, f.sessionKey, original.id)!;
      const before = f.calls.length;
      assert.equal((await mutation('edit')).status, 202);
      assert.equal((await mutation('edit', current)).status, 409, 'same mutation key cannot change observed version');
      assert.equal(f.calls.slice(before).every(call => call.startsWith('GET ')), true);
      assert.equal(f.turns.version(runtime, f.sessionKey, original.id), current);
      assert.equal(f.calls.filter(call => call.startsWith('PATCH ')).length, 1);
      assert.equal(f.calls.some(call => call.includes('/commands/original/queue')), false, 'Hub does not forward browser command identity');
      f.allowRead();
      const beforeReopen = f.calls.length;
      assert.equal((await f.recoverReopened('original', 'edit'))?.state, 'accepted');
      assert.equal(f.calls.slice(beforeReopen).every(call => call.startsWith('GET ')), true, 'reopened Hub only queries the saved original authority');
      const receipt = await f.request(`${base}/commands/edit`);
      assert.equal(receipt.status, 200);
      const recovered = (await receipt.json() as any).command;
      assert.equal(recovered.key, 'edit'); assert.equal(recovered.state, 'accepted'); assert.deepEqual(recovered.result.body, { ok: true });
      assert.equal((await mutation('stale')).status, 412);
      assert.equal((await (await f.request(`${base}/commands/stale`)).json() as any).command.state, 'rejected');
      const stranger = { ...f.policyTarget, userId: f.charlie.id };
      f.store.grants.create(stranger, { ...f.resource, actions: ['messages:read', 'messages:send', 'queue:manage'] });
      assert.equal((await f.request(`${base}/commands/edit`, 'GET', undefined, f.otherLogin.token)).status, 404);
      assert.equal((await f.request(base, 'DELETE', undefined, f.otherLogin.token, { 'idempotency-key': 'edit', 'if-match': JSON.stringify(current) })).status, 409);
      f.store.grants.revoke(f.policyTarget, f.send.id, 1);
      assert.equal((await mutation('no-longer-send', current)).status, 403);
      const beforeCancel = f.calls.length;
      assert.equal((await mutation('cancel', current, 'DELETE')).status, 200, 'cancel original unstarted item without send grant');
      assert.equal(f.turns.head(runtime, f.sessionKey), undefined);
      assert.equal(f.calls.slice(beforeCancel).some(call => call.startsWith('POST ')), false, 'no fresh grant acquisition');
      f.store.grants.revoke(f.policyTarget, manage.id, 1);
      const beforeReplay = f.calls.length;
      assert.equal((await mutation('cancel', current, 'DELETE')).status, 200, 'known replay is not a fresh write');
      assert.equal((await (await f.request(`${base}/commands/cancel`)).json() as any).command.state, 'accepted');
      assert.equal(f.calls.slice(beforeReplay).every(call => call.startsWith('GET ')), true);
      assert.equal(f.calls.filter(call => call.startsWith('DELETE ')).length, 1);
    } finally { await f.close(); }
  });
}

test('shared queue malformed receipts stay unknown, concurrent duplicates dispatch once and revoked issuer cannot recover', async () => {
  const f = await fixture();
  try {
    f.store.grants.create(f.policyTarget, { ...f.resource, actions: ['queue:manage'] });
    assert.equal((await f.post('original')).status, 200);
    const item = f.turns.head('codex', f.sessionKey)!, version = f.turns.version('codex', f.sessionKey, item.id)!;
    const path = `${f.base}/commands/original/queue`, headers = { 'idempotency-key': 'edit', 'if-match': JSON.stringify(version) };
    f.mutationReply(async response => {
      const body = await response.json() as any;
      return Response.json({ ...body, command: { ...body.command, key: 'wrong-delivery-key',
        result: { status: 200, body: { ok: true, private: 'must-not-leak' } } } }, { status: response.status, headers: response.headers });
    });
    const replies = await Promise.all([1, 2, 3].map(() => f.request(path, 'PATCH', { message: 'edited' }, f.login.token, headers)));
    for (const response of replies) {
      assert.equal(response.status, 202);
      assert.equal((await response.text()).includes('must-not-leak'), false);
    }
    assert.equal(f.calls.filter(call => call.startsWith('PATCH ')).length, 1);
    f.mutationReply(async response => response);
    f.tokens.revoke(f.issuer.record.id);
    assert.equal((await (await f.request(`${path}/commands/edit`)).json() as any).command.state, 'outcome_unknown');
    assert.equal((await f.request(path, 'PATCH', { message: 'edited' }, f.login.token, headers)).status, 202);
    assert.equal(f.calls.filter(call => call.startsWith('PATCH ')).length, 1);
  } finally { await f.close(); }
});

test('shared queue unknown original cannot be mutated and post-delivery read revocation suppresses response', async () => {
  const f = await fixture();
  try {
    f.store.grants.create(f.policyTarget, { ...f.resource, actions: ['queue:manage'] });
    f.loseAck(); assert.equal((await f.post('original')).status, 202);
    const queued = f.turns.head('codex', f.sessionKey)!, version = f.turns.version('codex', f.sessionKey, queued.id)!;
    const base = `${f.base}/commands/original/queue`, headers = { 'idempotency-key': 'edit', 'if-match': JSON.stringify(version) };
    assert.equal((await f.request(base, 'PATCH', { message: 'edited' }, f.login.token, headers)).status, 409);
    assert.equal(f.calls.some(call => call.startsWith('PATCH ')), false);
    f.allowRead(); assert.equal((await (await f.request(`${f.base}/commands/original`)).json() as any).command.state, 'accepted');
    f.afterMutation(() => { f.store.grants.revoke(f.policyTarget, f.read.id, 1); });
    assert.equal((await f.request(base, 'PATCH', { message: 'edited' }, f.login.token, headers)).status, 403);
    assert.equal(f.turns.head<any>('codex', f.sessionKey)!.payload.message, 'edited');
    f.store.grants.create(f.policyTarget, { ...f.resource, actions: ['messages:read'] });
    assert.equal((await (await f.request(`${base}/commands/edit`)).json() as any).command.state, 'accepted');
    assert.equal(f.calls.filter(call => call.startsWith('PATCH ')).length, 1);
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${transport}/${runtime}: authenticated shared HTTP commands delegate once and recover without a send grant`, async () => {
    const f = await fixture(transport, runtime);
    try {
      const replies = await Promise.all([f.post(), f.post()]);
      for (const response of replies) {
        // The duplicate may read while the original is awaiting admission.
        assert.ok([200, 202].includes(response.status)); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json() as any).command.state, response.status === 200 ? 'accepted' : 'outcome_unknown');
      }
      assert.equal((await (await f.request(f.base + '/commands/key')).json() as any).command.state, 'accepted');
      assert.equal(f.calls.filter(call => call.startsWith('POST') && call.endsWith('/messages')).length, 1);
      const queue = f.turns.list<{ actorId: string; executionGrant: { actorId: string } }>(runtime, f.sessionKey); assert.equal(queue.length, 1);
      assert.equal(queue[0]!.payload.executionGrant?.actorId, queue[0]!.payload.actorId);
      assert.notEqual(queue[0]!.id, 'key');
      assert.equal((await f.post('key', 'changed')).status, 409);
      f.store.grants.revoke(f.policyTarget, f.send.id, 1);
      const count = f.calls.length;
      assert.equal((await f.post()).status, 200, 'known receipt does not acquire or require fresh send');
      assert.equal((await f.request(f.base + '/commands/key')).status, 200);
      assert.equal(f.calls.length, count);
      assert.equal((await f.post('new')).status, 403);
      assert.equal((await f.request(`/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}/commands/key`)).status, 404, 'ordinary owner routes stay closed');
      assert.equal((await f.request(f.base + '/commands/key', 'GET', undefined, f.otherLogin.token)).status, 404);
    } finally { await f.close(); }
  });
}

test('shared HTTP lost ACK keeps historical authority and never retries a POST after policy change', async () => {
  const f = await fixture();
  try {
    f.loseAck();
    assert.equal((await f.post()).status, 202);
    assert.equal((await f.post()).status, 202);
    f.store.grants.revoke(f.policyTarget, f.send.id, 1); f.allowRead();
    const recovered = await f.request(f.base + '/commands/key');
    assert.equal((await recovered.json() as any).command.state, 'accepted');
    assert.equal((await f.post()).status, 200);
    assert.equal(f.calls.filter(call => call.startsWith('POST') && call.endsWith('/messages')).length, 1);
    assert.equal(f.turns.list(f.runtime, f.sessionKey).length, 1);
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: shared attachments bind original bytes and recover without replay after revocation`, async () => {
  const f = await fixture(transport);
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);
  const media = [{ type: 'image', name: 'shared.png', mimeType: 'image/png', size: bytes.length, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }];
  const payload = { message: '', media, idempotencyKey: 'attachment-original' };
  try {
    f.loseAck();
    assert.equal((await f.request(f.base + '/messages', 'POST', payload)).status, 202);
    const queue = f.turns.list<{ media: unknown[]; actorId: string; executionGrant: { actorId: string } }>(f.runtime, f.sessionKey);
    assert.equal(queue.length, 1); assert.deepEqual(queue[0]!.payload.media, media);
    assert.equal(queue[0]!.payload.actorId, queue[0]!.payload.executionGrant.actorId);
    const changed = { ...payload, media: [{ ...media[0], name: 'different.png' }] };
    assert.equal((await f.request(f.base + '/messages', 'POST', changed)).status, 409);
    f.store.grants.revoke(f.policyTarget, f.send.id, 1); f.allowRead();
    assert.equal((await f.request(f.base + '/commands/attachment-original')).status, 200);
    assert.equal((await f.request(f.base + '/messages', 'POST', payload)).status, 200);
    assert.equal((await f.request(f.base + '/messages', 'POST', { ...payload, idempotencyKey: 'fresh-attachment' })).status, 403);
    assert.equal(f.calls.filter(call => call.startsWith('POST') && call.endsWith('/messages')).length, 1);
    assert.equal(f.turns.list(f.runtime, f.sessionKey).length, 1);
  } finally { await f.close(); }
});

test('shared attachments revoked while acquiring lease never dispatch', async () => {
  const f = await fixture();
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);
  try {
    f.afterIssue(() => { f.store.grants.revoke(f.policyTarget, f.send.id, 1); });
    assert.equal((await f.request(f.base + '/messages', 'POST', { message: '', idempotencyKey: 'revoke-image', media: [
      { type: 'image', name: 'shared.png', mimeType: 'image/png', size: bytes.length, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` },
    ] })).status, 503); // Lease ACK changed mid-issuance: no proven admission, not a fabricated rejection.
    assert.equal(f.calls.filter(call => call.endsWith('/messages')).length, 0);
    assert.equal(f.turns.list(f.runtime, f.sessionKey).length, 0);
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) test(`${transport}/${runtime}: shared queue observes only the original command without new execution authority`, async () => {
  const f = await fixture(transport, runtime);
  try {
    const path = f.base + '/commands/key/queue';
    assert.equal((await f.request(path)).status, 404); assert.equal(f.calls.length, 0);
    assert.equal((await f.post()).status, 200);
    const item = f.turns.head<any>(runtime, f.sessionKey)!;
    const before = f.calls.length;
    const queued = await f.request(path);
    assert.equal(queued.status, 200); assert.equal(queued.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await queued.json(), { commandKey: 'key', queue: { presence: 'present', state: 'queued', createdAt: item.createdAt, version: f.turns.version(runtime, f.sessionKey, item.id) } });
    assert.equal(f.calls.length, before + 1); assert.match(f.calls.at(-1)!, /^GET .*\/commands\/.*\/queue$/);
    const unknownPath = f.base + '/commands/other/queue';
    assert.equal((await f.request(unknownPath)).status, 404);
    // Another reader cannot query Bob's commands despite knowing his key.
    f.store.grants.create({ ...f.policyTarget, userId: f.charlie.id }, { ...f.resource, actions: ['messages:read'] });
    assert.equal((await f.request(path, 'GET', undefined, f.otherLogin.token)).status, 404);
    assert.equal(f.calls.length, before + 1);
    f.store.grants.revoke(f.policyTarget, f.send.id, 1);
    f.grants.revoke(f.issuer.record.id, item.payload.executionGrant.id);
    f.turns.block(runtime, item.id);
    assert.equal((await (await f.request(path)).json() as any).queue.state, 'blocked');
    f.turns.complete(runtime, item.id);
    const absent = await f.request(path);
    assert.deepEqual(await absent.json(), { commandKey: 'key', queue: { presence: 'absent' } });
    assert.equal((await (await f.request(f.base + '/commands/key')).json() as any).command.state, 'accepted', 'queue absence does not settle an execution outcome');
    assert.equal(f.calls.filter(call => call.startsWith('POST') && call.endsWith('/messages')).length, 1);
    assert.equal(f.calls.filter(call => call.startsWith('POST') && call.endsWith('/execution-grants')).length, 1);
  } finally { await f.close(); }
});

test('shared queue fails closed on changed proof, login, issuer and malformed upstream observations', async () => {
  for (const change of ['read', 'login', 'issuer', 'identity', 'state', 'metadata', 'version'] as const) {
    const f = await fixture();
    try {
      await f.post();
      if (change === 'issuer') f.tokens.revoke(f.issuer.record.id);
      f.afterQueue(response => {
        if (change === 'read') { f.store.grants.revoke(f.policyTarget, f.read.id, 1); f.store.grants.create(f.policyTarget, { ...f.resource, actions: ['messages:read'] }); }
        if (change === 'login') f.store.identities.revokeKey(f.bob.id, f.login.id);
        if (['identity', 'state', 'metadata', 'version'].includes(change)) {
          void response.body?.cancel();
          const upstreamKey = f.calls.at(-1)!.split('/').at(-2)!;
          return Response.json({ commandKey: change === 'identity' ? 'wrong' : upstreamKey,
            queue: { presence: 'present', state: change === 'state' ? 'completed' : 'queued', createdAt: change === 'metadata' ? -1 : 1,
              ...(change === 'version' ? { version: { unexpected: 'data' } } : {}),
              payload: 'must-not-leak' } }, { headers: response.headers });
        }
        return response;
      });
      const response = await f.request(f.base + '/commands/key/queue');
      assert.equal(response.status, change === 'read' ? 403 : change === 'login' ? 401 : 503);
      assert.doesNotMatch(await response.text(), /must-not-leak|synthetic|completed/);
      assert.equal(f.turns.list(f.runtime).length, 1);
      assert.equal(f.calls.filter(call => call.startsWith('POST') && call.endsWith('/messages')).length, 1);
    } finally { await f.close(); }
  }
});

test('a lost admission ACK cannot turn a failed queue lookup into completion or redispatch', async () => {
  const f = await fixture();
  try {
    f.loseAck(); assert.equal((await f.post()).status, 202);
    const path = f.base + '/commands/key/queue';
    assert.equal((await f.request(path)).status, 503);
    f.allowRead();
    assert.equal((await (await f.request(path)).json() as any).queue.presence, 'present');
    const scope = JSON.stringify(['execution-v1', f.alice.id, f.bob.id, f.sessionId]);
    assert.equal(f.store.commands.get(scope, 'key')!.state, 'outcome_unknown', 'queue observation does not overwrite admission receipt');
    assert.equal(f.calls.filter(call => call.startsWith('POST') && call.endsWith('/messages')).length, 1);
  } finally { await f.close(); }
});

test('shared HTTP rejects caller provenance, unsupported controls/media and malformed identity before issuing', async () => {
  const f = await fixture();
  try {
    for (const body of [null, [], {}, { message: 'test' }, { message: 'test', idempotencyKey: 'bad key' },
      { message: 'x'.repeat(MAX_MESSAGE_CHARS + 1), idempotencyKey: 'key' }, { message: ' ', idempotencyKey: 'key' },
      ...['actorId', 'ownerUserId', 'grant', 'executionGrant', 'agentId', 'media', 'expectedRunId'].map(key => ({ message: 'test', idempotencyKey: 'key', [key]: 'fake' })),
      { message: 'test', idempotencyKey: 'key', deliveryMode: ['mirror'] }]) {
      assert.equal((await f.request(f.base + '/messages', 'POST', body)).status, 400);
    }
    for (const control of ['/stop', '/status', '/compact']) assert.equal((await f.post('key', control)).status, 409);
    assert.equal((await f.request(f.base + '/messages', 'POST', { message: 'test', idempotencyKey: 'key', deliveryMode: 'mirror' })).status, 409);
    assert.equal((await f.post('key', 'x'.repeat(MAX_TEXT_MESSAGE_BODY_BYTES))).status, 400);
    assert.equal((await f.request(f.base + '/commands/bad%20key')).status, 400);
    assert.equal((await f.request(f.base + '/commands/missing')).status, 404);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

for (const transport of ['local', 'http'] as const) {
  test(`${transport}: shared mirror requires explicit combined original policy and retains delivery across unknown recovery`, async () => {
    const setup = await fixture(transport, 'openclaw', true);
    const payload = { message: 'original input', idempotencyKey: 'original-mirror', deliveryMode: 'mirror' };
    try {
      setup.loseAck();
      assert.equal((await setup.request(setup.base + '/messages', 'POST', payload)).status, 202);
      const original = setup.turns.head<any>('openclaw', setup.sessionKey)!;
      assert.equal(original.payload.deliveryMode, 'mirror');
      assert.ok(original.payload.executionGrant);
      assert.equal(setup.grants.authorize(original.payload.executionGrant, setup.issuer.record.id,
        setup.resource, 'messages:mirror'), true);
      setup.store.grants.revoke(setup.policyTarget, setup.send.id, 1);
      setup.allowRead();
      assert.equal((await setup.request(setup.base + '/messages', 'POST', payload)).status, 200);
      assert.equal((await setup.request(setup.base + '/messages', 'POST', { ...payload, deliveryMode: 'web-only' })).status, 409);
      assert.equal((await setup.request(setup.base + '/messages', 'POST', { ...payload, idempotencyKey: 'new-key' })).status, 403);
      assert.equal(setup.calls.filter(call => call.startsWith('POST ') && call.endsWith('/messages')).length, 1);
      assert.equal(setup.turns.list('openclaw').length, 1);
    } finally { await setup.close(); }
  });

  test(`${transport}: shared mirror rejects send-only policy and revocation during original lease issuance`, async () => {
    const setup = await fixture(transport, 'openclaw', true);
    const payload = { message: 'original', idempotencyKey: 'mirror', deliveryMode: 'mirror' };
    try {
      setup.afterIssue(() => { setup.store.grants.revoke(setup.policyTarget, setup.send.id, 1); });
      assert.equal((await setup.request(setup.base + '/messages', 'POST', payload)).status, 503);
      assert.deepEqual(setup.turns.list('openclaw'), []);
      setup.store.grants.create(setup.policyTarget, { ...setup.resource, actions: ['messages:send'] });
      assert.equal((await setup.request(setup.base + '/messages', 'POST', { ...payload, idempotencyKey: 'later' })).status, 403);
      assert.equal(setup.calls.some(call => call.startsWith('POST ') && call.endsWith('/messages')), false);
    } finally { await setup.close(); }
  });
}

test('shared mirror does not combine unrelated grant versions into one execution authority', async () => {
  const setup = await fixture('local', 'openclaw');
  try {
    setup.store.grants.create(setup.policyTarget, { ...setup.resource, actions: ['messages:mirror'] });
    assert.equal((await setup.request(setup.base + '/messages', 'POST', {
      message: 'original', idempotencyKey: 'mirror', deliveryMode: 'mirror',
    })).status, 503);
    assert.equal(setup.calls.some(call => call.startsWith('POST ')), false);
    assert.deepEqual(setup.turns.list('openclaw'), []);
  } finally { await setup.close(); }
});

test('shared HTTP namespace isolates two recipients and explicit owner/session/node targets', async () => {
  const f = await fixture();
  try {
    f.store.grants.create({ ...f.policyTarget, userId: f.charlie.id }, { ...f.resource, actions: ['messages:read', 'messages:send'] });
    assert.equal((await f.post()).status, 200);
    assert.equal((await f.request(f.base + '/commands/key', 'GET', undefined, f.otherLogin.token)).status, 404);
    assert.equal((await f.request(f.base + '/messages', 'POST', { message: 'synthetic', idempotencyKey: 'key' }, f.otherLogin.token)).status, 200);
    const queue = f.turns.list<{ actorId: string }>(f.runtime, f.sessionKey); assert.equal(queue.length, 2);
    assert.notEqual(queue[0]!.payload.actorId, queue[1]!.payload.actorId); assert.notEqual(queue[0]!.id, queue[1]!.id);
    for (const path of [f.base.replace(f.alice.id, f.bob.id), f.base.replace(encodeURIComponent(f.sessionId), encodeURIComponent(encodeHubSessionId('node', 'codex:other'))),
      f.base.replace(encodeURIComponent(f.sessionId), encodeURIComponent(encodeHubSessionId('other', f.sessionKey)))]) {
      assert.equal((await f.request(path + '/messages', 'POST', { message: 'synthetic', idempotencyKey: 'key' })).status, 404);
    }
    f.store.grants.revoke(f.policyTarget, f.read.id, 1);
    f.store.grants.create(f.policyTarget, { runtime: f.runtime, agentId: 'caller-asserted', actions: ['messages:read'] });
    assert.equal((await f.post('new')).status, 404, 'agent identity is not guessed from a session key');
  } finally { await f.close(); }
});

test('shared HTTP loses access during lease ACK without dispatch; logout after admission hides reply but preserves work', async () => {
  for (const phase of ['issue', 'send'] as const) {
    const f = await fixture();
    try {
      const revoke = () => f.store.identities.revokeKey(f.bob.id, f.login.id);
      if (phase === 'issue') f.afterIssue(revoke); else f.afterSend(revoke);
      assert.equal((await f.post()).status, 401);
      assert.equal(f.turns.list(f.runtime, f.sessionKey).length, phase === 'send' ? 1 : 0);
      const login = f.store.identities.issueKey(f.bob.id);
      const recovered = await f.request(f.base + '/commands/key', 'GET', undefined, login.token);
      assert.equal(recovered.status, phase === 'send' ? 200 : 404);
      if (phase === 'send') assert.equal((await recovered.json() as any).command.state, 'accepted');
    } finally { await f.close(); }
  }
});

test('shared HTTP revalidates the captured read proof after a held request body', async () => {
  for (const change of ['logout', 'policy', 'node'] as const) {
    const f = await fixture();
    let release!: () => void, reading!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { reading = resolve; });
    try {
      const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
        reading(); await held;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: 'synthetic', idempotencyKey: 'key' }))); controller.close();
      } }, { highWaterMark: 0 });
      const pending = f.app.fetch(new Request('http://hub.example.invalid' + f.base + '/messages', {
        method: 'POST', headers: { authorization: `Bearer ${f.login.token}`, 'content-type': 'application/json' }, body: stream, duplex: 'half',
      } as RequestInit));
      await started;
      if (change === 'logout') f.store.identities.revokeKey(f.bob.id, f.login.id);
      if (change === 'policy') f.store.grants.replace(f.policyTarget, f.read.id, 1, { ...f.resource, actions: ['messages:read'] });
      if (change === 'node') f.store.upsertConnection({ ...f.connection, credentialToken: 'synthetic-changed' });
      release();
      assert.equal((await pending).status, change === 'logout' ? 401 : 403);
      assert.deepEqual(f.calls, []); assert.equal(f.turns.list(f.runtime, f.sessionKey).length, 0);
    } finally { release(); await f.close(); }
  }
});

test('shared HTTP requires a current verified issuer and never falls back to an owner credential', async () => {
  const f = await fixture();
  try {
    f.store.upsertConnection({ ...f.connection, credentialToken: 'synthetic-owner-token' });
    f.store.grants.replace(f.policyTarget, f.read.id, 1, { ...f.resource, actions: ['messages:read'] });
    f.store.grants.replace(f.policyTarget, f.send.id, 1, { ...f.resource, actions: ['messages:send'] });
    assert.equal((await f.post()).status, 409);
    assert.equal((await f.request(f.base + '/commands/key')).status, 404);
    assert.deepEqual(f.calls, []);
    f.store.upsertConnection({ ...f.connection, status: 'disabled' });
    assert.equal((await f.post()).status, 404);
  } finally { await f.close(); }
});
});
