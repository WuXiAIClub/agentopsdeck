import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RESEARCH_RESULT_LIMIT, validResearchResult } from '@agentopsdeck/shared';
import { loadConfig, redactedConfig } from '../config.js';
import { parseResearchConfig, RESEARCH_RESPONSE_BYTES, ResearchError, WorkspaceResearch } from './workspace-research.js';
import { searchProvider } from './workspace-search-provider.js';

const env = { AOD_RESEARCH_ENABLED: 'true', AOD_RESEARCH_PROVIDER: 'tavily',
  AOD_RESEARCH_USERS: 'alice', AOD_RESEARCH_SEARCH_TOKEN: 'synthetic-tavily-key' };
const config = () => parseResearchConfig(env)!;
const signal = () => new AbortController().signal;
const status = (code: number) => (error: unknown) => error instanceof ResearchError && error.status === code;
const fixture = () => ({ query: 'provider echo is ignored', answer: 'not a sourced answer', images: ['https://image.invalid'],
  results: [{ title: '<b>Source</b>', url: 'https://example.org/article', content: '<b>Snippet</b>', raw_content: 'never forward', score: 0.9 },
    { url: 'https://example.org/article', content: 'duplicate' }, { url: 'javascript:bad' }] });

test('provider selection is explicit, old configuration is compatible, Tavily requires a private token', () => {
  assert.deepEqual(config(), { provider: 'tavily', searchUrl: 'https://api.tavily.com/search', users: ['alice'], token: env.AOD_RESEARCH_SEARCH_TOKEN });
  const legacy = { ...env, AOD_RESEARCH_PROVIDER: undefined, AOD_RESEARCH_SEARCH_URL: 'https://search.example/search' };
  assert.equal(parseResearchConfig(legacy)?.provider, undefined);
  assert.equal(parseResearchConfig({ ...legacy, AOD_RESEARCH_PROVIDER: 'searxng' })?.provider, 'searxng');
  assert.equal(parseResearchConfig({ ...env, AOD_RESEARCH_ENABLED: undefined }), undefined);
  for (const provider of ['', 'travily', 'Tavily', 'unknown', '__proto__']) {
    assert.throws(() => parseResearchConfig({ ...env, AOD_RESEARCH_PROVIDER: provider }), /Invalid research configuration/);
  }
  for (const token of [undefined, '', 'bad\nkey']) assert.throws(() => parseResearchConfig({ ...env, AOD_RESEARCH_SEARCH_TOKEN: token }));
  for (const url of ['', 'http://example.org/search', 'https://user:secret@example.org/search', 'https://example.org/search?key=secret', 'https://example.org/#key']) {
    assert.throws(() => parseResearchConfig({ ...env, AOD_RESEARCH_SEARCH_URL: url }));
  }
  assert.equal(parseResearchConfig({ ...env, AOD_RESEARCH_SEARCH_URL: 'https://gateway.example/tavily/search' })?.searchUrl, 'https://gateway.example/tavily/search');
  const diagnostic = JSON.stringify(redactedConfig(loadConfig(env)));
  for (const secret of ['synthetic-tavily-key', 'api.tavily.com', 'alice']) assert.ok(!diagnostic.includes(secret));
});

test('Tavily request is bounded JSON with header-only auth; legacy form request unchanged', () => {
  const request = searchProvider('tavily').request('中文 query', 'synthetic-key');
  assert.equal(request.headers.authorization, 'Bearer synthetic-key');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(request.body)), { query: '中文 query', topic: 'general', search_depth: 'basic',
    max_results: RESEARCH_RESULT_LIMIT, auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false });
  assert.ok(!String(request.body).includes('synthetic-key'));
  assert.throws(() => searchProvider('tavily').request('q'), status(503));
  assert.equal(String(searchProvider().request('q').body), 'q=q&format=json&pageno=1&categories=general&safesearch=1');
});

test('Tavily normalizes only safe sources and retains owner-scoped synthesis snapshots', async () => {
  const service = new WorkspaceResearch({ ...config(), synthesis: { url: 'https://ai.example/responses', model: 'test', token: 'synthetic', users: ['alice'] } },
    async () => Response.json(fixture()));
  try {
    const result = await service.search('alice', 'actual query', signal(), () => true);
    assert.ok(validResearchResult(result)); assert.equal(result.query, 'actual query');
    assert.deepEqual(result.sources, [{ id: 'S1', title: 'Source', url: 'https://example.org/article', snippet: 'Snippet' }]);
    assert.deepEqual(service.snapshot('alice', result.searchId), result);
    assert.throws(() => service.snapshot('bob', result.searchId));
    assert.equal(searchProvider('tavily').project({ results: [] }).length, 0);
    assert.throws(() => searchProvider('tavily').project({ detail: 'error' }), status(502));
    assert.equal(searchProvider('tavily').project({ results: Array.from({ length: 20 }, (_, i) => ({ url: `https://example.org/${i}`, content: 'x'.repeat(4000) })) }).length, RESEARCH_RESULT_LIMIT);
    assert.equal(searchProvider('tavily').project({ results: [{ url: 'https://example.org', content: 'x'.repeat(4000) }] })[0]!.snippet.length, 1200);
  } finally { service.close(); }
});

test('Tavily failures are generic and never retry/fallback or expose upstream bodies', async () => {
  for (const code of [401, 403, 429, 432, 433, 500]) {
    let calls = 0;
    const service = new WorkspaceResearch(config(), async () => { calls++; return Response.json({ detail: 'synthetic-provider-secret' }, { status: code }); });
    try {
      await assert.rejects(service.search('alice', 'query', signal(), () => true), error => status(502)(error) && !String(error).includes('synthetic-provider-secret'));
      assert.equal(calls, 1);
    } finally { service.close(); }
  }
  for (const body of [() => new Response('not JSON'), () => Response.json({ results: [], raw_content: 'x'.repeat(RESEARCH_RESPONSE_BYTES) })]) {
    const service = new WorkspaceResearch(config(), async () => body());
    try { await assert.rejects(service.search('alice', 'query', signal(), () => true), status(502)); } finally { service.close(); }
  }
});

test('Tavily uses shared admission, cancellation, revocation and deadline controls', async () => {
  let calls = 0, upstream: AbortSignal | null | undefined;
  const service = new WorkspaceResearch(config(), async (_url, init) => { calls++; upstream = init?.signal; return new Promise<Response>(() => {}); });
  const caller = new AbortController();
  try {
    await assert.rejects(service.search('bob', 'query', signal(), () => true), status(403));
    await assert.rejects(service.search('alice', 'query', signal(), () => false), status(401));
    assert.equal(calls, 0);
    const pending = assert.rejects(service.search('alice', 'query', caller.signal, () => true), status(503));
    await assert.rejects(service.search('alice', 'another', signal(), () => true), status(429));
    caller.abort(); await pending; assert.ok(upstream?.aborted); assert.equal(calls, 1);
  } finally { service.close(); }
  const keepAlive = setInterval(() => {}, 1000);
  const timeout = new WorkspaceResearch(config(), async () => new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }), Date.now, 20);
  let allowed = true;
  const revoked = new WorkspaceResearch(config(), async () => { allowed = false; return Response.json(fixture()); });
  try {
    await assert.rejects(timeout.search('alice', 'query', signal(), () => true), status(504));
    await assert.rejects(revoked.search('alice', 'query', signal(), () => allowed), status(401));
  } finally { timeout.close(); revoked.close(); clearInterval(keepAlive); }
});

test('Tavily actual HTTP POST roundtrip, normalized output and redirect refusal', async () => {
  let mode = 'success', forwarded = 0;
  const requests: { method: string | undefined; path: string | undefined; contentType: string | undefined; auth: string | undefined; body: string }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/leak') { forwarded++; res.end('never'); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ method: req.method, path: req.url, contentType: req.headers['content-type'], auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (mode === 'redirect') { res.writeHead(307, { location: '/leak' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const service = new WorkspaceResearch(parseResearchConfig({ ...env, AOD_RESEARCH_SEARCH_URL: `http://127.0.0.1:${address.port}/search`, AOD_RESEARCH_ALLOW_HTTP: 'true' }));
  try {
    const result = await service.search('alice', 'query text', signal(), () => true);
    assert.ok(validResearchResult(result)); assert.equal(result.sources.length, 1);
    assert.equal(requests[0]!.method, 'POST'); assert.equal(requests[0]!.path, '/search');
    assert.equal(requests[0]!.auth, `Bearer ${env.AOD_RESEARCH_SEARCH_TOKEN}`);
    assert.equal(requests[0]!.contentType, 'application/json');
    assert.equal(JSON.parse(requests[0]!.body).query, 'query text');
    assert.ok(!requests[0]!.body.includes(env.AOD_RESEARCH_SEARCH_TOKEN));
    mode = 'redirect'; await assert.rejects(service.search('alice', 'query', signal(), () => true), status(502));
    assert.equal(forwarded, 0); assert.equal(requests.length, 2);
  } finally { service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
