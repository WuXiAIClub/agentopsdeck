import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesHistory } from './async-hermes-history.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { validConnectorHermesHistoryInput, type ConnectorHermesHistoryKind } from './connector-hermes-history-domain.js';
import { attachHermesSession, refreshHermesHistory } from '../hermes/session-history.js';
import type { HermesExecution } from '../hermes/journal.js';
import type { HermesHistoryRow } from '../hermes/history.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const key = 'hermes:original', silence = new PerformanceDiagnostics(() => {});
const rows: HermesHistoryRow[] = [{ row_id: 1, role: 'user', text: 'private input', timestamp: 1 },
  { row_id: 2, role: 'assistant', text: 'private reply', timestamp: 2 }];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const session = () => ({ key, stored: 'stored', title: 'Original', started: false, messages: [] });
const execution = (): HermesExecution => ({ key, id: 'original-execution', live: 'live', epoch: 'epoch', members: ['input'], at: 1, updated: 1, phase: 'running', row: 1 });
function fixture() {
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.hermesJournal.save(session()); const command = createConnectorOwnerCommands(store);
  return { store, command, facade: new AsyncHermesHistory({ command }),
    close() { command.dispose(); store.close(); } };
}

test('original history chain attaches, persists native rows and projects only committed messages', async () => {
  const f = fixture(); let attached = 0, reads = 0, published = 0;
  try {
    const result = await refreshHermesHistory(key, f.facade, {
      current: () => true,
      attach: () => attachHermesSession(key, f.facade, async snapshot => {
        attached++; assert.equal(snapshot.stored, 'stored'); return { live: 'live', stored: 'new-stored' };
      }, () => true),
      history: async live => { reads++; assert.equal(live, 'live'); return rows; },
    }, messages => { published++; assert.deepEqual(messages.map(m => m.text), ['private input', 'private reply']); }, silence);
    assert.equal(result, 'committed'); assert.equal(attached, 1); assert.equal(reads, 1); assert.equal(published, 1);
    assert.equal(f.store.hermesJournal.session(key)?.stored, 'new-stored');
    assert.equal(f.store.hermesJournal.current(key), undefined);
  } finally { f.close(); }
});

for (const change of ['messages', 'execution', 'unknown', 'deletion', 'aba'] as const)
  test(`history read crossing ${change} cannot overwrite original state or publish stale rows`, async () => {
    const f = fixture(); let published = 0;
    try {
      const result = await refreshHermesHistory(key, f.facade, { attach: async () => 'live', current: () => true,
        history: async () => {
          if (change === 'messages') f.store.hermesJournal.save({ ...session(), title: 'New title' });
          if (change === 'execution' || change === 'unknown') f.store.hermesJournal.update({ ...execution(), phase: change === 'unknown' ? 'unknown' : 'running' });
          if (change === 'deletion') f.store.hermesJournal.beginDeletion(key);
          if (change === 'aba') { f.store.hermesJournal.save({ ...session(), title: 'Intermediate' }); f.store.hermesJournal.save(session()); }
          return rows;
        } }, () => { published++; }, silence);
      assert.equal(result, 'stale'); assert.equal(published, 0);
      assert.deepEqual(f.store.hermesJournal.session(key)?.messages, []);
      if (change === 'unknown') assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown');
    } finally { f.close(); }
  });

for (const change of ['stored', 'unknown', 'deletion', 'disconnect'] as const)
  test(`attachment crossing ${change} never binds a stale native identity or retries`, async () => {
    const f = fixture(); let calls = 0, current = true;
    try {
      await assert.rejects(attachHermesSession(key, f.facade, async () => {
        calls++;
        if (change === 'stored') f.store.hermesJournal.save({ ...session(), stored: 'newer-stored' });
        if (change === 'unknown') f.store.hermesJournal.update({ ...execution(), phase: 'unknown' });
        if (change === 'deletion') f.store.hermesJournal.beginDeletion(key);
        if (change === 'disconnect') current = false;
        return { live: 'stale-live', stored: 'stale-stored' };
      }, () => current));
      assert.equal(calls, 1); assert.notEqual(f.store.hermesJournal.session(key)?.stored, 'stale-stored');
    } finally { f.close(); }
  });

test('started native identity cannot rotate on ordinary attach; unknown only reads cache, even offline', async () => {
  const f = fixture(); let calls = 0;
  try {
    f.store.hermesJournal.save({ ...session(), started: true });
    await assert.rejects(attachHermesSession(key, f.facade, async () => ({ live: 'live', stored: 'rotated' }), () => true));
    f.store.hermesJournal.update({ ...execution(), phase: 'unknown' });
    assert.equal(await refreshHermesHistory(key, f.facade, { current: () => false,
      attach: async () => { calls++; return 'live'; }, history: async () => { calls++; return rows; } }, () => { calls++; }, silence), 'cached');
    assert.equal(calls, 0); assert.equal(f.store.hermesJournal.session(key)?.stored, 'stored');
    assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown');
  } finally { f.close(); }
});

test('history uses original row binding and retains redacted tool pairs', async () => {
  const f = fixture();
  try {
    const e = execution(); f.store.hermesJournal.update(e);
    f.store.hermesJournal.save({ ...session(), messages: [{ id: 'hermes-tool:original:call', sessionKey: key,
      turnId: e.id, role: 'tool', text: 'Tool: isolated\nStarted', toolName: 'isolated', toolCallId: 'original:tool', toolPhase: 'call', createdAt: 1 }] });
    const snapshot = (await f.facade.snapshot(key))!;
    const committed = (await f.facade.commit(snapshot, rows))!;
    const messages = (await f.facade.projection(committed))!;
    assert.equal(messages.find(m => m.role === 'user')?.id, 'input');
    assert.equal(messages.filter(m => m.id === 'hermes-tool:original:call').length, 1);
    assert.equal(f.store.hermesJournal.current(key)?.phase, 'running');
  } finally { f.close(); }
});

test('projection is byte-bounded, complete and rejects revisions changing between pages', async () => {
  const f = fixture();
  try {
    const many = Array.from({ length: 70 }, (_, i) => ({ row_id: i + 1, role: 'assistant' as const, text: 'x'.repeat(80_000), timestamp: i + 1 }));
    const snapshot = (await f.facade.snapshot(key))!, committed = (await f.facade.commit(snapshot, many))!;
    const first = await f.command('hermesHistoryProjection', { key, digest: committed.digest, offset: 0, limit: 64 });
    assert.ok(first && first.next !== null && first.messages.length < 64);
    assert.deepEqual((await f.facade.projection(committed))?.map(m => m.text), many.map(m => m.text));
    let pages = 0;
    const changing = new AsyncHermesHistory({ command: async (kind, input) => {
      const result = await f.command(kind, input);
      if (kind === 'hermesHistoryProjection' && ++pages === 1) f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, title: 'New' });
      return result;
    } });
    assert.equal(await changing.projection(committed), null); assert.equal(pages, 2);
  } finally { f.close(); }
});

test('fixed history commands exclude caller SQL, actor, authority and arbitrary messages', async () => {
  const f = fixture();
  try {
    const snapshot = (await f.facade.snapshot(key))!;
    const inputs = { hermesHistorySnapshot: { key }, hermesHistoryAttach: { key, digest: snapshot.digest, stored: 'stored' },
      hermesHistoryCommit: { key, digest: snapshot.digest, rows }, hermesHistoryProjection: { key, digest: snapshot.digest, offset: 0, limit: 64 },
      hermesHistoryMessagePart: { key, digest: snapshot.digest, index: 0, offset: 0 } };
    for (const kind of Object.keys(inputs) as ConnectorHermesHistoryKind[]) {
      assert.equal(validConnectorHermesHistoryInput(kind, inputs[kind]), true);
      for (const name of ['sql', 'actorId', 'authorized', 'callback', 'messages', 'unlock', 'replay'])
        assert.equal(validConnectorHermesHistoryInput(kind, { ...inputs[kind], [name]: true }), false);
    }
    assert.equal(validConnectorHermesHistoryInput('hermesHistoryCommit', { key, digest: snapshot.digest, rows: [rows[0], rows[0]] }), false);
    assert.equal(validConnectorHermesHistoryInput('hermesHistoryProjection', { key, digest: snapshot.digest, offset: -1, limit: 64 }), false);
  } finally { f.close(); }
});

const largeRows = (): HermesHistoryRow[] => [rows[0]!,
  { row_id: 2, role: 'assistant', text: '🙂汉字"\\\n'.repeat(100_000), timestamp: 2 },
  { row_id: 3, role: 'assistant', text: 'Original tail', timestamp: 3 }];

test('oversized original messages retain UTF-8, escaping, metadata and order through bounded parts', async () => {
  const f = fixture();
  try {
    const input = largeRows(), snapshot = (await f.facade.snapshot(key))!;
    const committed = (await f.facade.commit(snapshot, input))!;
    const page = await f.command('hermesHistoryProjection', { key, digest: committed.digest, offset: 0, limit: 64 });
    assert.ok(page?.large); assert.equal(page.large.index, 1); assert.equal(page.next, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 512 * 1024);
    let parts = 0;
    const tracked = new AsyncHermesHistory({ command: async (kind, body) => {
      const result = await f.command(kind, body);
      if (kind === 'hermesHistoryMessagePart') {
        parts++; const part = result as { data: string };
        assert.ok(Buffer.from(part.data, 'base64').length <= 262144);
        assert.ok(Buffer.byteLength(JSON.stringify(part)) < 512 * 1024);
      }
      return result;
    } });
    const messages = await tracked.projection(committed);
    assert.ok(parts > 4);
    assert.deepEqual(messages, f.store.hermesJournal.session(key)?.messages);
    assert.deepEqual(messages?.map(m => m.text), input.map(r => r.text));
  } finally { f.close(); }
});

test('revision change during large-message parts discards the whole projection without publishing a prefix', async () => {
  const f = fixture(); let parts = 0;
  try {
    const committed = (await f.facade.commit((await f.facade.snapshot(key))!, largeRows()))!;
    const changing = new AsyncHermesHistory({ command: async (kind, body) => {
      const result = await f.command(kind, body);
      if (kind === 'hermesHistoryMessagePart' && ++parts === 1)
        f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, title: 'Changed' });
      return result;
    } });
    assert.equal(await changing.projection(committed), null); assert.equal(parts, 2);
    assert.equal(f.store.hermesJournal.session(key)?.messages[1]?.text, largeRows()[1]?.text);
  } finally { f.close(); }
});

test('real worker preserves original history across close/reopen, stale fences and additive schema', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-history-owner-')), file = join(directory, 'connector.sqlite');
  let staleDigest = '';
  try {
    // Original pre-revision schema/data, without using the new constructor to
    // seed it. Opening the candidate must preserve it and install fences.
    const legacy = new DatabaseSync(file);
    legacy.exec('CREATE TABLE hermes_sessions (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
    legacy.prepare('INSERT INTO hermes_sessions VALUES (?, ?)').run(key, JSON.stringify(session())); legacy.close();
    const owner = new AsyncConnectorOwner({ file }, silence), facade = new AsyncHermesHistory(owner);
    try {
      await owner.open(); const snapshot = (await facade.snapshot(key))!; staleDigest = snapshot.digest;
      const committed = (await facade.commit(snapshot, largeRows()))!; assert.ok(committed);
      assert.equal(await facade.commit(snapshot, []), null);
      assert.deepEqual((await facade.projection(committed))?.map(m => m.text), largeRows().map(m => m.text));
    } finally { await owner.close(); }
    const reopened = new AsyncConnectorOwner({ file }, silence), after = new AsyncHermesHistory(reopened);
    try {
      await reopened.open(); const snapshot = (await after.snapshot(key))!;
      assert.notEqual(snapshot.digest, staleDigest);
      assert.deepEqual((await after.projection(snapshot))?.map(m => m.text), largeRows().map(m => m.text));
      assert.equal(await reopened.command('hermesHistoryCommit', { key, digest: staleDigest, rows: [] }), null);
    } finally { await reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

class Fake extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { return Promise.resolve(0); }
  reply(value: unknown) { const request = this.messages[0]!; this.emit('message', { id: request.id, kind: request.kind, ok: true, body: JSON.stringify(value) }); }
}
for (const change of ['key', 'digest', 'next'] as const)
  test(`foreign history ${change} reply retires original owner without accepting partial pages`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hermes-history-foreign-')), fake = new Fake();
    const owner = new AsyncConnectorOwner({ file: join(directory, 'original.sqlite') }, silence, () => fake as unknown as Worker);
    try {
      fake.emit('message', { kind: 'ready' }); const digest = 'a'.repeat(64);
      const work = owner.command('hermesHistoryProjection', { key, digest, offset: 0, limit: 64 });
      const rejected = assert.rejects(work, /connector_storage_unavailable/); await tick();
      fake.reply({ key, digest, large: null, messages: [{ id: 'm', sessionKey: key, role: 'assistant', text: 'private', createdAt: 1 }], next: 1,
        [change]: change === 'key' ? 'hermes:foreign' : change === 'digest' ? 'b'.repeat(64) : 2 });
      await rejected;
      assert.equal(fake.messages.length, 1, 'foreign ACK must not issue a recovery or replay command');
      await assert.rejects(owner.command('hermesHistorySnapshot', { key }), /connector_storage_unavailable/);
    } finally {
      const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
      rmSync(directory, { recursive: true, force: true });
    }
  });

for (const change of ['key', 'digest', 'index', 'offset', 'next', 'data'] as const)
  test(`foreign large-message ${change} ACK retires owner without retry or partial publication`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hermes-history-part-foreign-')), fake = new Fake();
    const owner = new AsyncConnectorOwner({ file: join(directory, 'original.sqlite') }, silence, () => fake as unknown as Worker);
    try {
      fake.emit('message', { kind: 'ready' }); const digest = 'a'.repeat(64);
      const work = owner.command('hermesHistoryMessagePart', { key, digest, index: 1, offset: 0 });
      const rejected = assert.rejects(work, /connector_storage_unavailable/); await tick();
      fake.reply({ key, digest, index: 1, offset: 0, data: Buffer.from('original').toString('base64'), total: 700_000, next: 8,
        [change]: change === 'key' ? 'hermes:foreign' : change === 'digest' ? 'b'.repeat(64)
          : change === 'data' ? '' : change === 'index' ? 2 : change === 'offset' ? 1 : 9 });
      await rejected; assert.equal(fake.messages.length, 1);
      await assert.rejects(owner.command('hermesHistorySnapshot', { key }), /connector_storage_unavailable/);
    } finally {
      const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
      rmSync(directory, { recursive: true, force: true });
    }
  });

test('history logs contain fixed steps and counts, no private text, identity or path', async () => {
  const f = fixture(), logs: string[] = [];
  try {
    await refreshHermesHistory(key, f.facade, { attach: async () => 'private-live', history: async () => rows, current: () => true },
      () => {}, new PerformanceDiagnostics(line => logs.push(JSON.stringify(line))));
    const text = logs.join('\n'); assert.match(text, /hermes-history-sync/);
    for (const secret of ['private input', 'private reply', key, 'private-live', 'Original', '/home/']) assert.equal(text.includes(secret), false);
  } finally { f.close(); }
});
