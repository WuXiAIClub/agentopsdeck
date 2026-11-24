import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { QuickChatStore } from '../hub/quick-chat-store.js';
import { QuickChatService } from '../hub/quick-chat-service.js';
import { registerHubQuickChat } from './hub-quick-chat.js';

const config = { url: 'https://synthetic.test/v1/responses', model: 'synthetic-model', token: 'synthetic-secret', users: ['alice'] };
const completed = () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_RESULT' }] }] });
test('temporary chat sends bounded structured history, binds receipt identity, and never replays or accepts privileged roles', async () => {
  const db = new DatabaseSync(':memory:'), store = new QuickChatStore(db, Date.now, Buffer.alloc(32, 2));
  const bodies: Record<string, unknown>[] = [];
  const service = new QuickChatService(store, config, async (_, init) => { bodies.push(JSON.parse(String(init?.body))); return completed(); });
  const app = new Hono(); registerHubQuickChat(app, { service, principal: () => ({ userId: 'alice', admin: false }) });
  const post = (body: unknown) => app.request('/api/hub/v1/quick-chat/requests', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  try {
    const profileId = randomUUID(); service.saveProfile('alice', 0, { id: profileId, name: 'Temporary', target: 'hub-standalone', model: config.model, outputLimit: 700 });
    const history = [{ role: 'user', content: 'FIRST_PRIVATE' }, { role: 'assistant', content: 'ANSWER_PRIVATE' }];
    const original = { requestId: randomUUID(), profileId, revision: 1, input: 'Follow up', history };
    assert.equal((await post(original)).status, 200);
    assert.deepEqual(bodies[0]?.input, [...history, { role: 'user', content: 'Follow up' }]);
    assert.equal(bodies[0]?.store, false); assert.equal(bodies[0]?.stream, false);
    assert.equal((await post(original)).status, 200); assert.equal(bodies.length, 1);
    assert.equal((await post({ ...original, history: [{ ...history[0], content: 'Changed' }, history[1]] })).status, 409);
    for (const history of [null, {}, [{ role: 'system', content: 'Secret' }, { role: 'assistant', content: 'a' }],
      [{ role: 'user', content: 'q' }], [{ role: 'user', content: 'q', tool: 'bad' }, { role: 'assistant', content: 'a' }],
      Array(34).fill([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]).flat(),
      [{ role: 'user', content: 'q'.repeat(8001) }, { role: 'assistant', content: 'a' }],
      [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a'.repeat(32001) }],
      [{ role: 'user', content: 'q'.repeat(8000) }, { role: 'assistant', content: 'a'.repeat(32000) }, { role: 'user', content: 'q'.repeat(8000) }, { role: 'assistant', content: 'a' }]]) {
      assert.equal((await post({ ...original, requestId: randomUUID(), history })).status, 409);
    }
    assert.equal(bodies.length, 1);
    assert.equal(store.receipts('alice').length, 1, 'invalid history is rejected before durable admission');
    assert.equal(JSON.stringify(store.receipts('alice')).includes('FIRST_PRIVATE'), false);
  } finally { service.close(); db.close(); }
});
test('gateway catalog selects real models, edits profiles with CAS and dispatches the frozen selection without a session', async () => {
  const db = new DatabaseSync(':memory:'), store = new QuickChatStore(db, Date.now, Buffer.alloc(32, 2));
  let reads = 0, writes = 0; const bodies: Record<string, unknown>[] = [];
  const service = new QuickChatService(store, config, async (url, init) => {
    if (init?.method === 'GET') {
      reads++; assert.equal(String(url), 'https://synthetic.test/v1/models'); assert.equal(init.redirect, 'error');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-secret');
      return Response.json({ data: [{ id: 'synthetic-model' }, { id: 'sol' }, { id: 'luna' }, { id: 'sol' }] });
    }
    writes++; assert.equal(String(url), config.url); bodies.push(JSON.parse(String(init?.body))); return completed();
  }, 45000, { discoverModels: true, defaultModel: 'sol' });
  const app = new Hono(); registerHubQuickChat(app, { service, principal: () => ({ userId: 'alice', admin: false }) });
  const request = (path = '', method = 'GET', body?: unknown) => app.request('/api/hub/v1/quick-chat' + path,
    { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
  try {
    const result = await (await request()).json(); assert.equal(result.target.model, 'sol');
    assert.deepEqual(result.target.models.map((m: { id: string }) => m.id), ['synthetic-model', 'sol', 'luna']);
    assert.equal(result.target.catalogState, 'ready'); assert.equal(reads, 1); assert.equal(writes, 0);
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
    const id = randomUUID(), profile = { revision: 0, name: 'Heavy', target: 'hub-standalone', model: 'sol', outputLimit: 700 };
    assert.equal((await request(`/profiles/${id}`, 'PUT', profile)).status, 200);
    assert.equal((await request(`/profiles/${randomUUID()}`, 'PUT', { ...profile, model: 'forged' })).status, 409);
    const original = { requestId: randomUUID(), profileId: id, revision: 1, input: 'input' };
    assert.equal((await request('/requests', 'POST', original)).status, 200);
    assert.equal((await request(`/profiles/${id}`, 'PUT', { ...profile, revision: 1, model: 'luna' })).status, 200);
    assert.equal((await request(`/profiles/${id}`, 'PUT', { ...profile, revision: 1 })).status, 409);
    const next = { ...original, requestId: randomUUID(), revision: 2 };
    assert.equal((await request('/requests', 'POST', next)).status, 200);
    assert.deepEqual(bodies.map(b => b.model), ['sol', 'luna']);
    for (const body of bodies) { assert.equal(body.store, false); assert.equal(body.stream, false); assert.deepEqual(body.tools, []); assert.equal(body.max_output_tokens, 700); }
    assert.equal((await (await request(`/requests/${original.requestId}`)).json()).receipt.profile.model, 'sol');
    await request('/requests', 'POST', original); assert.equal(reads, 1); assert.equal(writes, 2);
  } finally { service.close(); db.close(); }
});
test('catalog removal/failure cannot retain stale models; original receipt queries never discover or resend', async () => {
  const db = new DatabaseSync(':memory:'), store = new QuickChatStore(db, Date.now, Buffer.alloc(32, 3));
  let broken = false, ids = ['synthetic-model', 'sol'], reads = 0, writes = 0;
  const service = new QuickChatService(store, config, async (_, init) => {
    if (init?.method === 'GET') { reads++; if (broken) throw Error('PRIVATE_ERROR'); return Response.json({ data: ids.map(id => ({ id })) }); }
    writes++; return completed();
  }, 45000, { discoverModels: true });
  const id = randomUUID(), requestId = randomUUID();
  try {
    await service.catalog('alice'); service.saveProfile('alice', 0, { id, name: 'Sol', target: 'hub-standalone', model: 'sol', outputLimit: 100 });
    await service.send('alice', requestId, id, 1, 'input', () => true);
    ids = ['synthetic-model']; await service.catalog('alice', true);
    await assert.rejects(service.send('alice', randomUUID(), id, 1, 'next', () => true), /target-changed/);
    await service.send('alice', requestId, id, 1, 'input', () => true); assert.equal(writes, 1); assert.equal(reads, 2);
    broken = true; const target = await service.catalog('alice', true);
    assert.equal(target?.catalogState, 'unavailable'); assert.deepEqual(target?.models.map(m => m.id), ['synthetic-model']);
    assert.throws(() => service.saveProfile('alice', 1, { id, name: 'Sol', target: 'hub-standalone', model: 'sol', outputLimit: 100 }), /target-changed/);
    service.inspect('alice', requestId); assert.equal(reads, 3); assert.equal(writes, 1);
    assert.equal(await service.catalog('bob'), undefined); assert.equal(reads, 3);
  } finally { service.close(); db.close(); }
});
test('overlapping catalog reads coalesce; malformed, oversized and timed-out catalogs fail closed without inference', async () => {
  for (const mode of ['coalesce', 'malformed', 'oversize', 'timeout']) {
    const db = new DatabaseSync(':memory:'), store = new QuickChatStore(db, Date.now, Buffer.alloc(32, 4));
    let calls = 0, release: (() => void) | undefined;
    const service = new QuickChatService(store, config, async (_, init) => {
      calls++; assert.equal(init?.method, 'GET');
      if (mode === 'coalesce') await new Promise<void>(resolve => { release = resolve; });
      if (mode === 'timeout') return await new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(Error('timeout')), { once: true }));
      if (mode === 'malformed') return Response.json({ data: [{ id: ' sol' }] });
      if (mode === 'oversize') return new Response('x'.repeat(128 * 1024 + 1), { headers: { 'content-type': 'application/json' } });
      return Response.json({ data: [{ id: 'sol' }] });
    }, 45000, { discoverModels: true, catalogTimeoutMs: mode === 'timeout' ? 5 : 1000 });
    const keepAlive = setInterval(() => {}, 50);
    try {
      const first = service.catalog('alice', true), second = service.catalog('alice', true);
      // Original work is published before transport/diagnostics may reenter.
      await Promise.resolve(); release?.();
      const targets = await Promise.all([first, second]); assert.equal(calls, 1);
      assert.deepEqual(targets[0]?.models.map(m => m.id), mode === 'coalesce' ? ['sol'] : ['synthetic-model']);
      assert.equal(targets[0]?.model, mode === 'coalesce' ? 'sol' : 'synthetic-model');
      assert.equal(targets[0]?.catalogState, mode === 'coalesce' ? 'ready' : 'unavailable');
    } finally { clearInterval(keepAlive); await service.close(); db.close(); }
  }
});
test('identity changes during catalog reads are fenced and cannot disclose profiles', async () => {
  const db = new DatabaseSync(':memory:'), store = new QuickChatStore(db, Date.now, Buffer.alloc(32, 5)); let owner = 'alice';
  const service = new QuickChatService(store, config, async () => { owner = 'bob'; return Response.json({ data: [{ id: 'sol' }] }); }, 45000, { discoverModels: true });
  const app = new Hono(); registerHubQuickChat(app, { service, principal: () => ({ userId: owner, admin: false }) });
  try { assert.equal((await app.request('/api/hub/v1/quick-chat')).status, 403); }
  finally { service.close(); db.close(); }
});
test('provider timeout and oversized responses retain original unknown identity', async () => {
  for (const mode of ['timeout', 'oversize']) {
    const db = new DatabaseSync(':memory:'); let calls = 0;
    const store = new QuickChatStore(db, Date.now, Buffer.alloc(32, 1));
    const service = new QuickChatService(store, config, async (_, init) => {
      calls++;
      if (mode === 'timeout') return await new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(Error('timeout')), { once: true }));
      return new Response('x'.repeat(128 * 1024 + 1), { headers: { 'content-type': 'application/json' } });
    }, 5);
    const keepAlive = setInterval(() => {}, 50);
    try {
      const id = randomUUID(), profileId = randomUUID();
      service.saveProfile('alice', 0, { id: profileId, name: 'Fixture', target: 'hub-standalone', model: config.model, outputLimit: 100 });
      assert.equal((await service.send('alice', id, profileId, 1, 'input', () => true)).receipt.state, 'unknown');
      assert.equal((await service.send('alice', id, profileId, 1, 'input', () => true)).receipt.state, 'unknown');
      assert.equal(calls, 1);
    } finally { clearInterval(keepAlive); service.close(); db.close(); }
  }
});
test('overlapping calls claim once and cannot bypass provider active capacity', async () => {
  const db = new DatabaseSync(':memory:'); let calls = 0; const releases: (() => void)[] = [];
  const store = new QuickChatStore(db, Date.now, Buffer.alloc(32, 1));
  const service = new QuickChatService(store, { ...config, users: ['alice', 'bob', 'carol'] }, async () => {
    calls++; await new Promise<void>(resolve => releases.push(resolve)); return completed();
  });
  const profileId = randomUUID(), id = randomUUID();
  try {
    for (const owner of ['alice', 'bob', 'carol']) service.saveProfile(owner, 0, { id: profileId, name: 'Fixture', target: 'hub-standalone', model: config.model, outputLimit: 100 });
    const first = service.send('alice', id, profileId, 1, 'input', () => true);
    const second = service.send('bob', id, profileId, 1, 'input', () => true);
    assert.equal((await service.send('alice', id, profileId, 1, 'input', () => true)).receipt.state, 'unknown');
    await assert.rejects(service.send('carol', id, profileId, 1, 'input', () => true), /provider-capacity/);
    releases.forEach(resolve => resolve()); await Promise.all([first, second]); assert.equal(calls, 2);
  } finally { service.close(); db.close(); }
});
function fixture(transport: typeof fetch = async () => completed()) {
  const db = new DatabaseSync(':memory:'), key = Buffer.alloc(32, 9); let owner = 'alice', now = 1000;
  const store = new QuickChatStore(db, () => now, key), service = new QuickChatService(store, config, transport);
  const app = new Hono(); registerHubQuickChat(app, { service, principal: () => ({ userId: owner, admin: false }) });
  const request = (path = '', method = 'GET', body?: unknown) => app.request('/api/hub/v1/quick-chat' + path,
    { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
  const profileId = randomUUID(), requestId = randomUUID();
  const profile = { name: 'LowPriority', target: 'hub-standalone', model: config.model, outputLimit: 1024, revision: 0 };
  const send = { requestId, profileId, revision: 1, input: 'PRIVATE_INPUT' };
  return { db, store, service, request, profileId, profile, send, owner: (v: string) => { owner = v; }, tick: (v: number) => { now = v; },
    close: () => { service.close(); db.close(); } };
}
test('quick chat HTTP uses configured target, sends once without thread, persists private result and owner-only original GET', async () => {
  let writes = 0;
  const f = fixture(async (url, init) => {
    writes++; assert.equal(url, config.url); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { model: config.model, store: false, stream: false, tools: [], max_output_tokens: 1024, input: [{ role: 'user', content: 'PRIVATE_INPUT' }] });
    return completed();
  });
  try {
    assert.equal((await f.request()).status, 200); assert.equal(writes, 0);
    assert.equal((await f.request(`/profiles/${f.profileId}`, 'PUT', f.profile)).status, 200);
    const response = await f.request('/requests', 'POST', f.send); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.receipt.state, 'completed'); assert.equal(result.output, 'PRIVATE_RESULT');
    assert.equal(JSON.stringify(result).includes('fingerprint'), false);
    assert.equal((await (await f.request('/requests', 'POST', f.send)).json()).receipt.state, 'completed'); assert.equal(writes, 1);
    assert.equal((await f.request('/requests', 'POST', { ...f.send, input: 'different' })).status, 409);
    const payload = JSON.stringify(f.db.prepare('SELECT payload FROM quick_chat_receipts').all());
    assert.equal(payload.includes('PRIVATE_INPUT'), false); assert.equal(payload.includes('PRIVATE_RESULT'), false);
    assert.equal(Buffer.from(f.db.prepare('SELECT body FROM quick_chat_results').get()!.body as Uint8Array).includes(Buffer.from('PRIVATE_RESULT')), false);
    assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE '%session%'").get()!.n, 0);
    f.owner('bob'); assert.equal((await f.request(`/requests/${f.send.requestId}`)).status, 409);
    assert.deepEqual(await (await f.request()).json(), { target: null, profiles: [], receipts: [] });
    f.owner('alice'); assert.equal((await (await f.request(`/requests/${f.send.requestId}`)).json()).output, 'PRIVATE_RESULT');
    assert.equal((await (await f.request(`/requests/${f.send.requestId}/result`, 'DELETE')).json()).output, null);
    assert.equal((await (await f.request('/requests', 'POST', f.send)).json()).output, null); assert.equal(writes, 1);
  } finally { f.close(); }
});
test('lost provider response and malformed replies remain unknown; original GET and repeat POST never dispatch again', async () => {
  for (const transport of [async () => { throw Error('PRIVATE_PROVIDER_ERROR'); }, async () => new Response('bad'),
    async () => Response.json({ status: 'incomplete', output: [] }), async () => Response.json({ status: 'completed', output: [{ type: 'function_call' }] })]) {
    let calls = 0; const f = fixture(async () => { calls++; return transport(); });
    try {
      await f.request(`/profiles/${f.profileId}`, 'PUT', f.profile);
      assert.equal((await (await f.request('/requests', 'POST', f.send)).json()).receipt.state, 'unknown');
      assert.equal((await (await f.request(`/requests/${f.send.requestId}`)).json()).receipt.state, 'unknown');
      await f.request('/requests', 'POST', f.send); assert.equal(calls, 1);
      assert.equal((await f.request(`/requests/${f.send.requestId}/cancel`, 'POST')).status, 409);
      await f.request(`/requests/${f.send.requestId}/result`, 'DELETE');
      assert.equal(f.store.receipt('alice', f.send.requestId)?.state, 'unknown');
      f.tick(86401001); assert.equal(f.store.receipt('alice', f.send.requestId)?.state, 'unknown');
    } finally { f.close(); }
  }
});
test('profile target forgery, revision drift, extra fields and identity change cannot send', async () => {
  let writes = 0; const f = fixture(async () => { writes++; return completed(); });
  try {
    assert.equal((await f.request(`/profiles/${f.profileId}`, 'PUT', { ...f.profile, target: 'https://evil.test' })).status, 409);
    assert.equal((await f.request(`/profiles/${f.profileId}`, 'PUT', { ...f.profile, token: 'forbidden' })).status, 400);
    await f.request(`/profiles/${f.profileId}`, 'PUT', f.profile);
    assert.equal((await f.request('/requests', 'POST', { ...f.send, revision: 0 })).status, 409);
    assert.equal((await f.request('/requests', 'POST', { ...f.send, sessionId: 'forbidden' })).status, 400);
    await assert.rejects(f.service.send('alice', f.send.requestId, f.profileId, 1, 'PRIVATE_INPUT', () => false), /authority/);
    f.owner('bob'); assert.equal((await f.request('/requests', 'POST', f.send)).status, 409); assert.equal(writes, 0);
  } finally { f.close(); }
});
test('revocation during provider I/O does not disclose result; later owner lookup can recover original', async () => {
  const f = fixture(async () => { f.owner('bob'); return completed(); });
  try {
    await f.request(`/profiles/${f.profileId}`, 'PUT', f.profile);
    assert.equal((await f.request('/requests', 'POST', f.send)).status, 403);
    assert.equal(f.store.receipt('alice', f.send.requestId)?.state, 'completed');
    f.owner('alice'); assert.equal((await (await f.request(`/requests/${f.send.requestId}`)).json()).output, 'PRIVATE_RESULT');
  } finally { f.close(); }
});
test('encrypted result and original unknown receipt survive real SQLite reopen; TTL and clear do not permit replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-quick-chat-')), file = join(root, 'fixture.sqlite'), key = Buffer.alloc(32, 7);
  let db = new DatabaseSync(file), now = 1000, calls = 0;
  let store = new QuickChatStore(db, () => now, key), service = new QuickChatService(store, config, async () => { calls++; return completed(); });
  const profileId = randomUUID(), requestId = randomUUID();
  try {
    service.saveProfile('alice', 0, { id: profileId, name: 'Heavy', target: 'hub-standalone', model: config.model, outputLimit: 1000 });
    await service.send('alice', requestId, profileId, 1, 'PRIVATE_INPUT', () => true);
    service.close(); db.close(); db = new DatabaseSync(file); store = new QuickChatStore(db, () => now, key);
    service = new QuickChatService(store, config, async () => { calls++; throw Error('never replay'); });
    assert.equal(service.inspect('alice', requestId).output, 'PRIVATE_RESULT');
    await service.send('alice', requestId, profileId, 1, 'PRIVATE_INPUT', () => true); assert.equal(calls, 1);
    now = 86401001; assert.equal(service.inspect('alice', requestId).output, null);
    await service.send('alice', requestId, profileId, 1, 'PRIVATE_INPUT', () => true); assert.equal(calls, 1);
    const unknown = randomUUID(); await service.send('alice', unknown, profileId, 1, 'new input', () => true);
    service.close(); db.close(); db = new DatabaseSync(file); store = new QuickChatStore(db, () => now, key);
    service = new QuickChatService(store, config, async () => { calls++; return completed(); });
    assert.equal(service.inspect('alice', unknown).receipt.state, 'unknown');
    await service.send('alice', unknown, profileId, 1, 'new input', () => true); assert.equal(calls, 2);
  } finally { service.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
