import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Hono } from 'hono';
import { ConnectorClient } from './connector-client.js';
import { HubEventBrokers } from './event-broker.js';
import { hubEventResponse } from './event-stream.js';
import { HubStore } from './hub-store.js';
import { WORKSPACE_REVISION_TYPES, type DeliveryPage, type WorkspaceRevisions } from './delivery-reader-protocol.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1_500;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'stream cleanup converges'); await delay(5); }
}

function fixture(materializeContext = false, holdUpstream = false) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-event-stream-'));
  const store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'http://synthetic', capabilities: ['events'], credentialToken: 'synthetic' });
  let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = 0;
  let connect!: () => void;
  const upstreamReady = new Promise<void>(resolve => { connect = resolve; });
  const registry = new HubEventBrokers(store, () => new ConnectorClient('http://synthetic', 'synthetic', async () => {
    if (holdUpstream) await upstreamReady;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { feed = controller; controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: \n\n')); },
      cancel() { cancelled++; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }));
  const app = new Hono();
  if (materializeContext) app.use('*', async (c, next) => {
    c.res.headers.set('X-Synthetic-Middleware', 'preserved');
    await next();
  });
  let active = 0;
  app.get('/events', c => {
    const handle = registry.acquire('default');
    active++;
    return hubEventResponse(c, { store, ownerUserId: 'default', authorize: () => {},
      subscription: { events: handle.events, release() { active--; handle.release(); } } });
  });
  return { store, registry, app, connect, active: () => active, cancelled: () => cancelled,
    emit() {
      for (let i = 0; i < 10; i++) feed!.enqueue(new TextEncoder().encode(`id: ${i}\nevent: session.updated\ndata: {"type":"session.updated","sessionKey":"synthetic","payload":{"i":${i}}}\n\n`));
    },
    async close() { registry.close(); await until(() => active === 0); await registry.drain(); await store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('browser heartbeat before upstream attachment is followed by a durable snapshot reset', { timeout: 15_000 }, async () => {
  const f = fixture(false, true);
  const reader = (await f.app.request('/events')).body!.getReader();
  const decoder = new TextDecoder();
  try {
    const first = decoder.decode((await reader.read()).value);
    assert.match(first, /event: heartbeat/);
    assert.equal(f.store.latestDeliveryCursor('default'), undefined);
    f.connect();
    const reset = decoder.decode((await reader.read()).value);
    assert.match(reset, /event: stream.reset/);
    assert.match(reset, /connector_connected/);
    assert.ok(f.store.latestDeliveryCursor('default'), 'Reset is durable, not a fabricated agent event');
    assert.doesNotMatch(reset, /message.created|run.completed/);
  } finally { f.connect(); await reader.cancel(); await f.close(); }
});

test('SSE no-store policy survives a middleware-materialized context response', { timeout: 5_000 }, async () => {
  const f = fixture(true);
  const response = await f.app.request('/events');
  const reader = response.body!.getReader();
  try {
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(response.headers.get('x-synthetic-middleware'), 'preserved');
  } finally { await reader.cancel(); await f.close(); }
});

for (const slow of [false, true]) {
  // The outer budget includes real SQLite-reader startup and physical owner
  // close under full-suite load. The shutdown requirement is still bounded by
  // until()'s separate 1.5s deadline, not by this fixture/teardown allowance.
  test(`Hub shutdown cancels ${slow ? 'backpressured' : 'idle'} responses and releases subscriptions immediately`, { timeout: 15_000 }, async () => {
    const f = fixture();
    const response = await f.app.request('/events');
    const reader = response.body!.getReader();
    try {
      assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
      assert.equal(response.headers.get('x-accel-buffering'), 'no');
      await reader.read();
      await reader.read(); // Initial node-connected reset.
      if (slow) { f.emit(); await delay(30); }
      f.registry.close(); f.registry.close();
      await until(() => f.active() === 0 && f.cancelled() === 1);
      let reads = 0;
      f.store.deliveryPageAsync = async () => { reads++; throw new Error('closed store'); };
      while (!(await reader.read()).done) { /* Already-buffered frames may drain; no new reads. */ }
      assert.equal(reads, 0);
      assert.equal((f.registry as any).subscribers, 0);
    } finally { await reader.cancel(); await f.close(); }
  });
}

test('Hub journal read failure aborts delivery without leaking errors or retaining upstreams', { timeout: 5_000 }, async () => {
  const sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  const f = fixture();
  const reader = (await f.app.request('/events')).body!.getReader();
  try {
    await reader.read(); await reader.read();
    f.store.deliveryPageAsync = async () => { throw new Error('private database details'); };
    f.emit();
    let text = '';
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
    assert.equal(text.includes('private'), false);
    await until(() => f.active() === 0 && f.cancelled() === 1);
    assert.equal((f.registry as any).brokers.size, 0);
    const observations = performanceDiagnostics.snapshot().events.filter(event => event.sequence > sequence && event.operation === 'hub-event-stream');
    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.phase, 'finished');
    assert.equal(observations[0]!.category, 'failed');
    assert.equal(observations[0]!.step, 3);
    assert.equal(observations[0]!.settled, 1);
    assert.doesNotMatch(JSON.stringify(observations), /private database|synthetic|hub\.sqlite/);
  } finally { await reader.cancel(); await f.close(); }
});

test('Hub release SQL failure finishes a sanitized failure trace instead of leaving an invisible stream', async t => {
  const f = fixture(), sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  const reader = (await f.app.request('/events')).body!.getReader();
  try {
    await reader.read(); await reader.read();
    t.mock.method(f.store.completions, 'markGap', () => {
      throw Object.assign(Error('private-release-SQL'), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
    });
    await reader.cancel(); await until(() => f.active() === 0 && f.cancelled() === 1);
    const observations = performanceDiagnostics.snapshot().events.filter(row => row.sequence > sequence && row.operation === 'hub-event-stream');
    assert.equal(observations.length, 1);
    const row = observations[0]!;
    assert.equal(row.phase, 'finished'); assert.equal(row.category, 'failed'); assert.equal(row.step, 3);
    assert.equal(row.sqlErrorCode, 1811); assert.equal(row.unknown, 1); assert.equal(row.settled, undefined);
    assert.doesNotMatch(JSON.stringify(observations), /private-release|synthetic|hub\.sqlite/);
    assert.equal((f.registry as any).subscribers, 0);
  } finally { t.mock.restoreAll(); await reader.cancel(); await f.close(); }
});

test('Hub slow write deadline releases the owner broker and its upstream', { timeout: 30_000 }, async () => {
  const sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  const f = fixture();
  const response = await f.app.request('/events');
  try {
    // Leave even the initial reset unread, without cancelling the request.
    await delay(10_200);
    await until(() => f.active() === 0 && f.cancelled() === 1);
    assert.equal((f.registry as any).subscribers, 0);
    assert.equal((f.registry as any).brokers.size, 0);
    assert.ok((await response.text()).includes('heartbeat'));
    const observations = performanceDiagnostics.snapshot().events.filter(event => event.sequence > sequence && event.operation === 'hub-event-stream');
    assert.equal(observations.length, 2);
    assert.deepEqual(observations.map(event => [event.phase, event.step, event.timedOut]),
      [['pending', 1, 1], ['finished', 3, 1]]);
    assert.equal(observations[0]!.sequence, observations[1]!.sequence);
    assert.equal(observations[0]!.pending, 1);
    assert.equal(observations[0]!.settled, undefined, 'cancellation request is not original release proof');
    assert.equal(observations[1]!.settled, 1);
    assert.doesNotMatch(JSON.stringify(observations), /synthetic|hub\.sqlite/);
  } finally { if (!response.bodyUsed) await response.body?.cancel(); await f.close(); }
});

function pendingReplay(workspaceResources = false, directoryPending = false) {
  const store = new HubStore(':memory:', 'synthetic'), app = new Hono(), closed = new AbortController();
  let resolvePage!: (page: DeliveryPage) => void, started!: () => void;
  let resolveRevisions!: (rows: WorkspaceRevisions) => void;
  let rejectRevisions!: (error: Error) => void;
  const readStarted = new Promise<void>(resolve => { started = resolve; });
  let resolveDirectory!: () => void, enteredDirectory!: () => void;
  let directorySettled = !directoryPending, pageReads = 0;
  const directoryStarted = new Promise<void>(resolve => { enteredDirectory = resolve; });
  const directory = new Promise<void>(resolve => { resolveDirectory = () => { directorySettled = true; resolve(); }; });
  let released = 0, authorized = true, domain = 'current', receivedCursor: string | undefined;
  store.deliveryPageAsync = async cursor => {
    pageReads++;
    receivedCursor = cursor; started();
    return new Promise<DeliveryPage>(resolve => { resolvePage = resolve; });
  };
  store.workspaceRevisionsAsync = async () => {
    started();
    return new Promise<WorkspaceRevisions>((resolve, reject) => { resolveRevisions = resolve; rejectRevisions = reject; });
  };
  const events = { revision: 0, closedSignal: closed.signal, get isClosed() { return closed.signal.aborted; },
    directoryReady: () => { enteredDirectory(); return directoryPending ? directory : Promise.resolve(); },
    deniedConnections: () => [], visibleDomains: () => directorySettled ? new Map([['node', domain]]) : new Map<string, string>(),
    visibleDomain: (id: string) => id === 'node' ? domain : undefined,
    wait: (_revision: number, signal: AbortSignal) => new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    }) };
  app.get('/events', c => hubEventResponse(c, { store, ownerUserId: 'default', workspaceResources,
    authorize: () => { if (!authorized) throw Error('private-revocation'); },
    subscription: { events, release: () => { released++; } } as any }));
  return { store, app, closed, readStarted, cursor: () => receivedCursor, released: () => released,
    directoryStarted, finishDirectory: resolveDirectory, directorySettled: () => directorySettled, pageReads: () => pageReads,
    revoke() { authorized = false; }, rotate() { domain = 'new'; },
    rejectVersions() { rejectRevisions(Error('private-display-metadata')); },
    finishPage() { resolvePage({ reset: false, cursor: 'next-cursor', events: [{ id: 'next-cursor', envConnectionId: 'node',
      type: 'session.updated', ts: 1, payload: { text: 'continued-chat' } }] }); },
    finish() {
      if (workspaceResources) resolveRevisions(Object.fromEntries(WORKSPACE_REVISION_TYPES.map(type => [type,
        type === 'taskboard' ? [{ resourceId: 'must-not-leak', revision: 1 }] : []])) as WorkspaceRevisions);
      else resolvePage({ reset: false, cursor: 'next-cursor', events: [{ id: 'next-cursor', envConnectionId: 'node',
        type: 'session.updated', ts: 1, payload: { text: 'must-not-leak' } }] });
    },
    async close() { closed.abort(); resolveDirectory(); await store.close(); } };
}

test('initial directory readiness preserves heartbeat and original cursor without an empty-scope replay', async () => {
  const h = pendingReplay(false, true);
  h.store.latestDeliveryCursor = () => 'before-directory';
  const reader = (await h.app.request('/events')).body!.getReader();
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: heartbeat/);
    await h.directoryStarted;
    await delay(20);
    assert.equal(h.pageReads(), 0, 'no empty-scope SQL may advance the initial cursor');
    h.store.latestDeliveryCursor = () => 'event-during-directory';
    h.finishDirectory(); await h.readStarted;
    assert.equal(h.cursor(), 'before-directory', 'capture before SQL readiness, not afterwards');
    h.finishPage();
    const text = new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /event: session.updated/); assert.match(text, /continued-chat/);
  } finally { await reader.cancel(); await h.close(); }
});

for (const reason of ['disconnect', 'hub-close', 'revoked-proof'] as const) {
  test(`${reason} during initial directory readiness cannot replay stale scope or retain the browser`, async () => {
    const h = pendingReplay(false, true), reader = (await h.app.request('/events')).body!.getReader();
    try {
      await reader.read(); await h.directoryStarted;
      if (reason === 'revoked-proof') { h.revoke(); h.finishDirectory(); assert.equal((await reader.read()).done, true); }
      else {
        if (reason === 'disconnect') await reader.cancel(); else { h.closed.abort(); assert.equal((await reader.read()).done, true); }
        await until(() => h.released() === 1);
        assert.equal(h.directorySettled(), false, 'browser cancellation is not original SQL settlement');
        h.finishDirectory();
      }
      assert.equal(h.pageReads(), 0); assert.equal(h.released(), 1);
    } finally { await reader.cancel(); await h.close(); }
  });
}

test('workspace revision rejection keeps chat replay and its original cursor alive without leaking display errors', async () => {
  const h = pendingReplay(true), reader = (await h.app.request('/events', { headers: { 'last-event-id': 'original-cursor' } })).body!.getReader();
  try {
    await reader.read(); await h.readStarted; h.rejectVersions();
    await until(() => h.cursor() === 'original-cursor');
    assert.equal(h.released(), 0); h.finishPage();
    const text = new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /event: session.updated/); assert.match(text, /continued-chat/); assert.match(text, /id: next-cursor/);
    assert.doesNotMatch(text, /workspace.revisions|private-display|stream.reset/);
    await reader.cancel(); await until(() => h.released() === 1);
  } finally { await reader.cancel(); await h.close(); }
});

test('workspace revision rejection never bypasses revoked authorization to continue replay', async () => {
  const h = pendingReplay(true), reader = (await h.app.request('/events')).body!.getReader();
  try {
    await reader.read(); await h.readStarted; h.revoke(); h.rejectVersions();
    assert.equal((await reader.read()).done, true);
    assert.equal(h.cursor(), undefined); assert.equal(h.released(), 1);
  } finally { await reader.cancel(); await h.close(); }
});

test('revoked proof during workspace revision IO cannot publish a stale resource frame', async () => {
  const h = pendingReplay(true), reader = (await h.app.request('/events')).body!.getReader();
  try {
    await reader.read(); await h.readStarted; h.revoke(); h.finish();
    let tail = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
    assert.doesNotMatch(tail, /workspace.revisions|must-not-leak|private-revocation/);
    assert.equal(h.released(), 1);
  } finally { await reader.cancel(); await h.close(); }
});

for (const reason of ['disconnect', 'hub-close'] as const) test(`${reason} releases subscription while workspace versions are pending`, async () => {
  const h = pendingReplay(true), reader = (await h.app.request('/events')).body!.getReader();
  try {
    await reader.read(); await h.readStarted;
    if (reason === 'disconnect') await reader.cancel(); else h.closed.abort();
    await until(() => h.released() === 1);
    h.finish(); await delay(5); assert.equal(h.released(), 1);
    if (reason === 'hub-close') assert.equal((await reader.read()).done, true);
  } finally { await reader.cancel(); await h.close(); }
});

test('workspace revision frames retain legacy resource type and payload without advancing replay cursor', async () => {
  const h = pendingReplay(true), reader = (await h.app.request('/events')).body!.getReader();
  try {
    await reader.read(); await h.readStarted; h.finish();
    const text = new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /event: workspace.revisions/);
    assert.match(text, /"resourceType":"taskboard","resources":\[{"resourceId":"must-not-leak","revision":1}\]/);
    assert.doesNotMatch(text, /(?:^|\n)id:/);
    await reader.cancel(); await until(() => h.released() === 1);
  } finally { await reader.cancel(); await h.close(); }
});

test('revoked proof while replay is pending cannot publish the page or a forged reset/cursor', async () => {
  const h = pendingReplay(), response = await h.app.request('/events', { headers: { 'last-event-id': 'original-cursor' } });
  const reader = response.body!.getReader();
  try {
    await reader.read(); await h.readStarted; assert.equal(h.cursor(), 'original-cursor');
    h.revoke(); h.finish();
    let tail = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
    assert.doesNotMatch(tail, /must-not-leak|private-revocation|next-cursor|stream.reset/);
    assert.equal(h.released(), 1);
  } finally { await reader.cancel(); await h.close(); }
});

test('domain rotation during replay skips old-domain events without publishing their cursor', async () => {
  const h = pendingReplay(), response = await h.app.request('/events', { headers: { 'last-event-id': 'original-cursor' } });
  const reader = response.body!.getReader();
  try {
    await reader.read(); await h.readStarted;
    h.rotate(); h.finish(); await delay(10); h.closed.abort();
    let tail = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
    assert.doesNotMatch(tail, /must-not-leak|next-cursor/); assert.equal(h.released(), 1);
  } finally { await reader.cancel(); await h.close(); }
});

for (const reason of ['disconnect', 'hub-close'] as const) {
  test(`${reason} releases subscription immediately while original SQL remains pending`, async () => {
    const h = pendingReplay(), response = await h.app.request('/events');
    const reader = response.body!.getReader();
    try {
      await reader.read(); await h.readStarted;
      if (reason === 'disconnect') await reader.cancel(); else h.closed.abort();
      await until(() => h.released() === 1);
      h.finish(); await delay(5); assert.equal(h.released(), 1);
      if (reason === 'hub-close') assert.equal((await reader.read()).done, true);
    } finally { await reader.cancel(); await h.close(); }
  });
}
