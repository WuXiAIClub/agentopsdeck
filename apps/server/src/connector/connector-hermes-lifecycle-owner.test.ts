import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage } from '@agentopsdeck/shared';
import { DeckStore } from '../projection/deck-store.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createConnectorOwnerCommands, type ConnectorOwnerCommands, type ConnectorOwnerKind } from './connector-owner-domain.js';
import { AsyncHermesLifecycle } from './async-hermes-lifecycle.js';
import { validConnectorHermesLifecycleInput } from './connector-hermes-lifecycle-domain.js';
import { hermesSessionView } from '../hermes/session-view.js';
import type { HermesExecution } from '../hermes/journal.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const key = 'hermes:original', silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const message = (id: string, text = id): ChatMessage => ({ id, sessionKey: key, text, role: 'assistant', createdAt: 1 });
const execution = (phase: HermesExecution['phase'] = 'running', id = 'execution'): HermesExecution =>
  ({ key, id, live: 'private-live', epoch: 'private-epoch', phase, members: ['input'], at: 1, updated: 2, row: 1 });
function fixture() {
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.hermesJournal.save({ key, title: 'Original', stored: 'private-stored', started: true, messages: [message('old')] });
  const command = createConnectorOwnerCommands(store), projection = new DeckStore(), calls: ConnectorOwnerKind[] = [];
  const owner = { command: async <K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']) => { calls.push(kind); return command(kind, input); } };
  const lifecycle = new AsyncHermesLifecycle({ owner, projection, connected: () => false, diagnostics: silence });
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, command, owner, projection, calls, lifecycle, db,
    close() { command.dispose(); store.close(); } };
}

test('Hermes lifecycle constructor has no effects; single restore freezes original execution and tools without replay', async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.calls, []); assert.equal(f.lifecycle.recovered, false);
    const call: ChatMessage = { ...message('hermes-tool:execution:call'), turnId: 'execution', role: 'tool', toolName: 'private-tool', toolCallId: 'call', toolPhase: 'call' };
    f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, messages: [call] });
    f.store.turns.enqueue('hermes', { id: 'input', sessionKey: key, createdAt: 1, payload: { actorId: 'original', text: 'private input', images: [] } });
    assert.equal(f.store.turns.startBatch('hermes', key, ['input']), true);
    f.store.hermesJournal.update(execution());
    const first = f.lifecycle.restore(); assert.equal(f.lifecycle.restore(), first); await first;
    assert.equal(f.lifecycle.recovered, true); assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown');
    assert.equal(f.store.turns.head('hermes', key)?.state, 'outcome_unknown');
    assert.equal(f.projection.getSession(key)?.status, 'unknown');
    assert.equal(f.projection.getMessages(key).filter(m => m.toolPhase === 'result').length, 1);
    await f.lifecycle.restore(); assert.equal(f.projection.getMessages(key).filter(m => m.toolPhase === 'result').length, 1);
    assert.ok(f.calls.every(kind => ['hermesRecoveryPage', 'hermesLifecycleRepairTools', 'hermesLifecyclePage', 'hermesLifecycleRead', 'hermesLifecycleHistoryPage'].includes(kind)));
  } finally { await f.lifecycle.close(); f.close(); }
});

for (const phase of ['completed', 'failed', 'interrupted', 'unknown'] as const) test(`Hermes lifecycle repairs old ${phase} tool outcomes once and preserves original state`, async () => {
  const f = fixture();
  try {
    f.store.hermesJournal.update(execution(phase));
    f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, messages: [{ ...message('hermes-tool:execution:call'), role: 'tool',
      turnId: 'execution', toolCallId: 'call', toolName: 'Original', toolPhase: 'call' }] });
    await f.lifecycle.restore(); assert.equal(f.store.hermesJournal.current(key)?.phase, phase);
    const one = f.store.hermesJournal.session(key)!.messages;
    assert.equal(one.filter(m => m.toolPhase === 'result').length, 1);
    await f.command('hermesLifecycleRepairTools', { key, after: 0, limit: 64 });
    assert.deepEqual(f.store.hermesJournal.session(key)!.messages, one);
  } finally { await f.lifecycle.close(); f.close(); }
});

test('Hermes legacy tool repair is one original transaction, skips live executions and pending deletion', async () => {
  const f = fixture();
  try {
    f.store.hermesJournal.update(execution('completed'));
    f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, messages: [{ ...message('hermes-tool:execution:call'), role: 'tool',
      turnId: 'execution', toolCallId: 'call', toolPhase: 'call' }] });
    f.db.exec("CREATE TRIGGER lifecycle_test_failure BEFORE UPDATE ON hermes_sessions BEGIN SELECT RAISE(ABORT, 'private storage failure'); END");
    await assert.rejects(f.command('hermesLifecycleRepairTools', { key, after: 0, limit: 64 }));
    assert.equal(f.store.hermesJournal.session(key)!.messages.length, 1);
    f.db.exec('DROP TRIGGER lifecycle_test_failure'); f.store.hermesJournal.update(execution('running'));
    await f.command('hermesLifecycleRepairTools', { key, after: 0, limit: 64 }); assert.equal(f.store.hermesJournal.session(key)!.messages.length, 1);
    f.store.hermesJournal.update(execution('completed')); f.store.hermesJournal.beginDeletion(key);
    await f.command('hermesLifecycleRepairTools', { key, after: 0, limit: 64 }); assert.equal(f.store.hermesJournal.session(key)!.messages.length, 1);
  } finally { await f.lifecycle.close(); f.close(); }
});

test('Hermes startup freezes pending deletion execution without replay or writing through its history fence', async () => {
  const f = fixture();
  try {
    f.store.turns.enqueue('hermes', { id: 'input', sessionKey: key, createdAt: 1, payload: { actorId: 'original', text: 'Input' } });
    assert.equal(f.store.turns.startBatch('hermes', key, ['input']), true);
    f.store.hermesJournal.update(execution());
    f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, messages: [{ ...message('hermes-tool:execution:call'),
      role: 'tool', turnId: 'execution', toolCallId: 'call', toolPhase: 'call' }] });
    const original = f.store.hermesJournal.session(key)!;
    f.store.hermesJournal.beginDeletion(key);
    await f.lifecycle.restore();
    assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown');
    assert.equal(f.store.turns.head('hermes', key)?.state, 'outcome_unknown');
    assert.equal(f.store.hermesJournal.deletion(key), 'pending');
    assert.deepEqual(f.store.hermesJournal.session(key), original);
    assert.equal(f.projection.getSession(key)?.status, 'unknown');
    assert.equal(await f.command('hermesHistorySnapshot', { key }), null);
  } finally { await f.lifecycle.close(); f.close(); }
});

for (const during of ['messages', 'summary'] as const) test(`Hermes lifecycle close reentered by ${during} publication prevents any later effect`, async () => {
  const f = fixture(); let closed: Promise<void> | undefined, summaries = 0;
  const lifecycle = new AsyncHermesLifecycle({ owner: f.owner, connected: () => false, diagnostics: silence,
    projection: { getMessages: k => f.projection.getMessages(k), removeSession: k => f.projection.removeSession(k),
      replaceMessages: (...args) => { f.projection.replaceMessages(...args); if (during === 'messages') closed = lifecycle.close(); },
      upsertSession: s => { summaries++; f.projection.upsertSession(s); if (during === 'summary') closed = lifecycle.close(); } } });
  try {
    await assert.rejects(lifecycle.restore()); await closed;
    assert.equal(lifecycle.recovered, false); assert.equal(summaries, during === 'messages' ? 0 : 1);
  } finally { await lifecycle.close(); f.close(); }
});

test('Hermes lifecycle pages old executions, sessions and accepted tombstones; pending deletion retains cached history', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 65; i++) {
      f.store.hermesJournal.save({ key: `hermes:page-${String(i).padStart(3, '0')}`, title: 'Page', stored: `stored-${i}`, started: false, messages: [] });
      f.store.hermesJournal.update(execution('completed', `old-${i}`));
    }
    const tombstone = 'hermes:deleted';
    f.store.hermesJournal.save({ key: tombstone, title: 'Deleted', stored: 'deleted', started: false, messages: [] });
    f.store.hermesJournal.beginDeletion(tombstone); f.store.hermesJournal.finishDeletion(tombstone);
    f.projection.upsertSession(hermesSessionView(tombstone, 'Deleted', undefined, true));
    f.store.hermesJournal.beginDeletion(key);
    await f.lifecycle.restore();
    assert.equal(f.projection.getSession(tombstone), undefined);
    assert.deepEqual(f.projection.getMessages(key).map(m => m.text), ['old']); assert.equal(f.projection.getSession(key)?.status, 'unknown');
    assert.ok(f.calls.filter(k => k === 'hermesLifecyclePage').length >= 2);
    assert.equal(await f.command('hermesHistorySnapshot', { key }), null, 'cached observation is not native attach authority');
    const page = await f.command('hermesLifecyclePage', { after: '', limit: 64 }); assert.equal(page.length, 64);
    assert.ok(page.includes(tombstone));
  } finally { await f.lifecycle.close(); f.close(); }
});

test('Hermes lifecycle repairs more than one execution page without duplicating old tool results', async () => {
  const f = fixture();
  try {
    const calls: ChatMessage[] = [];
    for (let i = 0; i < 65; i++) {
      const id = `old-${i}`;
      f.store.hermesJournal.update(execution('completed', id));
      calls.push({ ...message(`hermes-tool:${id}:call`), role: 'tool', turnId: id, toolCallId: id, toolPhase: 'call' });
    }
    f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, messages: calls });
    await f.lifecycle.restore();
    assert.equal(f.calls.filter(k => k === 'hermesLifecycleRepairTools').length, 2);
    assert.equal(f.projection.getMessages(key).filter(m => m.toolPhase === 'result').length, 65);
    await f.command('hermesLifecycleRepairTools', { key, after: 0, limit: 64 });
    assert.equal(f.store.hermesJournal.session(key)!.messages.length, 130);
  } finally { await f.lifecycle.close(); f.close(); }
});

test('Hermes lifecycle large UTF-8 history reassembles bytes, while metadata never returns messages or native identity', async () => {
  const f = fixture();
  try {
    const text = '私密🙂'.repeat(110_000);
    f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, messages: [message('large', text)] });
    const snapshot = await f.command('hermesLifecycleRead', { key });
    assert.deepEqual(Object.keys(snapshot).sort(), ['deletion', 'digest', 'execution', 'key', 'title']);
    assert.doesNotMatch(JSON.stringify(snapshot), /private-stored|私密/);
    await f.lifecycle.restore(); assert.equal(f.projection.getMessages(key)[0]!.text, text);
    assert.ok(f.calls.includes('hermesLifecycleHistoryPart'));
  } finally { await f.lifecycle.close(); f.close(); }
});

for (const change of ['history', 'aba', 'deletion'] as const) test(`Hermes lifecycle ${change} during history read discards partial publication`, async () => {
  const f = fixture(); let churn = false, publications = 0;
  const lifecycle = new AsyncHermesLifecycle({ owner: { command: async (kind, input) => {
    const value = await f.owner.command(kind, input);
    if (churn && kind === 'hermesLifecycleHistoryPage') {
      const original = f.store.hermesJournal.session(key)!;
      if (change === 'deletion') { if (!f.store.hermesJournal.deletion(key)) f.store.hermesJournal.beginDeletion(key); else f.db.prepare('UPDATE hermes_deletions SET state = state WHERE key = ?').run(key); }
      else { f.store.hermesJournal.save({ ...original, title: 'Changed' }); if (change === 'aba') f.store.hermesJournal.save(original); }
    }
    return value;
  } }, projection: { ...f.projection, getMessages: k => f.projection.getMessages(k), removeSession: k => f.projection.removeSession(k),
    upsertSession: s => f.projection.upsertSession(s), replaceMessages: (...args) => { publications++; return f.projection.replaceMessages(...args); } }, connected: () => false, diagnostics: silence });
  try {
    await lifecycle.restore(); const initial = publications; churn = true;
    await assert.rejects(lifecycle.refresh(key)); assert.equal(publications, initial);
    assert.deepEqual(f.projection.getMessages(key).map(m => m.text), ['old']);
  } finally { await lifecycle.close(); f.close(); }
});

test('Hermes lifecycle coalesces a same-key successor and directory scan begun after late observation', async () => {
  const f = fixture(); let block = false, entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lifecycle = new AsyncHermesLifecycle({ owner: { command: async (kind, input) => {
    const result = await f.owner.command(kind, input);
    if (block && !entered && kind === 'hermesLifecycleRead') { entered = true; await gate; }
    return result;
  } }, projection: f.projection, connected: () => false, diagnostics: silence });
  try {
    await lifecycle.restore(); block = true;
    const first = lifecycle.refreshProjection(); while (!entered) await tick();
    f.store.hermesJournal.save({ ...f.store.hermesJournal.session(key)!, messages: [message('new')] });
    const second = lifecycle.refreshProjection(); assert.equal(first, second);
    const a = lifecycle.refresh(key), b = lifecycle.refresh(key); assert.equal(a, b);
    release(); await Promise.all([first, a]); assert.equal(f.projection.getMessages(key)[0]!.text, 'new');
    assert.ok(f.calls.filter(k => k === 'hermesLifecyclePage').length >= 3);
  } finally { release(); await lifecycle.close(); f.close(); }
});

test('Hermes lifecycle close drains physically pending owner work, publishes nothing after stop, never closes owner', async () => {
  const f = fixture(); let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lifecycle = new AsyncHermesLifecycle({ owner: { command: async (kind, input) => {
    entered = true; await gate; return f.owner.command(kind, input);
  } }, projection: f.projection, connected: () => false, diagnostics: silence });
  try {
    const work = lifecycle.restore(); void work.catch(() => {}); while (!entered) await tick();
    let drained = false; const close = lifecycle.close().then(() => { drained = true; });
    assert.equal(lifecycle.close(), lifecycle.close()); await tick(); assert.equal(drained, false);
    await assert.rejects(lifecycle.refresh(key)); release(); await close; await assert.rejects(work);
    assert.equal(f.projection.getSession(key), undefined);
    assert.equal((await f.command('hermesLifecycleRead', { key })).title, 'Original');
  } finally { release(); await lifecycle.close(); f.close(); }
});

test('Hermes lifecycle close before deferred restore forbids all effects; failed initialization is not retried', async () => {
  const f = fixture();
  try {
    const work = f.lifecycle.restore(); void work.catch(() => {}); await f.lifecycle.close(); await assert.rejects(work); assert.deepEqual(f.calls, []);
    let count = 0;
    const failed = new AsyncHermesLifecycle({ owner: { command: async () => { count++; throw Error('private DB'); } }, projection: f.projection, connected: () => false, diagnostics: silence });
    const first = failed.restore(); await assert.rejects(first); assert.equal(failed.restore(), first); await assert.rejects(failed.restore());
    assert.equal(count, 1); assert.equal(failed.recovered, false); await failed.close();
  } finally { f.close(); }
});

test('Hermes lifecycle rejects forged authority, foreign reply and nonadvancing history without publication', async () => {
  assert.equal(validConnectorHermesLifecycleInput('hermesLifecycleRead', { key, actorId: 'forged' }), false);
  assert.equal(validConnectorHermesLifecycleInput('hermesLifecycleRepairTools', { key, after: -1, limit: 64 }), false);
  for (const mismatch of ['key', 'cursor', 'digest'] as const) {
    const f = fixture();
    const lifecycle = new AsyncHermesLifecycle({ owner: { command: async (kind, input) => {
      const value = await f.owner.command(kind, input);
      if (kind === 'hermesLifecycleRead' && mismatch === 'key') return { ...value as object, key: 'hermes:foreign' } as typeof value;
      if (kind === 'hermesLifecycleHistoryPage') return { ...value as object, ...(mismatch === 'cursor' ? { next: 0 } : { digest: '0'.repeat(64) }) } as typeof value;
      return value;
    } }, projection: f.projection, connected: () => false, diagnostics: silence });
    try { await assert.rejects(lifecycle.restore()); assert.equal(f.projection.getSession(key), undefined); }
    finally { await lifecycle.close(); f.close(); }
  }
});

for (const phase of ['starting', 'running', 'completed', 'failed', 'interrupted', 'unknown'] as const) test(`Hermes shared ${phase} wire mapping preserves original runtime dimensions`, () => {
  const original = execution(phase), view = hermesSessionView(key, 'Original', original, true);
  assert.equal(view.runtime!.phase, phase); assert.equal(view.runtime!.turnId, original.id);
  assert.equal(view.hasActiveRun, phase === 'starting' || phase === 'running');
  assert.equal(hermesSessionView(key, 'Original', original, false, true).status, 'unknown');
  assert.equal(hermesSessionView(key, 'Original', original, false, true).runtime!.threadActivity, 'unknown');
});

test('Hermes lifecycle original worker restores persisted unknown and deletion after physical close/reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-lifecycle-')), file = join(root, 'connector.sqlite');
  let owner: AsyncConnectorOwner | undefined, lifecycle: AsyncHermesLifecycle | undefined;
  try {
    const store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    store.hermesJournal.save({ key, stored: 'original-stored', title: 'Original', started: true, messages: [message('retained')] });
    store.hermesJournal.update(execution()); store.close();
    owner = new AsyncConnectorOwner({ file }, silence); const projection = new DeckStore();
    lifecycle = new AsyncHermesLifecycle({ owner, projection, connected: () => false, diagnostics: silence });
    await lifecycle.restore(); assert.equal(projection.getSession(key)?.status, 'unknown'); await lifecycle.close(); await owner.closeForShutdown();
    owner = new AsyncConnectorOwner({ file }, silence); const reopened = new DeckStore();
    lifecycle = new AsyncHermesLifecycle({ owner, projection: reopened, connected: () => false, diagnostics: silence });
    await lifecycle.restore(); assert.equal(reopened.getSession(key)?.runtime!.phase, 'unknown');
    assert.equal(reopened.getMessages(key)[0]!.text, 'retained');
  } finally { await lifecycle?.close(); await owner?.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const broken of [false, true]) test(`Hermes lifecycle logs bounded redacted failures independently of sink failure=${broken}`, async () => {
  const projection = new DeckStore(), lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { if (broken) throw Error('private sink'); lines.push(line); });
  for (let i = 0; i < 256; i++) {
    diagnostics.start('hermes-journal-change').finish(false);
    diagnostics.start('hermes-journal-change').finish(true);
  }
  const lifecycle = new AsyncHermesLifecycle({ owner: { command: async () => { throw Error('private-live private-stored private input'); } },
    projection, connected: () => false, diagnostics });
  await assert.rejects(lifecycle.restore()); await lifecycle.close();
  const events = diagnostics.snapshot().events.filter(e => e.operation === 'hermes-lifecycle');
  assert.ok(events.some(e => e.step === 1 && e.category === 'failed'));
  assert.ok(events.some(e => e.step === 4 && e.category === 'routine'));
  assert.doesNotMatch(JSON.stringify(events) + lines.join(''), /private-live|private-stored|private input|private sink/);
});
