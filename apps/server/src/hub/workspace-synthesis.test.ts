import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ResearchError, WorkspaceResearch, parseResearchConfig } from './workspace-research.js';
import { WorkspaceSynthesis, SYNTHESIS_OUTPUT_TOKENS } from './workspace-synthesis.js';
import { loadConfig, redactedConfig } from '../config.js';

const config = { url: 'https://model.example/v1/responses', model: 'operator-model', token: 'synthetic-ai-only', users: ['alice', 'bob', 'carol', 'dan'] };
const research = { searchUrl: 'https://search.example/search', users: config.users, synthesis: config };
const result = { searchId: '99999999-0000-4000-8000-000000000000', query: 'a query', fetchedAt: 1,
  sources: [{ id: 'S1', title: 'Title', url: 'https://source.example/', snippet: 'Untrusted snippet' },
    { id: 'S2', title: 'Excluded', url: 'https://source.example/2', snippet: 'not-selected' }] };
const answer = { paragraphs: [{ text: 'A synthesis.', citations: ['S1'] }], caveat: 'Only snippets, not verified.' };
const envelope = (value: unknown = answer) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const status = (code: number) => (error: unknown) => error instanceof ResearchError && error.status === code;
const signal = () => new AbortController().signal;

test('discovered selected model is actually dispatched; invalid models and unauthorized owners never infer', async () => {
  let reads = 0; const sent: string[] = [];
  const service = new WorkspaceSynthesis(config, async (url, init) => {
    if (init?.method === 'GET') { reads++; return Response.json({ data: [{ id: config.model }, { id: 'sol' }, { id: 'luna' }] }); }
    sent.push(JSON.parse(init!.body as string).model); return Response.json(envelope());
  }, Date.now, 45_000, { discoverModels: true, defaultModel: 'sol' });
  try {
    assert.equal(await service.catalog('unknown'), undefined); assert.equal(reads, 0);
    assert.equal((await service.catalog('alice'))?.model, 'sol');
    await service.synthesize('alice', result, ['S1'], signal(), () => true, undefined, 'luna');
    await service.synthesize('bob', result, ['S1'], signal(), () => true);
    for (const model of ['not-offered', ' sol', 'sol\n'])
      await assert.rejects(service.synthesize('alice', result, ['S1'], signal(), () => true, undefined, model), status(400));
    assert.deepEqual(sent, ['luna', 'sol']); assert.equal(reads, 1);
  } finally { service.close(); }
});

test('authorization and cancellation are rechecked after discovery before any model dispatch', async () => {
  let allowed = true, resolve!: (value: Response) => void, calls = 0;
  let entered!: () => void; const discovering = new Promise<void>(done => { entered = done; });
  const service = new WorkspaceSynthesis(config, async (_url, init) => {
    if (init?.method === 'GET') return new Promise(done => { resolve = done; entered(); });
    calls++; return Response.json(envelope());
  }, Date.now, 45_000, { discoverModels: true });
  try {
    const pending = service.synthesize('alice', result, ['S1'], signal(), () => allowed);
    await discovering; allowed = false; resolve(Response.json({ data: [{ id: config.model }] }));
    await assert.rejects(pending, status(401)); assert.equal(calls, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(service.synthesize('bob', result, ['S1'], controller.signal, () => true), status(503)); assert.equal(calls, 0);
  } finally { service.close(); }
});

test('AI config requires separate opt-in, explicit subset, dedicated credentials, and redacts every value', () => {
  const env = { AOD_RESEARCH_ENABLED: 'true', AOD_RESEARCH_SEARCH_URL: research.searchUrl, AOD_RESEARCH_USERS: 'alice,bob',
    AOD_RESEARCH_AI_ENABLED: 'true', AOD_RESEARCH_AI_RESPONSES_URL: config.url, AOD_RESEARCH_AI_MODEL: config.model,
    AOD_RESEARCH_AI_TOKEN: config.token, AOD_RESEARCH_AI_USERS: 'alice' };
  assert.equal(parseResearchConfig({ ...env, AOD_RESEARCH_AI_ENABLED: 'false' })?.synthesis, undefined);
  assert.deepEqual(parseResearchConfig(env)?.synthesis, { ...config, users: ['alice'] });
  for (const [key, values] of Object.entries({ AOD_RESEARCH_AI_RESPONSES_URL: ['', 'file:///secret', 'http://lan/v1/responses', 'https://u:p@model.test/', 'https://model.test/?key=a', 'https://model.test/#a'],
    AOD_RESEARCH_AI_MODEL: ['', 'bad\nmodel'], AOD_RESEARCH_AI_TOKEN: ['', 'bad\nkey'], AOD_RESEARCH_AI_USERS: ['', 'admin', 'alice,carol'] })) {
    for (const value of values) assert.throws(() => parseResearchConfig({ ...env, [key]: value }), /Invalid research AI configuration/);
  }
  assert.ok(parseResearchConfig({ ...env, AOD_RESEARCH_AI_RESPONSES_URL: 'http://127.0.0.1:9999/responses', AOD_RESEARCH_AI_ALLOW_HTTP: 'true' }));
  const diagnostic = JSON.stringify(redactedConfig(loadConfig(env)));
  for (const value of [config.url, config.model, config.token, 'alice']) assert.ok(!diagnostic.includes(value));
});

test('snapshots are owner-bound, cloned, replaced, expire, disappear on shutdown and absent without AI', async () => {
  let now = 1000;
  const search = new WorkspaceResearch(research, async () => Response.json({ results: [{ title: 'T', url: 'https://s.example/', content: 'S' }] }), () => now);
  const first = await search.search('alice', 'q', signal(), () => true);
  assert.throws(() => search.snapshot('bob', first.searchId), status(400));
  first.sources[0]!.snippet = 'browser mutation'; assert.equal(search.snapshot('alice', first.searchId).sources[0]!.snippet, 'S');
  const second = await search.search('alice', 'q2', signal(), () => true);
  assert.throws(() => search.snapshot('alice', first.searchId), status(400));
  now += 600_000; assert.throws(() => search.snapshot('alice', second.searchId), status(400));
  search.close(); assert.throws(() => search.snapshot('alice', second.searchId), status(403));
  const off = new WorkspaceResearch({ searchUrl: research.searchUrl, users: research.users }); assert.equal(off.synthesisEnabled('alice'), false); off.close();
});

test('only selected snapshot fields leave Hub; result citations verified and projected; one request without cookies/retries', async () => {
  let calls = 0;
  const service = new WorkspaceSynthesis(config, async (url, init) => {
    calls++; assert.equal(url, config.url); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.deepEqual(init?.headers, { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${config.token}` });
    const body = JSON.parse(init!.body as string); assert.equal(body.model, config.model); assert.equal(body.store, false); assert.equal(body.stream, false);
    assert.deepEqual(body.tools, []); assert.equal(body.max_output_tokens, SYNTHESIS_OUTPUT_TOKENS);
    const input = JSON.parse(body.input[0].content); assert.deepEqual(input.sources, [{ id: 'S1', title: 'Title', snippet: 'Untrusted snippet' }]);
    assert.equal(input.query, result.query); assert.ok(!init!.body!.toString().includes('https://source.example'));
    return Response.json(envelope({ ...answer, paragraphs: [{ ...answer.paragraphs[0], injected: 'discard' }] }));
  });
  assert.deepEqual(await service.synthesize('alice', result, ['S1'], signal(), () => true), { ...answer, searchId: result.searchId });
  assert.equal(calls, 1); service.close();
});

test('rejects unknown/missing/duplicate/unselected citations, tools, refusal, incomplete, oversized and malformed responses', async () => {
  const bad = [envelope({ ...answer, paragraphs: [{ text: 'X', citations: ['S9'] }] }), envelope({ ...answer, paragraphs: [{ text: 'X', citations: ['S2'] }] }),
    envelope({ ...answer, paragraphs: [{ text: 'X', citations: [] }] }), envelope({ ...answer, paragraphs: [{ text: 'X', citations: ['S1', 'S1'] }] }),
    envelope({ ...answer, paragraphs: [{ text: 'X'.repeat(2001), citations: ['S1'] }] }),
    { ...envelope(), status: 'incomplete' }, { status: 'completed', output: [{ ...envelope().output[0], status: 'incomplete' }] },
    { status: 'completed', output: [{ type: 'function_call' }] },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] },
    { ...envelope(), extra: 'x'.repeat(128 * 1024) }];
  for (const value of bad) {
    const service = new WorkspaceSynthesis(config, async () => Response.json(value));
    await assert.rejects(service.synthesize('alice', result, ['S1'], signal(), () => true), status(502)); service.close();
  }
  for (const response of [new Response('secret', { status: 500 }), new Response('{}'), new Response('bad json', { headers: { 'content-type': 'application/json' } })]) {
    const service = new WorkspaceSynthesis(config, async () => response);
    await assert.rejects(service.synthesize('alice', result, ['S1'], signal(), () => true), status(502)); service.close();
  }
});

test('separate concurrency/rate budgets, early auth/source validation, no automatic replay after cancellation', async () => {
  let calls = 0;
  const service = new WorkspaceSynthesis(config, async () => { calls++; return Response.json(envelope()); });
  await assert.rejects(service.synthesize('admin', result, ['S1'], signal(), () => true), status(403));
  for (const ids of [[], ['S9'], ['S1', 'S1']]) await assert.rejects(service.synthesize('alice', result, ids, signal(), () => true), status(400));
  await assert.rejects(service.synthesize('alice', result, ['S1'], signal(), () => false), status(401));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.synthesize('alice', result, ['S1'], controller.signal, () => true), status(503)); assert.equal(calls, 0);
  for (const user of config.users.slice(0, 3)) for (let i = 0; i < 3; i++) await service.synthesize(user, result, ['S1'], signal(), () => true);
  await assert.rejects(service.synthesize('alice', result, ['S1'], signal(), () => true), status(429));
  await service.synthesize('dan', result, ['S1'], signal(), () => true);
  await assert.rejects(service.synthesize('dan', result, ['S1'], signal(), () => true), status(429)); assert.equal(calls, 10); service.close();
  const stuck = new WorkspaceSynthesis(config, async () => new Promise<Response>(() => {}));
  const pending = ['alice', 'bob'].map(user => assert.rejects(stuck.synthesize(user, result, ['S1'], signal(), () => true), status(503)));
  await assert.rejects(stuck.synthesize('carol', result, ['S1'], signal(), () => true), status(429));
  await assert.rejects(stuck.synthesize('alice', result, ['S1'], signal(), () => true), status(429)); stuck.close(); await Promise.all(pending);
});

test('deadline covers headers and body; revocation and disconnect abort active transport', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const transport of [async () => new Promise<Response>(() => {}), async () => new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } })]) {
      const service = new WorkspaceSynthesis(config, transport, Date.now, 20);
      await assert.rejects(service.synthesize('alice', result, ['S1'], signal(), () => true), status(504)); service.close();
    }
    let allowed = true, providerSignal: AbortSignal | null | undefined;
    const currentProviderSignal = (): AbortSignal | null | undefined => providerSignal;
    const service = new WorkspaceSynthesis(config, async (_url, init) => { providerSignal = init?.signal; return new Promise<Response>(() => {}); });
    const revoked = assert.rejects(service.synthesize('alice', result, ['S1'], signal(), () => allowed), status(401));
    await new Promise(resolve => setImmediate(resolve)); assert.ok(providerSignal); allowed = false;
    await revoked; assert.ok(currentProviderSignal()?.aborted); allowed = true;
    await assert.rejects(service.synthesize('alice', result, ['S1'], signal(), () => true), status(429));
    providerSignal = undefined;
    const caller = new AbortController(), cancelled = assert.rejects(service.synthesize('bob', result, ['S1'], caller.signal, () => true), status(503));
    await new Promise(resolve => setImmediate(resolve)); assert.ok(providerSignal);
    caller.abort(); await cancelled; assert.ok(currentProviderSignal()?.aborted); service.close();
    const late = new WorkspaceSynthesis(config, async () => { allowed = false; return Response.json(envelope()); }); allowed = true;
    await assert.rejects(late.synthesize('alice', result, ['S1'], signal(), () => allowed), status(401)); late.close();
  } finally { clearInterval(keepAlive); }
});

test('real HTTP refuses redirect credential forwarding and aborts a stalled response body', async () => {
  let mode = 'redirect', leaked = 0, closed: Promise<unknown> | undefined;
  const server = createServer((req, res) => {
    if (req.url === '/secret') { leaked++; res.end(); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: '/secret' }); res.end(); return; }
    closed = once(res, 'close'); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const service = new WorkspaceSynthesis({ ...config, url: `http://127.0.0.1:${address.port}/responses` });
  try {
    await assert.rejects(service.synthesize('alice', result, ['S1'], signal(), () => true), status(502)); assert.equal(leaked, 0);
    mode = 'slow'; const caller = new AbortController(), pending = assert.rejects(service.synthesize('alice', result, ['S1'], caller.signal, () => true), status(503));
    for (let i = 0; i < 100 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(closed);
    caller.abort(); await pending; await closed;
  } finally { service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
