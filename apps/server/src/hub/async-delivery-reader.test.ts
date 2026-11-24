import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubDeliveryReader } from './async-delivery-reader.js';
import { validDeliveryPage, validDeliveryRead, validPreferenceRead, validPreferenceRows,
  WORKSPACE_REVISION_TYPES, type WorkspaceRevisions, type DeliveryPage, type DeliveryRead } from './delivery-reader-protocol.js';
import { HubStore } from './hub-store.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';
import { readDeliveryPage } from './delivery-page.js';
import { readSessionPreferences } from './preference-read.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const request: DeliveryRead = { owner: 'default', domains: [['node', 'current']] };
const empty: DeliveryPage = { reset: false, cursor: undefined, events: [] };
const event = (id: string) => ({ id, envConnectionId: 'node', type: 'session.updated', ts: 1, payload: { text: 'private-marker' } });
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-delivery-reader-')), file = join(dir, 'hub.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE hub_events(id TEXT PRIMARY KEY,owner_user_id TEXT,connection_id TEXT,stream_domain TEXT,payload_json TEXT)`);
  db.exec(`CREATE TABLE session_preferences(user_id TEXT,session_id TEXT,hidden INTEGER,archived INTEGER,pinned INTEGER, PRIMARY KEY(user_id,session_id))`);
  const stat = lstatSync(file), lines: string[] = [];
  const reader = new AsyncHubDeliveryReader({ file, dev: stat.dev, ino: stat.ino }, new PerformanceDiagnostics(line => lines.push(line)));
  const insert = (id: string, owner = 'default', domain = 'current', payload: unknown = event(id)) =>
    db.prepare('INSERT INTO hub_events VALUES(?,?,?,?,?)').run(id, owner, 'node', domain, JSON.stringify(payload));
  const snapshot = () => JSON.stringify(db.prepare('SELECT * FROM hub_events').all());
  t.after(async () => { await reader.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, db, reader, insert, snapshot, lines };
}
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; read?: DeliveryRead }[] = [];
  autoClose = true;
  autoExit = true;
  terminated = 0;
  postMessage(message: { id: number; kind: string; read?: DeliveryRead }) {
    this.messages.push(message);
    if (message.kind === 'close' && this.autoClose) queueMicrotask(() => {
      this.emit('message', { id: message.id, kind: 'close', ok: true }); this.emit('exit', 0);
    });
  }
  terminate() { this.terminated++; if (this.autoExit) queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
}
function fake(t: TestContext, timeout = 1000, ready = true, clock?: () => number) {
  const worker = new FakeWorker(), lines: string[] = [];
  const reader = new AsyncHubDeliveryReader({ file: '/unused', dev: 1, ino: 1 },
    new PerformanceDiagnostics(line => lines.push(line), clock), () => worker as unknown as Worker, timeout);
  if (ready) queueMicrotask(() => worker.emit('message', { kind: 'ready' }));
  t.after(async () => { worker.autoExit = true; worker.emit('exit', 1); await reader.close(); });
  return { worker, reader, lines };
}
function reply(worker: FakeWorker, index = 0, value: unknown = empty) {
  const sent = worker.messages[index]!;
  worker.emit('message', { id: sent.id, kind: sent.kind, ok: true, value });
}

const emptyRevisions = (): WorkspaceRevisions => ({ taskboard: [], 'taskboard-binding': [], drawing: [], 'native-drawio': [],
  'metric-card': [], 'card-file-binding': [], 'card-configuration': [], report: [] });

test('revision read is fixed scoped metadata and shares bounded snapshot admission before ready', async t => {
  const h = fake(t, 1000, false), reads = Array.from({ length: 4 }, () => h.reader.revisions('owner'));
  await assert.rejects(h.reader.revisions('owner')); assert.equal(h.reader.recoveryState.unavailable, false);
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.equal(h.worker.messages.length, 4);
  h.worker.messages.forEach((sent, index) => { assert.deepEqual(sent.read, { owner: 'owner' }); assert.equal(sent.kind, 'revisions'); reply(h.worker, index, emptyRevisions()); });
  await Promise.all(reads);
  const next = h.reader.revisions('next'); await turn(); reply(h.worker, 4, emptyRevisions());
  assert.deepEqual(await next, emptyRevisions());
});

test('incomplete revision worker reply fails the original owner instead of publishing missing domains', async t => {
  const h = fake(t), read = h.reader.revisions('owner'); await turn();
  reply(h.worker, 0, { taskboard: [] }); await assert.rejects(read);
  assert.equal(h.reader.recoveryState.unavailable, true);
});

test('exact revision rejection restores its slot without failing concurrent chat replay', async t => {
  const h = fake(t), revision = h.reader.revisions('owner'), rejected = assert.rejects(revision);
  const page = h.reader.read(request); await turn();
  const sent = h.worker.messages[0]!;
  h.worker.emit('message', { id: sent.id, kind: 'revisions', ok: false });
  await rejected; assert.equal(h.reader.recoveryState.unavailable, false);
  reply(h.worker, 1, { reset: false, cursor: undefined, events: [] });
  assert.deepEqual(await page, { reset: false, cursor: undefined, events: [] });
  const next = h.reader.revisions('owner'); await turn(); reply(h.worker, 2, emptyRevisions());
  assert.deepEqual(await next, emptyRevisions());
});

test('revision rejection with extra fields remains a fatal protocol failure', async t => {
  const h = fake(t), revision = h.reader.revisions('owner'), rejected = assert.rejects(revision); await turn();
  h.worker.emit('message', { id: h.worker.messages[0]!.id, kind: 'revisions', ok: false, value: 'private-error' });
  await rejected; assert.equal(h.reader.recoveryState.unavailable, true);
});

test('revision timeout cannot declare physical exit or replace the original readonly owner', async t => {
  const h = fake(t, 30); h.worker.autoExit = false;
  const read = h.reader.revisions('owner'), rejected = assert.rejects(read); await turn(); await delay(50); await rejected;
  assert.equal(h.reader.recoveryState.unavailable, true); assert.equal(h.reader.recoveryState.exitConfirmed, false);
  let closed = false; const close = h.reader.close().then(() => { closed = true; });
  await turn(); assert.equal(closed, false);
  h.worker.emit('exit', 1); await close; assert.equal(h.reader.recoveryState.exitConfirmed, true);
});

test('real replay preserves owner/domain/cursor semantics and leaves schema and facts unchanged', async t => {
  const h = fixture(t);
  h.insert('first'); h.insert('invisible', 'default', 'old'); h.insert('other-owner', 'other'); h.insert('last');
  const before = h.snapshot(), schema = h.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
  assert.deepEqual(await h.reader.read(request), { reset: false, cursor: 'last', events: [event('first'), event('last')] });
  assert.deepEqual(await h.reader.read({ ...request, cursor: 'first' }), { reset: false, cursor: 'last', events: [event('last')] });
  assert.deepEqual(await h.reader.read({ ...request, cursor: 'other-owner' }), { reset: true, cursor: 'last', events: [] });
  assert.deepEqual(await h.reader.read({ ...request, owner: 'missing', cursor: 'first' }), { reset: true, cursor: undefined, events: [] });
  assert.equal(h.snapshot(), before); assert.deepEqual(h.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), schema);
  assert.ok(h.lines.every(line => !line.includes(h.file) && !line.includes('private-marker')));
});

test('row and byte bounds include invisible rows so a hidden prefix still advances safely', async t => {
  const h = fixture(t);
  for (let n = 0; n < 20; n++) h.insert(`event-${n}`, 'default', n < 16 ? 'hidden' : 'current');
  const first = await h.reader.read(request);
  assert.deepEqual(first, { reset: false, cursor: 'event-15', events: [] });
  assert.equal((await h.reader.read({ ...request, cursor: first.cursor })).events.length, 4);
  h.db.exec('DELETE FROM hub_events');
  for (let n = 0; n < 5; n++) h.insert(`large-${n}`, 'default', 'current', { ...event(`large-${n}`), payload: '字'.repeat(80_000) });
  const page = await h.reader.read(request);
  assert.equal(page.events.length, 2); assert.equal(page.cursor, 'large-1');
});

test('real exclusive SQLite lock waits off-thread while the main event loop releases it', async t => {
  const h = fixture(t); h.insert('first'); await h.reader.read(request);
  h.db.exec('BEGIN EXCLUSIVE');
  let ticked = false;
  const release = setTimeout(() => { ticked = true; h.db.exec('ROLLBACK'); }, 80);
  try { assert.equal((await h.reader.read(request)).events.length, 1); assert.equal(ticked, true); }
  finally { clearTimeout(release); if (h.db.isTransaction) h.db.exec('ROLLBACK'); }
});

test('real preferences preserve owner/null/false flags, execute off-thread, and never mutate schema or facts', async t => {
  const h = fixture(t);
  h.db.prepare('INSERT INTO session_preferences VALUES(?,?,?,?,?)').run('default', 'private-session-marker', 0, null, 1);
  h.db.prepare('INSERT INTO session_preferences VALUES(?,?,?,?,?)').run('other', 'other-owner-marker', 1, 1, 1);
  const schema = h.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
  const facts = h.db.prepare('SELECT * FROM session_preferences').all();
  await h.reader.preferences('default');
  h.db.exec('BEGIN EXCLUSIVE'); let ticked = false;
  const release = setTimeout(() => { ticked = true; h.db.exec('ROLLBACK'); }, 80);
  try {
    assert.deepEqual(await h.reader.preferences('default'), [['private-session-marker', { hidden: false, pinned: true }]]);
    assert.equal(ticked, true);
  } finally { clearTimeout(release); if (h.db.isTransaction) h.db.exec('ROLLBACK'); }
  assert.deepEqual(h.db.prepare('SELECT * FROM session_preferences').all(), facts);
  assert.deepEqual(h.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), schema);
  assert.equal(h.lines.join('').includes('private-session-marker'), false);
});

test('preference protocol refuses arbitrary SQL, duplicate identifiers and nonboolean flags', () => {
  assert.equal(validPreferenceRead({ owner: 'default' }), true);
  assert.equal(validPreferenceRead({ owner: 'default', sql: 'SELECT 1' }), false);
  for (const value of [[['id', { hidden: 1 }]], [['id', {}], ['id', {}]], [['id', { unknown: false }]], [['bad\0id', {}]]])
    assert.equal(validPreferenceRows(value), false);
});

test('preferences share replay capacity and original close drains both command kinds', async t => {
  const h = fake(t), pending = Array.from({ length: 255 }, () => h.reader.read(request));
  const preference = h.reader.preferences('default');
  await assert.rejects(h.reader.preferences('default'), /hub_delivery_read_unavailable/);
  await turn(); assert.equal(h.worker.messages.length, 256);
  let closed = false; const closing = h.reader.close().then(() => { closed = true; });
  for (let i = 0; i < 255; i++) reply(h.worker, i);
  await Promise.all(pending); assert.equal(closed, false);
  reply(h.worker, 255, [['id', { hidden: true }]]);
  assert.deepEqual(await preference, [['id', { hidden: true }]]);
  await closing; assert.equal(closed, true);
  assert.deepEqual(h.worker.messages[255]?.read, { owner: 'default' });
});

test('preference response capacity includes startup waiters and releases only original settlements', async t => {
  const h = fake(t, 1000, false), pending = Array.from({ length: 4 }, () => h.reader.preferences('default'));
  await assert.rejects(h.reader.preferences('default'), /hub_delivery_read_unavailable/);
  assert.equal(h.worker.messages.length, 0);
  assert.ok(h.lines.some(line => line.includes('hub-preference-read') && line.includes('"step":6') && line.includes('"pending":4')));
  // Preference backpressure must not retire the observer or consume replay slots.
  const replay = h.reader.read(request);
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.equal(h.worker.messages.length, 5);
  reply(h.worker, 4); await replay;
  await assert.rejects(h.reader.preferences('default'), /hub_delivery_read_unavailable/);
  reply(h.worker, 0, []); await pending[0];
  const next = h.reader.preferences('default'); await turn();
  await assert.rejects(h.reader.preferences('default'), /hub_delivery_read_unavailable/);
  let closed = false; const closing = h.reader.close().then(() => { closed = true; });
  for (let i = 1; i < 4; i++) reply(h.worker, i, []);
  await Promise.all(pending); assert.equal(closed, false);
  reply(h.worker, 5, []); await next; await closing;
  assert.equal(closed, true); assert.equal(h.reader.recoveryState.unavailable, false);
});

test('preference timeout refuses replay, waits actual exit, and records sanitized failure', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  const h = fake(t, 20); h.worker.autoExit = false;
  const pending = h.reader.preferences('default');
  await assert.rejects(pending, /hub_delivery_read_unavailable/);
  assert.deepEqual(h.reader.recoveryState, { unavailable: true, exitConfirmed: false });
  let closed = false; const closing = h.reader.close().then(() => { closed = true; });
  await turn(); assert.equal(closed, false);
  h.worker.emit('exit', 1); await closing;
  assert.ok(h.lines.some(line => line.includes('hub-preference-read') && line.includes('timedOut')));
});

test('oversized preference identifiers fail closed rather than truncate hidden state', async t => {
  const h = fixture(t);
  h.db.prepare('INSERT INTO session_preferences VALUES(?,?,?,?,?)').run('default', 'x'.repeat(4097), 1, 0, 0);
  await assert.rejects(h.reader.preferences('default'), /hub_delivery_read_unavailable/);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM session_preferences').get()!.n, 1);
});

for (const fault of ['nul-id', 'utf8-id', 'blob-id', 'oversized-bytes', 'invalid-flag', 'text-flag'] as const)
  for (const asynchronous of [false, true]) test(`strict ${asynchronous ? 'worker' : 'original'} preferences refuse ${fault} without repairing facts`, async t => {
    const h = fixture(t);
    h.db.prepare('INSERT INTO session_preferences VALUES(?,?,?,?,?)').run('default', 'private-marker', 1, null, 0);
    if (fault === 'invalid-flag' || fault === 'text-flag')
      h.db.prepare('UPDATE session_preferences SET hidden=?').run(fault === 'invalid-flag' ? 2 : 'invalid');
    else {
      const bytes = fault === 'nul-id' ? Buffer.from('private-marker\0alias')
        : fault === 'utf8-id' ? Buffer.from([255])
        : fault === 'oversized-bytes' ? Buffer.from('字'.repeat(6000)) : Buffer.from('private-marker');
      h.db.prepare(`UPDATE session_preferences SET session_id=${fault === 'blob-id' ? '?' : 'CAST(? AS TEXT)'}`).run(bytes);
    }
    const snapshot = () => h.db.prepare('SELECT CAST(session_id AS BLOB) AS id,typeof(session_id) AS type,hidden,archived,pinned FROM session_preferences').all();
    const before = snapshot();
    if (asynchronous) await assert.rejects(h.reader.preferences('default'), /^Error: hub_delivery_read_unavailable$/);
    else assert.throws(() => readSessionPreferences(h.db, 'default'), /^Error: hub_delivery_read_unavailable$/);
    assert.deepEqual(snapshot(), before); assert.equal(h.db.isTransaction, false);
    assert.equal(h.lines.join('').includes('private-marker'), false);
  });

test('strict preference decoding preserves valid non-ASCII and literal BOM identifiers', t => {
  const h = fixture(t), ids = ['\uFEFFliteral-id', '字'.repeat(4096), '😀'.repeat(2048)];
  for (const id of ids) h.db.prepare('INSERT INTO session_preferences VALUES(?,?,?,?,?)').run('default', id, 0, 1, null);
  assert.deepEqual(new Map(readSessionPreferences(h.db, 'default')), new Map(ids.map(id => [id, { hidden: false, archived: true }])));
});

for (const limit of ['rows', 'utf8-bytes'] as const) test(`preference ${limit} limit rejects whole snapshot and releases readonly statement`, t => {
  const h = fixture(t), count = limit === 'rows' ? 65_537 : 1000;
  h.db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < ?)
    INSERT INTO session_preferences SELECT 'default', ? || i, 1, NULL, NULL FROM n`).run(count, limit === 'rows' ? 'id-' : '字'.repeat(3000));
  assert.throws(() => readSessionPreferences(h.db, 'default'), /hub_delivery_read_unavailable/);
  assert.equal(h.db.isTransaction, false);
  // Iterator failure must not leave a statement/cursor occupying the handle.
  h.db.exec('BEGIN IMMEDIATE; DELETE FROM session_preferences; COMMIT');
  assert.deepEqual(readSessionPreferences(h.db, 'default'), []);
});

test('preference waiter rejects replay-shaped preference rows', async t => {
  const h = fake(t), pending = h.reader.preferences('default'); await turn();
  reply(h.worker, 0, empty);
  await assert.rejects(pending, /hub_delivery_read_unavailable/);
  assert.equal(h.reader.recoveryState.unavailable, true);
});

test('valid preference rows with the wrong command kind cannot settle the original waiter', async t => {
  const h = fake(t), pending = h.reader.preferences('default'); await turn();
  h.worker.emit('message', { id: h.worker.messages[0]!.id, kind: 'page', ok: true, value: [['id', { hidden: true }]] });
  await assert.rejects(pending, /hub_delivery_read_unavailable/);
});

for (const fault of ['nul-json', 'utf8-json', 'invalid-json', 'nul-id', 'nul-connection', 'nul-domain', 'utf8-id', 'oversized-id', 'blob-id'] as const) {
  for (const hidden of [false, true]) for (const asynchronous of [false, true]) {
    test(`strict ${asynchronous ? 'worker' : 'original'} replay refuses ${hidden ? 'hidden' : 'visible'} ${fault} without modifying facts`, async t => {
      const h = fixture(t); h.insert('blocked', 'default', hidden ? 'hidden' : 'current'); h.insert('after');
      const column = fault.endsWith('id') ? 'id' : fault === 'nul-connection' ? 'connection_id'
        : fault === 'nul-domain' ? 'stream_domain' : 'payload_json';
      const bytes = fault === 'nul-json' ? Buffer.from(JSON.stringify(event('blocked')) + '\0private-marker')
        : fault === 'utf8-json' ? Buffer.concat([Buffer.from('{"id":"blocked","envConnectionId":"node","type":"session.updated","ts":1,"payload":"'), Buffer.from([255]), Buffer.from('"}')])
        : fault === 'invalid-json' ? Buffer.from('{private-marker') : fault === 'nul-id' ? Buffer.from('blocked\0alias')
        : fault === 'nul-connection' ? Buffer.from('node\0alias') : fault === 'nul-domain' ? Buffer.from((hidden ? 'hidden' : 'current') + '\0alias')
        : fault === 'utf8-id' ? Buffer.from([255]) : fault === 'oversized-id' ? Buffer.from('x'.repeat(16385)) : Buffer.from('blocked');
      h.db.prepare(`UPDATE hub_events SET ${column}=${fault === 'blob-id' ? '?' : 'CAST(? AS TEXT)'} WHERE id='blocked'`).run(bytes);
      const snapshot = () => h.db.prepare('SELECT CAST(id AS BLOB) AS id, CAST(connection_id AS BLOB) AS connection, CAST(stream_domain AS BLOB) AS domain, CAST(payload_json AS BLOB) AS body FROM hub_events ORDER BY rowid').all();
      const before = snapshot();
      if (asynchronous) await assert.rejects(h.reader.read(request), /^Error: hub_delivery_read_unavailable$/);
      else assert.throws(() => readDeliveryPage(h.db, request), /^Error: hub_delivery_read_unavailable$/);
      assert.equal(h.db.isTransaction, false); assert.deepEqual(snapshot(), before);
      if (asynchronous) {
        assert.ok(h.lines.some(line => { const log = JSON.parse(line); return log.operation === 'hub-delivery-read' && log.category === 'failed'; }));
        assert.ok(h.lines.every(line => !line.includes('private-marker') && !line.includes(h.file)));
      }
    });
  }
}

for (const asynchronous of [false, true]) {
  test(`strict ${asynchronous ? 'worker' : 'original'} reset refuses a truncated latest cursor`, async t => {
    const h = fixture(t); h.insert('last');
    h.db.prepare('UPDATE hub_events SET id=CAST(? AS TEXT)').run(Buffer.from('last\0alias'));
    const read = { ...request, cursor: 'expired' };
    if (asynchronous) await assert.rejects(h.reader.read(read), /hub_delivery_read_unavailable/);
    else assert.throws(() => readDeliveryPage(h.db, read), /hub_delivery_read_unavailable/);
  });
  test(`strict ${asynchronous ? 'worker' : 'original'} replay preserves Unicode and historical empty domains`, async t => {
    const h = fixture(t), id = '事件😀', connection = '连接😀', domain = '域😀';
    const value = { ...event(id), envConnectionId: connection, payload: { text: '字😀\u0000inside JSON' } };
    h.db.prepare('INSERT INTO hub_events VALUES(?,?,?,?,?)').run(id, 'default', connection, domain, JSON.stringify(value));
    h.insert('legacy-empty', 'default', '');
    const read = { owner: 'default', domains: [[connection, domain]] as [string, string][] };
    const page = asynchronous ? await h.reader.read(read) : readDeliveryPage(h.db, read);
    assert.deepEqual(page, { reset: false, cursor: 'legacy-empty', events: [value] });
  });
}

for (const fault of ['oversized', 'null', 'blob', 'empty'] as const) {
  for (const hidden of [false, true]) {
    test(`unpageable ${hidden ? 'hidden' : 'visible'} ${fault} row fails instead of idling or skipping facts`, async t => {
      const h = fixture(t);
      h.insert('blocked', 'default', hidden ? 'hidden' : 'current'); h.insert('after');
      const payload = fault === 'oversized' ? JSON.stringify({ ...event('blocked'), payload: '字'.repeat(180_000) })
        : fault === 'null' ? null : fault === 'blob' ? Buffer.from(JSON.stringify(event('blocked'))) : '';
      h.db.prepare('UPDATE hub_events SET payload_json=? WHERE id=?').run(payload, 'blocked');
      const before = h.snapshot();
      await assert.rejects(h.reader.read(request), /hub_delivery_read_unavailable/);
      await h.reader.close();
      assert.equal(h.snapshot(), before); assert.equal(h.db.isTransaction, false);
      assert.ok(h.lines.map(line => JSON.parse(line)).some(log => log.operation === 'hub-delivery-read'
        && log.step === 1 && log.category === 'failed'));
      assert.ok(h.lines.every(line => !line.includes('private-marker') && !line.includes(h.file)));
    });
  }
}

test('a bounded valid prefix advances once, then refuses its original oversized successor', async t => {
  const h = fixture(t); h.insert('prefix');
  h.insert('blocked', 'default', 'hidden', { ...event('blocked'), payload: '字'.repeat(180_000) });
  h.insert('after');
  const before = h.snapshot(), page = await h.reader.read(request);
  assert.deepEqual(page, { reset: false, cursor: 'prefix', events: [event('prefix')] });
  await assert.rejects(h.reader.read({ ...request, cursor: page.cursor }), /hub_delivery_read_unavailable/);
  await h.reader.close(); assert.equal(h.snapshot(), before);
});

for (const fault of ['json', 'id', 'connection', 'timestamp', 'inode', 'sidecar'] as const) {
  test(`real reader safely retires on ${fault} without repairing facts or replacing writer`, async t => {
    const h = fixture(t); h.insert('first'); await h.reader.read(request);
    if (fault === 'json') h.db.exec("UPDATE hub_events SET payload_json='{private-marker'");
    if (fault === 'id') h.db.prepare('UPDATE hub_events SET payload_json=?').run(JSON.stringify(event('different')));
    if (fault === 'connection') h.db.prepare('UPDATE hub_events SET payload_json=?').run(JSON.stringify({ ...event('first'), envConnectionId: 'different' }));
    if (fault === 'timestamp') h.db.prepare('UPDATE hub_events SET payload_json=?').run(JSON.stringify({ ...event('first'), ts: null }));
    const before = h.snapshot();
    if (fault === 'inode') { renameSync(h.file, h.file + '.original'); writeFileSync(h.file, 'replacement'); }
    if (fault === 'sidecar') { writeFileSync(h.file + '.target', 'private-marker'); symlinkSync(h.file + '.target', h.file + '-journal'); }
    await assert.rejects(h.reader.read(request), /hub_delivery_read_unavailable/);
    await assert.rejects(h.reader.read(request), /hub_delivery_read_unavailable/);
    await h.reader.close();
    if (fault === 'sidecar') renameSync(h.file + '-journal', h.file + '.rejected-sidecar');
    assert.equal(h.snapshot(), before);
    assert.ok(h.lines.every(line => !line.includes('private-marker') && !line.includes(h.file)));
  });
}

test('admission snapshots caller-owned domains before awaiting readiness', async t => {
  const h = fake(t, 1000, false), input: DeliveryRead = { owner: 'default', domains: [['node', 'old']] };
  const read = h.reader.read(input); input.owner = 'other'; input.domains[0]![1] = 'new'; input.domains.push(['extra', 'new']);
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.deepEqual(h.worker.messages[0]!.read, { owner: 'default', cursor: undefined, domains: [['node', 'old']] });
  reply(h.worker); await read;
});

const metadataBudget = 8 * 1024 * 1024;
const largeRequest = (): DeliveryRead => ({ owner: 'default', domains:
  Array.from({ length: 100 }, (_, index) => [`node-${index}`, '字'.repeat(3072)]) });
const outcome = (read: Promise<DeliveryPage>) => read.then(() => 'completed', () => 'refused');

test('aggregate metadata budget bounds accepted reads even while worker readiness is pending', async t => {
  const h = fake(t, 10_000, false), input = largeRequest();
  assert.ok(validDeliveryRead(input));
  const count = Math.floor(metadataBudget / Buffer.byteLength(JSON.stringify(input)));
  const reads = Array.from({ length: count }, () => outcome(h.reader.read(input)));
  const extra = outcome(h.reader.read(input));
  assert.equal(await Promise.race([extra, turn().then(() => 'pending')]), 'refused');
  assert.equal(h.worker.messages.length, 0);
  assert.equal(h.worker.terminated, 0);
  assert.ok(h.lines.map(line => JSON.parse(line)).some(log => log.operation === 'hub-delivery-read'
    && log.step === 5 && log.deferred === 1 && log.pending === count
    && log.snapshotBytes === count * Buffer.byteLength(JSON.stringify(input))));
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.equal(h.worker.messages.length, count);
  for (let i = 0; i < count; i++) reply(h.worker, i);
  assert.ok((await Promise.all(reads)).every(result => result === 'completed'));
  assert.ok(h.lines.every(line => !line.includes('字') && !line.includes('node-')));
});

test('only an original read settlement restores aggregate metadata capacity', async t => {
  const h = fake(t, 10_000), input = largeRequest();
  const count = Math.floor(metadataBudget / Buffer.byteLength(JSON.stringify(input)));
  const reads = Array.from({ length: count }, () => outcome(h.reader.read(input)));
  await turn();
  for (let i = 0; i < 20; i++) {
    const extra = outcome(h.reader.read(input));
    assert.equal(await Promise.race([extra, turn().then(() => 'pending')]), 'refused');
  }
  assert.equal(h.worker.messages.length, count);
  assert.equal(h.worker.terminated, 0);
  reply(h.worker, 0); assert.equal(await reads[0], 'completed');
  const replacement = outcome(h.reader.read(input)); await turn();
  assert.equal(h.worker.messages.length, count + 1);
  for (let i = 1; i <= count; i++) reply(h.worker, i);
  assert.ok((await Promise.all([...reads, replacement])).every(result => result === 'completed'));
  assert.deepEqual(h.reader.recoveryState, { unavailable: false, exitConfirmed: false });
});

test('mutating caller metadata cannot prematurely restore the owned byte budget', async t => {
  const h = fake(t, 10_000, false), input = largeRequest();
  const count = Math.floor(metadataBudget / Buffer.byteLength(JSON.stringify(input)));
  const reads = Array.from({ length: count }, () => outcome(h.reader.read(input)));
  input.domains.length = 0;
  const extra = outcome(h.reader.read(largeRequest()));
  assert.equal(await Promise.race([extra, turn().then(() => 'pending')]), 'refused');
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.equal(h.worker.messages.length, count);
  assert.ok(h.worker.messages.every(message => message.read!.domains.length === 100));
  for (let i = 0; i < count; i++) reply(h.worker, i);
  await Promise.all(reads);
  const later = outcome(h.reader.read(largeRequest())); await turn();
  assert.equal(h.worker.messages.length, count + 1);
  reply(h.worker, count); assert.equal(await later, 'completed');
});

test('a caller getter changing after validation is refused before metadata admission', async t => {
  const h = fake(t, 10_000, false);
  let accesses = 0;
  const pair: [string, string] = ['node', 'current'];
  Object.defineProperty(pair, '0', { enumerable: true, get() {
    return ++accesses > 3 ? 'node\0changed' : 'node';
  } });
  const result = outcome(h.reader.read({ owner: 'default', domains: [pair] }));
  assert.equal(await Promise.race([result, turn().then(() => 'pending')]), 'refused');
  const later = outcome(h.reader.read(request));
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.equal(h.worker.messages.length, 1);
  assert.deepEqual(h.worker.messages[0]!.read, { ...request, cursor: undefined });
  reply(h.worker); assert.equal(await later, 'completed');
  assert.equal(h.worker.terminated, 0);
});

test('bounded admission refuses request 257 without dispatching or retiring valid work', async t => {
  const h = fake(t), reads = Array.from({ length: 256 }, () => h.reader.read(request));
  await assert.rejects(h.reader.read(request), /hub_delivery_read_unavailable/); await turn();
  assert.equal(h.worker.messages.length, 256);
  for (let i = 0; i < 256; i++) reply(h.worker, i);
  await Promise.all(reads); assert.equal(h.reader.recoveryState.unavailable, false);
});

test('reentrant caller inspection cannot exceed the accepted request bound', async t => {
  const h = fake(t, 10_000, false), reads: Promise<string>[] = [];
  let entered = false;
  const input: DeliveryRead = { get owner() {
    if (!entered) {
      entered = true;
      for (let i = 0; i < 256; i++) reads.push(outcome(h.reader.read(request)));
    }
    return 'default';
  }, domains: [['node', 'current']] };
  const extra = outcome(h.reader.read(input));
  assert.equal(await Promise.race([extra, turn().then(() => 'pending')]), 'refused');
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.equal(h.worker.messages.length, 256);
  assert.equal(h.worker.terminated, 0);
  for (let i = 0; i < 256; i++) reply(h.worker, i);
  assert.ok((await Promise.all(reads)).every(result => result === 'completed'));
});

for (const ready of [false, true]) test(`diagnostic clock reentrancy retains original request admission (ready=${ready})`, async t => {
  const reads: Promise<string>[] = [];
  let armed = false;
  const h = fake(t, 10_000, ready, () => {
    if (armed) {
      armed = false;
      for (let i = 0; i < 256; i++) reads.push(outcome(h.reader.read(request)));
    }
    return 0;
  });
  armed = true;
  reads.push(outcome(h.reader.read(request)));
  await turn();
  if (!ready) { assert.equal(h.worker.messages.length, 0); h.worker.emit('message', { kind: 'ready' }); await turn(); }
  assert.equal(h.worker.messages.length, 256);
  assert.equal(h.worker.terminated, 0);
  for (let i = 0; i < 256; i++) reply(h.worker, i);
  const results = await Promise.all(reads);
  assert.equal(results.filter(result => result === 'completed').length, 256);
  assert.equal(results.filter(result => result === 'refused').length, 1);
  const later = h.reader.read(request); await turn(); reply(h.worker, 256);
  assert.deepEqual(await later, empty);
  assert.equal(h.reader.recoveryState.unavailable, false);
});

for (const ready of [false, true]) for (const trigger of ['immediate', 'clock'] as const)
  test(`original admitted replay drains before ${trigger} close (ready=${ready})`, async t => {
    let armed = false, closing: Promise<void> | undefined, closed = false;
    const h = fake(t, 10_000, ready, () => {
      if (armed) { armed = false; closing = h.reader.close(); }
      return 0;
    });
    armed = trigger === 'clock';
    const read = h.reader.read(request);
    if (trigger === 'immediate') closing = h.reader.close();
    await turn();
    assert.ok(closing); assert.equal(h.reader.close(), closing);
    void closing.then(() => { closed = true; });
    await assert.rejects(h.reader.read(request), /hub_delivery_read_unavailable/);
    if (!ready) {
      assert.equal(h.worker.messages.length, 0); assert.equal(closed, false);
      h.worker.emit('message', { kind: 'ready' }); await turn();
    }
    assert.equal(closed, false);
    assert.deepEqual(h.worker.messages.map(message => message.kind), ['page']);
    reply(h.worker); assert.deepEqual(await read, empty); await closing;
    assert.equal(closed, true); assert.equal(h.worker.terminated, 0);
    assert.equal(h.reader.recoveryState.exitConfirmed, true);
    assert.deepEqual(h.worker.messages.map(message => message.kind), ['page', 'close']);
    assert.ok(h.lines.some(line => { const row = JSON.parse(line); return row.step === 3 && row.settled === 1; }));
  });

test('caller inspection cannot admit a new read after requesting original close', async t => {
  const h = fake(t, 10_000, false);
  let closing: Promise<void> | undefined;
  const input: DeliveryRead = { get owner() {
    closing ??= h.reader.close();
    return 'default';
  }, domains: [['node', 'current']] };
  const result = outcome(h.reader.read(input));
  assert.equal(await Promise.race([result, turn().then(() => 'pending')]), 'refused');
  h.worker.emit('message', { kind: 'ready' });
  await closing;
  assert.deepEqual(h.worker.messages.map(message => message.kind), ['close']);
  assert.equal(h.worker.terminated, 0);
});

test('a caller-owned map method cannot retain mutable domain references in the snapshot', async t => {
  const h = fake(t, 10_000, false), input: DeliveryRead = { owner: 'default', domains: [['node', 'old']] };
  Object.defineProperty(input.domains, 'map', { value() { return this; } });
  const read = outcome(h.reader.read(input));
  input.domains[0]![1] = 'new'; input.domains.push(['extra', 'new']);
  h.worker.emit('message', { kind: 'ready' }); await turn();
  assert.deepEqual(h.worker.messages[0]!.read, { owner: 'default', cursor: undefined, domains: [['node', 'old']] });
  reply(h.worker); assert.equal(await read, 'completed');
});

test('malformed metadata and cyclic payload validation safely refuse without leaking raw errors', async t => {
  const h = fake(t), cycle: any = event('first'); cycle.payload = cycle;
  assert.equal(validDeliveryPage({ reset: false, cursor: 'first', events: [cycle] }), false);
  assert.equal(validDeliveryRead({ ...request, domains: [['node', 'one'], ['node', 'two']] }), false);
  const throwing = new Proxy({}, { ownKeys() { throw Error('private-marker'); } });
  assert.equal(validDeliveryRead(throwing), false); assert.equal(validDeliveryPage(throwing), false);
  await assert.rejects(h.reader.read(throwing as DeliveryRead), /hub_delivery_read_unavailable/);
  assert.equal(h.reader.recoveryState.unavailable, false);
});
for (const fault of ['wrong-id', 'extra-key', 'duplicate-ready', 'reset-with-events', 'non-finite', 'too-many', 'error', 'exit'] as const) {
  test(`protocol ${fault} rejects pending work and retires only the observer`, async t => {
    const h = fake(t), read = h.reader.read(request); await turn();
    if (fault === 'wrong-id') h.worker.emit('message', { id: 999, kind: 'page', ok: true, value: empty });
    if (fault === 'extra-key') h.worker.emit('message', { id: 1, kind: 'page', ok: true, value: empty, private: 'marker' });
    if (fault === 'duplicate-ready') h.worker.emit('message', { kind: 'ready' });
    if (fault === 'reset-with-events') reply(h.worker, 0, { ...empty, reset: true, events: [event('first')] });
    if (fault === 'non-finite') reply(h.worker, 0, { ...empty, events: [{ ...event('first'), ts: NaN }] });
    if (fault === 'too-many') reply(h.worker, 0, { ...empty, events: Array.from({ length: 17 }, () => event('first')) });
    if (fault === 'error') h.worker.emit('error', Error('private-marker'));
    if (fault === 'exit') h.worker.emit('exit', 0);
    await assert.rejects(read, /hub_delivery_read_unavailable/); await turn();
    assert.equal(h.reader.recoveryState.unavailable, true); assert.equal(h.reader.recoveryState.exitConfirmed, true);
    assert.ok(h.lines.every(line => !line.includes('private-marker')));
  });
}
for (const ready of [false, true]) test(`${ready ? 'query' : 'startup'} timeout is bounded and inspectable`, async t => {
  const h = fake(t, 15, ready), read = h.reader.read(request);
  await Promise.all([assert.rejects(read, /hub_delivery_read_unavailable/), delay(30)]);
  assert.ok(h.worker.terminated > 0); assert.ok(h.lines.some(line => JSON.parse(line).timedOut === 1));
});
test('close freezes admission and drains accepted work before requesting observer close', async t => {
  const h = fake(t), read = h.reader.read(request); await turn();
  let settled = false; const close = h.reader.close().then(() => { settled = true; });
  assert.equal(h.reader.close(), h.reader.close()); await assert.rejects(h.reader.read(request), /hub_delivery_read_unavailable/);
  await turn(); assert.equal(settled, false); assert.deepEqual(h.worker.messages.map(m => m.kind), ['page']);
  reply(h.worker); await read; await close;
  assert.deepEqual(h.worker.messages.map(m => m.kind), ['page', 'close']);
  assert.ok(h.lines.some(line => { const row = JSON.parse(line); return row.step === 3 && row.settled === 1; }));
});
test('lost close acknowledgement recovers on actual exit without a second close signal', async t => {
  const h = fake(t, 15); h.worker.autoClose = false; h.worker.autoExit = false;
  const read = h.reader.read(request); await turn(); reply(h.worker); await read;
  let settled = false; const close = h.reader.close().then(() => { settled = true; });
  await delay(35); assert.equal(settled, false); assert.equal(h.worker.terminated, 1);
  assert.equal(h.reader.recoveryState.exitConfirmed, false);
  assert.ok(h.lines.some(line => { const row = JSON.parse(line); return row.step === 3 && row.pending === 1 && row.unknown === 1; }));
  h.worker.emit('exit', 1); await close; assert.equal(settled, true);
});

test('original Hub writer stays open while observer termination has no confirmed exit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-delivery-close-')), store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  const h = fake(t, 15); h.worker.autoClose = false; h.worker.autoExit = false;
  (store as any).deliveryReader = h.reader;
  const db = (store as any).db as DatabaseSync, original = DatabaseSync.prototype.close; let closes = 0;
  // The recoverable connection is a proxy: assigning db.close would replace
  // its native target and make a bound proxy wrapper recursively call itself.
  DatabaseSync.prototype.close = function () { closes++; original.call(this); };
  t.after(async () => {
    h.worker.emit('exit', 1);
    try { await store.close(); } finally { DatabaseSync.prototype.close = original; rmSync(dir, { recursive: true, force: true }); }
  });
  let settled = false; const close = Promise.resolve(store.close()).then(() => { settled = true; });
  await delay(35); assert.equal(settled, false); assert.equal(closes, 0); assert.ok(db.prepare('SELECT 1').get());
  h.worker.emit('exit', 1); await close; assert.equal(closes, 1);
});

test('file-backed Hub async replay matches original DTOs and drains before same-data reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-delivery-parity-')), file = join(dir, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic');
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.upsertConnection({ id: 'node', label: 'Node', connectorUrl: 'http://synthetic', capabilities: ['events'], credentialToken: 'synthetic' });
  for (let n = 0; n < 21; n++) store.appendDelivery({ ...event(`not-authoritative-${n}`) }, 'current', `remote-${n}`);
  const domains = new Map(request.domains), sync = store.deliveryPage(undefined, domains);
  assert.deepEqual(await store.deliveryPageAsync(undefined, domains), sync);
  assert.deepEqual(await store.deliveryPageAsync(sync.cursor, domains), store.deliveryPage(sync.cursor, domains));
  assert.equal(store.upstreamCursor('node', 'current'), 'remote-20');
  await store.close(); await assert.rejects(store.deliveryPageAsync(undefined, domains), /hub_delivery_read_unavailable/);
  store = new HubStore(file, 'synthetic'); assert.deepEqual(await store.deliveryPageAsync(undefined, domains), sync);
  assert.equal(store.upstreamCursor('node', 'current'), 'remote-20');
});

test('Hub later distinct requests replace a failed observer only after confirmed exit and cooldown', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-delivery-recover-')), store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  const h = fake(t); h.worker.autoExit = false;
  (store as any).deliveryReader = h.reader;
  t.after(async () => { h.worker.emit('exit', 1); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const domains = new Map(request.domains), first = store.deliveryPageAsync(undefined, domains); await turn();
  h.worker.emit('message', { kind: 'ready' }); await assert.rejects(first, /hub_delivery_read_unavailable/);
  (store as any).deliveryRetryAt = 0;
  await assert.rejects(store.deliveryPageAsync(undefined, domains), /hub_delivery_read_unavailable/);
  assert.equal((store as any).deliveryReader, h.reader);
  h.worker.emit('exit', 1); (store as any).deliveryRetryAt = performance.now() + 10_000;
  await assert.rejects(store.deliveryPageAsync(undefined, domains), /hub_delivery_read_unavailable/);
  (store as any).deliveryRetryAt = 0;
  const pages = await Promise.all(Array.from({ length: 10 }, () => store.deliveryPageAsync(undefined, domains)));
  assert.ok(pages.every(page => page.events.length === 0)); assert.notEqual((store as any).deliveryReader, h.reader);
});

test('Hub preferences recover on a distinct read only after actual observer exit and retain same-data flags across restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-preferences-recover-')), file = join(dir, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic'); const h = fake(t); h.worker.autoExit = false;
  (store as any).deliveryReader = h.reader;
  t.after(async () => { h.worker.emit('exit', 1); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.setSessionPreference('node:a2V5', 'hidden', true);
  const first = store.sessionPreferencesAsync(); await turn();
  reply(h.worker, 0, empty); await assert.rejects(first, /hub_delivery_read_unavailable/);
  (store as any).deliveryRetryAt = 0;
  await assert.rejects(store.sessionPreferencesAsync(), /hub_delivery_read_unavailable/);
  assert.equal((store as any).deliveryReader, h.reader);
  h.worker.emit('exit', 1); (store as any).deliveryRetryAt = performance.now() + 10_000;
  await assert.rejects(store.sessionPreferencesAsync(), /hub_delivery_read_unavailable/);
  (store as any).deliveryRetryAt = 0;
  const views = await Promise.allSettled(Array.from({ length: 10 }, () => store.sessionPreferencesAsync()));
  assert.equal(views.filter(view => view.status === 'fulfilled').length, 4);
  assert.equal(views.filter(view => view.status === 'rejected').length, 6);
  for (const view of views) {
    if (view.status === 'fulfilled') assert.equal(view.value.get('node:a2V5')?.hidden, true);
    else assert.match(String(view.reason), /hub_delivery_read_unavailable/);
  }
  // Admission pressure does not retire the successfully recovered observer.
  assert.equal((store as any).deliveryReader.recoveryState.unavailable, false);
  assert.equal((await store.sessionPreferencesAsync()).get('node:a2V5')?.hidden, true);
  await store.close(); await assert.rejects(store.sessionPreferencesAsync(), /hub_delivery_read_unavailable/);
  store = new HubStore(file, 'synthetic');
  assert.deepEqual(await store.sessionPreferencesAsync(), store.sessionPreferences());
});

test('preferences finishing after original Hub shutdown fail while the same accepted read drains', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-preferences-fence-')), store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  const h = fake(t); (store as any).deliveryReader = h.reader;
  t.after(async () => { h.worker.emit('exit', 1); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const pending = store.sessionPreferencesAsync(); await turn();
  const closing = store.close(); reply(h.worker, 0, [['node:a2V5', { hidden: true }]]);
  await assert.rejects(pending, /hub_delivery_read_unavailable/); await closing;
  assert.equal(store.storageRecovery().state, 'closed');
});

for (const mutation of ['set', 'remove'] as const) test(`original async preferences refuse a stale snapshot after ${mutation}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-preferences-version-')), store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  const h = fake(t); (store as any).deliveryReader = h.reader;
  t.after(async () => { h.worker.emit('exit', 1); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.setSessionPreference('node:a2V5', 'hidden', true);
  const pending = store.sessionPreferencesAsync(); await turn();
  if (mutation === 'set') store.setSessionPreference('node:a2V5', 'hidden', false);
  else store.removeSessionPreferences('node:a2V5');
  reply(h.worker, 0, [['node:a2V5', { hidden: true }]]);
  await assert.rejects(pending, /hub_delivery_read_unavailable/);
  // A stale read is not a broken worker or an instruction to replace a writer.
  assert.equal(h.reader.recoveryState.unavailable, false);
  const next = store.sessionPreferencesAsync(); await turn();
  const expected = mutation === 'set' ? [['node:a2V5', { hidden: false }]] : [];
  reply(h.worker, 1, expected); assert.deepEqual([...(await next)], expected);
});

test('writer open replacement cannot bind browser replay to an unrelated file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-delivery-open-')), file = join(dir, 'hub.sqlite');
  const first = new HubStore(file, 'synthetic'); await first.close();
  const open = startupDatabaseOwners.open;
  startupDatabaseOwners.open = function (path) {
    const db = open.call(this, path); renameSync(path, path + '.original'); writeFileSync(path, 'replacement'); return db;
  };
  try { assert.throws(() => new HubStore(file, 'synthetic'), /hub_delivery_read_unavailable/); }
  finally { startupDatabaseOwners.open = open; rmSync(dir, { recursive: true, force: true }); }
});

test('a page completing after original Hub shutdown is refused and close drains that same accepted read', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-delivery-fence-')), store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  const h = fake(t); (store as any).deliveryReader = h.reader;
  t.after(async () => { h.worker.emit('exit', 1); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const read = store.deliveryPageAsync(undefined, new Map(request.domains)); await turn();
  const close = store.close(); reply(h.worker, 0, { ...empty, cursor: 'first', events: [event('first')] });
  await assert.rejects(read, /hub_delivery_read_unavailable/); await close;
  assert.equal(store.storageRecovery().state, 'closed');
});
