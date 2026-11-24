import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RESEARCH_ARTICLE_LIMIT, validResearchArticle, type ResearchResult } from '@agentopsdeck/shared';
import { parseResearchConfig, WorkspaceResearch } from './workspace-research.js';
import { WorkspaceReader } from './workspace-reader.js';

const config = { url: 'https://reader.example/extract', users: ['alice'], sourceOrigins: ['https://article.example'], token: 'synthetic-reader-only' };
const snapshot = (): ResearchResult => ({ searchId: randomUUID(), query: 'private search', fetchedAt: Date.now(),
  sources: [{ id: 'S1', url: 'https://article.example/story', title: 'Source title', snippet: 'Snippet' }] });
const reply = (result: ResearchResult, text = 'Full article\nSecond paragraph') => Response.json({ url: result.sources[0]!.url, text, truncated: false });
const allowed = () => true;
const signal = () => new AbortController().signal;

test('reader config default-off and exact users/origins, rejects wildcard and private literal sources', () => {
  const env = { AOD_RESEARCH_ENABLED: 'true', AOD_RESEARCH_SEARCH_URL: 'https://search.example/search', AOD_RESEARCH_USERS: 'alice' };
  assert.equal(parseResearchConfig(env)?.reader, undefined);
  const enabled = { ...env, AOD_RESEARCH_READER_ENABLED: 'true', AOD_RESEARCH_READER_URL: config.url,
    AOD_RESEARCH_READER_USERS: 'alice', AOD_RESEARCH_READER_SOURCE_ORIGINS: JSON.stringify(config.sourceOrigins) };
  assert.deepEqual(parseResearchConfig(enabled)?.reader, { url: config.url, users: config.users, sourceOrigins: config.sourceOrigins });
  for (const origins of [[], ['*'], ['https://*.example'], ['https://localhost'], ['https://127.0.0.1'], ['https://[::1]'],
    ['https://foo.local'], ['http://article.example'], ['https://article.example/'], ['https://article.example/path'], ['https://u:p@article.example'], ['https://article.example?x']]) {
    assert.throws(() => parseResearchConfig({ ...enabled, AOD_RESEARCH_READER_SOURCE_ORIGINS: JSON.stringify(origins) }), /Invalid research reader configuration/);
  }
  assert.throws(() => parseResearchConfig({ ...enabled, AOD_RESEARCH_READER_USERS: 'admin' }));
  assert.throws(() => parseResearchConfig({ ...enabled, AOD_RESEARCH_READER_TOKEN: 'SECRET\nKEY' }), error => !String(error).includes('SECRET'));
  assert.throws(() => parseResearchConfig({ ...enabled, AOD_RESEARCH_READER_URL: 'http://localhost/extract' }));
  assert.equal(parseResearchConfig({ ...enabled, AOD_RESEARCH_READER_URL: 'http://localhost/extract', AOD_RESEARCH_READER_ALLOW_HTTP: 'true' })?.reader?.url, 'http://localhost/extract');
});

test('fixed gateway only, strips private metadata, bounded plain text with original citation', async () => {
  const result = snapshot(); let calls = 0;
  const reader = new WorkspaceReader(config, async (url, init) => {
    calls++; assert.equal(url, config.url); assert.equal(init?.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${config.token}`);
    assert.deepEqual(JSON.parse(String(init.body)), { url: result.sources[0]!.url, format: 'text', redirects: false, maxCharacters: RESEARCH_ARTICLE_LIMIT });
    return reply(result, '<img src=x onerror=alert(1)>\nText\u202e\u0000');
  });
  try {
    const article = await reader.read('alice', result, 'S1', signal(), allowed);
    assert.ok(validResearchArticle(article, result)); assert.equal(article.text, '<img src=x onerror=alert(1)>\nText');
    assert.equal(article.title, 'Source title'); assert.equal(calls, 1); assert.ok(!JSON.stringify(article).includes(config.token));
    assert.equal(reader.target('admin'), undefined); assert.deepEqual(reader.origins('admin'), []);
    await assert.rejects(reader.read('admin', result, 'S1', signal(), allowed), /reader_unavailable/);
    await assert.rejects(reader.read('alice', result, 'S2', signal(), allowed), /reader_source_not_allowed/);
    result.sources[0]!.url = 'http://127.0.0.1/private';
    await assert.rejects(reader.read('alice', result, 'S1', signal(), allowed), /reader_source_not_allowed/);
    assert.equal(calls, 1);
  } finally { reader.close(); }
});

test('invalid/redirected/oversized provider responses rejected without retry', async () => {
  const result = snapshot();
  for (const response of [Response.json({ url: 'https://other.example/', text: 'redirect', truncated: false }),
    Response.json({ url: result.sources[0]!.url, text: 'x'.repeat(RESEARCH_ARTICLE_LIMIT + 1), truncated: false }),
    Response.json({ url: result.sources[0]!.url, text: '\u0000', truncated: false }), Response.json(null),
    new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    new Response('<html>not text</html>', { headers: { 'content-type': 'text/html' } }), new Response(null, { status: 302 })]) {
    let calls = 0; const reader = new WorkspaceReader(config, async () => { calls++; return response; });
    try { await assert.rejects(reader.read('alice', result, 'S1', signal(), allowed)); assert.equal(calls, 1); } finally { reader.close(); }
  }
});

test('cancellation, close, deadline, revocation and concurrency release admission even for uncooperative transport', async () => {
  const result = snapshot();
  for (const mode of ['cancel', 'close', 'timeout', 'revoke'] as const) {
    let calls = 0, authorized = true; const caller = new AbortController();
    const reader = new WorkspaceReader(config, async () => { calls++; return new Promise<Response>(() => {}); }, Date.now, mode === 'timeout' ? 20 : 2000);
    // The fake transport owns no real socket. Keep the isolated test alive for unref timers.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const pending = reader.read('alice', result, 'S1', caller.signal, () => authorized);
      const rejected = assert.rejects(pending, mode === 'timeout' ? /reader_timeout/ : mode === 'revoke' ? /authorization_changed/ : /reader_stopped/);
      await assert.rejects(reader.read('alice', result, 'S1', signal(), allowed), /reader_budget_exceeded/);
      if (mode === 'cancel') caller.abort(); else if (mode === 'close') reader.close(); else if (mode === 'revoke') authorized = false;
      await rejected; assert.equal(calls, 1);
    } finally { reader.close(); clearInterval(keepAlive); }
  }
});

test('reader-only users get bounded own snapshots and expiry, never another user snapshot', async () => {
  let now = Date.now();
  const service = new WorkspaceResearch({ searchUrl: 'https://search.example', users: ['alice', 'bob'], reader: config },
    async () => Response.json({ results: [{ title: 'Title', url: 'https://article.example/story', content: 'Snippet' }] }), () => now);
  try {
    const result = await service.search('alice', 'q', signal(), allowed);
    assert.deepEqual(service.snapshot('alice', result.searchId), result);
    assert.throws(() => service.snapshot('bob', result.searchId));
    now += 600_000; assert.throws(() => service.snapshot('alice', result.searchId), /search_expired/);
  } finally { service.close(); }
});

test('per-user rate cap resets, global parallel cap denies fifth read', async () => {
  let now = Date.now(); const result = snapshot(), users = ['a', 'b', 'c', 'd', 'e'];
  const reader = new WorkspaceReader({ ...config, users }, async () => reply(result), () => now);
  try {
    for (let i = 0; i < 10; i++) await reader.read('a', result, 'S1', signal(), allowed);
    await assert.rejects(reader.read('a', result, 'S1', signal(), allowed), /reader_budget_exceeded/);
    now += 60_000; await reader.read('a', result, 'S1', signal(), allowed);
  } finally { reader.close(); }
  const blocked = new WorkspaceReader({ ...config, users }, async () => new Promise<Response>(() => {}));
  const pending = users.slice(0, 4).map(user => assert.rejects(blocked.read(user, result, 'S1', signal(), allowed), /reader_stopped/));
  await assert.rejects(blocked.read('e', result, 'S1', signal(), allowed), /reader_budget_exceeded/);
  blocked.close(); await Promise.all(pending);
});
