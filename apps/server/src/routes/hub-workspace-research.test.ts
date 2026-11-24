import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { registerHubResearchRoutes } from './hub-workspace-research.js';
import { WorkspaceResearch } from '../hub/workspace-research.js';
import { AuthAuditLog } from '../auth/security.js';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from './hub.js';
import { WorkspaceSynthesis } from '../hub/workspace-synthesis.js';
import { WorkspaceReader } from '../hub/workspace-reader.js';

const base = '/api/hub/v1/workspace/research';
for (const kind of ['private-response', 'throwing-status', 'invalid-status'] as const) {
  test(`research authority failures return safe JSON (${kind})`, async () => {
    const app = new Hono(), audit = new AuthAuditLog();
    const error = new HTTPException(401, { res: new Response('private-credential', { status: 401 }) });
    if (kind === 'throwing-status') Object.defineProperty(error, 'status', { get() { throw Error('private-status'); } });
    if (kind === 'invalid-status') Object.defineProperty(error, 'status', { value: 200 });
    const routes = registerHubResearchRoutes(app, { audit, principal: () => { throw error; } });
    try {
      const response = await app.request(`${base}/config`);
      assert.equal(response.status, kind === 'private-response' ? 401 : 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'research_unavailable' });
    } finally { await routes.close(); }
  });
}
test('model directory and selected synthesis model are credential-scoped; invalid selections never infer', async () => {
  const app = new Hono(), audit = new AuthAuditLog(); let catalogCalls = 0; const inferenceModels: string[] = [];
  const ai = { url: 'https://ai.example/v1/responses', model: 'astra', token: 'synthetic-key', users: ['alice'] };
  const service = new WorkspaceResearch({ searchUrl: 'https://search.example/search', users: ['alice'], synthesis: ai },
    async () => Response.json({ results: [{ title: 'Title', url: 'https://source.example/', content: 'Snippet' }] }));
  const synthesis = new WorkspaceSynthesis(ai, async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-key');
    if (String(url).endsWith('/models')) { catalogCalls++; assert.equal(init?.method, 'GET'); return Response.json({ data: [{ id: 'sol' }, { id: 'luna' }] }); }
    const body = JSON.parse(String(init?.body)); inferenceModels.push(body.model);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
      text: JSON.stringify({ paragraphs: [{ text: 'Answer', citations: ['S1'] }], caveat: 'Snippets only' }) }] }] });
  }, Date.now, 45000, { discoverModels: true, defaultModel: 'sol' });
  const routes = registerHubResearchRoutes(app, { audit, service, synthesis, principal: c => ({ userId: c.req.header('x-user') ?? 'bob', admin: true }) });
  const post = (path: string, body: unknown) => app.request(`${base}/${path}`, { method: 'POST', headers: { 'x-user': 'alice' }, body: JSON.stringify(body) });
  try {
    await app.request(`${base}/config`); assert.equal(catalogCalls, 0);
    const config = await (await app.request(`${base}/config`, { headers: { 'x-user': 'alice' } })).json();
    assert.equal(config.synthesisTarget.model, 'sol'); assert.equal(catalogCalls, 1); assert.equal(inferenceModels.length, 0);
    const { searchId } = await (await post('search', { query: 'Question' })).json();
    for (const model of ['unknown', '', ' luna', 42]) assert.equal((await post('synthesize', { searchId, sourceIds: ['S1'], consent: true, model })).status, 400);
    assert.equal(inferenceModels.length, 0);
    assert.equal((await post('synthesize', { searchId, sourceIds: ['S1'], consent: true, model: 'luna' })).status, 200);
    assert.deepEqual(inferenceModels, ['luna']); assert.equal(catalogCalls, 1);
  } finally { routes.close(); }
});
test('reader API binds source to owned snapshot, exact origin and consent; excludes text, URL and credential from audit', async () => {
  const app = new Hono(), audit = new AuthAuditLog(); let calls = 0, allowed = true;
  const readerConfig = { url: 'https://reader.example/extract', users: ['alice', 'bob'], sourceOrigins: ['https://article.example'], token: 'synthetic-reader-secret' };
  const config = { searchUrl: 'https://search.example/search', users: ['alice', 'bob', 'search-only'], reader: readerConfig };
  const service = new WorkspaceResearch(config, async () => Response.json({ results: [
    { title: 'Private title', url: 'https://article.example/private', content: 'Private snippet' },
    { title: 'Disallowed', url: 'http://127.0.0.1/secret', content: 'No fetch' },
  ] }));
  const reader = new WorkspaceReader(readerConfig, async () => { calls++; return Response.json({ url: 'https://article.example/private', text: 'Private full article', truncated: false }); });
  const routes = registerHubResearchRoutes(app, { service, reader, audit, principal: c => {
    if (!allowed || !c.req.header('x-user')) throw new HTTPException(401); return { userId: c.req.header('x-user')!, admin: true };
  } });
  const post = (path: string, data: unknown, user = 'alice') => app.request(`${base}/${path}`, { method: 'POST', headers: { 'x-user': user }, body: JSON.stringify(data) });
  try {
    const settings = await (await app.request(`${base}/config`, { headers: { 'x-user': 'alice' } })).json();
    assert.deepEqual(settings, { enabled: true, synthesisEnabled: false, readerEnabled: true, readerTarget: 'https://reader.example', readerOrigins: ['https://article.example'] });
    const search = await (await post('search', { query: 'Private query' })).json() as { searchId: string };
    const body = { searchId: search.searchId, sourceId: 'S1', consent: true };
    for (const invalid of [null, [], { ...body, consent: false }, { ...body, url: 'http://127.0.0.1' }, { ...body, sourceId: 'S1\n' }, { ...body, text: 'injected' }])
      assert.equal((await post('read', invalid)).status, 400);
    assert.equal((await post('read?x=1', body)).status, 400);
    assert.equal((await post('read', body, 'bob')).status, 400);
    assert.equal((await post('read', body, 'search-only')).status, 403);
    assert.equal((await post('read', body, 'admin')).status, 403);
    assert.equal((await post('read', { ...body, sourceId: 'S2' })).status, 403); assert.equal(calls, 0);
    const response = await post('read', body); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const article = await response.json() as { text: string }; assert.equal(article.text, 'Private full article'); assert.equal(calls, 1);
    const logs = JSON.stringify(audit.page());
    for (const secret of ['Private', readerConfig.url, readerConfig.token, search.searchId, 'https://article.example/private']) assert.ok(!logs.includes(secret));
    assert.ok(logs.includes('workspace_research_read_completed'));
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { allowed = false; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } });
    assert.equal((await app.request(new Request(`http://hub${base}/read`, { method: 'POST', headers: { 'x-user': 'alice' }, body: stream, duplex: 'half' } as RequestInit))).status, 401);
    assert.equal(calls, 1);
  } finally { routes.close(); }
});

test('synthesis requires separate admission, explicit consent and user-owned snapshot; never accepts browser source text', async () => {
  const app = new Hono(), audit = new AuthAuditLog(); let calls = 0, allowed = true;
  const ai = { url: 'https://ai.example/responses', model: 'configured-model', token: 'synthetic-key', users: ['alice', 'bob'] };
  const config = { searchUrl: 'https://search.example/search', users: ['alice', 'bob', 'search-only'], synthesis: ai };
  const service = new WorkspaceResearch(config, async () => Response.json({ results: [{ title: 'Secret-title', url: 'https://s.example/', content: 'Secret-snippet' }] }));
  const synthesis = new WorkspaceSynthesis(ai, async () => { calls++; return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify({ paragraphs: [{ text: 'Answer', citations: ['S1'] }], caveat: 'Snippets only' }) }] }] }); });
  const routes = registerHubResearchRoutes(app, { audit, service, synthesis, principal: c => {
    if (!allowed || !c.req.header('x-user')) throw new HTTPException(401); return { userId: c.req.header('x-user')!, admin: true };
  } });
  const post = (path: string, value: unknown, user = 'alice') => app.request(`${base}/${path}`, { method: 'POST', headers: { 'x-user': user }, body: JSON.stringify(value) });
  try {
    const getConfig = (user: string) => app.request(`${base}/config`, { headers: { 'x-user': user } });
    assert.deepEqual(await (await getConfig('alice')).json(), { enabled: true, synthesisEnabled: true,
      synthesisTarget: { model: ai.model, provider: 'https://ai.example', models: [{ id: ai.model, label: ai.model }], catalogState: 'unavailable' } });
    assert.deepEqual(await (await getConfig('search-only')).json(), { enabled: true, synthesisEnabled: false });
    assert.deepEqual(await (await getConfig('admin')).json(), { enabled: false, synthesisEnabled: false });
    const search = await (await post('search', { query: 'Private-query' })).json() as { searchId: string };
    const body = { searchId: search.searchId, sourceIds: ['S1'], consent: true };
    assert.equal((await post('synthesize', body, 'admin')).status, 403);
    assert.equal((await post('synthesize', body, 'search-only')).status, 403);
    assert.equal((await post('synthesize', body, 'bob')).status, 400);
    for (const invalid of [{ ...body, consent: false }, { ...body, sourceIds: ['S2'] }, { ...body, sourceIds: ['S1', 'S1'] },
      { ...body, sourceIds: [] }, { ...body, sourceIds: [4] }, { ...body, sources: [{ snippet: 'Private file' }] }, { ...body, model: 'override' }])
      assert.equal((await post('synthesize', invalid)).status, 400);
    assert.equal((await post('synthesize?url=private', body)).status, 400); assert.equal(calls, 0);
    const response = await post('synthesize', body); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(calls, 1);
    const logs = JSON.stringify(audit.page());
    for (const secret of ['Private-query', 'Secret-title', 'Secret-snippet', ai.token, ai.url, ai.model, search.searchId]) assert.ok(!logs.includes(secret));
    assert.ok(logs.includes('workspace_research_synthesis_completed'));
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { allowed = false; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } });
    const revoked = await app.request(new Request(`http://hub${base}/synthesize`, { method: 'POST', headers: { 'x-user': 'alice' }, body: stream, duplex: 'half' } as RequestInit));
    assert.equal(revoked.status, 401); assert.equal(calls, 1);
  } finally { routes.close(); }
});
test('API requires identity and allowlist; validates body; sanitizes audits; no administrator inheritance', async () => {
  const app = new Hono(), audit = new AuthAuditLog(), config = { searchUrl: 'https://search.example/search', users: ['alice'] };
  let calls = 0, allowed = true;
  const service = new WorkspaceResearch(config, async () => { calls++; return Response.json({ results: [{ title: 'Title', url: 'https://example.org/', content: 'secret-snippet' }] }); });
  const routes = registerHubResearchRoutes(app, { audit, service, principal: c => {
    if (!allowed || !c.req.header('x-user')) throw new HTTPException(401); return { userId: c.req.header('x-user')!, admin: true };
  } });
  const post = (body: unknown, user = 'alice', suffix = '') => app.request(`${base}/search${suffix}`, { method: 'POST', headers: { 'x-user': user }, body: JSON.stringify(body) });
  try {
    assert.equal((await app.request(`${base}/config`)).status, 401);
    assert.deepEqual(await (await app.request(`${base}/config`, { headers: { 'x-user': 'admin' } })).json(), { enabled: false, synthesisEnabled: false });
    assert.equal((await post({ query: 'q' }, 'admin')).status, 403);
    for (const value of [null, [], { query: 'x', url: 'https://private' }, { query: '' }, { query: 'x'.repeat(321) }, { query: 'a\nb' }]) assert.equal((await post(value)).status, 400);
    assert.equal((await post({ query: 'q' }, 'alice', '?url=http://private')).status, 400);
    assert.equal((await post({ query: 'x'.repeat(5000) })).status, 413); assert.equal(calls, 0);
    const result = await post({ query: 'private-query' }); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(calls, 1);
    const logs = JSON.stringify(audit.page()); assert.ok(!logs.includes('private-query')); assert.ok(!logs.includes('secret-snippet')); assert.ok(!logs.includes(config.searchUrl));
    assert.ok(logs.includes('workspace_research_search_completed'));
    for (let i = 0; i < 9; i++) await post({ query: 'q' });
    const limited = await post({ query: 'q' }); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
    allowed = false; assert.equal((await post({ query: 'q' })).status, 401);
  } finally { routes.close(); }
});

test('route revocation after async body read does not dispatch; active cancellation reaches provider', async () => {
  const app = new Hono(), audit = new AuthAuditLog(); let allowed = true, calls = 0;
  const service = new WorkspaceResearch({ searchUrl: 'https://search.example/search', users: ['alice'] }, async () => { calls++; return new Promise<Response>(() => {}); });
  const routes = registerHubResearchRoutes(app, { service, audit, principal: () => { if (!allowed) throw new HTTPException(401); return { userId: 'alice', admin: false }; } });
  try {
    const body = new ReadableStream<Uint8Array>({ pull(stream) { allowed = false; stream.enqueue(new TextEncoder().encode('{"query":"q"}')); stream.close(); } });
    const revoked = await app.request(new Request(`http://hub${base}/search`, { method: 'POST', body, duplex: 'half' } as RequestInit));
    assert.equal(revoked.status, 401); assert.equal(calls, 0); allowed = true;
    const caller = new AbortController(); const pending = app.request(`${base}/search`, { method: 'POST', body: '{"query":"q"}', signal: caller.signal });
    while (!calls) await new Promise(resolve => setTimeout(resolve, 5)); caller.abort();
    assert.equal((await pending).status, 503);
  } finally { routes.close(); }
});

test('real Hub registration is default-off and cannot use a board capability as research authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-research-')), hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic');
  const app = new Hono(), routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
    principal: req => req.headers.has('x-user') ? { userId: 'default', admin: true } : undefined,
    normalizeError: () => 'Synthetic', connectorClient: () => { throw Error('research must not use Connector transport'); } });
  try {
    assert.equal((await app.request(`${base}/config`)).status, 401);
    const headers = { 'x-user': 'default' };
    assert.deepEqual(await (await app.request(`${base}/config`, { headers })).json(), { enabled: false, synthesisEnabled: false });
    assert.equal((await app.request(`${base}/search`, { method: 'POST', headers, body: '{"query":"q"}' })).status, 403);
    assert.equal((await app.request(`${base}/synthesize`, { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await app.request(`${base}/synthesize`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await app.request(`${base}/synthesize`, { method: 'POST', headers: { ...headers, authorization: 'Bearer aod_board_synthetic' }, body: '{}' })).status, 401);
    assert.equal((await app.request(`${base}/config`, { headers: { authorization: 'Bearer synthetic-board-token' } })).status, 401);
    assert.equal((await app.request(`${base}/config`, { headers: { ...headers, authorization: 'Bearer aod_board_synthetic' } })).status, 401);
  } finally { routes?.close(); hub.close(); await rm(root, { recursive: true, force: true }); }
});
