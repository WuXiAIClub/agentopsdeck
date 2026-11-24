import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { hubMemberEvidence, type HubMemberKind } from './member-owner-domain.js';
import { WorkspaceResearch } from './workspace-research.js';
import { WorkspaceReader } from './workspace-reader.js';
import { WorkspaceSynthesis } from './workspace-synthesis.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubResearchRoutes } from '../routes/hub-workspace-research.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { originalRequestScope, pinOriginalRequestScope } from './original-request-scope.js';

const base = '/api/hub/v1/workspace/research';
const ai = { url: 'https://ai.example/responses', model: 'fixture', token: 'PRIVATE_MODEL_TOKEN', users: ['default'] };
const extraction = { url: 'https://extract.example/read', users: ['default'], sourceOrigins: ['https://article.example'] };
const config = { searchUrl: 'https://search.example/search', users: ['default'], synthesis: ai, reader: extraction };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function provider(url: string, init?: RequestInit) {
  if (url === config.searchUrl) return Response.json({ results: [1, 2].map(i => ({ title: 'PRIVATE_TITLE', url: `https://article.example/${i}`, content: 'PRIVATE_SNIPPET' })) });
  const body = JSON.parse(init!.body as string);
  if (url === extraction.url) return Response.json({ url: body.url, text: 'PRIVATE_ARTICLE text for selected sources', truncated: false });
  assert.equal(url, ai.url);
  const input = JSON.parse(body.input[0].content) as { sources: { id: string }[] };
  return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
    text: JSON.stringify({ paragraphs: [{ text: 'PRIVATE_ANSWER', citations: input.sources.map(s => s.id) }], caveat: 'Unverified.' }) }] }] });
}
async function fixture(t: TestContext, mode: 'original' | 'worker', throwingSink = false, enableOther = false) {
  const root = mkdtempSync(join(tmpdir(), 'research-async-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const key = seed.identities.issueKey('default'), observer = seed.identities.issueKey('default');
  const session = seed.identities.createSession(key.token)!;
  const other = seed.createUser('Other'), otherKey = seed.identities.issueKey(other.id); await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); if (throwingSink) throw Error('sink failed'); });
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const behavior: { after?: (kind: HubMemberKind) => void | Promise<void>; audits: number;
    transport?: (url: string, init?: RequestInit) => Promise<Response>; calls: string[] } = { audits: 0, calls: [] };
  const port = { command: async (kind: HubMemberKind, value: never) => {
    const result = await owner.command(kind, value); if (kind === 'auditAppend') behavior.audits++;
    await behavior.after?.(kind); return result;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices({ ...port, weixinBackground: () => owner.weixinBackground(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), connectionControlSettlement: () => owner.connectionControlSettlement() }, diagnostics), access = group.createWorkspaceResearchAccess();
  const transport: typeof fetch = async (url, init) => { behavior.calls.push(String(url)); return behavior.transport ? behavior.transport(String(url), init) : provider(String(url), init); };
  const users = enableOther ? ['default', other.id] : ['default'];
  const researchConfig = { ...config, users, reader: { ...extraction, users }, synthesis: { ...ai, users } };
  const service = new WorkspaceResearch(researchConfig, transport), reader = new WorkspaceReader(researchConfig.reader, transport), synthesis = new WorkspaceSynthesis(researchConfig.synthesis, transport);
  const app = new Hono(), routes = registerHubResearchRoutes(app, { mode: 'async', service, reader, synthesis, access, diagnostics });
  const request = (path: string, body?: unknown, token = key.token, method = body === undefined ? 'GET' : 'POST') => new Request('http://hub.invalid' + base + '/' + path,
    { method, headers: { 'x-agentopsdeck-key': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const revoke = async () => {
    const evidence = hubMemberEvidence(request('config', undefined, observer.token));
    const current = await owner.command('memberSnapshot', evidence); assert.ok(current);
    assert.deepEqual(await owner.command('memberKeyRevoke', { evidence, expectedScope: current.recoveryScope, userId: 'default', keyId: key.id }), { ok: true });
  };
  t.after(async () => {
    await routes.close(); await group.close(); await owner.close(); await original?.close();
    for (const secret of [key.token, session, observer.token, otherKey.token, ai.token, 'PRIVATE_QUERY', 'PRIVATE_TITLE', 'PRIVATE_SNIPPET', 'PRIVATE_ARTICLE', 'PRIVATE_ANSWER'])
      assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, original, owner, group, access, app, routes, request, revoke, key, session, observer, otherKey, behavior };
}
async function workflow(app: Hono, request: (path: string, body?: unknown, token?: string, method?: string) => Request) {
  for (const method of ['GET', 'HEAD']) assert.equal((await app.fetch(request('config', undefined, undefined, method))).status, 200);
  const search = await app.fetch(request('search', { query: 'PRIVATE_QUERY' })); assert.equal(search.status, 200);
  const snapshot = await search.json() as { searchId: string };
  const ids: string[] = [];
  for (const sourceId of ['S1', 'S2']) {
    const read = await app.fetch(request('read', { searchId: snapshot.searchId, sourceId, consent: true, retain: true })); assert.equal(read.status, 200);
    ids.push((await read.json() as { articleId: string }).articleId);
  }
  for (const [path, body] of [
    ['synthesize', { searchId: snapshot.searchId, sourceIds: ['S1', 'S2'], consent: true }],
    ['read/synthesize', { searchId: snapshot.searchId, articleId: ids[0], consent: true, mode: 'full' }],
    ['read/synthesize-many', { searchId: snapshot.searchId, consent: true, selections: ids.map(articleId => ({ articleId, mode: 'full' })) }],
  ] as const) {
    const response = await app.fetch(request(path, body)); assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json() as { paragraphs: unknown[] }).paragraphs.length, 1);
  }
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} research rejects stale browser scope before body, provider or audit effects`, async t => {
    const f = await fixture(t, mode);
    for (const path of ['config', 'search', 'read', 'synthesize', 'read/synthesize', 'read/synthesize-many']) {
      const request = f.request(path, path === 'config' ? undefined : {});
      request.headers.set('x-agentopsdeck-recovery-scope', 'stale-browser-account');
      assert.equal((await f.app.fetch(request)).status, 409, path);
      request.headers.delete('x-agentopsdeck-key');
      assert.equal((await f.app.fetch(new Request(request))).status, 401, 'authenticate before comparing public hints');
    }
    assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.audits, 0);
  });
  test(`${mode} research pins authenticated scope, never a public hint`, async t => {
    const f = await fixture(t, mode), snapshot = await f.owner.command('memberSnapshot', hubMemberEvidence(f.request('config')));
    assert.ok(snapshot);
    for (const hint of [undefined, snapshot.recoveryScope]) {
      const request = f.request('config');
      if (hint !== undefined) request.headers.set('x-agentopsdeck-recovery-scope', hint);
      assert.equal((await f.app.fetch(request)).status, 200);
      assert.equal(originalRequestScope(request), snapshot.recoveryScope);
    }
    const conflicting = f.request('search', { query: 'PRIVATE_QUERY' });
    conflicting.headers.set('x-agentopsdeck-recovery-scope', snapshot.recoveryScope);
    pinOriginalRequestScope(conflicting, 'different-private-original');
    assert.equal((await f.app.fetch(conflicting)).status, 401);
    assert.equal(f.behavior.calls.length, 0); assert.equal(f.behavior.audits, 0);
  });
  test(`${mode} independently enabled research users cannot consume or invalidate another user's search and article snapshots`, async t => {
    const f = await fixture(t, mode, false, true);
    const json = async (path: string, body: unknown, token: string) => {
      const response = await f.app.fetch(f.request(path, body, token));
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      return response.json();
    };
    const first = await json('search', { query: 'PRIVATE_QUERY' }, f.key.token);
    const second = await json('search', { query: 'PRIVATE_QUERY' }, f.otherKey.token);
    assert.notEqual(first.searchId, second.searchId);
    assert.deepEqual(first.sources, second.sources, 'identical provider source IDs are not resource authority');
    const article = await json('read', { searchId: first.searchId, sourceId: 'S1', consent: true, retain: true }, f.key.token);
    const otherArticle = await json('read', { searchId: second.searchId, sourceId: 'S1', consent: true, retain: true }, f.otherKey.token);
    const ownSecond = await json('read', { searchId: first.searchId, sourceId: 'S2', consent: true, retain: true }, f.key.token);
    const otherSecond = await json('read', { searchId: second.searchId, sourceId: 'S2', consent: true, retain: true }, f.otherKey.token);
    assert.notEqual(article.articleId, otherArticle.articleId);
    const calls = f.behavior.calls.length;
    for (const [token, own, foreign, foreignArticle, allowedArticle] of [
      [f.key.token, first, second, otherArticle, ownSecond], [f.otherKey.token, second, first, article, otherSecond],
    ] as const) {
      for (const [path, body, status] of [
        ['read', { searchId: foreign.searchId, sourceId: 'S1', consent: true, retain: true }, 400],
        ['synthesize', { searchId: foreign.searchId, sourceIds: ['S1'], consent: true }, 400],
        ['read/synthesize', { searchId: own.searchId, articleId: foreignArticle.articleId, consent: true, mode: 'full' }, 409],
        ['read/synthesize-many', { searchId: own.searchId, selections: [{ articleId: allowedArticle.articleId, mode: 'full' }, { articleId: foreignArticle.articleId, mode: 'full' }], consent: true }, 409],
      ] as const) assert.equal((await f.app.fetch(f.request(path, body, token))).status, status, path);
    }
    assert.equal(f.behavior.calls.length, calls, 'foreign references cannot dispatch extraction or model requests');
    // Replacing A's search drops only A's retained articles. B keeps its exact
    // original search/article pair, including after A's credential is revoked.
    await json('search', { query: 'replacement' }, f.key.token);
    await f.revoke();
    await json('read/synthesize', { searchId: second.searchId, articleId: otherArticle.articleId, consent: true, mode: 'full' }, f.otherKey.token);
    assert.equal(f.behavior.calls.length, calls + 2);
  });
  test(`${mode} research malformed body after revocation cannot deliver stale validation result`, async t => {
    const f = await fixture(t, mode);
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      await f.revoke(); controller.enqueue(new TextEncoder().encode('{')); controller.close();
    } }, { highWaterMark: 0 });
    const request = new Request('http://hub.invalid' + base + '/search', { method: 'POST',
      headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit);
    assert.equal((await f.app.fetch(request)).status, 401);
    assert.deepEqual(f.behavior.calls, []);
    assert.equal(f.behavior.audits, 0);
  });
  test(`${mode} research complete six-entry chain preserves evidence, article scopes and JSON contracts`, async t => {
    const f = await fixture(t, mode); await workflow(f.app, f.request);
    assert.equal(f.behavior.audits, 6); assert.equal(f.behavior.calls.length, 6);
    assert.equal((await f.app.fetch(f.request('search', { query: 'q' }, f.otherKey.token))).status, 403);
    assert.equal((await f.app.fetch(f.request('search', { query: 'q' }, 'aod_board_synthetic'))).status, 401);
    for (const cookie of [`agentopsdeck_access=${f.key.token}`, `agentopsdeck_session=${f.session}`])
      assert.equal((await f.app.fetch(new Request('http://hub.invalid' + base + '/config', { headers: { cookie } }))).status, 200);
  });
  test(`${mode} research body-time revocation prevents provider dispatch`, async t => {
    const f = await fixture(t, mode);
    const body = new ReadableStream<Uint8Array>({ async pull(stream) { await f.revoke(); stream.enqueue(new TextEncoder().encode('{"query":"q"}')); stream.close(); } });
    const response = await f.app.fetch(new Request('http://hub.invalid' + base + '/search', { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit));
    assert.equal(response.status, 401); assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode} research revocation during original IO suppresses disclosure without retry`, async t => {
    const f = await fixture(t, mode), entered = deferred<void>(), release = deferred<Response>();
    f.behavior.transport = async () => { entered.resolve(); return release.promise; };
    const running = Promise.resolve(f.app.fetch(f.request('search', { query: 'PRIVATE_QUERY' })));
    try { await entered.promise; await f.revoke(); release.resolve(provider(config.searchUrl));
      const response = await running; assert.equal(response.status, 401); assert.equal((await response.text()).includes('PRIVATE_SNIPPET'), false);
      assert.equal(f.behavior.calls.length, 1);
    } finally { release.resolve(provider(config.searchUrl)); await running; }
  });
  test(`${mode} research close retains original audit ACK independently of administrative close`, async t => {
    const f = await fixture(t, mode), entered = deferred<void>(), release = deferred<void>();
    f.behavior.after = async kind => { if (kind === 'auditAppend') { entered.resolve(); await release.promise; } };
    const running = Promise.resolve(f.app.fetch(f.request('search', { query: 'PRIVATE_QUERY' })));
    try { await entered.promise; await f.group.close(); let drained = false;
      const closing = f.routes.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
      assert.equal((await f.app.fetch(f.request('config'))).status, 503);
      release.resolve(); assert.equal((await running).status, 503); await closing;
      assert.equal(drained, true); assert.equal(f.behavior.calls.length, 1); assert.equal(f.behavior.audits, 1);
    } finally { release.resolve(); await running; }
  });
  test(`${mode} research lost audit ACK fails safely without retry even if diagnostics throw`, async t => {
    const f = await fixture(t, mode, true);
    f.behavior.after = kind => { if (kind === 'auditAppend') throw Error('lost ACK'); };
    assert.equal((await f.app.fetch(f.request('search', { query: 'PRIVATE_QUERY' }))).status, 503);
    assert.equal(f.behavior.calls.length, 1); assert.equal(f.behavior.audits, 1);
  });
  test(`${mode} research snapshot replaced while audit awaits cannot deliver stale result`, async t => {
    const f = await fixture(t, mode), entered = deferred<void>(), release = deferred<void>(); let held = false;
    f.behavior.after = async kind => { if (kind === 'auditAppend' && !held) { held = true; entered.resolve(); await release.promise; } };
    const running = Promise.resolve(f.app.fetch(f.request('search', { query: 'PRIVATE_QUERY' })));
    try { await entered.promise;
      assert.equal((await f.app.fetch(f.request('search', { query: 'replacement' }))).status, 200);
      release.resolve(); assert.equal((await running).status, 400); assert.equal(f.behavior.calls.length, 2);
    } finally { release.resolve(); await running; }
  });
}

test('production Hub research composition uses async access for six entries and denies capabilities first', async t => {
  const f = await fixture(t, 'original'), settings = loadConfig({ HOME: f.root, AOD_SERVER_ROLE: 'hub' });
  settings.hub.research = config;
  let guarded = false, principals = 0;
  const store = new Proxy(f.original!, { get(target, key, receiver) { if (guarded) throw Error('SYNC_PRODUCTION_STORE_FALLBACK'); return Reflect.get(target, key, receiver); } });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => provider(String(url), init));
  const app = new Hono(), routes = registerHubRoutes(app, { config: settings, hubStore: store, administrative: f.group,
    principal: () => { principals++; return undefined; }, connectorClient: () => { throw Error('UNEXPECTED_CONNECTOR_EFFECT'); }, normalizeError: () => 'safe' });
  try { guarded = true;
    for (const token of ['aod_board_synthetic', 'aod_note_synthetic']) assert.equal((await app.fetch(f.request('config', undefined, token))).status, 401);
    const stale = f.request('search', { query: 'PRIVATE_QUERY' });
    stale.headers.set('x-agentopsdeck-recovery-scope', 'stale-browser-account');
    assert.equal((await app.fetch(stale)).status, 409);
    await workflow(app, f.request); assert.equal(principals, 0);
    assert.equal((await app.fetch(f.request('config', undefined, undefined, 'PATCH'))).status, 401); assert.equal(principals, 1);
  } finally { guarded = false; await routes?.close(); }
});
