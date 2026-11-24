import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubEventReplay, type HubEventReplayPort } from './async-event-replay.js';
import { registerHubEventRoutes } from './event-http.js';
import type { HubEventBrokers } from './event-broker.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { hubMemberEvidence, hubMemberResultBytes, validHubMemberInput, type HubMemberCommands } from './member-owner-domain.js';
import { hubEventReplayResultBytes, validHubEventReplayCommand, validHubEventReplayReply, validHubEventReplayResult } from './member-event-replay-domain.js';
import { isDeliverySnapshotReadRejected, WORKSPACE_REVISION_TYPES } from './delivery-reader-protocol.js';
import { isWorkspaceRevisionReadRejected, WorkspaceRevisionReadRejected } from './workspace-revision-read.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const emptyRevisions = () => Object.fromEntries(WORKSPACE_REVISION_TYPES.map(k => [k, []])) as unknown as Awaited<ReturnType<HubEventReplayPort['revisions']>>;

function subscription(onRelease: () => void = () => {}) {
  const closed = new AbortController();
  const events = { closedSignal: closed.signal, isClosed: false, revision: 0,
    directoryReady: async () => {}, deniedConnections: () => [],
    visibleDomains: () => new Map([['node', 'synthetic-domain']]), visibleDomain: () => 'synthetic-domain',
    wait: (_: number, signal: AbortSignal) => new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  };
  let released = false;
  return { events, release() { if (!released) { released = true; onRelease(); closed.abort(); } } } as unknown as ReturnType<HubEventBrokers['acquire']>;
}

async function fixture(t: TestContext, mode: 'worker' | 'original', metadata?: 'invalid' | 'large') {
  const root = mkdtempSync(join(tmpdir(), 'event-replay-chain-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'synthetic-vault');
  seed.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'http://synthetic', capabilities: ['events'] });
  seed.appendDelivery({ envConnectionId: 'node', type: 'session.updated', ts: 1, payload: { n: 1 } }, 'synthetic-domain');
  const first = seed.latestDeliveryCursor('default')!;
  let deep: object = { n: 2 };
  for (let i = 0; i < 80; i++) deep = { child: deep };
  seed.appendDelivery({ envConnectionId: 'node', type: 'session.updated', ts: 2, payload: deep }, 'synthetic-domain');
  const last = seed.latestDeliveryCursor('default')!, login = seed.identities.issueKey('default');
  await seed.close();
  const roles = new DatabaseSync(file);
  try {
    roles.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
    if (metadata) {
      roles.exec('BEGIN');
      const insert = roles.prepare('INSERT INTO hub_workspace_boards VALUES (?,?,?,?,?)');
      if (metadata === 'invalid') insert.run('default', 'private\ninvalid', '{}', 1, 1);
      else for (let i = 0; i < 8300; i++) insert.run('default', `board-${i}`, '{}', 1, 1);
      roles.exec('COMMIT');
    }
  } finally { roles.close(); }
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const original = mode === 'original' ? new HubStore(file, 'synthetic-vault') : undefined;
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault' }, diagnostics);
  const replay = new AsyncHubEventReplay(owner, diagnostics);
  const request = (query = '', key = login.token) => new Request(`http://localhost/api/hub/v1/events/stream${query}`, { headers: { authorization: `Bearer ${key}` } });
  let acquired = 0, released = 0;
  const app = new Hono();
  registerHubEventRoutes(app, '/api/hub/v1', { asyncEvents: replay,
    brokers: { acquire(user) { assert.equal(user, 'default'); acquired++; return subscription(() => { released++; }); } } });
  t.after(async () => { await replay.close(); await owner.close(); await original?.close(); rmSync(root, { recursive: true, force: true }); });
  return { owner, replay, request, app, first, last, login, logs, acquired: () => acquired, released: () => released };
}

for (const mode of ['worker', 'original'] as const) {
  test(`${mode}: four simultaneous cursor/page readers fit the unchanged owner budget`, async t => {
    const f = await fixture(t, mode);
    const ports = await Promise.all(Array.from({ length: 4 }, () => f.replay.open(f.request())));
    assert.ok(ports.every(port => port.initialCursor === f.last));
    const pages = await Promise.all(ports.map(port => port.page(f.first, new Map([['node', 'synthetic-domain']]))));
    assert.ok(pages.every(page => page.cursor === f.last && page.events.length === 1));
    assert.deepEqual(await Promise.all(ports.map(port => port.revisions())), ports.map(() => emptyRevisions()));
  });

  test(`${mode}: completed metadata refusal preserves chat replay and original cursor`, async t => {
    const f = await fixture(t, mode, 'invalid'), port = await f.replay.open(f.request());
    await assert.rejects(port.revisions(), error => isDeliverySnapshotReadRejected(error));
    await port.check();
    assert.equal((await port.page(f.first, new Map([['node', 'synthetic-domain']]))).cursor, f.last);
    const reader = (await f.app.request(f.request(`?lastEventId=${encodeURIComponent(f.first)}`))).body!.getReader();
    try {
      let text = '';
      while (!text.includes('event: session.updated')) {
        const next = await reader.read(); assert.equal(next.done, false); text += new TextDecoder().decode(next.value);
      }
      assert.ok(text.includes(`id: ${f.last}`));
      assert.doesNotMatch(text, /workspace.revisions|private|invalid/);
    } finally { await reader.cancel(); }
  });

  test(`${mode}: bounded revision snapshot retains more than settings DTO array limit`, async t => {
    const f = await fixture(t, mode, 'large'), port = await f.replay.open(f.request());
    const revisions = await port.revisions();
    assert.equal(revisions.taskboard.length, 8300);
    assert.ok(revisions.taskboard.every(row => row.revision === 1));
  });

  test(`${mode}: original credentials scope cursor/page/revisions without a synchronous caller`, async t => {
    const f = await fixture(t, mode), port = await f.replay.open(f.request());
    assert.equal(port.ownerUserId, 'default'); assert.equal(port.initialCursor, f.last);
    const page = await port.page(f.first, new Map([['node', 'synthetic-domain']]));
    assert.equal(page.cursor, f.last); assert.equal(page.events.length, 1);
    let payload = page.events[0]!.payload as Record<string, unknown>;
    for (let i = 0; i < 80; i++) payload = payload.child as Record<string, unknown>;
    assert.equal(payload.n, 2, 'legacy event depth is not a settings DTO depth limit');
    assert.deepEqual(await port.revisions(), emptyRevisions());
    assert.equal((await port.page(f.first, new Map([['foreign', 'synthetic-domain']]))).events.length, 0);
    const evidence = hubMemberEvidence(f.request());
    const current = await f.owner.command('memberSnapshot', evidence); assert.ok(current);
    await f.owner.command('memberKeyRevoke', { evidence, expectedScope: current.recoveryScope, userId: 'default', keyId: f.login.id });
    await assert.rejects(port.check(), { status: 401 });
    await assert.rejects(port.page(f.first, new Map()), { status: 401 });
    assert.equal(f.logs.some(line => line.includes(f.login.token)), false);
  });

  test(`${mode}: actual HTTP SSE retains Last-Event-ID and scope query; denies invalid proof before acquire`, async t => {
    const f = await fixture(t, mode);
    const snapshot = await f.owner.command('memberSnapshot', hubMemberEvidence(f.request()));
    assert.ok(snapshot);
    assert.equal((await f.app.request(f.request('?recoveryScope=wrong'))).status, 409);
    assert.equal((await f.app.request(f.request('', 'aod_board_synthetic'))).status, 401);
    assert.equal((await f.app.request(f.request('', 'invalid'))).status, 401);
    assert.equal(f.acquired(), 0);
    const response = await f.app.request(f.request(`?recoveryScope=${snapshot.recoveryScope}&lastEventId=${encodeURIComponent(f.first)}`));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    const reader = response.body!.getReader(); let text = '';
    try {
      while (!text.includes('event: session.updated')) {
        const next = await reader.read(); assert.equal(next.done, false); text += new TextDecoder().decode(next.value);
      }
      assert.match(text, /event: heartbeat/); assert.ok(text.includes(`id: ${f.last}`));
    } finally { await reader.cancel(); }
    await tick(); assert.equal(f.released(), 1);
  });
}

test('event replay capacity follows the copied action and accounts for the full escaped wire', () => {
  for (const [command, bytes] of [
    [{ action: 'cursor' }, 32 * 1024],
    [{ action: 'page', cursor: null, domains: [] }, 2 * 524288 + 65536],
    [{ action: 'revisions' }, 20 * 1024 * 1024],
  ] as const) {
    assert.equal(hubEventReplayResultBytes(command), bytes);
    assert.equal(hubMemberResultBytes('eventReplay', { command }), bytes);
  }
  assert.equal(validHubEventReplayResult({ body: JSON.stringify({ action: 'cursor', cursor: '\t'.repeat(4096) }) }), true);
  assert.equal(validHubEventReplayResult({ body: JSON.stringify({ action: 'cursor', cursor: '\u0001'.repeat(4096) }) }), true);
  assert.equal(validHubEventReplayResult({ body: JSON.stringify({ action: 'cursor', cursor: null }) + ' '.repeat(32 * 1024) }), false);
  assert.equal(validHubEventReplayResult({ body: JSON.stringify({ action: 'forged', cursor: null }) }), false);
});

for (const stop of ['cancel', 'queued-cancel', 'close'] as const) test(`revisions ${stop} retains the original owner ACK before dispatching a peer`, { timeout: 15000 }, async t => {
  const f = await fixture(t, 'worker');
  let release!: () => void, entered!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const command: AsyncHubMemberOwner['command'] = ((kind, input) => {
    const original = f.owner.command(kind, input);
    if (kind !== 'eventReplay' || (input as HubMemberCommands['eventReplay']['input']).command.action !== 'revisions') return original;
    if (++calls !== 1) return original;
    entered(); return original.then(async value => { await held; return value; });
  }) as AsyncHubMemberOwner['command'];
  const replay = new AsyncHubEventReplay({ command }), abort = new AbortController(), peerAbort = new AbortController();
  const port = await replay.open(new Request(f.request(), { signal: abort.signal }));
  const peer = await replay.open(new Request(f.request(), { signal: peerAbort.signal }));
  const first = port.revisions(); void first.catch(() => {}); await reached;
  const second = peer.revisions(); void second.catch(() => {});
  let closed = false;
  try {
    await peer.check(); await tick(); assert.equal(calls, 1);
    if (stop === 'cancel') {
      abort.abort(); await assert.rejects(first, { status: 499 });
      await tick(); assert.equal(calls, 1);
      release(); assert.deepEqual(await second, emptyRevisions()); assert.equal(calls, 2);
    } else if (stop === 'queued-cancel') {
      peerAbort.abort(); await assert.rejects(second, { status: 499 });
      await tick(); assert.equal(calls, 1);
      release(); assert.deepEqual(await first, emptyRevisions());
      await replay.close(); assert.equal(calls, 1, 'cancelled queued request cannot enter the SQL owner');
    } else {
      const drain = replay.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false); assert.equal(calls, 1);
      release(); await assert.rejects(first, { status: 503 }); await assert.rejects(second, { status: 503 });
      await drain; assert.equal(closed, true); assert.equal(calls, 1);
    }
  } finally { release(); await Promise.allSettled([first, second]); await replay.close(); }
});

test('event replay refuses supplied owner/admin, wrong reply action and foreign delivery ACK', () => {
  assert.equal(validHubEventReplayCommand({ action: 'cursor', ownerUserId: 'foreign' }), false);
  assert.equal(validHubMemberInput('eventReplay', { evidence: { accessKey: 'synthetic' }, expectedScope: 'a'.repeat(64), command: { action: 'cursor' }, admin: true }), false);
  assert.equal(validHubEventReplayResult({ body: JSON.stringify({ action: 'cursor', cursor: null }) }), true);
  assert.equal(validHubEventReplayReply({ action: 'revisions' }, { body: JSON.stringify({ action: 'cursor', cursor: null }) }), false);
  assert.equal(validHubEventReplayReply({ action: 'page', cursor: null, domains: [] }, { body: JSON.stringify({ action: 'page', page: {
    reset: false, cursor: null, events: [{ id: 'hub:foreign', envConnectionId: 'foreign', type: 'session.updated', ts: 1, payload: {} }],
  } }) }), false);
});

test('completed revision refusal is unforgeable and does not inspect hostile exception objects', () => {
  assert.equal(isWorkspaceRevisionReadRejected(new WorkspaceRevisionReadRejected()), true);
  assert.equal(isWorkspaceRevisionReadRejected(new Error('hub_delivery_read_unavailable')), false);
  assert.equal(isWorkspaceRevisionReadRejected(Object.create(WorkspaceRevisionReadRejected.prototype)), false);
  assert.equal(isWorkspaceRevisionReadRejected(new Proxy({}, { get() { throw Error('getter'); },
    getPrototypeOf() { throw Error('prototype'); } })), false);
  assert.equal(validHubEventReplayReply({ action: 'revisions' }, { body: JSON.stringify({ action: 'revisions', rejected: true }) }), true);
  assert.equal(validHubEventReplayReply({ action: 'page', cursor: null, domains: [] }, { body: JSON.stringify({ action: 'revisions', rejected: true }) }), false);
});

for (const stop of ['revocation', 'disconnect'] as const) {
  test(`${stop} between reset ID and reset body cannot publish the body or a page`, { timeout: 5000 }, async () => {
    const app = new Hono(), abort = new AbortController(); let checks = 0, released = 0, enter!: () => void, reject!: (error: Error) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>((_, no) => { reject = no; });
    registerHubEventRoutes(app, '/api/hub/v1', {
      asyncEvents: { close: async () => {}, open: async () => ({ ownerUserId: 'default', initialCursor: undefined,
        check: async () => { if (++checks === 6) { enter(); await held; } },
        revisions: async () => emptyRevisions(),
        page: async () => ({ reset: true, cursor: undefined, events: [{ id: 'hub:must-not-leak', envConnectionId: 'node',
          type: 'session.updated', ts: 1, payload: { text: 'must-not-leak' } }] }),
      }) }, brokers: { acquire() { return subscription(() => { released++; }); } },
    });
    const reader = (await app.request(new Request('http://localhost/api/hub/v1/events/stream', { signal: abort.signal }))).body!.getReader();
    try {
      let text = '';
      while (!text.includes('id:\n')) {
        const next = await reader.read(); assert.equal(next.done, false); text += new TextDecoder().decode(next.value);
      }
      await entered;
      if (stop === 'disconnect') abort.abort(); else reject(Error('private-revocation'));
      for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
      if (stop === 'disconnect') reject(Error('late-private-revocation'));
      await tick();
      assert.doesNotMatch(text, /event: stream.reset|must-not-leak|private-revocation/);
      assert.equal(released, 1);
    } finally { abort.abort(); reject(Error('cleanup')); await reader.cancel(); }
  });
}

test('route captures cursor before acquire, never falls back when that cursor is absent', async () => {
  const order: string[] = [], app = new Hono(); let released = 0;
  registerHubEventRoutes(app, '/api/hub/v1', {
    asyncEvents: { close: async () => {}, open: async () => { order.push('cursor'); return {
      ownerUserId: 'default', initialCursor: undefined, check: async () => {}, revisions: async () => emptyRevisions(),
      page: async cursor => { assert.equal(cursor, undefined); order.push('page'); return { reset: false, cursor, events: [] }; },
    }; } },
    brokers: { acquire() { order.push('acquire'); return subscription(() => { released++; }); } },
  });
  const reader = (await app.request('/api/hub/v1/events/stream')).body!.getReader();
  await reader.read(); await tick(); await reader.cancel(); await tick();
  assert.deepEqual(order.slice(0, 2), ['cursor', 'acquire']); assert.ok(order.includes('page')); assert.equal(released, 1);
});

test('abort releases SSE during awaited authority and consumes late rejection without a frame', async () => {
  let reject!: (error: Error) => void, released = 0;
  const held = new Promise<void>((_, no) => { reject = no; }), app = new Hono(), abort = new AbortController();
  registerHubEventRoutes(app, '/api/hub/v1', {
    asyncEvents: { close: async () => {}, open: async () => ({ ownerUserId: 'default', initialCursor: undefined,
      check: () => held, page: async () => ({ reset: false, cursor: undefined, events: [] }), revisions: async () => emptyRevisions() }) },
    brokers: { acquire() { return subscription(() => { released++; }); } },
  });
  const response = await app.request(new Request('http://localhost/api/hub/v1/events/stream', { signal: abort.signal }));
  const reader = response.body!.getReader(), reading = reader.read();
  abort.abort(); assert.equal((await reading).done, true); await tick(); assert.equal(released, 1);
  reject(Error('private authority failure')); await tick();
});

test('cancelled replay SQL holds original drain and retained request handles cannot dispatch after close', async () => {
  let calls = 0, settle!: (value: unknown) => void, drained = false;
  const pending = new Promise(resolve => { settle = resolve; });
  const snapshot = { principal: { userId: 'default', admin: false }, recoveryScope: 'a'.repeat(64) };
  const owner = { command(kind: string) { calls++; return kind === 'memberSnapshot' ? Promise.resolve(snapshot) : pending; } } as Pick<AsyncHubMemberOwner, 'command'>;
  const service = new AsyncHubEventReplay(owner, new PerformanceDiagnostics(() => {}));
  const abort = new AbortController();
  const opening = assert.rejects(service.open(new Request('http://localhost', { signal: abort.signal })), { status: 499 });
  while (calls < 3) await tick();
  abort.abort(); await opening;
  const closing = service.close(); void closing.then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  const before = calls;
  await assert.rejects(service.open(new Request('http://localhost')), { status: 503 }); assert.equal(calls, before);
  settle({ body: JSON.stringify({ action: 'cursor', cursor: null }) }); await closing; assert.equal(drained, true);
});

test('successful replay handles freeze on close and malformed original ACK fences further reads', async () => {
  let calls = 0, malformed = false;
  const owner = { command(kind: string) { calls++; return Promise.resolve(kind === 'memberSnapshot'
    ? { principal: { userId: 'default', admin: false }, recoveryScope: 'a'.repeat(64) }
    : { body: JSON.stringify(malformed ? { action: 'cursor', cursor: null } : { action: 'cursor', cursor: 'hub:original' }) }); } } as Pick<AsyncHubMemberOwner, 'command'>;
  const service = new AsyncHubEventReplay(owner, new PerformanceDiagnostics(() => {}));
  const port = await service.open(new Request('http://localhost'));
  malformed = true;
  await assert.rejects(port.revisions(), { status: 503 }); const before = calls;
  await assert.rejects(port.page(undefined, new Map()), { status: 503 }); assert.equal(calls, before);
  await service.close();
  await assert.rejects(port.check(), { status: 503 }); assert.equal(calls, before);
});
