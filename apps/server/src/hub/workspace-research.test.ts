import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { researchQuery, researchSourceUrl, validResearchResult } from '@agentopsdeck/shared';
import { parseResearchConfig, projectResearchSources, RESEARCH_RESPONSE_BYTES, ResearchError, WorkspaceResearch } from './workspace-research.js';
import { loadConfig, redactedConfig } from '../config.js';

const config = { searchUrl: 'https://search.example/search', users: ['alice'], token: 'synthetic-secret' };
const response = () => Response.json({ results: [{ title: '<b>Example</b>', url: 'https://example.org/article', content: 'A search snippet' }] });
const status = (code: number) => (error: unknown) => error instanceof ResearchError && error.status === code;
const controller = () => new AbortController();

test('research config is off by default, explicit and redacted including endpoints/user IDs', () => {
  assert.equal(parseResearchConfig({ AOD_RESEARCH_SEARCH_URL: 'https://ignored' }), undefined);
  assert.throws(() => parseResearchConfig({ AOD_RESEARCH_ENABLED: 'true' }));
  const env = { AOD_RESEARCH_ENABLED: 'true', AOD_RESEARCH_SEARCH_URL: config.searchUrl, AOD_RESEARCH_USERS: ' alice,alice ', AOD_RESEARCH_SEARCH_TOKEN: config.token };
  assert.deepEqual(parseResearchConfig(env), config);
  for (const searchUrl of ['http://search.example/search', 'https://user:secret@search.example/', 'https://search.example/?key=secret', 'file:///tmp/search', 'https://search.example/#secret', 'https://search.example/\n'])
    assert.throws(() => parseResearchConfig({ ...env, AOD_RESEARCH_SEARCH_URL: searchUrl }), /Invalid research configuration/);
  assert.ok(parseResearchConfig({ ...env, AOD_RESEARCH_SEARCH_URL: 'http://127.0.0.1:9876/search', AOD_RESEARCH_ALLOW_HTTP: 'true' }));
  assert.throws(() => parseResearchConfig({ ...env, AOD_RESEARCH_USERS: 'bad\nuser' }));
  assert.throws(() => parseResearchConfig({ ...env, AOD_RESEARCH_USERS: Array.from({ length: 129 }, (_, i) => `user${i}`).join(',') }));
  assert.throws(() => parseResearchConfig({ ...env, AOD_RESEARCH_SEARCH_TOKEN: 'a\nb' }));
  const diagnostic = JSON.stringify(redactedConfig(loadConfig(env)));
  assert.ok(!diagnostic.includes(config.token)); assert.ok(!diagnostic.includes(config.searchUrl)); assert.ok(!diagnostic.includes('alice'));
});

test('bounded queries and hostile sources do not become markup, credentials, extra fields or unlimited output', () => {
  assert.equal(researchQuery('   query  '), 'query'); assert.equal(researchQuery('  '), undefined);
  assert.equal(researchQuery('x'.repeat(321)), undefined); assert.equal(researchQuery('x\n'), undefined);
  for (const url of ['javascript:alert(1)', 'file:///secret', 'https://u:p@site.test/', '//site.test/', 'https://site.test/\n']) assert.equal(researchSourceUrl(url), undefined);
  assert.equal(researchSourceUrl('https://site.test/a#frag'), 'https://site.test/a');
  const sources = projectResearchSources({ results: [null, { url: 'javascript:evil' }, { url: 'https://a.test/', title: '<b>Safe</b>', content: '<img src="https://tracking.test">Text', secret: 'never' },
    { url: 'https://a.test/#same', title: 'duplicate' }, ...Array.from({ length: 30 }, (_, i) => ({ title: 't'.repeat(300), url: `https://b.test/${i}`, content: 'x'.repeat(1300) }))] });
  assert.equal(sources.length, 8); assert.deepEqual(sources[0], { id: 'S1', title: 'Safe', url: 'https://a.test/', snippet: 'Text' });
  assert.equal(sources[1]!.title.length, 240); assert.equal(sources[1]!.snippet.length, 1200); assert.equal(sources[7]!.id, 'S8');
  const longHost = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  assert.equal(projectResearchSources({ results: [{ url: `https://${longHost}/` }] })[0]!.title.length, 240);
  // Unclosed '<' runs stay linear rather than repeatedly scanning the whole suffix.
  assert.equal(projectResearchSources({ results: [{ url: 'https://a.test/', content: '<'.repeat(200_000) }] })[0]!.snippet.length, 1200);
  assert.throws(() => projectResearchSources({ error: 'provider error' }), status(502));
});

test('one explicit fixed-endpoint POST; secret only on provider; projection and no automatic retry', async () => {
  let calls = 0;
  const service = new WorkspaceResearch(config, async (url, init) => {
    calls++; assert.equal(url, config.searchUrl); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${config.token}`); assert.equal(new Headers(init?.headers).has('cookie'), false);
    assert.equal(String(init?.body), 'q=some+query&format=json&pageno=1&categories=general&safesearch=1'); return response();
  });
  const result = await service.search('alice', 'some query', controller().signal, () => true);
  assert.ok(validResearchResult(result)); assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes(config.token));
  await assert.rejects(service.search('admin', 'query', controller().signal, () => true), status(403)); assert.equal(calls, 1);
  service.close(); await assert.rejects(service.search('alice', 'query', controller().signal, () => true), status(403));
});

test('per-user active and minute budgets; global concurrency and admissions stay bounded', async () => {
  let now = 100_000, calls = 0;
  const service = new WorkspaceResearch(config, async () => { calls++; return response(); }, () => now);
  for (let i = 0; i < 10; i++) await service.search('alice', 'q', controller().signal, () => true);
  await assert.rejects(service.search('alice', 'q', controller().signal, () => true), status(429)); assert.equal(calls, 10);
  now += 60_000; await service.search('alice', 'q', controller().signal, () => true); service.close();
  const users = ['a', 'b', 'c', 'd', 'e'];
  const concurrent = new WorkspaceResearch({ ...config, users }, async () => new Promise<Response>(() => {}));
  const pending = users.slice(0, 4).map(user => assert.rejects(concurrent.search(user, 'q', controller().signal, () => true), status(503)));
  await assert.rejects(concurrent.search('e', 'q', controller().signal, () => true), status(429));
  await assert.rejects(concurrent.search('a', 'q', controller().signal, () => true), status(429));
  concurrent.close(); await Promise.all(pending);
  const global = new WorkspaceResearch({ ...config, users }, async () => response());
  for (const user of users.slice(0, 3)) for (let i = 0; i < 10; i++) await global.search(user, 'q', controller().signal, () => true);
  await assert.rejects(global.search('d', 'q', controller().signal, () => true), status(429)); global.close();
});

test('cancellation stops delivery but retains admission and drain until original fetch settles', async () => {
  let calls = 0, providerSignal: AbortSignal | null | undefined;
  let release!: (value: Response) => void;
  const original = new Promise<Response>(resolve => { release = resolve; });
  const service = new WorkspaceResearch(config, async (_url, init) => { calls++; providerSignal = init?.signal; return original; });
  const aborted = controller(); aborted.abort();
  await assert.rejects(service.search('alice', 'q', aborted.signal, () => true), status(503)); assert.equal(calls, 0);
  const caller = controller(), pending = assert.rejects(service.search('alice', 'q', caller.signal, () => true), status(503)); caller.abort(); await pending;
  assert.ok(providerSignal?.aborted);
  await assert.rejects(service.search('alice', 'q', controller().signal, () => true), status(429)); assert.equal(calls, 1);
  let drained = false; const closing = service.close().then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(response()); await closing; assert.equal(drained, true);
});

test('revocation cancels in-flight work and never delivers a buffered response', async () => {
  let allowed = true, providerSignal: AbortSignal | null | undefined;
  const service = new WorkspaceResearch(config, async (_url, init) => { providerSignal = init?.signal; return new Promise<Response>(() => {}); });
  // Keep a test handle alive while production reauthorization timers are unref'ed.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const pending = assert.rejects(service.search('alice', 'q', controller().signal, () => allowed), status(401)); allowed = false;
    await pending; assert.ok(providerSignal?.aborted);
  } finally { clearInterval(keepAlive); service.close(); }
  const late = new WorkspaceResearch(config, async () => { allowed = false; return response(); }); allowed = true;
  await assert.rejects(late.search('alice', 'q', controller().signal, () => allowed), status(401)); late.close();
});

test('deadline covers stalled headers and body; oversized decoded bytes and invalid JSON/type rejected', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const fetcher of [async () => new Promise<Response>(() => {}), async () => new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } })]) {
      const service = new WorkspaceResearch(config, fetcher, Date.now, 25);
      await assert.rejects(service.search('alice', 'q', controller().signal, () => true), status(504)); service.close();
    }
    for (const bad of [new Response('secret', { status: 500 }), new Response('{}'), new Response('broken', { headers: { 'content-type': 'application/json' } }),
      Response.json({ content: 'x'.repeat(RESEARCH_RESPONSE_BYTES) })]) {
      let calls = 0; const service = new WorkspaceResearch(config, async () => { calls++; return bad; });
      await assert.rejects(service.search('alice', 'q', controller().signal, () => true), status(502)); assert.equal(calls, 1); service.close();
    }
  } finally { clearInterval(keepAlive); }
});

test('actual HTTP transport refuses redirects and aborts slow response stream on disconnect', async () => {
  let mode = 'redirect', secretRequests = 0, closed: Promise<unknown> | undefined;
  const server = createServer((req, res) => {
    if (req.url === '/secret') { secretRequests++; res.end('never'); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: '/secret' }); res.end(); return; }
    closed = once(res, 'close'); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"results":[');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const service = new WorkspaceResearch({ ...config, searchUrl: `http://127.0.0.1:${address.port}/search` });
  try {
    await assert.rejects(service.search('alice', 'q', controller().signal, () => true), status(502)); assert.equal(secretRequests, 0);
    mode = 'slow'; const caller = controller(), pending = assert.rejects(service.search('alice', 'q', caller.signal, () => true), status(503));
    while (!closed) await new Promise(resolve => setTimeout(resolve, 5));
    caller.abort(); await pending; await closed;
  } finally { service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
