import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { registerHubResearchRoutes } from './hub-workspace-research.js';
import { WorkspaceResearch } from '../hub/workspace-research.js';
import { WorkspaceReader } from '../hub/workspace-reader.js';
import { WorkspaceSynthesis } from '../hub/workspace-synthesis.js';
import { WorkspaceArticleSnapshots, ARTICLE_SNAPSHOT_TTL } from '../hub/workspace-article-snapshots.js';
import { AuthAuditLog } from '../auth/security.js';
const base = '/api/hub/v1/workspace/research';
async function prepareMany(f: ReturnType<typeof fixture>) {
  const { search, article } = await f.prepare();
  f.setText('Second article, independent text.');
  const response = await f.post('read', { searchId: search.searchId, sourceId: 'S2', consent: true, retain: true });
  assert.equal(response.status, 200);
  const second = await response.json();
  return { search, article, second, body: { searchId: search.searchId, consent: true, selections: [
    { articleId: article.articleId, mode: 'selection', range: { start: 16, end: 36 } }, { articleId: second.articleId, mode: 'full' }] } };
}
test('two article scopes retain distinct text and exact provenance; snippet synthesis remains compatible', async () => {
  const f = fixture(2); try {
    const { body, article, second } = await prepareMany(f);
    assert.equal(f.inputs.length, 0); assert.equal(f.reads(), 2);
    const response = await f.post('read/synthesize-many', body); assert.equal(response.status, 200);
    const answer = await response.json(), input = JSON.parse(f.inputs[0]!.input[0].content);
    assert.equal(input.sources[0].text, article.text.slice(16, 36)); assert.equal(input.sources[1].text, second.text);
    assert.deepEqual(answer.evidence.map((e: any) => [e.sourceId, e.mode, e.start, e.end]), [['S1', 'selection', 16, 36], ['S2', 'full', 0, second.text.length]]);
    const serialized = JSON.stringify(f.inputs[0]); for (const absent of ['Private prefix', 'Snippet excluded', article.articleId, 'https://article.example']) assert.ok(!serialized.includes(absent));
    assert.equal((await f.post('synthesize', { searchId: body.searchId, sourceIds: ['S1', 'S2'], consent: true })).status, 200);
    assert.equal(f.reads(), 2);
  } finally { f.close(); }
});
test('three articles retain source identity and share admission budget with single reading and snippets', async () => {
  const f = fixture(3); try {
    const { body, article } = await prepareMany(f);
    f.setText('Third article.');
    const extracted = await f.post('read', { searchId: body.searchId, sourceId: 'S3', consent: true, retain: true });
    assert.equal(extracted.status, 200);
    const third = await extracted.json();
    const many = { ...body, selections: [...body.selections, { articleId: third.articleId, mode: 'full' }] };
    const answer = await f.post('read/synthesize-many', many);
    assert.equal(answer.status, 200);
    assert.deepEqual((await answer.json()).evidence.map((e: any) => e.sourceId), ['S1', 'S2', 'S3']);
    assert.deepEqual(JSON.parse(f.inputs[0]!.input[0].content).sources.map((s: any) => s.id), ['S1', 'S2', 'S3']);
    const single = { searchId: body.searchId, articleId: article.articleId, mode: 'full', consent: true };
    assert.equal((await f.post('read/synthesize', single)).status, 200);
    assert.equal((await f.post('synthesize', { searchId: body.searchId, sourceIds: ['S1'], consent: true })).status, 200);
    for (const [route, input] of [['read/synthesize-many', many], ['read/synthesize', single]] as const) {
      const rejected = await f.post(route, input);
      assert.equal(rejected.status, 429); assert.ok(rejected.headers.get('retry-after'));
    }
    assert.equal(f.inputs.length, 3); assert.equal(f.reads(), 3);
    f.advance(60_001);
    assert.equal((await f.post('read/synthesize-many', many)).status, 200);
  } finally { f.close(); }
});
test('many reading rejects forged scopes, duplicate sources, foreign ownership, aggregate overflow and stale sources before AI', async () => {
  const f = fixture(3); try {
    const { body } = await prepareMany(f);
    for (const bad of [null, {}, { ...body, consent: false }, { ...body, text: 'fake' }, { ...body, selections: [] },
      { ...body, selections: [...body.selections, ...body.selections] }, { ...body, selections: [body.selections[0], body.selections[0]] },
      { ...body, selections: body.selections.map(s => ({ ...s, url: 'https://evil.example' })) },
      { ...body, selections: [{ ...body.selections[0], range: { start: 24, end: 25 } }, body.selections[1]] }])
      assert.equal((await f.post('read/synthesize-many', bad)).status, 400);
    assert.equal((await f.post('read/synthesize-many?x=1', body)).status, 400);
    assert.equal((await f.post('read/synthesize-many', body, 'bob')).status, 400);
    for (const retain of [false, 'true', 1]) assert.equal((await f.post('read', { searchId: body.searchId, sourceId: 'S3', consent: true, retain })).status, 400);
    f.setText('x'.repeat(17000));
    const a = await (await f.post('read', { searchId: body.searchId, sourceId: 'S1', consent: true, retain: true })).json();
    const b = await (await f.post('read', { searchId: body.searchId, sourceId: 'S2', consent: true, retain: true })).json();
    assert.equal((await f.post('read/synthesize-many', body)).status, 409);
    assert.equal((await f.post('read/synthesize-many', { ...body, selections: [a, b].map(a => ({ articleId: a.articleId, mode: 'full' })) })).status, 413);
    assert.equal(f.inputs.length, 0);
  } finally { f.close(); }
});
for (const change of ['replace-second', 'revoke', 'expire', 'cancel'] as const) test(`many reading cancels on ${change}, shares existing AI budgets`, async () => {
  const f = fixture(2); try {
    const { body } = await prepareMany(f); let start!: () => void; const ready = new Promise<void>(r => { start = r; }); let aborted = false;
    f.setProvider(async (_input, signal) => { start(); return new Promise((_r, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })); });
    const controller = new AbortController(), pending = f.post('read/synthesize-many', body, 'alice', controller.signal); await ready;
    if (change === 'replace-second') await f.post('read', { searchId: body.searchId, sourceId: 'S2', consent: true, retain: true });
    if (change === 'revoke') f.revoke(); if (change === 'expire') f.advance(ARTICLE_SNAPSHOT_TTL); if (change === 'cancel') controller.abort();
    const timer = setInterval(() => {}, 1000);
    try { const response = await pending; assert.ok([401, 503].includes(response.status)); assert.equal(aborted, true);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const result = await response.json(); assert.equal(result.paragraphs, undefined);
      if (change === 'revoke' || change === 'cancel') assert.deepEqual(result, { error: 'research_unavailable' }); }
    finally { clearInterval(timer); }
  } finally { f.close(); }
});
function fixture(count = 1) {
  const app = new Hono(), audit = new AuthAuditLog(); let now = 1000, allowed = true, reads = 0;
  let text = 'Private prefix. Selected 😀 passage. Private suffix.';
  const inputs: Record<string, any>[] = [];
  const config = { searchUrl: 'https://search.example/', users: ['alice', 'bob'],
    reader: { url: 'https://reader.example/', users: ['alice', 'bob'], sourceOrigins: ['https://article.example'] },
    synthesis: { url: 'https://ai.example/', users: ['alice', 'bob'], model: 'fixture', token: 'synthetic-only' } };
  const service = new WorkspaceResearch(config, async () => Response.json({ results: Array.from({ length: count }, (_, i) => ({ title: `Title ${i}`, url: `https://article.example/${i}`, content: 'Snippet excluded from reading' })) }), () => now);
  const reader = new WorkspaceReader(config.reader, async (_url, init) => { reads++; const { url } = JSON.parse(init!.body as string); return Response.json({ url, text, truncated: true }); }, () => now);
  let provider: (input: any, signal: AbortSignal) => Promise<Response> = async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ paragraphs: [{ text: 'Summary', citations: ['S1'] }], caveat: 'Selection is unverified.' }) }] }] });
  const synthesis = new WorkspaceSynthesis(config.synthesis, async (_url, init) => { const body = JSON.parse(init!.body as string); inputs.push(body); return provider(body, init!.signal!); }, () => now);
  const articles = new WorkspaceArticleSnapshots(() => now);
  const routes = registerHubResearchRoutes(app, { service, reader, synthesis, articles, audit, principal: c => { if (!allowed) throw new HTTPException(401); return { userId: c.req.header('x-user') ?? 'alice', admin: false }; } });
  const post = (path: string, body: unknown, user = 'alice', signal?: AbortSignal) => app.request(base + '/' + path, { method: 'POST', headers: { 'x-user': user }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  const prepare = async () => { const search = await (await post('search', { query: 'Private query' })).json(); const article = await (await post('read', { searchId: search.searchId, sourceId: 'S1', consent: true })).json(); return { search, article, body: { searchId: search.searchId, articleId: article.articleId, mode: 'full', consent: true } }; };
  return { app, audit, inputs, post, prepare, close: routes.close, advance: (ms: number) => now += ms, revoke: () => { allowed = false; }, setText: (value: string) => { text = value; }, setProvider: (fn: typeof provider) => { provider = fn; }, reads: () => reads };
}
test('search → read → consent → full/selected AI input → bounded source evidence; no hidden reads or audit text', async () => {
  const f = fixture(); try {
    assert.equal((await (await f.app.request(base + '/config')).json()).articleSynthesisEnabled, true);
    const { body, article } = await f.prepare(); assert.equal(f.inputs.length, 0);
    const full = await f.post('read/synthesize', body); assert.equal(full.status, 200); assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.parse(f.inputs[0]!.input[0].content).sources[0].text, article.text);
    const start = article.text.indexOf('Selected'), end = article.text.indexOf(' Private suffix');
    const selection = await f.post('read/synthesize', { ...body, mode: 'selection', range: { start, end } }); assert.equal(selection.status, 200);
    const answer = await selection.json(); assert.deepEqual(answer.evidence, { articleId: article.articleId, sourceId: 'S1', mode: 'selection', start, end, truncated: true });
    const sent = JSON.stringify(f.inputs[1]);
    assert.ok(sent.includes('Selected 😀 passage.')); for (const absent of ['Private prefix', 'Private suffix', 'https://article.example', 'Snippet excluded', article.articleId]) assert.ok(!sent.includes(absent));
    assert.deepEqual(f.inputs[1]!.tools, []); assert.equal(f.inputs[1]!.store, false); assert.equal(f.reads(), 1);
    const audit = JSON.stringify(f.audit.page()); for (const absent of ['Private query', 'Selected 😀', article.articleId, 'https://article.example']) assert.ok(!audit.includes(absent));
  } finally { f.close(); }
});
test('bad consent, forged text/URL, malformed ranges, foreign snapshots and expired generations never call AI', async () => {
  const f = fixture(); try {
    const { body } = await f.prepare();
    for (const bad of [null, [], { ...body, consent: false }, { ...body, text: 'injection' }, { ...body, url: 'https://bad.example' }, { ...body, range: {} },
      { ...body, mode: 'selection', range: { start: 0, end: 9999 } }, { ...body, mode: 'selection', range: { start: '0', end: 1 } }, { ...body, mode: 'selection', range: { start: 0, end: 3, text: 'fake' } }])
      assert.equal((await f.post('read/synthesize', bad)).status, 400);
    assert.equal((await f.post('read/synthesize?x=1', body)).status, 400);
    assert.equal((await f.post('read/synthesize', body, 'bob')).status, 400);
    await f.post('read', { searchId: body.searchId, sourceId: 'S1', consent: true });
    assert.equal((await f.post('read/synthesize', body)).status, 409);
    const next = await f.prepare(); f.advance(ARTICLE_SNAPSHOT_TTL);
    assert.equal((await f.post('read/synthesize', next.body)).status, 409);
    const newest = await f.prepare(); await f.post('search', { query: 'replacement' });
    assert.equal((await f.post('read/synthesize', newest.body)).status, 400);
    assert.equal(f.inputs.length, 0);
  } finally { f.close(); }
});
test('oversized text remains selectable, input limits never silently discard full text; read and AI budgets independent', async () => {
  const f = fixture(); try {
    f.setText('中'.repeat(11000)); const { body } = await f.prepare();
    assert.equal((await f.post('read/synthesize', body)).status, 413); assert.equal(f.inputs.length, 0);
    for (let i = 0; i < 3; i++) assert.equal((await f.post('read/synthesize', { ...body, mode: 'selection', range: { start: 0, end: 100 } })).status, 200);
    const limited = await f.post('read/synthesize', body.mode === 'full' ? { ...body, mode: 'selection', range: { start: 0, end: 100 } } : body);
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60'); assert.equal(f.reads(), 1);
  } finally { f.close(); }
});
test('JSON escaping counts toward provider input budget and reports size, not stale snapshot', async () => {
  const f = fixture(); try {
    f.setText('"'.repeat(30000)); const { body } = await f.prepare();
    assert.equal((await f.post('read/synthesize', body)).status, 413); assert.equal(f.inputs.length, 0);
    assert.equal((await f.post('read/synthesize', { ...body, mode: 'selection', range: { start: 0, end: 100 } })).status, 200);
  } finally { f.close(); }
});
for (const event of ['revoke', 'replace-search', 'replace-article', 'expire', 'cancel', 'close'] as const) test(`in-flight ${event} cancels AI and returns no late summary`, async () => {
  const f = fixture(); try {
    const { body } = await f.prepare(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    let providerAborted = false;
    f.setProvider(async (_body, signal) => { started(); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { providerAborted = true; reject(signal.reason); }, { once: true }); }); });
    const controller = new AbortController(), pending = f.post('read/synthesize', body, 'alice', controller.signal); await ready;
    if (event === 'revoke') f.revoke();
    if (event === 'replace-search') await f.post('search', { query: 'new' });
    if (event === 'replace-article') await f.post('read', { searchId: body.searchId, sourceId: 'S1', consent: true });
    if (event === 'expire') f.advance(ARTICLE_SNAPSHOT_TTL);
    if (event === 'cancel') controller.abort();
    if (event === 'close') f.close();
    // Keep node:test alive while the production unref'd authorization timer runs.
    const keepAlive = setInterval(() => {}, 1000);
    try { const response = await pending; assert.ok([401, 503].includes(response.status)); assert.equal(providerAborted, true);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const result = await response.json(); assert.equal(result.paragraphs, undefined);
      if (event === 'revoke' || event === 'cancel' || event === 'close') assert.deepEqual(result, { error: 'research_unavailable' }); }
    finally { clearInterval(keepAlive); }
  } finally { f.close(); }
});
