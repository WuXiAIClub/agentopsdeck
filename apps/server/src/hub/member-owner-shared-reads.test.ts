import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubSharedReads } from './async-shared-reads.js';
import { createHubConnectorReadServices } from './connector-read-services.js';
import { HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence, type HubMemberKind } from './member-owner-domain.js';
import { validHubSharedReadCommand, validHubSharedReadReply, validHubSharedReadResult } from './member-shared-read-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import type { HubEventBrokers } from './event-broker.js';
import { registerHubSharedReadRoutes } from '../routes/hub-shared-reads.js';
import { registerAsyncHubSharedSessions, isAsyncHubSharedSessionRequest } from '../routes/hub-shared-sessions-async.js';
import { pinOriginalRequestScope } from './original-request-scope.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const nodeId = 'node_00000000-0000-4000-8000-000000000001';
const quiet = new PerformanceDiagnostics(() => {});
const forbiddenStore = new Proxy({} as HubStore, { get() { throw Error('synchronous shared-read bypass'); } });
const forbidden = () => { throw Error('synchronous shared-read authority/client bypass'); };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
type Owner = Pick<AsyncHubMemberOwner, 'command'>;
const decorate = (fn: (kind: HubMemberKind, input: unknown) => Promise<unknown>): Owner => ({ command: fn as Owner['command'] });

async function fixture(t: TestContext, mode: 'original' | 'worker', assembly: 'standalone' | 'parent' = 'standalone') {
  const root = mkdtempSync(join(tmpdir(), 'shared-reads-owner-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'synthetic-vault');
  const member = seed.createUser('Member'), outsider = seed.createUser('Outsider');
  const administrator = seed.createUser('Lifecycle administrator');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(administrator.id);
  const administratorKey = seed.identities.issueKey(administrator.id);
  seed.upsertConnection({ id: 'local', kind: 'local', label: 'Local', connectorUrl: 'http://connector.example.invalid', capabilities: ['events'] });
  seed.pinConnectionNode('local', 'default', seed.connectionAuthority('local')!, nodeId);
  const nodeVersion = seed.connectionAuthority('local')!;
  const sessionKey = 'codex:shared/空 格', sessionId = encodeHubSessionId('local', sessionKey);
  const target = { ownerUserId: 'default', sessionId }, grantTarget = { ownerUserId: 'default', connectionId: 'local', userId: member.id };
  const policy = { runtime: 'codex' as const, sessionKey };
  const readGrant = seed.grants.create(grantTarget, { ...policy, actions: ['messages:read'] });
  const mediaGrant = seed.grants.create(grantTarget, { ...policy, actions: ['media:read'] });
  const eventsGrant = seed.grants.create(grantTarget, { ...policy, actions: ['events:read'] });
  const login = seed.identities.issueKey(member.id), ownerLogin = seed.identities.issueKey('default'), outside = seed.identities.issueKey(outsider.id);
  const ref = sessionRef(nodeId, sessionKey)!;
  seed.appendDelivery({ envConnectionId: 'local', remoteSessionKey: sessionKey, sessionRef: ref,
    remoteEventId: 'source-1', type: 'message.created', ts: 1, payload: { text: 'first-private' } }, 'shared-domain');
  const first = seed.latestDeliveryCursor('default')!;
  let deep: object = { private: 'never-export-owner-payload' };
  for (let i = 0; i < 80; i++) deep = { child: deep };
  seed.appendDelivery({ envConnectionId: 'local', remoteSessionKey: 'codex:other', sessionRef: sessionRef(nodeId, 'codex:other')!,
    type: 'message.created', ts: 2, payload: deep }, 'shared-domain');
  seed.appendDelivery({ envConnectionId: 'local', remoteSessionKey: sessionKey, sessionRef: ref,
    remoteEventId: 'source-3', type: 'message.created', ts: 3, payload: deep }, 'shared-domain');
  const last = seed.latestDeliveryCursor('default')!;
  await seed.close(); // No second writer when the actual worker starts.
  const original = mode === 'original' ? new HubStore(file, 'synthetic-vault') : undefined;
  const owner = original ? new OriginalHubAdministrativeCommands(original, quiet) : new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault' }, quiet);
  const calls: Request[] = [];
  let after: ((request: Request, response: Response) => Promise<Response>) | undefined;
  const message = { id: 'message-1', role: 'assistant', text: 'visible-shared-reply', timestamp: 1, sessionKey };
  const local = { connectionId: 'local', token: 'synthetic-local', dispatch: async (request: Request) => {
    calls.push(request);
    const path = new URL(request.url).pathname;
    let response: Response;
    if (path.endsWith('/state')) response = Response.json({ sessionKey, status: 'idle' });
    else if (path.includes('/media/')) response = new Response('png', { headers: { 'content-type': 'image/png', 'content-length': '3' } });
    else if (path.endsWith('/messages/message-1')) response = Response.json({ message, updatedAt: 1 });
    else response = Response.json({ messages: [message], totalCount: 1, updatedAt: 1 });
    response.headers.set('x-agentopsdeck-node-id', nodeId);
    return after ? after(request, response) : response;
  } };
  const services = createHubConnectorReadServices(owner, local, quiet);
  let beforeResolver: (() => Promise<void>) | undefined;
  const connector: typeof services.connector = Object.assign(async (...args: Parameters<typeof services.connector>) => {
    await beforeResolver?.(); return services.connector(...args);
  }, { close: () => services.connector.close() });
  let acquired = 0, released = 0;
  const waiting = gate(); let wake = () => {};
  const brokers = { acquire(user: string, connection: string) {
    assert.equal(user, 'default'); assert.equal(connection, 'local'); acquired++;
    const closed = new AbortController();
    return { events: { closedSignal: closed.signal, isClosed: false, revision: 0,
      directoryReady: async () => {}, deniedConnections: () => [], visibleDomains: () => new Map([['local', 'shared-domain']]),
      visibleDomain: () => 'shared-domain', wait: (_: number, signal: AbortSignal) => new Promise<void>(resolve => {
        const finish = () => { signal.removeEventListener('abort', finish); resolve(); };
        wake = finish; waiting.resolve();
        if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
      }) }, release() { if (!closed.signal.aborted) { released++; closed.abort(); } } };
  } } as unknown as HubEventBrokers;
  const app = new Hono(), base = `/api/hub/v1/shared/default/sessions/${encodeURIComponent(sessionId)}`;
  const scaffold = assembly === 'parent' ? new HubStore(join(root, 'assembly.sqlite'), 'synthetic-vault') : undefined;
  const routes = scaffold ? registerHubRoutes(app, {
    config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: scaffold,
    connectorClient: forbidden, principal: forbidden, normalizeError: () => 'Synthetic',
    asyncSharedDirectory: services.directory, asyncSharedCommands: services.sharedCommands,
    asyncSharedReads: services.sharedReads, asyncConnectorClient: connector,
  }) : registerAsyncHubSharedSessions(app, { mode: 'async', directory: services.directory,
    commands: services.sharedCommands, reads: services.sharedReads, connector, brokers, diagnostics: quiet });
  const request = (suffix = '/messages', token = login.token, headers: Record<string, string> = {}) =>
    new Request('http://hub.example.invalid' + base + suffix, { headers: { authorization: `Bearer ${token}`, ...headers } });
  const change = async (grant: typeof readGrant, action: 'revoke' | 'replace') => {
    const evidence = hubMemberEvidence(request('', ownerLogin.token));
    const snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    const command = action === 'revoke' ? { action, target: { ownerUserId: 'default', connectionId: 'local' },
      id: grant.id, version: grant.version, nodeVersion }
      : { action, target: { ownerUserId: 'default', connectionId: 'local' }, id: grant.id, version: grant.version, nodeVersion,
        policy: { ...policy, actions: [grant.id === readGrant.id ? 'messages:read' as const
          : grant.id === mediaGrant.id ? 'media:read' as const : 'events:read' as const] } };
    const result = await owner.command('grantChange', { evidence, expectedScope: snapshot.recoveryScope, command });
    assert.ok(result && !('error' in result), JSON.stringify(result));
  };
  t.after(async () => { await routes?.close(); await services.close(); await owner.close(); await original?.close(); await scaffold?.close(); rmSync(root, { recursive: true, force: true }); });
  const disable = async () => {
    const evidence = hubMemberEvidence(request('', administratorKey.token));
    const snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    const result = await owner.command('userChange', { evidence, expectedScope: snapshot.recoveryScope,
      change: { action: 'accessChange', userId: member.id, status: 'disabled', expectedVersion: 0 } });
    assert.deepEqual(result, { access: { userId: member.id, status: 'disabled', version: 1 } });
  };
  return { owner, original, root, services, app, brokers, request, target, readGrant, mediaGrant, eventsGrant, change, disable, first, last, sessionKey, ref,
    outside, calls, routes, acquired: () => acquired, released: () => released, after: (fn: typeof after) => { after = fn; },
    beforeResolver: (fn: typeof beforeResolver) => { beforeResolver = fn; },
    waiting: waiting.promise, wake: () => wake() };
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: known read revocation remains forbidden at repeated delivery fences without redispatch`, async t => {
    const f = await fixture(t, mode); let calls = 0;
    const owner = decorate(async (kind, input) => {
      if (kind === 'sharedRead') calls++;
      return f.owner.command(kind, input as never);
    });
    const reads = new AsyncHubSharedReads(owner, quiet); t.after(() => reads.close());
    const auth = await reads.open(f.request(), f.target);
    await auth.require('media:read'); await f.change(f.readGrant, 'revoke');
    const forbidden = (error: unknown) => error instanceof HubMemberRequestError && error.status === 403;
    await assert.rejects(auth.require('media:read'), forbidden);
    const count = calls;
    await assert.rejects(auth.read(), forbidden);
    await assert.rejects(auth.require('media:read'), forbidden);
    await assert.rejects(auth.hints(), forbidden);
    assert.equal(calls, count);
  });

  for (const revocation of ['grant', 'account'] as const) test(`${mode}: ${revocation} revocation closes SSE and suppresses concurrent history/media responses`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, mode), historyEntered = gate(), mediaEntered = gate(), finish = gate();
    const stream = await f.app.fetch(f.request('/events/stream')), reader = stream.body!.getReader();
    assert.equal(stream.status, 200);
    assert.match(new TextDecoder().decode((await reader.read()).value), /heartbeat/);
    await f.waiting; // Wake the same synthetic broker; no timing/polling shortcut.
    f.after(async (request, response) => {
      const media = new URL(request.url).pathname.includes('/media/');
      (media ? mediaEntered : historyEntered).resolve();
      await finish.promise; return response;
    });
    const history = f.app.fetch(f.request());
    const media = f.app.fetch(f.request('/messages/message-1/media/' + 'a'.repeat(64)));
    try {
      await Promise.all([historyEntered.promise, mediaEntered.promise]);
      const calls = f.calls.length;
      if (revocation === 'account') await f.disable(); else await f.change(f.readGrant, 'revoke');
      f.wake(); finish.resolve();
      for (const [index, response] of (await Promise.all([history, media])).entries()) {
        assert.equal(response.status, revocation === 'account' ? 401 : 403, index === 0 ? 'history revocation' : 'media revocation');
        const text = await response.text();
        assert.equal(text.includes('visible-shared-reply'), false); assert.equal(text.includes('png'), false);
      }
      // A stream may close normally or be aborted; neither may emit private frames.
      let privateBytes = '';
      try {
        for (;;) { const next = await reader.read(); if (next.done) break; privateBytes += new TextDecoder().decode(next.value); }
      } catch { /* Expected authority-triggered stream abort. */ }
      assert.equal(privateBytes.includes('first-private'), false);
      assert.equal(privateBytes.includes('never-export-owner-payload'), false);
      assert.equal(f.released(), 1);
      f.after(undefined);
      assert.ok((revocation === 'account' ? [401] : [403, 404]).includes((await f.app.fetch(f.request())).status));
      assert.equal(f.calls.length, calls, 'late denial and fresh denied requests must not redispatch Connector reads');
    } finally {
      finish.resolve(); f.wake(); f.after(undefined);
      await reader.cancel().catch(() => {});
      await Promise.allSettled([history, media]);
    }
  });

  for (const assembly of ['standalone', 'parent'] as const) test(`${mode}/${assembly}: real shared state/history/detail/media keep wire identity without synchronous bypass`, async t => {
    const f = await fixture(t, mode, assembly);
    const state = await f.app.fetch(f.request('/state')); assert.equal(state.status, 200); assert.equal((await state.json()).sessionKey, f.target.sessionId);
    const history = await f.app.fetch(f.request()); assert.equal(history.status, 200); assert.equal(history.headers.get('cache-control'), 'no-store');
    const page = await history.json(); assert.equal(page.messages[0].sessionKey, f.target.sessionId); assert.deepEqual(page.messages[0].sessionRef, f.ref);
    assert.deepEqual(page.access, { messagesSend: false, messagesMirror: false, eventsRead: true });
    const detail = await f.app.fetch(f.request('/messages/message-1')); assert.equal(detail.status, 200); assert.equal((await detail.json()).message.text, 'visible-shared-reply');
    const media = await f.app.fetch(f.request('/messages/message-1/media/' + 'a'.repeat(64))); assert.equal(media.status, 200); assert.equal(await media.text(), 'png');
    const conditional = await f.app.fetch(f.request('/messages', undefined, { 'if-none-match': history.headers.get('etag')! })); assert.equal(conditional.status, 304);
    const count = f.calls.length;
    assert.equal((await f.app.fetch(f.request('/messages', f.outside.token))).status, 404);
    assert.equal(f.calls.length, count, 'unauthorized shared access never reaches Connector');
  });

  test(`${mode}: all shared ports preserve the private request scope instead of upgrading stale proof`, async t => {
    const f = await fixture(t, mode);
    function request() { const request = f.request(); pinOriginalRequestScope(request, 'stale-private-scope'); return request; }
    for (const open of [() => f.services.sharedReads.open(request(), f.target),
      () => f.services.sharedCommands.open(request(), f.target),
      () => f.services.directory.sessions(request(), { ownerUserId: 'default', connectionId: 'local', grantId: f.readGrant.id })]) {
      await assert.rejects(open(), (error: unknown) => error instanceof HubMemberRequestError && error.status === 401);
    }
    assert.equal(f.calls.length, 0);
  });

  test(`${mode}: closing complete shared composition releases an open SSE without caller cancellation`, async t => {
    const f = await fixture(t, mode);
    const response = await f.app.fetch(f.request('/events/stream')), reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /heartbeat/);
    await f.routes!.close();
    assert.equal(f.released(), 1);
    await reader.cancel().catch(() => {});
    assert.equal((await f.app.fetch(f.request())).status, 503);
  });

  test(`${mode}: unconsumed media retains original cancellation ACK through route close`, async t => {
    const f = await fixture(t, mode), entered = gate(), finish = gate();
    f.after(async (request, response) => {
      if (!new URL(request.url).pathname.includes('/media/')) return response;
      await response.body?.cancel();
      return new Response(new ReadableStream<Uint8Array>({ cancel() { entered.resolve(); return finish.promise; } }, { highWaterMark: 0 }),
        { headers: { 'content-type': 'image/png', 'x-agentopsdeck-node-id': nodeId } });
    });
    const response = await f.app.fetch(f.request('/messages/message-1/media/' + 'a'.repeat(64)));
    assert.equal(response.status, 200);
    let closed = false; const close = f.routes!.close().then(() => { closed = true; });
    try { await entered.promise; await tick(); assert.equal(closed, false); }
    finally { finish.resolve(); await close; }
    await assert.rejects(response.text());
  });

  test(`${mode}: complete shared composition retains ignored-abort resolver and forbids late dispatch`, async t => {
    const f = await fixture(t, mode), entered = gate(), finish = gate();
    f.beforeResolver(async () => { entered.resolve(); await finish.promise; });
    const abort = new AbortController(), response = f.app.fetch(new Request(f.request(), { signal: abort.signal }));
    await entered.promise; abort.abort();
    let closed = false; const close = f.routes!.close().then(() => { closed = true; });
    try { await tick(); assert.equal(closed, false); assert.equal(f.calls.length, 0); }
    finally { finish.resolve(); await close; }
    assert.equal((await response).status, 503); assert.equal(f.calls.length, 0);
  });

  for (const malformed of [false, true]) test(`${mode}: shared body wait retains original HTTP; malformed=${malformed}`, async t => {
    const f = await fixture(t, mode), reading = gate(); let body!: ReadableStreamDefaultController<Uint8Array>;
    const request = new Request(f.request('/messages'), { method: 'POST', duplex: 'half',
      body: new ReadableStream<Uint8Array>({ start(out) { body = out; }, pull() { reading.resolve(); } }, { highWaterMark: 0 }),
    } as RequestInit & { duplex: 'half' });
    const response = f.app.fetch(request); await reading.promise;
    let closed = false; const close = f.routes!.close().then(() => { closed = true; });
    try { await tick(); assert.equal(closed, false); }
    finally {
      body.enqueue(new TextEncoder().encode(malformed ? '{' : '{"message":"original","idempotencyKey":"body-close"}')); body.close();
      await close;
    }
    assert.equal((await response).status, 503); assert.equal(f.calls.length, 0);
  });

  test(`${mode}: shared replay projects inside original SQL and real SSE retains original cursor`, async t => {
    const f = await fixture(t, mode), auth = await f.services.sharedReads.open(f.request(), f.target), replay = await auth.replay();
    assert.equal(replay.initialCursor, f.last);
    const page = await replay.page(f.first, new Map([['local', 'shared-domain']]));
    assert.equal(page.cursor, f.last); assert.equal(page.events.length, 1); assert.equal(page.events[0]!.type, 'session.invalidated');
    assert.deepEqual(page.events[0]!.payload, { invalidation: true }); assert.equal(page.events[0]!.remoteEventId, 'source-3');
    assert.ok(!JSON.stringify(page).includes('never-export-owner-payload'));
    await assert.rejects(replay.revisions(), (e: unknown) => e instanceof HubMemberRequestError && e.status === 403);
    await assert.rejects(replay.page(f.first, new Map([['other-node', 'shared-domain']])), (e: unknown) => e instanceof HubMemberRequestError && e.status === 400);
    const response = await f.app.fetch(f.request('/events/stream', undefined, { 'last-event-id': f.first })); assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    try {
      let text = '';
      for (let n = 0; n < 8 && !text.includes('session.invalidated'); n++) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /session.invalidated/); assert.ok(!text.includes('never-export-owner-payload')); assert.ok(!text.includes('codex:other'));
    } finally { await reader.cancel(); }
    for (let n = 0; n < 20 && f.released() === 0; n++) await tick();
    assert.equal(f.acquired(), 1); assert.equal(f.released(), 1);
  });

  test(`${mode}: replaced read grant during network cannot deliver history or a cached 304`, async t => {
    const f = await fixture(t, mode);
    const before = await f.app.fetch(f.request()); assert.equal(before.status, 200); await before.text();
    f.after(async (_, response) => { await f.change(f.readGrant, 'replace'); return response; });
    const denied = await f.app.fetch(f.request('/messages', undefined, { 'if-none-match': before.headers.get('etag')! }));
    assert.equal(denied.status, 403); assert.ok(!(await denied.text()).includes('visible-shared-reply'));
    f.after(undefined);
    assert.equal((await f.app.fetch(f.request())).status, 200, 'only a new request can obtain a new grant version');
  });

  test(`${mode}: action proof replacement never revives retained media/events requests`, async t => {
    const f = await fixture(t, mode), media = await f.services.sharedReads.open(f.request(), f.target);
    await media.require('media:read'); await f.change(f.mediaGrant, 'replace');
    await assert.rejects(media.require('media:read'), (e: unknown) => e instanceof HubMemberRequestError && e.status === 403);
    const events = await f.services.sharedReads.open(f.request(), f.target), replay = await events.replay();
    await f.change(f.eventsGrant, 'replace');
    await assert.rejects(replay.check(), (e: unknown) => e instanceof HubMemberRequestError && e.status === 403);
    const fresh = await f.services.sharedReads.open(f.request(), f.target); await fresh.require('events:read');
  });

  test(`${mode}: media response rechecks precise action after remote wait`, async t => {
    const f = await fixture(t, mode);
    f.after(async (_, response) => { await f.change(f.mediaGrant, 'revoke'); return response; });
    const denied = await f.app.fetch(f.request('/messages/message-1/media/' + 'a'.repeat(64)));
    assert.equal(denied.status, 403); assert.ok(!(await denied.text()).includes('png'));
  });

  test(`${mode}: unknown shared-read ACK fences request, never replays or falls back`, async t => {
    const f = await fixture(t, mode); let shared = 0, lose = false;
    const owner = decorate(async (kind, input) => {
      const result = await f.owner.command(kind, input as never);
      if (kind === 'sharedRead') { shared++; if (lose) throw Error('synthetic lost original ACK'); }
      return result;
    });
    const reads = new AsyncHubSharedReads(owner, quiet); t.after(() => reads.close());
    const auth = await reads.open(f.request(), f.target); lose = true;
    await assert.rejects(auth.read(), (e: unknown) => e instanceof HubMemberRequestError && e.status === 503);
    const count = shared; await assert.rejects(auth.read()); assert.equal(shared, count);
  });

  test(`${mode}: media revocation between chunks cancels upstream without delivering the next chunk`, async t => {
    const f = await fixture(t, mode), next = gate(); let cancelled = false, chunks = 0;
    f.after(async (request, response) => {
      if (!new URL(request.url).pathname.includes('/media/')) return response;
      await response.body?.cancel();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (chunks++ === 0) controller.enqueue(new TextEncoder().encode('first'));
          else { await next.promise; if (!cancelled) controller.enqueue(new TextEncoder().encode('private-next')); }
        }, cancel() { cancelled = true; next.resolve(); },
      }), { headers: { 'content-type': 'image/png', 'x-agentopsdeck-node-id': nodeId } });
    });
    const response = await f.app.fetch(f.request('/messages/message-1/media/' + 'a'.repeat(64)));
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    try {
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
      await f.change(f.mediaGrant, 'revoke'); next.resolve();
      await assert.rejects(reader.read());
      for (let n = 0; n < 10 && !cancelled; n++) await tick();
      assert.equal(cancelled, true);
    } finally { next.resolve(); await reader.cancel().catch(() => {}); }
  });

  test(`${mode}: SSE rechecks the original grant after a held journal page ACK`, async t => {
    const f = await fixture(t, mode), entered = gate(), finish = gate();
    const owner = decorate(async (kind, input) => {
      const result = await f.owner.command(kind, input as never);
      if (kind === 'sharedRead' && (input as { command: { action: string } }).command.action === 'page') {
        entered.resolve(); await finish.promise;
      }
      return result;
    });
    const reads = new AsyncHubSharedReads(owner, quiet); t.after(() => reads.close());
    const app = new Hono();
    registerHubSharedReadRoutes(app, { hubStore: forbiddenStore, principal: forbidden, connectorClient: forbidden,
      asyncConnectorClient: f.services.connector, asyncSharedReads: reads, brokers: f.brokers });
    const response = await app.fetch(f.request('/events/stream', undefined, { 'last-event-id': f.first }));
    const reader = response.body!.getReader();
    try {
      assert.match(new TextDecoder().decode((await reader.read()).value), /heartbeat/);
      await entered.promise; await f.change(f.eventsGrant, 'revoke'); finish.resolve();
      let text = '';
      for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); }
      assert.ok(!text.includes('session.invalidated')); assert.ok(!text.includes('never-export-owner-payload'));
      assert.equal(f.released(), 1);
    } finally { finish.resolve(); await reader.cancel().catch(() => {}); }
  });

  test(`${mode}: malformed or mismatched ACKs fence the selected request without fallback`, async t => {
    const f = await fixture(t, mode);
    for (const corruption of ['binding', 'action', 'scope', 'extra'] as const) {
      let corrupt = false, count = 0;
      const owner = decorate(async (kind, input) => {
        const result: unknown = await (f.owner.command as (kind: HubMemberKind, input: unknown) => Promise<unknown>)(kind, input);
        if (kind !== 'sharedRead') return result;
        count++;
        if (!corrupt || !result) return result;
        assert.equal(typeof result, 'object');
        const reply = result as Record<string, unknown>;
        if (corruption === 'binding') return { ...reply, binding: '0'.repeat(64) };
        if (corruption === 'action') return { ...reply, data: { action: 'cursor', cursor: null } };
        if (corruption === 'scope') return { ...reply, data: { action: 'permission', proof: { ...f.readGrant, ownerUserId: 'outsider' } } };
        return { ...reply, leakedOwnerData: true };
      });
      const reads = new AsyncHubSharedReads(owner, quiet);
      try {
        const auth = await reads.open(f.request(), f.target); corrupt = true;
        await assert.rejects(auth.read(), (e: unknown) => e instanceof HubMemberRequestError && e.status === 503);
        const originalCount = count; await assert.rejects(auth.read()); assert.equal(count, originalCount);
      } finally { await reads.close(); }
    }
  });

  test(`${mode}: stale recovery scope rejects before Connector and captured targets cannot be retargeted`, async t => {
    const f = await fixture(t, mode);
    const denied = await f.app.fetch(f.request('/messages', undefined, { 'x-agentopsdeck-recovery-scope': 'stale-scope' }));
    assert.equal(denied.status, 409); assert.equal(f.calls.length, 0);
    const target = { ...f.target }, opening = f.services.sharedReads.open(f.request(), target);
    target.ownerUserId = 'outsider'; target.sessionId = encodeHubSessionId('local', 'codex:other');
    const auth = await opening; assert.deepEqual(auth.target, { ...f.target, userId: auth.target.userId }); await auth.read();
    const closed = f.services.sharedReads.close();
    await assert.rejects(auth.hints(), (e: unknown) => e instanceof HubMemberRequestError && e.status === 503);
    await closed;
  });

  test(`${mode}: cancelled HTTP wait retains accepted original SQL until close drains`, async t => {
    const f = await fixture(t, mode), entered = gate(), finish = gate(); let hold = false;
    const owner = decorate(async (kind, input) => {
      const result = await f.owner.command(kind, input as never);
      if (kind === 'sharedRead' && hold) { entered.resolve(); await finish.promise; }
      return result;
    });
    const reads = new AsyncHubSharedReads(owner, quiet, 30000, 30000);
    const abort = new AbortController(), request = new Request(f.request(), { signal: abort.signal });
    const auth = await reads.open(request, f.target); hold = true;
    const pending = assert.rejects(auth.read(), (e: unknown) => e instanceof HubMemberRequestError && e.status === 499);
    await entered.promise; abort.abort(); await pending;
    let drained = false; const close = reads.close().then(() => { drained = true; });
    try { for (let n = 0; n < 5; n++) await tick(); assert.equal(drained, false); }
    finally { finish.resolve(); await close; }
    await assert.rejects(auth.read(), (e: unknown) => e instanceof HubMemberRequestError && e.status === 503);
  });
}

test('production Hub middleware selects async shared reads without bypassing authorization for other routes', async t => {
  const f = await fixture(t, 'original');
  let guarded = false, principals = 0;
  const store = new Proxy(f.original!, { get(target, key, receiver) {
    if (guarded) throw Error('production shared-read synchronous store bypass');
    return Reflect.get(target, key, receiver);
  } });
  const app = new Hono(), config = loadConfig({ HOME: f.root, AOD_SERVER_ROLE: 'hub' });
  const routes = registerHubRoutes(app, { config, hubStore: store, connectorClient: forbidden,
    asyncConnectorClient: f.services.connector, asyncSharedReads: f.services.sharedReads,
    principal: () => { principals++; return undefined; }, normalizeError: () => 'Synthetic' });
  assert.ok(routes);
  try {
    guarded = true;
    for (const path of ['/state', '/messages', '/messages/message-1', '/messages/message-1/media/' + 'a'.repeat(64)]) {
      const response = await app.fetch(f.request(path)); assert.equal(response.status, 200, path); await response.text();
    }
    const head = await app.fetch(new Request(f.request(), { method: 'HEAD' })); assert.equal(head.status, 200);
    assert.equal(principals, 0, 'selected async routes own original request authority');
    const unauthorized = await app.fetch(new Request(f.request('/messages'), { headers: { authorization: 'Bearer invalid' } }));
    assert.equal(unauthorized.status, 401); assert.equal(principals, 0);
    const notSelected = await app.fetch(f.request('/not-a-read')); assert.equal(notSelected.status, 401); assert.equal(principals, 1);
    const write = await app.fetch(new Request(f.request('/messages'), { method: 'POST' }));
    assert.equal(write.status, 401); assert.equal(principals, 2, 'read exemption cannot authorize writes');
  } finally { guarded = false; await routes.close(); }
});

test('complete shared matcher selects exact read/write ownership without opening other capabilities', () => {
  const base = '/api/hub/v1/shared/owner/sessions/session/';
  for (const suffix of ['state', 'events/stream', 'messages', 'messages/id', 'messages/id/media/hash', 'queue',
    'commands/key', 'commands/key/queue', 'commands/key/queue/commands/change']) {
    assert.equal(isAsyncHubSharedSessionRequest('GET', base + suffix), true, suffix);
    assert.equal(isAsyncHubSharedSessionRequest('HEAD', base + suffix), true, suffix);
  }
  assert.equal(isAsyncHubSharedSessionRequest('POST', base + 'messages'), true);
  assert.equal(isAsyncHubSharedSessionRequest('PATCH', base + 'commands/key/queue'), true);
  assert.equal(isAsyncHubSharedSessionRequest('DELETE', base + 'commands/key/queue'), true);
  assert.equal(isAsyncHubSharedSessionRequest('GET', '/api/hub/v1/shared/owner/connections/node/grants/grant/sessions'), true);
  for (const [method, suffix] of [['GET', 'settings'], ['GET', 'messages/id/media/hash/extra'], ['POST', 'compact'],
    ['DELETE', 'messages'], ['PUT', 'commands/key/queue'], ['POST', 'messages/']]) {
    assert.equal(isAsyncHubSharedSessionRequest(method!, base + suffix), false, suffix);
  }
});

test('shared command/reply protocol rejects extra authority, wrong action and incorrect binding', () => {
  const command = { action: 'open' as const, target: { ownerUserId: 'default', sessionId: encodeHubSessionId('local', 'codex:shared') } };
  assert.equal(validHubSharedReadCommand(command), true);
  assert.equal(validHubSharedReadCommand({ ...command, admin: true }), false);
  assert.equal(validHubSharedReadCommand({ ...command, target: { ...command.target, userId: 'admin' } }), false);
  assert.equal(validHubSharedReadResult({ binding: '0'.repeat(64), data: { action: 'check', ok: true } }), true);
  assert.equal(validHubSharedReadReply(command, { binding: '0'.repeat(64), data: { action: 'check', ok: true } }), false);
});
