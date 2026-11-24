import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER, type SessionDirectoryPage } from '@agentopsdeck/shared';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncSessionReads } from './async-session-reads.js';
import { registerSessionReadsHttp } from './session-reads-http.js';
import { DeckStore } from '../projection/deck-store.js';
import { hermesSessionView } from '../hermes/session-view.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { EventSnapshotRead } from '../routes/events.js';
import { registerConnectorRoutes } from '../routes/connector.js';
import { loadConfig } from '../config.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from './node-identity.js';

const authorization = 'Bearer isolated-catalog-reads';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture(timeoutMs = 5000) {
  const root = mkdtempSync(join(tmpdir(), 'session-reads-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), authorization.slice(7));
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens), deck = new DeckStore(), logs: string[] = [], calls = [0, 0];
  for (const key of ['hermes:a', 'hermes:b', 'hermes:c']) deck.upsertSession(hermesSessionView(key, key, undefined, true));
  deck.hideSession('hermes:a'); deck.archiveSession('hermes:b'); deck.pinSession('hermes:c');
  let ready: unknown = true, authentications = 0;
  const hooks: { refresh?: (index: number) => Promise<void>; snapshot?: EventSnapshotRead;
    afterAuth?: (index: number) => void | Promise<void> } = {};
  const port: Pick<AsyncConnectorOwner, 'command'> = { command: async (kind, input) => {
    const value = await command(kind, input);
    if (kind === 'tokenAuthenticate') await hooks.afterAuth?.(++authentications);
    return value;
  } };
  const reads = new AsyncSessionReads(port, { projection: deck, snapshot: capture => hooks.snapshot ? hooks.snapshot(capture) : capture('original-cursor'),
    refreshers: [0, 1].map(index => async options => { assert.deepEqual(options, { maxAgeMs: 2000 }); calls[index]!++; await hooks.refresh?.(index); }),
    snapshotReady: () => ready as boolean, connector: { environmentId: 'env', environmentLabel: 'Original environment' }, timeoutMs,
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)) });
  const app = new Hono(); registerSessionReadsHttp(app, '/sessions', { reads });
  app.get('/sessions/*', c => c.json({ fallback: true }));
  const request = (path = 'state', headers: Record<string, string> = {}, signal?: AbortSignal) =>
    app.request(`/sessions/${path}`, { headers: { authorization, ...headers }, ...(signal ? { signal } : {}) });
  return { root, tokens, store, deck, command, port, reads, request, hooks, logs, calls,
    ready(value: unknown) { ready = value; },
    async close() { await reads.close(); command.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('catalog HTTP keeps original directory pagination, flags, metadata and causal cursor without native refresh', async () => {
  const f = fixture();
  try {
    const first = await f.request('directory?runtime=hermes&limit=1'); assert.equal(first.status, 200);
    const page = await first.json() as SessionDirectoryPage;
    assert.deepEqual(page.sessions, [{ sessionKey: 'hermes:a', runtime: 'hermes' }]);
    assert.equal(page.nextCursor, 'hermes:a'); assert.equal(page.sourceCursor, 'original-cursor'); assert.deepEqual(f.calls, [0, 0]);
    const second = await f.request(`directory?runtime=hermes&after=${page.nextCursor}&limit=1`);
    assert.deepEqual((await second.json() as SessionDirectoryPage).sessions, [{ sessionKey: 'hermes:b', runtime: 'hermes' }]);
    const state = await f.request('state?includeHidden=true&includeArchived=1'); assert.equal(state.status, 200);
    const body = await state.json();
    assert.equal(typeof body.updatedAt, 'number');
    assert.deepEqual(body, { ...f.deck.getSessionsState({ includeHidden: true, includeArchived: true }), updatedAt: body.updatedAt,
      sourceCursor: 'original-cursor', connector: { environmentId: 'env', environmentLabel: 'Original environment' } });
    assert.deepEqual(f.calls, [1, 1]); assert.equal(state.headers.get('cache-control'), 'no-store');
    const visible = await f.request('state'); assert.equal(visible.status, 200);
    assert.deepEqual((await visible.json()).groups, f.deck.getSessionsState().groups);
    assert.ok(f.logs.length > 0); assert.ok(f.logs.every(line => !line.includes(authorization) && !line.includes('hermes:')));
  } finally { await f.close(); }
});

test('catalog rejects strict invalid queries only after current authority; invalid credentials never refresh', async () => {
  const f = fixture();
  try {
    for (const query of ['runtime=invalid', 'limit=0', 'limit=101', 'limit=1&limit=2', 'unknown=x', 'runtime=codex&sessionKey=hermes:a'])
      assert.equal((await f.request(`directory?${query}`)).status, 400);
    assert.equal((await f.request('directory?limit=0', { authorization: 'Bearer invalid' })).status, 403);
    const weak = f.tokens.create({ label: 'weak', scopes: ['messages:read'] });
    for (const path of ['directory', 'state']) for (const header of ['', 'Bearer invalid', `Bearer ${weak.token}`])
      assert.equal((await f.request(path, { authorization: header })).status, 403);
    assert.deepEqual(f.calls, [0, 0]);
  } finally { await f.close(); }
});

test('catalog retains original delegated sessions:read authority instead of imposing an incompatible new restriction', async () => {
  const f = fixture();
  try {
    const delegated = f.tokens.create({ label: 'original delegate', scopes: ['sessions:read', 'messages:send', 'execution:delegate'] });
    assert.equal((await f.request('directory', { authorization: `Bearer ${delegated.token}` })).status, 200);
    assert.equal((await f.request('state', { authorization: `Bearer ${delegated.token}` })).status, 200);
  } finally { await f.close(); }
});

for (const kind of ['directory', 'state'] as const) for (const change of ['revoke', 'reader', 'unavailable'] as const)
  test(`catalog ${kind} rechecks ${change} after the original causal snapshot, never legacy fallback`, async () => {
    const f = fixture();
    try {
      const original = f.tokens.authenticateAuthorization(authorization)!;
      f.hooks.snapshot = capture => {
        const body = capture('original-cursor');
        if (change === 'revoke') f.tokens.revoke(original.tokenId);
        return body;
      };
      if (change !== 'revoke') {
        const port: Pick<AsyncConnectorOwner, 'command'> = { command: async (command, input) => {
          const value = await f.port.command(command, input);
          if (command === 'tokenAuthenticate' && typeof value === 'object' && value && 'tokenId' in value) {
            if (++count > 1 && change === 'unavailable') throw new Error('private authority failure');
            return { ...value, tokenId: count > 1 ? 'different-reader' : original.tokenId } as typeof value;
          }
          return value;
        } };
        let count = 0;
        const reads = new AsyncSessionReads(port, { projection: f.deck, snapshot: capture => capture('original-cursor'),
          refreshers: [async () => {}], snapshotReady: () => true, connector: { environmentId: 'env', environmentLabel: 'env' } });
        const app = new Hono(); registerSessionReadsHttp(app, '/sessions', { reads });
        try { assert.equal((await app.request(`/sessions/${kind}`, { headers: { authorization } })).status, change === 'reader' ? 409 : 503); }
        finally { await reads.close(); }
      } else assert.equal((await f.request(kind)).status, 403);
    } finally { await f.close(); }
  });

test('state refresh is shared and close waits both original participants even after one rejects', async () => {
  const f = fixture(), entered = gate(), pending = gate();
  try {
    f.hooks.refresh = async index => { if (index === 0) throw new Error('private provider failed'); entered.release(); await pending.promise; };
    const first = f.request(), second = f.request(); await entered.promise; await tick();
    assert.deepEqual(f.calls, [1, 1]);
    let ended = false; const closing = f.reads.close().then(() => { ended = true; }); await tick();
    assert.equal(ended, false); assert.equal((await f.request()).status, 503);
    pending.release(); assert.equal((await first).status, 503); assert.equal((await second).status, 503);
    await closing; assert.equal(ended, true); assert.deepEqual(f.calls, [1, 1]);
  } finally { pending.release(); await f.close(); }
});

for (const value of [false, undefined, 1]) test(`state refuses non-current ready proof ${String(value)} but directory remains last-known`, async () => {
  const f = fixture();
  try { f.ready(value); assert.equal((await f.request()).status, 503); assert.equal((await f.request('directory')).status, 200); }
  finally { await f.close(); }
});

test('state cannot publish a snapshot invalidated during final worker authority delivery', async () => {
  const f = fixture();
  try { f.hooks.afterAuth = index => { if (index === 2) f.ready(false); }; assert.equal((await f.request()).status, 503); }
  finally { await f.close(); }
});

test('catalog requires the original causal cursor for both endpoints', async () => {
  const f = fixture();
  try {
    f.hooks.snapshot = capture => capture(undefined);
    assert.equal((await f.request()).status, 503); assert.equal((await f.request('directory')).status, 503);
  } finally { await f.close(); }
});

test('catalog retains all eight physical reads after HTTP cancellation and never exceeds capacity or replays', async () => {
  const f = fixture(), entered = gate(), pending = gate(); let snapshots = 0;
  try {
    f.hooks.snapshot = async capture => { if (++snapshots === 8) entered.release(); await pending.promise; return capture('original-cursor'); };
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const requests = controllers.map(c => f.request('directory', {}, c.signal)); await entered.promise;
    for (const c of controllers) c.abort();
    assert.ok((await Promise.all(requests)).every(r => r.status === 408));
    assert.equal((await f.request('directory')).status, 503); assert.equal(snapshots, 8);
    let done = false; const closing = f.reads.close().then(() => { done = true; }); await tick(); assert.equal(done, false);
    pending.release(); await closing; assert.equal(snapshots, 8);
  } finally { pending.release(); await f.close(); }
});

test('state HTTP deadline does not release or restart the original physical refresh', async () => {
  const f = fixture(25), entered = gate(), pending = gate();
  try {
    f.hooks.refresh = async index => { if (index === 1) entered.release(); await pending.promise; };
    const first = f.request(); await entered.promise; assert.equal((await first).status, 503);
    assert.equal((await f.request()).status, 503); assert.deepEqual(f.calls, [1, 1]);
    let done = false; const closing = f.reads.close().then(() => { done = true; }); await tick(); assert.equal(done, false);
    pending.release(); await closing; assert.deepEqual(f.calls, [1, 1]);
  } finally { pending.release(); await f.close(); }
});

test('catalog original worker credentials survive reopen and current revocation is enforced without SQL projection access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-worker-')), file = join(root, 'connector.sqlite'), tokenFile = join(root, 'tokens.json');
  let readerId: string | undefined;
  try {
    for (let index = 0; index < 2; index++) {
      const owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: authorization.slice(7) }, new PerformanceDiagnostics(() => {}));
      const deck = new DeckStore(); deck.upsertSession(hermesSessionView('hermes:original', 'Original', undefined, true));
      const reads = new AsyncSessionReads(owner, { projection: deck, snapshot: capture => capture('worker-cursor'), refreshers: [async () => {}],
        snapshotReady: () => true, connector: { environmentId: 'env', environmentLabel: 'Original' } });
      try {
        await owner.open(); const reader = await owner.command('tokenAuthenticate', { authorization }); assert.ok(reader);
        if (index === 0) readerId = reader.tokenId; else assert.equal(reader.tokenId, readerId);
        assert.equal((await reads.directory(authorization, {}, new Request('http://local/'))).sessions[0]?.sessionKey, 'hermes:original');
        assert.equal((await reads.state(authorization, { includeHidden: false, includeArchived: false }, new Request('http://local/'))).sourceCursor, 'worker-cursor');
        if (index === 1) {
          await owner.command('tokenRevoke', { tokenId: reader.tokenId });
          await assert.rejects(reads.directory(authorization, {}, new Request('http://local/')), { status: 403 });
        }
      } finally { await reads.close(); await owner.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('catalog router selection obeys protocol/node gates and never touches poisoned synchronous authority', async () => {
  const f = fixture();
  const app = new Hono(); let calls = 0;
  const port = { reads: { directory: (...args: Parameters<AsyncSessionReads['directory']>) => { calls++; return f.reads.directory(...args); },
    state: (...args: Parameters<AsyncSessionReads['state']>) => { calls++; return f.reads.state(...args); } } };
  const config = loadConfig({ AOD_CONNECTOR_TOKENS_FILE: join(f.root, 'unused.json'), AOD_CONNECTOR_USERS_DATABASE_FILE: join(f.root, 'unused.sqlite') } as NodeJS.ProcessEnv);
  const routes = registerConnectorRoutes(app, { config, connectorUsers: f.store, store: f.deck,
    tokens: { authenticateAuthorization() { throw new Error('legacy auth'); }, hasScope() { throw new Error('legacy scope'); } } as unknown as ConnectorTokenStore,
    sessionReads: port, gateway: {} as Parameters<typeof registerConnectorRoutes>[1]['gateway'],
    refreshSessions: async () => { throw new Error('legacy refresh'); }, sessionSnapshotReady: () => false, historySnapshotReady: () => false,
    refreshMessages: async () => {}, fallbackAgents: () => [], isAuthorizedRequest: () => true, normalizeError: () => 'private' });
  try {
    for (const path of ['directory', 'state']) {
      const url = `/api/connector/v1/sessions/${path}`;
      assert.equal((await app.request(url, { headers: { authorization, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
      assert.equal((await app.request(url, { headers: { authorization, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
      const before = calls, result = await app.request(url, { headers: { authorization } });
      assert.equal(result.status, 200); assert.equal(calls, before + 1); assert.equal(result.headers.get(NODE_ID_HEADER), f.store.nodeId);
    }
    assert.equal(calls, 2);
    assert.equal((await app.request('/api/connector/v1/sessions/directory', { headers: { authorization: 'Bearer invalid' } })).status, 403);
  } finally { await routes.close(); await f.close(); }
});
