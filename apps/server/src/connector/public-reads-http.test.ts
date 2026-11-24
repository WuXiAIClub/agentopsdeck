import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AgentSummary, SystemMetrics } from '@agentopsdeck/shared';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ChangeSignal } from '../utils/change-signal.js';
import type { EventReplayRead } from '../routes/events.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorReadAuthority, type ConnectorReadAuthority } from './read-authority.js';
import { registerConnectorPublicReads } from './public-reads-http.js';
import { registerConnectorProtocol } from './protocol-http.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from './node-identity.js';

const base = '/api/connector/v1';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const metrics: SystemMetrics = { version: 1, source: { kind: 'connector', id: 'node' }, sampledAt: 10000, scope: 'process',
  cpu: { percent: null, cores: 1 }, memory: { usedBytes: 10, totalBytes: null, availableBytes: null }, volumes: [] };
function held<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}
function fixture(options: { authority?: ConnectorReadAuthority; replay?: EventReplayRead; mediaRoot?: string;
  agents?: () => Promise<AgentSummary[]>; sample?: () => Promise<SystemMetrics>; waitMs?: number } = {}) {
  const changes = new ChangeSignal(), authorityChanges = new ChangeSignal();
  let allowed = true, samples = 0, stopped = 0, checks = 0;
  const authority: ConnectorReadAuthority = options.authority ?? { changes: authorityChanges,
    async begin(request, scope) {
      if (!allowed || request.headers.get('authorization') !== 'Bearer PRIVATE') throw new HTTPException(403);
      return { principal: { tokenId: 'private-id', label: 'private-label', scopes: [scope] }, check(signal) {
        checks++; signal?.throwIfAborted(); if (!allowed) throw new HTTPException(403);
      } };
    } };
  const diagnostics = new PerformanceDiagnostics(() => {}), app = new Hono();
  const routes = registerConnectorPublicReads(app, base, { authority, changes,
    replay: options.replay ?? (async () => ({ cursor: 'cursor', known: true, events: [] })),
    agents: options.agents ?? (async () => [{ id: 'agent' }]), connector: { environmentId: 'env', environmentLabel: 'Environment' },
    sampler: { sample: () => { samples++; return options.sample?.() ?? Promise.resolve(metrics); }, close: async () => { stopped++; } },
    diagnostics, ...(options.mediaRoot ? { mediaRoot: options.mediaRoot } : {}), waitMs: options.waitMs ?? 1000 });
  return { app, routes, changes, diagnostics, authorityChanges,
    get: (path: string, headers: Record<string, string> = {}, signal?: AbortSignal, method = 'GET') => app.request(
      new Request(`http://local${base}${path}`, { method, headers: { authorization: 'Bearer PRIVATE', ...headers }, ...(signal ? { signal } : {}) })),
    revoke() { allowed = false; authorityChanges.notify(); }, counts: () => ({ samples, stopped, checks }) };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) assert.fail('condition did not settle'); await tick(); }
}
function sseReader(response: Response) {
  const reader = response.body!.getReader(); let text = '';
  return { reader, async through(marker: string) {
    const timer = setTimeout(() => { void reader.cancel(); }, 3000);
    try {
      while (!text.includes(marker)) {
        const next = await reader.read(); if (next.done) assert.fail(`stream ended before ${marker}: ${text}`);
        text += new TextDecoder().decode(next.value);
      }
      return text;
    } finally { clearTimeout(timer); }
  } };
}

for (const target of ['agents', 'system/metrics'] as const) test(`${target} keeps original provider and refuses data after post-await revocation`, async () => {
  const agents = held<AgentSummary[]>(), sample = held<SystemMetrics>(), entered = held<void>();
  const f = fixture({ agents: () => { entered.resolve(); return agents.promise; }, sample: () => { entered.resolve(); return sample.promise; } });
  try {
    const response = f.get(`/${target}`); await entered.promise; f.revoke();
    agents.resolve([{ id: 'PRIVATE-agent-result' }]); sample.resolve(metrics);
    const result = await response; assert.equal(result.status, 403); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await result.text(), /PRIVATE|private-id/);
  } finally { await f.routes.close(); }
  assert.equal(f.counts().stopped, 1);
});

test('public media preserves GET/HEAD/Range, validates names, size and symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'public-media-'));
  writeFileSync(join(root, 'example.txt'), '0123456789');
  writeFileSync(join(root, 'large.bin'), ''); truncateSync(join(root, 'large.bin'), 64 * 1024 * 1024 + 1);
  symlinkSync(join(root, 'example.txt'), join(root, 'linked.txt'));
  const f = fixture({ mediaRoot: root });
  try {
    const full = await f.get('/media/inbound/example.txt'); assert.equal(full.status, 200); assert.equal(await full.text(), '0123456789');
    const range = await f.get('/media/inbound/example.txt', { range: 'bytes=2-5' });
    assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await range.text(), '2345');
    const head = await f.get('/media/inbound/example.txt', {}, undefined, 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal((await f.get('/media/inbound/example.txt', { range: 'bytes=20-30' })).status, 416);
    assert.equal((await f.get('/media/inbound/linked.txt')).status, 404);
    assert.equal((await f.get('/media/inbound/large.bin')).status, 413);
    assert.equal((await f.get('/media/inbound/missing.txt')).status, 404);
    for (const name of ['%2Fetc%2Fpasswd', 'bad%5Cname', '%00', '%E0%A4%A']) assert.equal((await f.get(`/media/inbound/${name}`)).status, 400);
    f.revoke(); assert.equal((await f.get('/media/inbound/example.txt')).status, 403);
  } finally { await f.routes.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const end of ['revoke', 'shutdown'] as const) test(`media ${end} closes an unconsumed response and never delivers bytes`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'public-media-end-')); writeFileSync(join(root, 'secret.txt'), 'PRIVATE-data');
  const f = fixture({ mediaRoot: root });
  try {
    const response = await f.get('/media/inbound/secret.txt'); assert.equal(response.status, 200);
    if (end === 'revoke') f.revoke(); else await f.routes.close();
    await assert.rejects(response.text());
  } finally { await f.routes.close(); rmSync(root, { recursive: true, force: true }); }
});

test('SSE resumes unchanged cursor, sends connector metadata and wakes on appends during replay', async () => {
  const replay = held<Awaited<ReturnType<EventReplayRead>>>(); let calls = 0;
  const f = fixture({ replay: async after => {
    calls++;
    if (calls === 1) { assert.equal(after, 'one'); return replay.promise; }
    if (after === 'one') return { cursor: 'two', known: true, events: [{ id: 'two', type: 'session.updated', ts: 1, payload: { state: 'running' } }] };
    return { cursor: 'two', known: true, events: [] };
  } });
  const response = await f.get('/events/stream', { 'last-event-id': 'one' }); const stream = sseReader(response);
  try {
    await until(() => calls === 1); f.changes.notify(); replay.resolve({ cursor: 'one', known: true, events: [] });
    const text = await stream.through('id: two');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-accel-buffering'), 'no'); assert.match(text, /event: session.updated/);
    assert.match(await stream.through('Environment'), /"connector":\{"environmentId":"env","environmentLabel":"Environment"\}/);
    assert.ok(calls >= 2); assert.equal((text.match(/id: two/g) ?? []).length, 1);
  } finally { await stream.reader.cancel(); await f.routes.close(); }
  assert.equal(f.changes.waiting, 0); assert.equal(f.authorityChanges.waiting, 0);
});

test('SSE fresh tail does not resend history and expired cursor emits reset', async () => {
  for (const fresh of [true, false]) {
    const f = fixture({ replay: async after => ({ cursor: 'head', known: after === null || after === 'head', events: [] }) });
    const response = await f.get('/events/stream', fresh ? {} : { 'last-event-id': 'expired' }); const stream = sseReader(response);
    try {
      const text = await stream.through(fresh ? 'event: heartbeat' : 'cursor_expired');
      if (fresh) assert.doesNotMatch(text, /session.updated|stream.reset/); else assert.match(text, /id: head/);
    } finally { await stream.reader.cancel(); await f.routes.close(); }
  }
});

for (const end of ['revoke', 'shutdown'] as const) test(`SSE ${end} retains late replay and does not publish its data`, async () => {
  const replay = held<Awaited<ReturnType<EventReplayRead>>>(), entered = held<void>();
  const f = fixture({ replay: () => { entered.resolve(); return replay.promise; } });
  const response = await f.get('/events/stream', { 'last-event-id': 'one' }); const reader = response.body!.getReader();
  const reading = reader.read(); await entered.promise;
  let drained = false;
  if (end === 'revoke') f.revoke();
  const closing = f.routes.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  replay.resolve({ cursor: 'two', known: true, events: [{ id: 'two', type: 'session.updated', ts: 1, payload: 'PRIVATE' }] });
  const result = await reading; assert.equal(result.done, true); await closing;
  assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()), /PRIVATE|Bearer/);
});

test('SSE idle revocation wakes immediately, and malformed replay fails closed', async () => {
  const f = fixture(), response = await f.get('/events/stream'), stream = sseReader(response);
  await stream.through('event: heartbeat'); await until(() => f.authorityChanges.waiting > 0);
  const reading = stream.reader.read(); f.revoke(); assert.equal((await reading).done, true); await f.routes.close();
  const broken = fixture({ replay: async () => ({ cursor: 'head', known: false, events: [{ id: 'bad', type: 'session.updated', ts: 1, payload: 'PRIVATE' }] }) });
  const bad = await broken.get('/events/stream'); assert.equal(await bad.text(), ''); await broken.routes.close();
});

test('SSE bounds accepted streams at 128 and shutdown releases all listeners', async () => {
  const f = fixture(); const streams: ReturnType<typeof sseReader>[] = [];
  try {
    for (let i = 0; i < 128; i++) { const stream = sseReader(await f.get('/events/stream')); streams.push(stream); await stream.through('event: heartbeat'); }
    assert.equal((await f.get('/events/stream')).status, 503);
    await f.routes.close();
    for (const stream of streams) { const next = await stream.reader.read(); assert.equal(next.done, true); }
    assert.equal(f.changes.waiting, 0); assert.equal(f.authorityChanges.waiting, 0);
  } finally { await Promise.all(streams.map(stream => stream.reader.cancel())); await f.routes.close(); }
});

test('real worker authorizes all four transports and revocation stops the original SSE and file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'public-worker-')); writeFileSync(join(root, 'private.txt'), 'PRIVATE-bytes');
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json') }, new PerformanceDiagnostics(() => {}));
  const authority = new AsyncConnectorReadAuthority(owner, { diagnostics: new PerformanceDiagnostics(() => {}) });
  const f = fixture({ authority, mediaRoot: root });
  try {
    await owner.open(); const token = await owner.command('tokenCreate', { label: 'public', scopes: ['agents:read', 'events:read', 'media:read', 'system:metrics:read'] });
    const headers = { authorization: `Bearer ${token.token}` };
    assert.equal((await f.get('/agents', headers)).status, 200); assert.equal((await f.get('/system/metrics', headers)).status, 200);
    const file = await f.get('/media/inbound/private.txt', headers), response = await f.get('/events/stream', headers);
    const stream = sseReader(response); await stream.through('event: heartbeat');
    await owner.command('tokenRevoke', { tokenId: token.record.id });
    await assert.rejects(file.text()); assert.equal((await stream.reader.read()).done, true);
    assert.equal((await f.get('/agents', headers)).status, 403); assert.equal((await f.get('/system/metrics', headers)).status, 403);
  } finally { await f.routes.close(); await authority.close(); await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('owner-independent protocol gate rejects before any feature work and pins raw stream responses', async () => {
  const app = new Hono(); let calls = 0;
  registerConnectorProtocol(app, base, 'node');
  app.get(`${base}/raw`, () => { calls++; return new Response('raw', { headers: { [NODE_ID_HEADER]: 'wrong' } }); });
  for (const [headers, status] of [[{ [CONNECTOR_PROTOCOL_HEADER]: '0' }, 426], [{ [EXPECTED_NODE_HEADER]: 'foreign' }, 409]] as const) {
    const response = await app.request(`${base}/raw`, { headers }); assert.equal(response.status, status);
    assert.equal(response.headers.get(NODE_ID_HEADER), 'node'); assert.equal(calls, 0);
  }
  const response = await app.request(`${base}/raw`); assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(await response.text(), 'raw'); assert.equal(response.headers.get(NODE_ID_HEADER), 'node');
  assert.equal(response.headers.get(CONNECTOR_PROTOCOL_HEADER), '1');
});
