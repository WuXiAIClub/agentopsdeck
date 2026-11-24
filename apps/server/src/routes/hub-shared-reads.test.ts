import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ChatMessage } from '@agentopsdeck/shared';
import { createConditionalHistoryCache, restoreHistoryDelta, HISTORY_DELTA_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { createConnectorClientResolver } from '../hub/connector-client.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { ArtifactRegistry } from '../messages/artifact-receiver.js';
import { mediaResourceId } from '../messages/media-resource.js';
import { loadConfig } from '../config.js';
import { registerConnectorRoutes } from './connector.js';
import { registerHubRoutes } from './hub.js';
import { parseConnectorEvents } from '../connector/sse.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';

async function fixture(mode: 'local' | 'http' = 'local', runtime: 'codex' | 'openclaw' = 'codex', events = false, directory = false, channel = false, files = false, workspaceConfigured = files, fileWrites = false, issues = false) {
  const dir = mkdtempSync(join(tmpdir(), 'shared-reads-')), previousHome = process.env.HOME;
  process.env.HOME = dir;
  const inbound = join(dir, '.local', 'share', 'agentopsdeck', 'media', 'inbound'); mkdirSync(inbound, { recursive: true, mode: 0o700 });
  const hub = new HubStore(join(dir, 'hub.sqlite'), 'synthetic-vault');
  const alice = hub.createUser('Alice'), bob = hub.createUser('Bob'), charlie = hub.createUser('Charlie');
  const ownerUserId = mode === 'local' ? 'default' : alice.id;
  const login = hub.identities.issueKey(bob.id), other = hub.identities.issueKey(charlie.id), ownerLogin = hub.identities.issueKey(ownerUserId);
  const workspace = join(dir, 'workspace'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'report.md'), '# Connector-only report');
  const config = loadConfig({ HOME: dir, AOD_SERVER_ROLE: 'hub', ...(workspaceConfigured ? { AOD_FILE_ROOTS_JSON: JSON.stringify({ codex: workspace }) } : {}) });
  const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'));
  const token = tokens.create({ label: 'Synthetic scoped', scopes: ['messages:read', 'media:read', ...(events ? ['events:read' as const] : []), ...(directory ? ['sessions:read' as const] : []), ...(files ? ['files:read' as const] : []), ...(fileWrites ? ['files:write' as const] : []), ...(issues ? ['issues:read' as const] : [])] });
  const users = new ConnectorUserStore(join(dir, 'connector.sqlite'));
  const deck = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json'), ...(events ? { eventLog: users.events } : {}) });
  const registry = new ArtifactRegistry(join(dir, 'artifacts.json'));
  config.artifactReceiver = { ...config.artifactReceiver, enabled: true, allowedDirs: [dir], indexFile: join(dir, 'artifacts.json') };
  const sessionKey = runtime === 'codex' ? 'codex:shared/空 格' : channel ? 'agent:synthetic:feishu:direct:original' : 'agent:main:dashboard:shared/空 格';
  const artifact = join(dir, 'report.zip'); writeFileSync(artifact, 'artifact');
  const info = statSync(artifact), artifactId = 'a'.repeat(32);
  registry.upsert({ id: artifactId, path: artifact, name: 'report.zip', mimeType: 'application/zip', size: info.size, mtimeMs: info.mtimeMs, createdAt: 1 });
  const message: ChatMessage = { id: 'message:one', sessionKey, role: 'assistant', text: 'Synthetic files', createdAt: 1,
    media: [{ type: 'file', name: 'file.bin', url: '/api/media/inbound/file.bin' }, { type: 'file', name: 'report.zip', url: `/api/artifacts/${artifactId}` },
      { type: 'file', name: 'external', url: 'https://example.invalid/file' }] };
  writeFileSync(join(inbound, 'file.bin'), Buffer.alloc(1024 * 1024, 7), { mode: 0o600 }); deck.addMessage(message);
  let refresh = async () => {};
  let historyReady = true;
  const connector = new Hono();
  registerConnectorRoutes(connector, { config, tokens, connectorUsers: users, store: deck, artifactRegistry: registry, sessionSnapshotReady: () => true, historySnapshotReady: () => historyReady,
    gateway: { request: async () => { throw new Error('No real execution allowed'); } } as any,
    refreshSessions: async () => {}, refreshMessages: () => refresh(), fallbackAgents: () => [], isAuthorizedRequest: () => false, normalizeError: () => 'Synthetic' });
  const calls: string[] = [];
  let after = async (response: Response, _request: Request) => response;
  const dispatch = async (request: Request) => { calls.push(new URL(request.url).pathname); return after(await connector.fetch(request), request); };
  const remote = mode === 'http' ? serve({ fetch: dispatch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (remote && !remote.listening) await new Promise<void>(resolve => remote.once('listening', resolve));
  const connection = { id: 'shared', ownerUserId, kind: mode === 'local' ? 'local' as const : 'remote' as const, label: 'Synthetic',
    connectorUrl: remote ? `http://127.0.0.1:${(remote.address() as { port: number }).port}` : 'local://aod-connector', credentialToken: token.token,
    ...(events ? { capabilities: ['events', 'messages', 'media'] } : {}) };
  hub.upsertConnection(connection); hub.pinConnectionNode(connection.id, ownerUserId, hub.connectionAuthority(connection.id, ownerUserId)!, users.nodeId);
  const target = { ownerUserId, connectionId: connection.id, userId: bob.id }, resource = { runtime, sessionKey };
  const read = hub.grants.create(target, { ...resource, actions: ['messages:read'] });
  const media = hub.grants.create(target, { ...resource, actions: ['media:read'] });
  const resolve = createConnectorClientResolver(hub, mode === 'local' ? { connectionId: connection.id, token: token.token, dispatch } : undefined);
  const app = new Hono(), routes = registerHubRoutes(app, { config, hubStore: hub, connectorClient: resolve, normalizeError: () => 'Synthetic',
    principal: request => hub.identities.keyPrincipal(request.headers.get('authorization')?.slice(7)) });
  const sessionId = encodeHubSessionId(connection.id, sessionKey), base = `/api/hub/v1/shared/${ownerUserId}/sessions/${encodeURIComponent(sessionId)}`;
  const request = (path = base + '/messages', credential = login.token, headers: Record<string, string> = {}, signal?: AbortSignal) => app.request(path, { ...(signal ? { signal } : {}), headers: { authorization: `Bearer ${credential}`, ...headers } });
  const writeText = (body: unknown, credential = ownerLogin.token) => app.request(`/api/hub/v1/connections/${connection.id}/files/agents/codex/text`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { dir, config, hub, users, deck, message, sessionId, base, calls, connection, target, resource, read, media, token, tokens, login, other, ownerLogin, resolve, request, writeText,
    after: (fn: typeof after) => { after = fn; }, refresh: (fn: typeof refresh) => { refresh = fn; },
    ready: (value: boolean) => { historyReady = value; },
    drainRoutes: () => routes!.close(),
    async close() {
      await routes?.close();
      if (remote) { if ('closeAllConnections' in remote) remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); }
      await hub.close(); await users.close();
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const mode of ['local', 'http'] as const) for (const historyStatus of ['cached', 'verified-session'] as const)
test(`${mode}: shared history preserves ${historyStatus} without inventing a global cursor`, async () => {
  const f = await fixture(mode);
  try {
    f.after(async (response, request) => {
      if (!new URL(request.url).pathname.endsWith('/messages') || response.status !== 200) return response;
      const page = await response.json();
      delete page.sourceCursor;
      const headers = new Headers(response.headers);
      headers.delete(HISTORY_DELTA_HEADER);
      headers.delete('etag');
      headers.delete('x-agentopsdeck-history-meta');
      return Response.json({ ...page, revision: `${historyStatus}:fixture`, historyStatus }, { headers });
    });
    const response = await f.request();
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.historyStatus, historyStatus); assert.equal(page.sourceCursor, undefined);
    assert.equal(page.messages.length, 1);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: source cards require exact connection owner and recheck replaced credentials`, async () => {
  for (const kind of ['files/git/roots', 'issues/sources']) {
    const f = await fixture(mode, 'codex', false, false, false, true, true, false, true);
    try {
      const path = `/api/hub/v1/connections/${f.connection.id}/${kind}`;
      const before = f.calls.length;
      for (const key of [f.login.token, f.other.token]) assert.equal((await f.request(path, key)).status, 404);
      assert.equal(f.calls.length, before, 'session grants never imply repository/provider access');
      const allowed = await f.request(path, f.ownerLogin.token); assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('cache-control'), 'no-store');
      const unknown = `/api/hub/v1/connections/${f.connection.id}/${kind.startsWith('files') ? 'files/git/codex/tree?url=https://evil.invalid' : 'issues/source/items?project=other'}`;
      const count = f.calls.length;
      assert.equal((await f.request(unknown, f.ownerLogin.token)).status, 400); assert.equal(f.calls.length, count);
      f.after(async response => { f.hub.upsertConnection({ ...f.connection, credentialToken: 'replaced-synthetic' }); return response; });
      const revoked = await f.request(path, f.ownerLogin.token); assert.notEqual(revoked.status, 200);
      const value = await revoked.text(); assert.ok(!value.includes('"sources"')); assert.ok(!value.includes('"roots"'));
    } finally { await f.close(); }
  }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: file editor owner isolation, stale revisions and no replay after uncertain receipt`, async () => {
  const f = await fixture(mode, 'codex', false, false, false, true, true, true);
  try {
    const previewPath = `/api/hub/v1/connections/${f.connection.id}/files/agents/codex/preview?path=report.md`;
    const preview = await (await f.request(previewPath, f.ownerLogin.token)).json();
    assert.equal(preview.canEdit, true);
    const body = { path: 'report.md', revision: preview.revision, text: 'Human edit' };
    const before = f.calls.length;
    for (const key of [f.login.token, f.other.token]) assert.equal((await f.writeText(body, key)).status, 404);
    assert.equal(f.calls.length, before, 'shared access cannot submit workspace edits');
    const saved = await f.writeText(body); assert.equal(saved.status, 200);
    assert.equal((await (await f.request(previewPath, f.ownerLogin.token)).json()).text, 'Human edit');
    assert.equal((await f.writeText(body)).status, 409);
    const receipt = await saved.json();
    f.after(async (response, request) => { if (request.method === 'POST') f.hub.upsertConnection({ ...f.connection, credentialToken: 'replaced-synthetic' }); return response; });
    const start = f.calls.length;
    assert.notEqual((await f.writeText({ ...body, revision: receipt.revision, text: 'Single attempt' })).status, 200);
    assert.equal(f.calls.slice(start).filter(path => path.endsWith('/text')).length, 1, 'uncertain save is never replayed');
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: history validators recheck read readiness and grants, including revocation in flight`, async () => {
  const f = await fixture(mode);
  try {
    const first = await f.request(); assert.equal(first.status, 200);
    const headers = { 'if-none-match': first.headers.get('etag')! };
    assert.ok(headers['if-none-match']);
    const same = await f.request(undefined, undefined, headers);
    assert.equal(same.status, 304); assert.equal(await same.text(), '');
    f.ready(false);
    assert.equal((await f.request(undefined, undefined, headers)).status, 502, 'shared route preserves its upstream-failure mapping, never 304');
    f.ready(true);
    f.after(async response => {
      f.hub.grants.revoke(f.target, f.read.id, f.read.version);
      return response;
    });
    assert.equal((await f.request(undefined, undefined, headers)).status, 403, 'post-await authority is checked before 304');
    assert.equal((await f.request(undefined, undefined, headers)).status, 404, 'subsequent denied requests do not reveal the resource');
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: real owner/shared routes negotiate deltas on both hops and retain revocation fences`, async () => {
  const f = await fixture(mode);
  try {
    for (let index = 0; index < 199; index++) f.deck.addMessage({ ...f.message, id: `history:${index}`, text: `history ${index} `.repeat(100), createdAt: index + 2 });
    const upstream: Array<{ status: number; delta: string | null; bytes: number }> = [];
    f.after(async response => { upstream.push({ status: response.status, delta: response.headers.get(HISTORY_DELTA_HEADER), bytes: (await response.clone().arrayBuffer()).byteLength }); return response; });
    for (const [base, token] of [[f.base, f.login.token], [`/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}`, f.ownerLogin.token]]) {
      const cache = createConditionalHistoryCache();
      const first = await f.request(base + '/messages?limit=200', token, { [HISTORY_DELTA_HEADER]: '1' });
      assert.equal(first.status, 200); cache.put('page', first.headers.get('etag'), await first.json());
      f.deck.addMessage({ ...f.message, id: 'history:198', text: `stream updated for ${base}`, createdAt: 200 });
      const previous = cache.get('page')!;
      const changed = await f.request(base + '/messages?limit=200', token, { [HISTORY_DELTA_HEADER]: '1', 'if-none-match': previous.etag });
      assert.equal(changed.status, 200); assert.equal(changed.headers.get(HISTORY_DELTA_HEADER), '1');
      assert.equal(upstream.at(-1)!.delta, '1', 'Connector also sent a delta, not a full page');
      const reconstructed = restoreHistoryDelta(previous, await changed.json());
      const full = await f.request(base + '/messages?limit=200', token);
      const { updatedAt: _time, sourceCursor: _cursor, ...content } = await full.json();
      const { updatedAt: _otherTime, sourceCursor: _otherCursor, ...restored } = reconstructed;
      assert.deepEqual(restored, content);
      assert.equal(upstream.at(-1)!.status, 304, 'unchanged Connector content transfers no body');
      assert.equal(upstream.at(-1)!.bytes, 0);
    }
    const first = await f.request(undefined, undefined, { [HISTORY_DELTA_HEADER]: '1' });
    const headers = { [HISTORY_DELTA_HEADER]: '1', 'if-none-match': first.headers.get('etag')! };
    f.deck.addMessage({ ...f.message, text: 'changed before revocation' });
    f.after(async response => { f.hub.grants.revoke(f.target, f.read.id, f.read.version); return response; });
    assert.equal((await f.request(undefined, undefined, headers)).status, 403);
    assert.equal((await f.request(undefined, undefined, headers)).status, 404);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: owner and shared history expose bounded Connector message limits without another capability request`, async () => {
  const f = await fixture(mode);
  try {
    let window = 200;
    for (const [limits, expected] of [
      [{ maxMessageChars: 100000 }, 100000],
      [undefined, 20000],
      [{ maxMessageChars: -1 }, 20000],
      [{ maxMessageChars: 500000, privateField: 'must not leak' }, 100000],
    ] as const) {
      f.after(async response => {
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response;
        const body = await response.json();
        return new Response(JSON.stringify({ ...body, limits }), { status: response.status, headers: response.headers });
      });
      for (const [base, token] of [[f.base, f.login.token], [`/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}`, f.ownerLogin.token]]) {
        const start = f.calls.length;
        // This fixture rewrites the upstream JSON without regenerating its
        // validator. Use an independent page per injected capability variant.
        const response = await f.request(base + `/messages?limit=${window--}`, token);
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).limits, { maxMessageChars: expected });
        assert.equal(f.calls.slice(start).some(path => path.includes('/capabilities')), false);
      }
    }
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: source previews use original Connector and existing owner/shared media authorization`, async () => {
  const f = await fixture(mode);
  try {
    const file = join(f.dir, 'source.ts'); writeFileSync(file, 'const example = 1;');
    // Register routes retains this config object; no real project files/credentials are used.
    f.config.sourcePreview!.allowedDirs.push(f.dir);
    f.deck.addMessage({ ...f.message, text: `[source](${file}:1)` });
    for (const [base, token] of [[f.base, f.login.token], [`/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}`, f.ownerLogin.token]]) {
      const messages = await f.request(base + '/messages', token); assert.equal(messages.status, 200);
      const source = (await messages.json()).messages[0].media.find((item: any) => item.sourceReference);
      assert.ok(source); assert.ok(source.url.startsWith(base + '/messages/'));
      const response = await f.request(source.url, token); assert.equal(response.status, 200);
      assert.equal((await response.json()).text, 'const example = 1;');
    }
    const source = (await (await f.request()).json()).messages[0].media.find((item: any) => item.sourceReference);
    assert.equal((await f.request(source.url, f.other.token)).status, 404);
    f.hub.grants.revoke(f.target, f.media.id, f.media.version);
    const before = f.calls.length;
    assert.equal((await f.request(source.url)).status, 403); assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) {
  test(`${mode}: workspace HTTP is exact-owner only, read-only and node-fenced`, async () => {
    const f = await fixture(mode, 'codex', false, false, false, true);
    const root = `/api/hub/v1/connections/${f.connection.id}/files`;
    try {
      const roots = await f.request(`${root}/roots`, f.ownerLogin.token);
      assert.equal(roots.status, 200); assert.equal(roots.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await roots.json(), { roots: [{ agentId: 'codex', label: 'codex', readOnly: true }] });
      const paths = [`${root}/roots`, `${root}/agents/codex`, `${root}/agents/codex/preview?path=report.md`, `${root}/agents/codex/download?path=report.md`];
      for (const path of paths) {
        const before = f.calls.length;
        for (const key of [f.login.token, f.other.token]) assert.equal((await f.request(path, key)).status, 404);
        assert.equal(f.calls.length, before, 'session read/media grants cannot browse owner workspace');
        const response = await f.request(path, f.ownerLogin.token);
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        if (path.includes('/download')) {
          assert.equal(await response.text(), '# Connector-only report');
          assert.match(response.headers.get('content-disposition')!, /^attachment/);
        } else if (path.includes('/preview')) assert.equal((await response.json()).text, '# Connector-only report');
      }
      assert.notEqual((await f.request(`${root}/agents/codex/preview?path=..%2Fhub.sqlite`, f.ownerLogin.token)).status, 200);
      assert.equal((await f.request(`${root}/agents/hermes`, f.ownerLogin.token)).status, 404);
      f.after(async response => {
        const headers = new Headers(response.headers); headers.set('x-agentopsdeck-node-id', 'node_11111111-1111-4111-8111-111111111111');
        return new Response(response.body, { status: response.status, headers });
      });
      for (const path of paths) assert.notEqual((await f.request(path, f.ownerLogin.token)).status, 200, 'foreign node response must not be rendered');
    } finally { await f.close(); }
  });
  test(`${mode}: workspace in-flight reads and downloads are revoked before delivery`, async () => {
    for (const operation of ['roots', 'agents/codex/preview?path=report.md', 'agents/codex/download?path=report.md']) {
      const f = await fixture(mode, 'codex', false, false, false, true);
      try {
        f.after(async response => { f.hub.upsertConnection({ ...f.connection, credentialToken: 'replacement-synthetic' }); return response; });
        const response = await f.request(`/api/hub/v1/connections/${f.connection.id}/files/${operation}`, f.ownerLogin.token);
        assert.notEqual(response.status, 200, operation);
        assert.equal((await response.text()).includes('Connector-only report'), false);
      } finally { await f.close(); }
    }
  });
  test(`${mode}: workspace requires files scope even for the owner`, async () => {
    const f = await fixture(mode, 'codex', false, false, false, false, true);
    try { assert.equal((await f.request(`/api/hub/v1/connections/${f.connection.id}/files/roots`, f.ownerLogin.token)).status, 403); }
    finally { await f.close(); }
  });
}

for (const mode of ['local', 'http'] as const) test(`${mode}: hot older history avoids hydration; cold and latest history refresh with readiness fences`, async () => {
  const f = await fixture(mode);
  try {
    const path = `/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}/messages`;
    let refreshes = 0;
    f.refresh(async () => { refreshes++; f.ready(true); });
    const older = `${path}?before=${encodeURIComponent(f.message.id)}&limit=200`;
    assert.equal((await f.request(older, f.ownerLogin.token)).status, 200);
    assert.equal(refreshes, 0);
    f.ready(false);
    assert.equal((await f.request(older, f.ownerLogin.token)).status, 200);
    assert.equal(refreshes, 1);
    assert.equal((await f.request(path, f.ownerLogin.token)).status, 200);
    assert.equal(refreshes, 2);
    assert.equal((await f.request(`${path}?before=unknown`, f.ownerLogin.token)).status, 409);
    assert.equal(refreshes, 3);
    f.ready(false); f.refresh(async () => {});
    assert.equal((await f.request(older, f.ownerLogin.token)).status, 503);
    f.ready(true); assert.equal(f.tokens.revoke(f.token.record.id), true);
    assert.equal((await f.request(older, f.ownerLogin.token)).status, 403);
  } finally { await f.close(); }
});

async function openEvents(f: Awaited<ReturnType<typeof fixture>>, path = f.base + '/events/stream', credential?: string, cursor?: string, retryDraining = false) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
  let response = await f.request(path, credential, cursor ? { 'last-event-id': cursor } : {}, signal);
  while (retryDraining && response.status === 503) {
    assert.equal(response.headers.get('retry-after'),'1');
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{error:'Shared event subscription unavailable'});
    // Only the same read subscription is retried; the server retains its
    // original feed until real settlement. No message/command is dispatched.
    assert.equal(signal.aborted,false,'original feed must eventually settle');
    await delay(25,undefined,{signal});
    response = await f.request(path,credential,cursor ? {'last-event-id':cursor} : {},signal);
  }
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream\b/);
  const iterator = parseConnectorEvents(response.body!, signal);
  const frames: string[] = [];
  const next = async (type: string) => {
    for (;;) {
      const result = await iterator.next();
      if (result.done) return result;
      frames.push(result.value.data);
      if (result.value.event === type) return result;
    }
  };
  await next('heartbeat');
  return { next, frames, close: async () => { controller.abort(); await iterator.return(undefined); } };
}

for (const mode of ['local', 'http'] as const) test(`${mode}: owner and shared history page beyond 500 with scoped stable anchors`, async () => {
  const f = await fixture(mode);
  try {
    for (let n = 0; n < 1050; n++) f.deck.addMessage({ id: `page:${n}`, sessionKey: f.resource.sessionKey,
      role: 'assistant', text: `History ${n}`, createdAt: n + 2 });
    f.deck.addMessage({ id: 'foreign-anchor', sessionKey: 'codex:foreign', role: 'assistant', text: 'Must not escape', createdAt: 1 });
    for (const [path, credential] of [[f.base + '/messages', f.login.token],
      [`/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}/messages`, f.ownerLogin.token]]) {
      let before: string | undefined, remaining = 1;
      const ids: string[] = [];
      while (remaining > 0) {
        const response = await f.request(`${path}?limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`, credential);
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.ok(page.messages.length <= 200);
        assert.ok(page.messages.every((message: ChatMessage) => message.sessionKey === f.sessionId));
        ids.unshift(...page.messages.map((message: ChatMessage) => message.id));
        before = page.messages[0]?.id;
        remaining = page.hiddenCount;
      }
      assert.equal(ids.length, 1051);
      assert.equal(new Set(ids).size, 1051);
      assert.equal(ids[0], f.message.id);
      const foreign = await f.request(`${path}?limit=200&before=foreign-anchor`, credential);
      assert.notEqual(foreign.status, 200);
      assert.doesNotMatch(await foreign.text(), /Must not escape/);
    }
    const anchor = encodeURIComponent('page:850');
    assert.equal((await f.request(`${f.base}/messages?limit=200&before=${anchor}`, f.other.token)).status, 404);
    f.hub.grants.revoke(f.target, f.read.id, f.read.version);
    assert.equal((await f.request(`${f.base}/messages?limit=200&before=${anchor}`)).status, 404);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: history action hints use current exact Hub policy, not upstream claims`, async () => {
  const f = await fixture(mode, 'codex', true);
  try {
    const hints = async () => { const response = await f.request(); assert.equal(response.status, 200); return (await response.json()).access; };
    f.after(async response => response.status === 304 ? response : new Response(JSON.stringify({ ...await response.json(), access: { messagesSend: true, eventsRead: true } }), { status: response.status, headers: response.headers }));
    assert.deepEqual(await hints(), { messagesSend: false, messagesMirror: false, eventsRead: false });
    f.hub.grants.create(f.target, { runtime: 'codex', sessionKey: 'codex:other', actions: ['messages:send', 'events:read'] });
    assert.deepEqual(await hints(), { messagesSend: false, messagesMirror: false, eventsRead: false });
    const grant = f.hub.grants.create(f.target, { ...f.resource, actions: ['messages:send', 'events:read'] });
    assert.deepEqual(await hints(), { messagesSend: true, messagesMirror: false, eventsRead: true });
    f.after(async response => { f.hub.grants.revoke(f.target, grant.id, grant.version); return response; });
    assert.deepEqual(await hints(), { messagesSend: false, messagesMirror: false, eventsRead: false });
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.every(path => path.endsWith('/messages')), 'hints add no upstream permissions, issuer or lease requests');
  } finally { await f.close(); }
});

test('history event hints require advertised events capability even with a policy', async () => {
  const f = await fixture();
  try {
    f.hub.grants.create(f.target, { ...f.resource, actions: ['messages:send', 'events:read'] });
    const response = await f.request(); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).access, { messagesSend: true, messagesMirror: false, eventsRead: false });
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) for (const runtime of ['openclaw', 'codex'] as const) {
  test(`${mode} ${runtime}: mirror hints require the original channel and combined grant, and revoke after reads`, async () => {
    const setup = await fixture(mode, runtime, false, false, true);
    try {
      const hints = async () => { const response = await setup.request(); assert.equal(response.status, 200); return (await response.json()).access; };
      setup.after(async response => response.status === 304 ? response : new Response(JSON.stringify({ ...await response.json(), access: { messagesSend: true, messagesMirror: true } }), { status: response.status, headers: response.headers }));
      assert.equal((await hints()).messagesMirror, false);
      const send = setup.hub.grants.create(setup.target, { ...setup.resource, actions: ['messages:send'] });
      const mirror = setup.hub.grants.create(setup.target, { ...setup.resource, actions: ['messages:mirror'] });
      assert.deepEqual(await hints(), { messagesSend: true, messagesMirror: false, eventsRead: false });
      setup.hub.grants.revoke(setup.target, send.id, send.version);
      setup.hub.grants.revoke(setup.target, mirror.id, mirror.version);
      const combined = setup.hub.grants.create(setup.target, { ...setup.resource, actions: ['messages:send', 'messages:mirror'] });
      assert.equal((await hints()).messagesMirror, runtime === 'openclaw');
      setup.after(async response => { setup.hub.grants.revoke(setup.target, combined.id, combined.version); return response; });
      assert.deepEqual(await hints(), { messagesSend: false, messagesMirror: false, eventsRead: false });
      assert.equal(setup.calls.length, 4);
      assert.ok(setup.calls.every(path => path.endsWith('/messages')));
      assert.equal(setup.hub.executionIssuers.current(setup.target.ownerUserId, setup.connection.id), undefined);
    } finally { await setup.close(); }
  });
}

test('OpenClaw web-only session has no channel mirror hint even with a combined policy', async () => {
  const setup = await fixture('local', 'openclaw');
  try {
    setup.hub.grants.create(setup.target, { ...setup.resource, actions: ['messages:send', 'messages:mirror'] });
    const response = await setup.request(); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).access, { messagesSend: true, messagesMirror: false, eventsRead: false });
  } finally { await setup.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: Hub discovery uses one named recipient grant and separates listing from reading`, async () => {
  const f = await fixture(mode, 'codex', false, true);
  try {
    for (let n = 104; n >= 0; n--) f.deck.upsertSession({ sessionKey: `codex:${String(n).padStart(3, '0')}`, agentId: 'codex', title: 'private title', status: 'running' });
    f.deck.upsertSession({ sessionKey: 'agent:main:dashboard:private-other-runtime', agentId: 'main', title: 'private', status: 'idle' });
    const grant = f.hub.grants.create(f.target, { runtime: 'codex', actions: ['sessions:read'] });
    const path = `/api/hub/v1/shared/${f.target.ownerUserId}/connections/${f.connection.id}/grants/${grant.id}/sessions`;
    const before = f.calls.length;
    const first = await f.request(path + '?limit=100');
    assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
    const page = await first.json();
    assert.equal(page.sessions.length, 100); assert.equal(page.nextCursor, 'codex:099');
    assert.deepEqual(page.sessions[0], { sessionKey: 'codex:000', runtime: 'codex', sessionId: null });
    assert.equal(JSON.stringify(page).includes('private'), false);
    assert.equal(f.calls.length, before + 1, 'one scoped Connector request');
    assert.ok(f.calls.at(-1)!.endsWith('/sessions/directory'));
    assert.equal(f.hub.executionIssuers.current(f.target.ownerUserId, f.connection.id), undefined, 'discovery creates no issuer');
    const second = await (await f.request(path + '?limit=100&after=codex%3A099')).json();
    assert.equal(second.sessions.length, 5); assert.equal(second.nextCursor, null);
    const readable = f.hub.grants.create(f.target, { runtime: 'codex', sessionKey: 'codex:000', actions: ['messages:read'] });
    const linked = await (await f.request(path + '?limit=2')).json();
    assert.equal(linked.sessions[0].sessionId, encodeHubSessionId(f.connection.id, 'codex:000'));
    assert.equal(linked.sessions[1].sessionId, null);
    f.hub.grants.revoke(f.target, readable.id, readable.version);
    assert.equal((await (await f.request(path + '?limit=1')).json()).sessions[0].sessionId, null);
    const noCalls = f.calls.length;
    for (const credential of [f.other.token, f.ownerLogin.token]) assert.equal((await f.request(path, credential)).status, 404);
    for (const query of ['runtime=openclaw', 'sessionKey=codex:001', 'agentId=main', 'ownerUserId=other', 'limit=1&limit=2', 'limit=101']) {
      assert.equal((await f.request(path + '?' + query)).status, 400);
    }
    for (const id of [f.read.id, 'missing']) assert.equal((await f.request(path.replace(grant.id, id))).status, 404);
    const agent = f.hub.grants.create(f.target, { runtime: 'codex', agentId: 'codex', actions: ['sessions:read'] });
    assert.equal((await f.request(path.replace(grant.id, agent.id))).status, 404, 'Agent metadata is not trusted authorization');
    assert.equal((await f.request(path.replace('/connections/shared/', '/connections/other/'))).status, 404);
    assert.equal(f.calls.length, noCalls, 'identity/scope/filter rejects happen before Connector');
    const exact = f.hub.grants.create(f.target, { runtime: 'codex', sessionKey: 'codex:005', actions: ['sessions:read'] });
    assert.deepEqual((await (await f.request(path.replace(grant.id, exact.id))).json()).sessions,
      [{ sessionKey: 'codex:005', runtime: 'codex', sessionId: null }]);
    f.after(async response => {
      const body = await response.json();
      return Response.json({ ...body, credential: 'private', sessions: body.sessions.map((item: object) => ({ ...item, title: 'private' })) }, { headers: response.headers });
    });
    assert.equal(JSON.stringify(await (await f.request(path)).json()).includes('private'), false);
    f.after(async response => Response.json({ ...await response.json(), sessions: [{ sessionKey: 'agent:main:dashboard:private', runtime: 'openclaw' }] }, { headers: response.headers }));
    assert.equal((await f.request(path)).status, 502, 'unfiltered or malformed upstream is not exposed');
    f.after(async response => { f.hub.grants.revoke(f.target, grant.id, grant.version); return response; });
    assert.equal((await f.request(path)).status, 403, 'original proof revalidated after transport');
    assert.equal((await f.request(path)).status, 404);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: discovery cannot replace a pending proof or follow rotated node credentials`, async () => {
  const f = await fixture(mode, 'codex', false, true);
  try {
    const grant = f.hub.grants.create(f.target, { actions: ['sessions:read'] });
    const path = `/api/hub/v1/shared/${f.target.ownerUserId}/connections/${f.connection.id}/grants/${grant.id}/sessions`;
    f.after(async response => { f.hub.grants.replace(f.target, grant.id, grant.version, { actions: ['sessions:read'] }); return response; });
    assert.equal((await f.request(path)).status, 403, 'same policy/new version does not revive pending read');
    f.after(async response => response);
    assert.equal((await f.request(path)).status, 200, 'explicit new GET can capture current authorization');
    f.hub.upsertConnection({ ...f.connection, credentialToken: 'rotated-synthetic' });
    const before = f.calls.length;
    assert.equal((await f.request(path)).status, 404); assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: directory credential bridge never broadens a captured discovery proof`, async () => {
  const f = await fixture(mode, 'codex', false, true);
  try {
    f.deck.upsertSession({ sessionKey: f.resource.sessionKey, agentId: 'codex', title: 'private', status: 'idle' });
    f.deck.upsertSession({ sessionKey: 'agent:main:dashboard:other', agentId: 'main', title: 'private', status: 'idle' });
    const broad = f.hub.grants.create(f.target, { actions: ['sessions:read'] });
    const clientFor = (resource: Parameters<typeof f.hub.grants.authorize>[2], action: 'sessions:read' | 'messages:read' = 'sessions:read') =>
      f.resolve(f.connection.id, false, f.target.userId, f.hub.grants.authorize(f.target, action, resource)!);
    const client = clientFor({ runtime: 'codex' });
    assert.deepEqual((await client.sessionDirectory({ runtime: 'codex' })).sessions, [{ ...f.resource }]);
    for (const path of ['/sessions/directory', '/sessions/directory?runtime=openclaw', '/sessions/directory?runtime=codex&runtime=openclaw',
      '/sessions/directory?runtime=codex&agentId=codex', '/sessions/directory?runtime=codex#ignored', '/sessions/state']) {
      const before = f.calls.length;
      await assert.rejects(client.json(path), { status: 403 }); assert.equal(f.calls.length, before, 'denied before transport');
    }
    await assert.rejects(client.json('/sessions/directory?runtime=codex', { method: 'POST' }), { status: 403 });
    await assert.rejects(client.sessionExecution(f.resource.sessionKey), { status: 403 });
    const exact = clientFor(f.resource);
    await assert.rejects(exact.sessionDirectory({ runtime: 'codex' }), { status: 403 });
    assert.equal((await exact.sessionDirectory(f.resource)).sessions.length, 1);
    assert.equal((await clientFor({}).sessionDirectory()).sessions.length, 2);
    await assert.rejects(clientFor({ ...f.resource, agentId: 'codex' }).sessionDirectory(f.resource), { status: 403 });
    await assert.rejects(clientFor(f.resource, 'messages:read').sessionDirectory(f.resource), { status: 403 });
    f.after(async response => { f.hub.grants.revoke(f.target, broad.id, broad.version); return response; });
    await assert.rejects(client.sessionDirectory({ runtime: 'codex' }), { status: 403 });
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${mode}/${runtime}: shared execution snapshot is exact, projection-only and independently authorized`, async () => {
    const f = await fixture(mode, runtime, true);
    try {
      assert.equal((await f.request(f.base + '/state')).status, 404, 'missing projection is not idle');
      f.deck.upsertSession({ sessionKey: f.resource.sessionKey, title: 'owner-private-title', agentId: runtime === 'codex' ? 'codex' : 'main',
        status: 'running', hasActiveRun: true, runStartedAt: 1, pinned: true, model: 'owner-private-model',
        runtime: { phase: 'finalizing', connection: 'disconnected', sync: 'error', lastEventAt: 2, turnId: 'turn', reason: 'private-diagnostics' } });
      f.refresh(async () => { throw new Error('Projection snapshot must not refresh runtime'); });
      const before = f.calls.length, response = await f.request(f.base + '/state');
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.deepEqual(body, { sessionKey: f.sessionId, sessionRef: { nodeId: f.users.nodeId, runtimeId: runtime,
        nativeSessionKey: runtime === 'codex' ? f.resource.sessionKey.slice(6) : f.resource.sessionKey },
        status: 'running', hasActiveRun: true, runStartedAt: 1, sourceCursor: f.deck.latestEventId(),
        runtime: { phase: 'finalizing', connection: 'disconnected', sync: 'error', lastEventAt: 2, turnId: 'turn' } });
      assert.equal(f.calls.length, before + 1, 'one exact Connector read, not catalog or runtime polling');
      assert.equal((await f.request(f.base + '/state', f.other.token)).status, 404);
      const proof = f.hub.grants.authorize(f.target, 'messages:read', f.resource)!;
      const client = f.resolve(f.connection.id, false, f.target.userId, proof);
      await assert.rejects(() => client.sessions(), /Node grant/);
      await assert.rejects(() => client.sessionExecution('codex:other'), /Node grant/);
      await assert.rejects(() => client.json(`/sessions/${encodeURIComponent(f.resource.sessionKey)}/state`, { method: 'POST' }), /Node grant/);
      f.after(async (response, request) => {
        if (new URL(request.url).pathname.endsWith('/state')) {
          const body = await response.json();
          return Response.json({ ...body, credential: 'private-extra', title: 'private-extra', runtime: { ...body.runtime, reason: 'private-extra' } }, { headers: response.headers });
        }
        return response;
      });
      assert.equal(JSON.stringify(await (await f.request(f.base + '/state')).json()).includes('private-extra'), false);
      for (const patch of [{ sessionKey: 'codex:other' }, { status: 'done' }, { runtime: { phase: 'running' } }, { sourceCursor: 123 }]) {
        f.after(async response => Response.json({ ...await response.json(), ...patch }, { headers: response.headers }));
        assert.equal((await f.request(f.base + '/state')).status, 502, 'invalid projection is not exposed');
      }
      f.after(async response => { f.hub.grants.revoke(f.target, f.read.id, f.read.version); return response; });
      assert.equal((await f.request(f.base + '/state')).status, 403, 'await revalidates original proof');
      assert.equal((await f.request(f.base + '/state')).status, 404);
    } finally { await f.close(); }
  });

  test(`${mode}/${runtime}: shared SSE reuses the owner feed, filters session payloads and replays exact invalidations`, async () => {
    const f = await fixture(mode, runtime, true);
    const streams: Awaited<ReturnType<typeof openEvents>>[] = [];
    try {
      f.hub.grants.create(f.target, { ...f.resource, actions: ['events:read'] });
      const owner = await openEvents(f, '/api/hub/v1/events/stream', f.ownerLogin.token); streams.push(owner);
      await owner.next('stream.reset');
      const shared = await openEvents(f); streams.push(shared);
      const another = await openEvents(f); streams.push(another);
      f.deck.append('message.created', { text: 'unrelated-private-body', command: 'private-tool-input' }, { sessionKey: 'codex:private' });
      f.deck.append('message.created', { text: 'shared-body-not-an-event-payload' }, { sessionKey: f.resource.sessionKey });
      const sourceCursor = f.deck.latestEventId();
      const first = await shared.next('session.invalidated');
      assert.equal(first.done, false);
      const data = JSON.parse(first.value!.data);
      assert.deepEqual(data, { type: 'session.invalidated', ts: data.ts, sessionKey: f.sessionId,
        sessionRef: { nodeId: f.users.nodeId, runtimeId: runtime, nativeSessionKey: runtime === 'codex' ? f.resource.sessionKey.slice(6) : f.resource.sessionKey },
        sourceCursor, payload: { invalidation: true } });
      assert.equal((await another.next('session.invalidated')).value!.id, first.value!.id);
      assert.equal(f.calls.filter(path => path.endsWith('/events/stream')).length, 1);
      assert.equal(shared.frames.join('').includes('private'), false);
      assert.equal(shared.frames.join('').includes('shared-body'), false);
      f.deck.append('message.updated', { text: 'second-body' }, { sessionKey: f.resource.sessionKey });
      const second = await shared.next('session.invalidated');
      await shared.close();
      const replay = await openEvents(f, undefined, undefined, first.value!.id); streams.push(replay);
      assert.equal((await replay.next('session.invalidated')).value!.id, second.value!.id);
      assert.equal(f.calls.filter(path => path.endsWith('/events/stream')).length, 1, 'reconnect reuses the remaining subscribers feed');
      const reset = await openEvents(f, undefined, undefined, 'hub:expired-cursor'); streams.push(reset);
      assert.equal(JSON.parse((await reset.next('stream.reset')).value!.data).payload.reason, 'cursor_expired');
    } finally { for (const stream of streams) await stream.close(); await f.close(); }
  });
}

for (const mode of ['local', 'http'] as const) test(`${mode}: managed OpenClaw lifecycle crosses shared snapshots and SSE without GET-driven dispatch`, async () => {
  const f = await fixture(mode, 'openclaw', true);
  const streams: Awaited<ReturnType<typeof openEvents>>[] = [];
  let sent = 0;
  const sessionKey = f.resource.sessionKey;
  f.deck.upsertSession({ sessionKey, title: 'private-owner-title', status: 'idle' });
  const queue = new OpenClawTurnQueue({ turns: f.users.turns, executions: f.users.openClawExecutions, store: f.deck,
    authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {}, mirror: async () => {},
    send: async () => { sent++; return sent === 1 ? { runId: 'owned' } : {}; } });
  const reconcile = () => (queue as any).reconcile(sessionKey) as Promise<void>;
  const state = async () => {
    const response = await f.request(f.base + '/state');
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    f.refresh(async () => { assert.fail('execution snapshots must not refresh runtime/history'); });
    f.hub.grants.create(f.target, { ...f.resource, actions: ['events:read'] });
    const owner = await openEvents(f, '/api/hub/v1/events/stream', f.ownerLogin.token); streams.push(owner);
    await owner.next('stream.reset');
    const shared = await openEvents(f); streams.push(shared);
    const another = await openEvents(f); streams.push(another);
    for (const id of ['one', 'two']) await queue.enqueueAsync({ id, sessionKey, createdAt: Date.now(),
      payload: { message: `private-command-${id}`, media: [], deliveryMode: 'web-only' } });
    assert.equal((await state()).status, 'idle');
    assert.equal(sent, 0, 'reads and subscriptions do not start the queue');
    await reconcile();
    f.deck.replaceSessions([{ key: sessionKey }]);
    f.deck.addMessage({ id: 'commentary', sessionKey, role: 'assistant', status: 'sent', text: 'private-final-looking-text', createdAt: Date.now() });
    const running = await state();
    assert.equal(running.status, 'running');
    assert.equal(running.runCompletedAt, undefined);
    assert.equal(running.sessionKey, f.sessionId);
    assert.equal(running.sessionRef.nodeId, f.users.nodeId);
    assert.equal(running.runtime, undefined, 'transport must not invent native run/health fields');
    assert.equal((await f.request(f.base + '/state', f.other.token)).status, 404);
    f.deck.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey, runId: 'old' } });
    assert.equal((await state()).status, 'running');
    f.deck.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey, runId: 'owned' } });
    const sourceCursor = f.deck.latestEventId();
    const completion = async (stream: Awaited<ReturnType<typeof openEvents>>) => {
      for (;;) {
        const event = await stream.next('session.invalidated');
        assert.equal(event.done, false);
        if (JSON.parse(event.value!.data).sourceCursor === sourceCursor) return event.value!;
      }
    };
    const first = await completion(shared), second = await completion(another);
    assert.equal(first.id, second.id, 'readers share the same Hub cursor');
    assert.notEqual(first.id, sourceCursor, 'Hub replay and Connector watermark remain separate');
    const completed = await state();
    assert.equal(completed.status, 'idle');
    assert.equal(completed.sourceCursor, sourceCursor);
    assert.ok(completed.runCompletedAt >= completed.runStartedAt);
    assert.equal(sent, 1, 'completion delivery does not run work in an unstarted worker');
    assert.equal(f.calls.filter(path => path.endsWith('/events/stream')).length, 1);
    assert.equal(shared.frames.join('').includes('private-'), false);
    await reconcile();
    assert.equal((await state()).status, 'unknown', 'accepted ACK without native identity is not guessed running/idle');
    f.deck.replaceSessions([{ key: sessionKey }]);
    f.deck.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey, runId: 'owned' } });
    await reconcile();
    assert.equal(sent, 2);
    assert.equal((await state()).status, 'unknown');
    f.after(async (response, request) => new URL(request.url).pathname.endsWith('/state')
      ? Response.json({ error: 'synthetic outage' }, { status: 503 }) : response);
    assert.equal((await f.request(f.base + '/state')).status, 502);
    f.after(async response => response);
    assert.equal((await state()).status, 'unknown', 'transport recovery does not complete a run');
    f.deck.invalidateOpenClawExecutionFacts();
    assert.equal((await f.request(f.base + '/state')).status, 502, 'unavailable facts never fall back to last idle');
  } finally { for (const stream of streams) await stream.close(); await queue.close(); await f.close(); }
});

test('shared SSE requires both exact read/event grants and browser identity before starting upstream work', async () => {
  const f = await fixture('local', 'codex', true);
  try {
    const path = f.base + '/events/stream';
    assert.equal((await f.request(path)).status, 403);
    assert.equal(f.calls.length, 0);
    const events = f.hub.grants.create(f.target, { ...f.resource, actions: ['events:read'] });
    assert.equal((await f.request(path, f.other.token)).status, 404);
    assert.equal((await f.request(path + '?recoveryScope=another-account')).status, 409);
    f.hub.grants.revoke(f.target, f.read.id, f.read.version);
    assert.equal((await f.request(path)).status, 404);
    assert.equal(f.calls.length, 0);
    f.hub.grants.revoke(f.target, events.id, events.version);
  } finally { await f.close(); }
});

test('two shared users on one node only receive their exact sessions without duplicate durable logs', async () => {
  const f = await fixture('local', 'codex', true);
  const streams: Awaited<ReturnType<typeof openEvents>>[] = [];
  try {
    f.hub.grants.create(f.target, { ...f.resource, actions: ['events:read'] });
    const otherId = f.hub.identities.keyPrincipal(f.other.token)!.userId;
    const otherKey = 'codex:other-resource';
    const otherSessionId = encodeHubSessionId(f.connection.id, otherKey);
    f.hub.grants.create({ ...f.target, userId: otherId }, { runtime: 'codex', sessionKey: otherKey, actions: ['messages:read', 'events:read'] });
    const otherPath = `/api/hub/v1/shared/${f.target.ownerUserId}/sessions/${encodeURIComponent(otherSessionId)}/events/stream`;
    assert.equal((await f.request(otherPath)).status, 404);
    const first = await openEvents(f); streams.push(first);
    await first.next('stream.reset');
    const second = await openEvents(f, otherPath, f.other.token); streams.push(second);
    f.deck.append('message.created', { text: 'first-private-body' }, { sessionKey: f.resource.sessionKey });
    f.deck.append('message.created', { text: 'second-private-body' }, { sessionKey: otherKey });
    const a = JSON.parse((await first.next('session.invalidated')).value!.data);
    const b = JSON.parse((await second.next('session.invalidated')).value!.data);
    assert.equal(a.sessionKey, f.sessionId);
    assert.equal(b.sessionKey, otherSessionId);
    assert.equal(second.frames.join('').includes(f.sessionId), false);
    assert.equal(first.frames.join('').includes(otherSessionId), false);
    assert.equal(f.calls.filter(path => path.endsWith('/events/stream')).length, 1);
    assert.equal(f.hub.latestDeliveryCursor(f.target.userId), undefined);
    assert.equal(f.hub.latestDeliveryCursor(otherId), undefined);
    assert.ok(f.hub.latestDeliveryCursor(f.target.ownerUserId));
  } finally { for (const stream of streams) await stream.close(); await f.close(); }
});

test('initial asynchronous directory gap triggers a scoped refresh that recovers messages written before Connector subscription', async () => {
  const f = await fixture('local', 'codex', true);
  const original = f.hub.listConnectionsAsync.bind(f.hub);
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.hub.listConnectionsAsync = async owner => { entered(); await pending; return original(owner); };
  let stream: Awaited<ReturnType<typeof openEvents>> | undefined;
  try {
    f.hub.grants.create(f.target, { ...f.resource, actions: ['events:read'] });
    stream = await openEvents(f); await started;
    assert.equal(f.calls.filter(path => path.endsWith('/events/stream')).length, 0, 'heartbeat is not upstream readiness');
    f.deck.addMessage({ ...f.message, id: 'during-original-directory', text: 'recoverable-before-subscription' });
    f.deck.append('message.created', { text: 'recoverable-before-subscription' }, { sessionKey: f.resource.sessionKey });
    f.hub.listConnectionsAsync = original; finish();
    const reset = await stream.next('stream.reset');
    assert.equal(reset.done, false);
    assert.equal(JSON.parse(reset.value!.data).payload.reason, 'source_changed');
    assert.equal(stream.frames.join('').includes('recoverable-before-subscription'), false, 'invalidation stream never forwards message bodies');
    const history = await f.request(); assert.equal(history.status, 200);
    assert.ok((await history.json()).messages.some((message: ChatMessage) => message.id === 'during-original-directory'));
  } finally { f.hub.listConnectionsAsync = original; finish(); await stream?.close(); await f.close(); }
});

for (const change of ['read', 'events', 'replace', 'logout', 'node', 'token'] as const) {
  test(`shared SSE closes or reports denied without forwarding data after ${change}`, async () => {
    const f = await fixture('local', 'codex', true);
    let stream: Awaited<ReturnType<typeof openEvents>> | undefined;
    try {
      const grant = f.hub.grants.create(f.target, { ...f.resource, actions: ['events:read'] });
      stream = await openEvents(f);
      // This case revokes an established feed, not just an initial browser
      // heartbeat. The reset is also the refresh contract for pre-feed gaps.
      await stream.next('stream.reset');
      f.deck.append('message.created', { text: 'before' }, { sessionKey: f.resource.sessionKey });
      await stream.next('session.invalidated');
      if (change === 'read') f.hub.grants.revoke(f.target, f.read.id, f.read.version);
      if (change === 'events') f.hub.grants.revoke(f.target, grant.id, grant.version);
      if (change === 'replace') f.hub.grants.replace(f.target, grant.id, grant.version, { ...f.resource, actions: ['events:read'] });
      if (change === 'logout') f.hub.identities.revokeKey(f.target.userId, f.login.id);
      if (change === 'node') f.hub.upsertConnection({ ...f.connection, status: 'disabled' });
      if (change === 'token') f.tokens.revoke(f.token.record.id);
      f.deck.append('message.created', { text: 'after-secret' }, { sessionKey: f.resource.sessionKey });
      if (change === 'token') {
        // EOF is first a disconnect; only the failed authenticated reconnect
        // proves denial, so do not collapse these two transport facts.
        let status;
        do { status = await stream.next('stream.status'); }
        while (!status.done && JSON.parse(status.value!.data).payload.connection !== 'unauthorized');
        assert.equal(status.done, false);
      } else assert.equal((await stream.next('session.invalidated')).done, true);
      assert.equal(stream.frames.join('').includes('after-secret'), false);
      if (change === 'replace') {
        const reopened = await openEvents(f,undefined,undefined,undefined,true);
        try {
          await reopened.next('stream.reset');
          f.deck.append('message.created', {}, { sessionKey: f.resource.sessionKey });
          assert.equal((await reopened.next('session.invalidated')).done, false, 'new request can explicitly use replacement proof');
        } finally { await reopened.close(); }
      }
    } finally { await stream?.close(); await f.close(); }
  });
}

test('owner and shared SSE temporary admission refuses without upstream IO and advertises read-only retry', async () => {
  const f = await fixture('local', 'codex', true);
  try {
    f.hub.grants.create(f.target, { ...f.resource, actions: ['events:read'] });
    await f.drainRoutes(); // Keep original identity/database, close only route admissions.
    const before = f.calls.length;
    for (const [path, key, error] of [
      [f.base + '/events/stream', f.login.token, 'Shared event subscription unavailable'],
      ['/api/hub/v1/events/stream', f.ownerLogin.token, 'Hub event subscription unavailable'],
    ] as const) {
      const response = await f.request(path, key);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '1');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error });
    }
    assert.equal(f.calls.length, before, 'refused subscriptions must not dispatch an upstream request');
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) test(`${mode}/${runtime}: shared history and attachment bytes keep exact owner/session identity`, async () => {
  const f = await fixture(mode, runtime);
  try {
    const response = await f.request(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await response.json() as any, message = page.messages[0];
    assert.equal(message.sessionKey, f.sessionId); assert.equal(message.sessionRef.nodeId, f.users.nodeId);
    assert.equal(message.sessionRef.runtimeId, runtime); assert.equal(message.media.length, 3);
    assert.equal(message.media[2].url, 'https://example.invalid/file');
    assert.ok(message.media[0].url.startsWith(f.base + '/messages/'));
    const partial = await f.request(message.media[0].url, undefined, { range: 'bytes=2-4' });
    assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 3);
    const artifact = await f.request(message.media[1].url, undefined, { range: 'bytes=-4' });
    assert.equal(artifact.status, 206); assert.equal(await artifact.text(), 'fact');
    const invalid = await f.request(message.media[0].url, undefined, { range: 'bytes=9999999-' });
    assert.equal(invalid.status, 416); assert.equal(await invalid.text(), '');
    assert.equal((await f.request(f.base + '/messages/' + encodeURIComponent(f.message.id))).status, 200);
    const count = f.calls.length;
    for (const path of [f.base + '/messages?limit=501', f.base + '/messages?limit=bad']) assert.equal((await f.request(path)).status, 400);
    assert.equal((await f.request(undefined, f.other.token)).status, 404);
    assert.equal((await f.request(message.media[0].url, f.other.token)).status, 404);
    assert.equal((await f.request(`/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}/messages`)).status, 404);
    assert.equal((await f.request(f.base.replace(encodeURIComponent(f.sessionId), encodeURIComponent(encodeHubSessionId('other', f.resource.sessionKey))) + '/messages')).status, 404);
    assert.equal(f.calls.length, count);
    f.hub.grants.revoke(f.target, f.media.id, f.media.version);
    assert.equal((await f.request()).status, 200, 'read does not require download scope');
    const before = f.calls.length;
    assert.equal((await f.request(message.media[0].url)).status, 403); assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

for (const mode of ['local', 'http'] as const) for (const runtime of ['codex', 'openclaw'] as const) test(`${mode}/${runtime}: owner history uses session-bound inbound and artifact routes`, async () => {
  const f = await fixture(mode, runtime);
  try {
    const base = `/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}`;
    const response = await f.request(base + '/messages', f.ownerLogin.token);
    assert.equal(response.status, 200);
    const message = (await response.json() as any).messages[0];
    assert.equal(message.remoteSessionKey, f.resource.sessionKey);
    assert.equal(message.sessionRef.nodeId, f.users.nodeId);
    assert.ok(message.media[0].url.startsWith(base + '/messages/'));
    const detail = await f.request(base + '/messages/' + encodeURIComponent(message.id), f.ownerLogin.token);
    assert.deepEqual((await detail.json() as any).message.media, message.media);
    const partial = await f.request(message.media[0].url, f.ownerLogin.token, { range: 'bytes=2-4' });
    assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 3);
    const artifact = await f.request(message.media[1].url, f.ownerLogin.token, { range: 'bytes=-4' });
    assert.equal(artifact.status, 206); assert.equal(await artifact.text(), 'fact');
    const invalid = await f.request(message.media[1].url, f.ownerLogin.token, { range: 'bytes=99999-' });
    assert.equal(invalid.status, 416); assert.equal(await invalid.text(), '');
    const full = await f.request(message.media[1].url, f.ownerLogin.token, { range: 'bytes=0-1', 'if-range': '"unmatched"' });
    assert.equal(full.status, 200); assert.equal(await full.text(), 'artifact');
    const calls = f.calls.length;
    // A shared grant is not owner permission, including for an already-known URL.
    assert.equal((await f.request(message.media[0].url)).status, 404);
    assert.equal((await f.request(message.media[1].url, f.other.token)).status, 404);
    assert.equal(f.calls.length, calls);
    f.deck.removeMessage(f.resource.sessionKey, f.message.id);
    const removed = await f.request(message.media[1].url, f.ownerLogin.token);
    assert.equal(removed.status, 404);
  } finally { await f.close(); }
});

for (const change of ['login', 'node', 'membership'] as const) test(`owner scoped file stream stops after ${change} changes`, async () => {
  const f = await fixture();
  try {
    const url = `/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}/messages/${encodeURIComponent(f.message.id)}/media/${mediaResourceId(f.message.media![0]!.url)}`;
    const response = await f.request(url, f.ownerLogin.token); assert.equal(response.status, 200);
    const reader = response.body!.getReader(); assert.ok((await reader.read()).value!.length);
    if (change === 'login') f.hub.identities.revokeKey(f.connection.ownerUserId, f.ownerLogin.id);
    else if (change === 'node') f.hub.upsertConnection({ ...f.connection, status: 'disabled' });
    else f.deck.removeMessage(f.resource.sessionKey, f.message.id);
    await assert.rejects(reader.read()); await reader.cancel().catch(() => {}); reader.releaseLock();
  } finally { await f.close(); }
});

test('owner history rejects upstream session and detail identity substitution', async () => {
  for (const detail of [false, true]) {
    const f = await fixture();
    try {
      f.after(async response => {
        const page = await response.json() as any;
        if (detail) page.message.id = 'other-message'; else page.messages[0].sessionKey = 'codex:private';
        return Response.json(page, { headers: response.headers });
      });
      const response = await f.request(`/api/hub/v1/sessions/${encodeURIComponent(f.sessionId)}/messages${detail ? '/' + encodeURIComponent(f.message.id) : ''}`, f.ownerLogin.token);
      assert.equal(response.status, 502);
      assert.doesNotMatch(await response.text(), /other-message|codex:private|file\.bin/);
    } finally { await f.close(); }
  }
});

for (const change of ['read', 'media', 'login', 'node', 'membership'] as const) test(`shared file streams stop after ${change} changes`, async () => {
  const f = await fixture();
  try {
    const url = `${f.base}/messages/${encodeURIComponent(f.message.id)}/media/${mediaResourceId(f.message.media![0]!.url)}`;
    const response = await f.request(url); assert.equal(response.status, 200);
    const reader = response.body!.getReader(); assert.ok((await reader.read()).value!.length);
    if (change === 'read' || change === 'media') f.hub.grants.revoke(f.target, f[change].id, f[change].version);
    else if (change === 'login') f.hub.identities.revokeKey(f.target.userId, f.login.id);
    else if (change === 'node') f.hub.upsertConnection({ ...f.connection, status: 'disabled' });
    else f.deck.removeMessage(f.message.sessionKey, f.message.id);
    await assert.rejects(reader.read()); await reader.cancel().catch(() => {}); reader.releaseLock();
  } finally { await f.close(); }
});

test('shared read proofs cannot expand to broad media, another session, writes or streams', async () => {
  const f = await fixture();
  try {
    const read = f.hub.grants.authorize(f.target, 'messages:read', f.resource)!;
    const media = f.hub.grants.authorize(f.target, 'media:read', f.resource)!;
    const readClient = f.resolve(f.connection.id, false, f.target.userId, read), mediaClient = f.resolve(f.connection.id, false, f.target.userId, media);
    await assert.rejects(readClient.sessionMedia(f.resource.sessionKey, f.message.id, mediaResourceId('a')), { status: 403 });
    await assert.rejects(mediaClient.media('file.bin'), { status: 403 });
    await assert.rejects(mediaClient.messages(f.resource.sessionKey), { status: 403 });
    await assert.rejects(mediaClient.sessionMedia('codex:other', f.message.id, mediaResourceId('a')), { status: 403 });
    await assert.rejects(readClient.json(`/sessions/${encodeURIComponent(f.resource.sessionKey)}/messages`, { method: 'POST', body: '{}' }), { status: 403 });
    await assert.rejects(readClient.events(new AbortController().signal).next(), { status: 403 });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('shared reads reject changed grants, logout, token revocation and mismatched upstream messages after awaits', async () => {
  for (const change of ['grant', 'login', 'token', 'identity'] as const) {
    const f = await fixture();
    try {
      if (change === 'token') f.refresh(async () => { f.tokens.revoke(f.token.record.id); });
      else f.after(async response => {
        if (change === 'grant') { f.hub.grants.revoke(f.target, f.read.id, f.read.version); f.hub.grants.create(f.target, { ...f.resource, actions: ['messages:read'] }); }
        if (change === 'login') f.hub.identities.revokeKey(f.target.userId, f.login.id);
        if (change === 'identity') {
          const page = await response.json() as any; page.messages[0].sessionKey = 'codex:private';
          return Response.json(page, { headers: response.headers });
        }
        return response;
      });
      const response = await f.request();
      assert.equal(response.status, change === 'login' ? 401 : change === 'identity' ? 502 : 403);
      assert.doesNotMatch(await response.text(), /Synthetic files|report.zip|private/);
    } finally { await f.close(); }
  }
});

test('shared message read forwards x-agentopsdeck-history-async header to connector', async () => {
  const f = await fixture('http');
  try {
    let seenHeader: string | null = null;
    f.after(async (response, request) => {
      seenHeader = request.headers.get('x-agentopsdeck-history-async');
      return response;
    });
    const res = await f.request(f.base + '/messages?limit=50', f.login.token, { 'x-agentopsdeck-history-async': '1' });
    assert.equal(res.status, 200);
    assert.equal(seenHeader, '1');
  } finally { await f.close(); }
});
