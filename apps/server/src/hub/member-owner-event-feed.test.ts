import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore, type HubDeliveryEvent } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubEventFeedPort, type HubEventFeedPort } from './async-event-feed.js';
import { HubEventBrokers } from './event-broker.js';
import { createConnectorClientResolver } from './connector-client.js';
import { AsyncHubEventReplay } from './async-event-replay.js';
import { registerHubEventRoutes } from './event-http.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validHubEventFeedCommand, validHubEventFeedReply, type HubEventFeedOwner, type HubEventFeedResult } from './event-feed-domain.js';

const nodeId = 'node_00000000-0000-4000-8000-000000000001';
const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw Error('event feed did not converge'); await delay(5); }
}
const delivery = (type = 'message.created'): Omit<HubDeliveryEvent, 'id'> => ({ envConnectionId: 'local', type, ts: Date.now(), remoteSessionKey: 'codex:session', payload: { text: 'visible' } });

async function fixture(t: TestContext, mode: 'original' | 'worker', decorate?: (owner: HubEventFeedOwner) => HubEventFeedOwner) {
  const root = mkdtempSync(join(tmpdir(), 'event-feed-owner-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'synthetic-vault');
  seed.upsertConnection({ id: 'local', kind: 'local', label: 'Local', connectorUrl: 'http://connector.example.invalid', capabilities: ['events'] });
  seed.pinConnectionNode('local', 'default', seed.connectionAuthority('local')!, nodeId);
  seed.upsertConnection({ id: 'remote', label: 'Remote', connectorUrl: 'http://remote.invalid', credentialToken: 'synthetic-remote', capabilities: ['events'] });
  const other = seed.createUser('Other');
  seed.upsertConnection({ id: 'local', ownerUserId: other.id, kind: 'local', label: 'Not this runtime', connectorUrl: 'http://connector.example.invalid', capabilities: ['events'] });
  const login = seed.identities.issueKey('default'), scope = seed.identities.recoveryScope({ userId: 'default', admin: false });
  const remoteDomain = createConnectorClientResolver(seed)('remote').eventDomain;
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'synthetic-vault') : undefined;
  const owner = original ? new OriginalHubAdministrativeCommands(original, quiet) : new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault' }, quiet);
  const requests: Request[] = [], streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let cancellations = 0;
  const local = { connectionId: 'local', token: 'synthetic-local', dispatch: async (request: Request) => {
    requests.push(request);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { streams.push(controller); controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: \n\n')); },
      cancel() { cancellations++; },
    }), { headers: { 'content-type': 'text/event-stream', 'x-agentopsdeck-node-id': nodeId } });
  } };
  const feedFactory = decorate ? { eventFeed: (user: string) => decorate(owner.eventFeed(user)) } : owner;
  const port = createHubEventFeedPort(feedFactory, 'default', local, quiet), replay = new AsyncHubEventReplay(owner, quiet);
  const registry = new HubEventBrokers({ mode: 'async', feed: user => {
    assert.equal(user, 'default'); return port;
  } }, undefined, 100);
  const request = () => new Request('http://localhost/api/hub/v1/events/stream', { headers: { authorization: `Bearer ${login.token}` } });
  const page = async () => {
    const view = await replay.open(request());
    const remote = await port.open('remote'), target = await port.open('local');
    return view.page(undefined, new Map([...(remote ? [['remote', remote.domain] as const] : []), ...(target ? [['local', target.domain] as const] : [])]));
  };
  t.after(async () => { await registry.drain(); await port.close(); await replay.close(); await owner.close(); await original?.close(); rmSync(root, { recursive: true, force: true }); });
  return { file, original, owner, port, replay, registry, local, requests, streams, page, request, other,
    remoteDomain, cancellations: () => cancellations,
    change: (id: string, epoch: number, configuration: { token?: string; status?: 'disabled' | 'enabled' }) => owner.command('connectionChange', {
      evidence: { accessKey: login.token }, expectedScope: scope, change: configuration.token !== undefined
        ? { action: 'maintenance', id, expectedEpoch: epoch, token: configuration.token }
        : { action: 'patch', id, expectedEpoch: epoch, configuration: { enabled: configuration.status !== 'disabled' } },
    }),
    emit(cursor: string) { streams.at(-1)!.enqueue(new TextEncoder().encode(`id: ${cursor}\nevent: message.created\ndata: ${JSON.stringify({ type: 'message.created', sessionKey: 'codex:session', payload: { text: cursor } })}\n\n`)); },
  };
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: gap keeps its own transaction after completion schema exists and isolates owners`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'event-feed-completion-')), file = join(root, 'hub.sqlite');
    const seed = new HubStore(file, 'synthetic-vault'), other = seed.createUser('Other');
    for (const user of ['default', other.id]) {
      seed.completions.baseline(user, 'target', 'epoch', 10);
      seed.completions.record({ owner: user, target: 'target', epoch: 'epoch', turnId: 'done',
        sourceCursor: 11, provenance: 'live-successful-message' });
      const observation = seed.completions.observe(user, 'target');
      seed.completions.markRead(user, 'target', 'original-ack', observation.token, observation.throughSequence);
      seed.completions.record({ owner: user, target: 'target', epoch: 'epoch', turnId: 'successor',
        sourceCursor: 12, provenance: 'live-successful-message' });
    }
    const original = mode === 'original' ? seed : undefined;
    if (!original) await seed.close();
    const owner = original ? new OriginalHubAdministrativeCommands(original, quiet)
      : new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault' }, quiet);
    const port = createHubEventFeedPort(owner, other.id, undefined, quiet);
    t.after(async () => { await port.close(); await owner.close(); await original?.close(); rmSync(root, { recursive: true, force: true }); });
    await port.gap();
    assert.equal(port.failed, false);
    // Inspect committed facts through a read-only connection, never a second writer.
    const reader = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = reader.prepare('SELECT owner,gap,latest,read_through FROM completion_targets ORDER BY owner').all();
      for (const row of rows) {
        // A worker reopen conservatively marks every owner as gap during the
        // original HubStore startup; an existing owner only marks this user.
        assert.equal(row.gap, mode === 'worker' || row.owner === other.id ? 1 : 0);
        assert.equal(row.latest, 2); assert.equal(row.read_through, 1);
      }
      assert.equal(rows.length, 2);
      assert.equal(reader.prepare('SELECT count(*) n FROM completion_events').get()!.n, 4);
      assert.equal(reader.prepare('SELECT count(*) n FROM completion_baselines').get()!.n, 2);
      assert.equal(reader.prepare('SELECT count(*) n FROM completion_acks').get()!.n, 2);
    } finally { reader.close(); }
    await port.gap();
    assert.equal(port.failed, false, 'a confirmed gap does not fence the feed');
  });

  test(`${mode}: private feed factory preserves owner, original domain, current epoch and no local fallback`, async t => {
    const f = await fixture(t, mode), target = await f.port.open('remote');
    assert.ok(target); assert.equal(target.domain, f.remoteDomain);
    assert.equal(await f.port.check(target), true);
    const changed = await f.change('remote', target.epoch, { token: 'synthetic-replacement' });
    assert.ok(changed && 'ok' in changed && changed.ok);
    assert.equal(await f.port.check(target), false);
    assert.equal(await f.port.append(target, { ...delivery(), envConnectionId: 'remote' }, 'stale'), false);
    const fresh = await f.port.open('remote'); assert.ok(fresh); assert.notEqual(fresh.domain, target.domain);
    assert.equal(await f.port.cursor(fresh), undefined);
    const other = createHubEventFeedPort(f.owner, f.other.id, f.local, quiet);
    try { assert.equal(await other.open('local'), undefined); assert.equal((await other.directory()).length, 1); }
    finally { await other.close(); }
    await assert.rejects(f.owner.command('eventFeed', { ownerUserId: 'default', command: { action: 'gap' } }));
    assert.equal(f.requests.length, 0);
  });

  test(`${mode}: append and duplicate cursor retain original event transaction and deep JSON payload`, async t => {
    const f = await fixture(t, mode), target = await f.port.open('local'); assert.ok(target);
    let payload: object = { text: 'deep' }; for (let i = 0; i < 80; i++) payload = { nested: payload };
    assert.equal(await f.port.append(target, { ...delivery(), payload }, 'cursor\t1'), true);
    assert.equal(await f.port.append(target, delivery(), 'cursor\t1'), false);
    assert.equal(await f.port.cursor(target), 'cursor\t1');
    const page = await f.page(); assert.equal(page.events.length, 1); assert.deepEqual(page.events[0]!.payload, payload);
    assert.equal(page.events[0]!.remoteSessionKey, 'codex:session');
  });

  test(`${mode}: real broker pumps and replays through owner without synchronous store or client bypass`, async t => {
    const f = await fixture(t, mode), handle = f.registry.acquire('default', 'local');
    try {
      await handle.events.directoryReady();
      await until(() => f.requests.length === 1);
      f.emit('live-1'); f.emit('live-1');
      await until(async () => (await f.page()).events.some(e => e.remoteEventId === 'live-1'));
      const page = await f.page(); assert.equal(page.events.filter(e => e.type === 'message.created').length, 1);
      assert.equal((await handle.events.visibleDomainsAsync()).size, 1);
      assert.throws(() => handle.events.visibleDomains(), /Awaited/);
      const target = await f.port.open('local'); assert.ok(target);
      assert.equal(await f.port.cursor(target), 'live-1');
      await f.change('local', target.epoch, { status: 'disabled' });
      assert.equal(await handle.events.visibleDomainAsync('local'), undefined);
      f.emit('revoked'); await tick(); await tick();
    } finally { handle.release(); await f.registry.drain(); }
    assert.equal(f.cancellations(), 1); assert.equal(handle.events.pendingWork, 0);
  });

  test(`${mode}: real HTTP owner SSE and broker share worker capability, preserve wire and cancel`, async t => {
    const f = await fixture(t, mode), app = new Hono();
    registerHubEventRoutes(app, '/api/hub/v1', { brokers: f.registry, asyncEvents: f.replay });
    const reader = (await app.request(f.request())).body!.getReader();
    try {
      await until(() => f.requests.length === 1); f.emit('http-live');
      let text = '';
      while (!text.includes('http-live')) { const next = await reader.read(); assert.equal(next.done, false); text += new TextDecoder().decode(next.value); }
      assert.match(text, /event: message.created/); assert.match(text, /id: hub:/); assert.match(text, /"remoteSessionKey":"codex:session"/);
      assert.doesNotMatch(text, /synthetic-local|synthetic-vault|synthetic-remote/);
    } finally { await reader.cancel(); await f.registry.drain(); }
    assert.equal(f.cancellations(), 1);
  });

  test(`${mode}: a lost append ACK fences the real broker without replay or reconnect`, async t => {
    let attempts = 0;
    const f = await fixture(t, mode, owner => ({ async command(input) {
      const result = await owner.command(input);
      if (input.action === 'append' && input.cursor === 'lost-ack') { attempts++; throw Error('synthetic lost ACK'); }
      return result;
    } }));
    const target = await f.port.open('local'); assert.ok(target);
    const handle = f.registry.acquire('default', 'local');
    await until(() => f.requests.length === 1); f.emit('lost-ack');
    await until(() => handle.events.isClosed); await handle.events.drain();
    assert.equal(f.port.failed, true); assert.equal(attempts, 1); assert.equal(f.requests.length, 1);
    const view = await f.replay.open(f.request()), page = await view.page(undefined, new Map([['local', target.domain]]));
    assert.equal(page.events.filter(event => event.remoteEventId === 'lost-ack').length, 1);
    handle.release(); await f.registry.drain(); assert.equal(f.cancellations(), 1);
  });

  test(`${mode}: current authority rejects a queued old-generation append and drain retains its original SQL`, async t => {
    let entered = false, resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const f = await fixture(t, mode, owner => ({ async command(input) {
      if (input.action === 'append' && input.cursor === 'late') { entered = true; await gate; }
      return owner.command(input);
    } }));
    const target = await f.port.open('local'); assert.ok(target);
    const handle = f.registry.acquire('default', 'local');
    try {
      await until(() => f.requests.length === 1); f.emit('late'); await until(() => entered);
      await f.change('local', target.epoch, { status: 'disabled' });
      handle.release(); assert.throws(() => f.registry.acquire('default', 'local'), /draining/);
      let drained = false; const close = f.registry.drain().then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.ok(handle.events.pendingWork > 0);
      resume(); await close;
      const view = await f.replay.open(f.request()), page = await view.page(undefined, new Map([['local', target.domain]]));
      assert.equal(page.events.some(event => event.remoteEventId === 'late'), false);
      assert.equal(handle.events.pendingWork, 0); assert.equal(f.requests.length, 1);
    } finally { resume(); handle.release(); }
  });

  test(`${mode}: HTTP cancellation returns while original service authority checks remain owned`, async t => {
    let entered = false, resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const f = await fixture(t, mode, owner => ({ async command(input) {
      if (input.action === 'check') { entered = true; await gate; }
      return owner.command(input);
    } }));
    const app = new Hono();
    registerHubEventRoutes(app, '/api/hub/v1', { brokers: f.registry, asyncEvents: f.replay });
    const reader = (await app.request(f.request())).body!.getReader();
    try {
      await until(() => entered); await reader.cancel();
      let drained = false; const close = f.registry.drain().then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.ok(f.port.pending > 0);
      resume(); await close; assert.equal(f.port.pending, 0); assert.equal(f.requests.length, 0);
    } finally { resume(); await reader.cancel(); }
  });

  test(`${mode}: lightweight current checks do not reserve the full directory response for every browser`, async t => {
    const f = await fixture(t, mode), target = await f.port.open('local'); assert.ok(target);
    assert.deepEqual(await Promise.all(Array.from({ length: 64 }, () => f.port.check(target))), Array(64).fill(true));
    assert.equal(f.port.failed, false);
  });
}

for (const stage of ['insert', 'completion', 'cursor', 'retention', 'commit'] as const) {
  test(`original feed ${stage} failure rolls back event, completion and cursor without replay`, async t => {
    const f = await fixture(t, 'original'), db = (f.original as unknown as { db: DatabaseSync }).db;
    const target = await f.port.open('local'); assert.ok(target);
    db.exec('CREATE TABLE feed_test_completion (n INTEGER)');
    let attempts = 0;
    t.mock.method(f.original!.completions, 'ingest', () => {
      db.prepare('INSERT INTO feed_test_completion VALUES (1)').run();
      if (stage === 'completion') { attempts++; throw Error('private completion failure'); }
    });
    t.mock.method(db, 'prepare', function(this: DatabaseSync, sql: string) {
      if (stage === 'insert' && sql.startsWith('INSERT INTO hub_events')
        || stage === 'cursor' && sql.startsWith('INSERT INTO remote_event_cursors')
        || stage === 'retention' && sql.startsWith('DELETE FROM hub_events')) { attempts++; throw Error('private SQL failure'); }
      return DatabaseSync.prototype.prepare.call(this, sql);
    });
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (stage === 'commit' && sql === 'COMMIT') { attempts++; throw Error('private commit failure'); }
      return exec(sql);
    };
    t.after(() => { db.exec = exec; });
    await assert.rejects(f.port.append(target, delivery('run.updated'), 'failed', 0), /hub_event_feed_unavailable/);
    assert.equal(attempts, 1); assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM hub_events').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM feed_test_completion').get()!.n, 0);
    assert.equal(f.original!.upstreamCursor('local', target.domain), undefined);
    await assert.rejects(f.port.append(target, delivery(), 'failed')); assert.equal(attempts, 1);
  });
}

test('private feed validates exact ACK scope/action/epoch/domain and fences unknown result without replay', async () => {
  for (const mutate of [(v: HubEventFeedResult) => ({ ...v, ownerUserId: 'other' }),
    (v: HubEventFeedResult) => ({ ...v, action: 'gap', ok: true }),
    (v: HubEventFeedResult) => ({ ...v, extra: true })]) {
    let calls = 0;
    const port = createHubEventFeedPort({ eventFeed: () => ({ async command() { calls++; return mutate({ ownerUserId: 'default', action: 'directory', body: '[]' }) as HubEventFeedResult; } }) }, 'default', undefined, quiet);
    await assert.rejects(port.directory()); await assert.rejects(port.directory());
    assert.equal(calls, 1); assert.equal(port.failed, true); await port.close();
  }
  const input = { ownerUserId: 'default', command: { action: 'cursor' as const, id: 'local', epoch: 1, domain: 'a'.repeat(64) } };
  const reply = { ownerUserId: 'default', action: 'cursor', id: 'local', epoch: 1, domain: 'a'.repeat(64), ok: true, cursor: null };
  assert.equal(validHubEventFeedReply(input, reply), true);
  for (const patch of [{ id: 'other' }, { epoch: 2 }, { domain: 'b'.repeat(64) }, { ownerUserId: 'other' }])
    assert.equal(validHubEventFeedReply(input, { ...reply, ...patch }), false);
  assert.equal(validHubEventFeedCommand({ action: 'directory', ownerUserId: 'other' }), false);
});

test('service close retains the original unacknowledged SQL; close never replays or accepts new commands', async () => {
  let complete!: (result: HubEventFeedResult) => void, calls = 0;
  const owner: HubEventFeedOwner = { command() { calls++; return new Promise(resolve => { complete = resolve; }); } };
  const port = createHubEventFeedPort({ eventFeed: () => owner }, 'default', undefined, quiet);
  const read = port.directory(); await tick();
  let drained = false; const close = port.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.equal(port.pending, 1);
  await assert.rejects(port.directory()); assert.equal(calls, 1);
  complete({ ownerUserId: 'default', action: 'directory', body: '[]' });
  await assert.rejects(read); await close; assert.equal(drained, true); assert.equal(port.pending, 0);
});

test('broker retirement retains async gap SQL before reentrant replacement admission', async () => {
  let complete!: () => void, gaps = 0, entered = false, port!: HubEventFeedPort;
  const registry = new HubEventBrokers({ mode: 'async', feed: () => port }, undefined, 100);
  port = {
    pending: 0, failed: false, async directory() { return []; }, async open() { return undefined; },
    async check() { return false; }, async cursor() { return undefined; }, async append() { return false; },
    gap() { gaps++; entered = true; return new Promise<void>(resolve => { complete = resolve; }); }, async close() {},
  };
  const handle = registry.acquire('default'); await until(() => entered);
  handle.release(); assert.throws(() => registry.acquire('default'), /draining/);
  let drained = false; const close = registry.drain().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.equal(gaps, 1);
  complete(); await close; assert.equal(drained, true); assert.equal(handle.events.pendingWork, 0);
});
