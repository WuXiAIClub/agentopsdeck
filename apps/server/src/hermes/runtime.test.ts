import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TurnQueue } from '../commands/turn-queue.js';
import { DeckStore } from '../projection/deck-store.js';
import { HermesJournal } from './journal.js';
import { HermesRuntime, type HermesTransport, type HermesToolPort } from './runtime.js';
import type { HermesEvent } from './protocol.js';
import { HermesRemoteError } from './rpc-peer.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

export const config = { enabled: true, executable: '/usr/bin/python3', sourceDirectory: '/isolated/hermes',
  homeDirectory: '/isolated/home', workspace: '/isolated/workspace', startupTimeoutMs: 1000 };

export function fixture(db = new DatabaseSync(':memory:'), tools?: HermesToolPort) {
  const turns = new TurnQueue(db), journal = new HermesJournal(db), store = new DeckStore();
  let emit!: (event: HermesEvent) => void, lost!: () => void;
  let sequence = 0, serial = 0, allowed = true;
  const rows: { row_id: number; role: string; text: string; timestamp: number }[] = [];
  const submits: string[] = [], calls: string[] = [];
  let submit: (() => Promise<unknown>) | undefined;
  let history: (() => Promise<unknown>) | undefined;
  let snapshot: (() => Promise<unknown>) | undefined;
  let closeSession: (() => Promise<unknown>) | undefined;
  let deleteSession: ((params: unknown) => Promise<unknown>) | undefined;
  const native: HermesTransport = { ready: false, epoch: 'epoch',
    async start() { this.ready = true; }, async close() { this.ready = false; },
    async request(method, params) {
      calls.push(method);
      if (method === 'session.create') return { session_id: 'live', stored_session_id: 'stored' };
      if (method === 'session.resume') return { session_id: 'live', session_key: 'stored', status: 'idle', running: false };
      if (method === 'session.activate') return snapshot ? snapshot() : { session_id: 'live', session_key: 'stored', running: false, status: 'idle' };
      if (method === 'session.history') return history ? history() : { messages: rows.map(r => ({ ...r })) };
      if (method === 'prompt.submit') {
        const text = (params as {text:string}).text; submits.push(text);
        rows.push({ row_id: ++serial, role: 'user', text, timestamp: Date.now() / 1000 });
        return submit ? submit() : { status: 'streaming' };
      }
      if (method === 'session.interrupt') return { interrupted: true };
      if (method === 'session.close') return closeSession ? closeSession() : { closed: true };
      if (method === 'session.delete') return deleteSession ? deleteSession(params) : { deleted: (params as {session_id:string}).session_id };
      throw new Error('Unexpected fixture method: ' + method);
    } };
  const runtime = new HermesRuntime({ config, journal, turns, store, ...(tools ? { tools } : {}), authorize: () => allowed }, (event, disconnect) => {
    emit = event; lost = disconnect; return native;
  });
  const event = (type: string, payload: Record<string, unknown> = {}, seq = ++sequence) => emit({ type, payload, sessionId: 'live', seq });
  return { db, turns, journal, store, runtime, native, calls, submits, rows, event,
    setSubmit(fn: typeof submit) { submit = fn; }, setHistory(fn: typeof history) { history = fn; },
    setClose(fn: typeof closeSession) { closeSession = fn; }, setDelete(fn: typeof deleteSession) { deleteSession = fn; },
    setSnapshot(fn: typeof snapshot) { snapshot = fn; }, globalEvent(type: string, payload: Record<string, unknown>) { emit({ type, payload, sessionId: undefined, seq: undefined }); },
    revoke() { allowed = false; }, disconnect() { native.ready = false; lost(); },
    async create() { await runtime.start(); return (await runtime.createSession('Test', () => {}, () => {})).key; },
    send(key: string, text: string, actorId = 'owner') { return runtime.send(key, text, { actorId, accept: () => () => {} }); },
    complete(text = 'reply') {
      rows.push({ row_id: ++serial, role: 'assistant', text, timestamp: Date.now() / 1000 });
      event('message.complete', { status: 'complete' });
    },
    async close() { await runtime.close(); db.close(); },
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.ok(check(), 'runtime did not reach expected state');
}

function deferredToolFixture() {
  const pending: { commit(): void; fail(): void }[] = [];
  const f = fixture(undefined, { tool(execution, observation) {
    return new Promise((resolve, reject) => pending.push({
      commit: () => resolve(f.journal.observeTool(execution, observation)),
      fail: () => reject(Error('private-tool-error')),
    }));
  } });
  return { ...f, pending };
}

for (const failure of ['reject', 'throw', 'read'] as const) test(`disconnect isolates ${failure} storage failure and preserves a local execution fence`, async () => {
  const f = fixture();
  const unknown = f.journal.unknown.bind(f.journal), session = f.journal.session.bind(f.journal);
  try {
    const key = await f.create(); await f.send(key, 'original');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'pending', name: 'private' });
    f.journal.unknown = () => { if (failure === 'reject') return false; throw Error('private-db-failure'); };
    if (failure === 'read') f.journal.session = () => { throw Error('private-read-failure'); };
    assert.doesNotThrow(() => f.disconnect());
    assert.equal(f.store.getSession(key)?.runtime?.phase, 'unknown');
    assert.equal(f.store.getSession(key)?.status, 'unknown');
    assert.equal(f.journal.current(key)?.phase, 'running');
    assert.equal(f.store.getMessages(key).filter(m => m.toolPhase === 'result').length, 0);
    f.native.ready = true;
    f.complete('late');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.journal.current(key)?.phase, 'running'); assert.equal(f.submits.length, 1);
    assert.equal(f.store.getMessages(key).some(m => m.text === 'late'), false);
    await f.runtime.close(); assert.equal(f.native.ready, false);
  } finally { f.journal.unknown = unknown; f.journal.session = session; await f.close(); }
});

test('disconnect publishes original atomic unknown tool facts without a second journal save', async () => {
  const f = fixture();
  try {
    const key = await f.create(); await f.send(key, 'original');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'pending', name: 'private' });
    const save = f.journal.save.bind(f.journal); let saves = 0;
    f.journal.save = value => { saves++; save(value); };
    f.disconnect();
    assert.equal(saves, 1);
    const result = f.journal.session(key)?.messages.find(m => m.toolPhase === 'result');
    assert.equal(result?.status, 'outcome_unknown');
    assert.deepEqual(f.store.getMessages(key).find(m => m.toolPhase === 'result'), result);
    f.disconnect(); assert.equal(saves, 1); assert.equal(f.submits.length, 1);
  } finally { await f.close(); }
});

for (const rejects of [false, true]) test(`close is single-flight and drains accepted tool ACK even when native close rejects=${rejects}`, async () => {
  const f = deferredToolFixture(), original = Error('private-native-close');
  let closes = 0, finished = false;
  try {
    const key = await f.create(); await f.send(key, 'original');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'late' }); await until(() => f.pending.length === 1);
    f.native.close = async () => { closes++; f.native.ready = false; if (rejects) throw original; };
    const close = f.runtime.close(), second = f.runtime.close();
    assert.equal(second, close); assert.equal(f.runtime.ready, false);
    const outcome = close.then(() => { finished = true; return undefined; }, error => { finished = true; return error; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closes, 1); assert.equal(finished, false);
    assert.equal(f.journal.current(key)?.phase, 'unknown');
    f.pending[0]!.commit();
    assert.equal(await outcome, rejects ? original : undefined);
    assert.equal(finished, true); assert.equal(closes, 1);
    assert.equal(f.store.getMessages(key).some(m => m.toolPhase === 'call'), false);
    assert.equal(f.submits.length, 1);
  } finally { await f.runtime.close().catch(() => {}); f.db.close(); }
});

for (const sinkFails of [false, true]) test(`protection and close evidence is redacted and observational, sink failure=${sinkFails}`, async () => {
  const f = fixture(), rows: string[] = [], start = performanceDiagnostics.start;
  const diagnostics = new PerformanceDiagnostics(line => { if (sinkFails) throw Error('PRIVATE sink'); rows.push(line); }, () => 0);
  try {
    const key = await f.create(); await f.send(key, 'PRIVATE prompt');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'PRIVATE tool', name: 'PRIVATE name' });
    performanceDiagnostics.start = operation => diagnostics.start(operation);
    assert.doesNotThrow(() => f.disconnect());
    await f.runtime.close();
    const events = diagnostics.snapshot().events;
    assert.ok(events.some(e => e.operation === 'hermes-execution-protection' && e.settled === 1));
    assert.ok(events.some(e => e.operation === 'hermes-runtime-close' && e.settled === 1));
    assert.doesNotMatch(JSON.stringify(events) + rows.join(''), /PRIVATE|hermes:|"stored"|"live"|"epoch"/);
    assert.equal(f.store.getSession(key)?.runtime?.phase, 'unknown');
  } finally { performanceDiagnostics.start = start; await f.close(); }
});

for (const action of ['pause', 'close'] as const) test(`synchronous tool port ${action} reentry drains the original physical ACK`, async () => {
  let release: (() => void) | undefined, drained = false, drain: Promise<void> | undefined;
  const f = fixture(undefined, { tool(execution, observation) {
    drain = action === 'pause' ? f.runtime.pauseQueueWorker().drained : f.runtime.close();
    void drain.then(() => { drained = true; });
    const message = f.journal.observeTool(execution, observation);
    return new Promise(resolve => { release = () => resolve(message); });
  } });
  try {
    const key = await f.create(); await f.send(key, 'hello');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'one' }); await until(() => !!release);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false, 'port reentry must not acknowledge physical drain early');
    release!(); await drain; assert.equal(drained, true);
  } finally { release?.(); await f.close(); }
});

test('projection callback disconnect cannot publish a late running tool activity', async () => {
  const f = fixture();
  try {
    const key = await f.create(); await f.send(key, 'hello');
    await until(() => f.journal.current(key)?.phase === 'running');
    const add = f.store.addMessage.bind(f.store); let observed = false;
    f.store.addMessage = message => {
      add(message);
      if (message.toolPhase === 'call' && !observed) { observed = true; f.disconnect(); }
    };
    f.event('tool.start', { tool_id: 'one' });
    assert.equal(f.journal.current(key)?.phase, 'unknown');
    assert.equal(f.store.getActivity(key).some(item => item.status === 'running'), false);
  } finally { await f.close(); }
});

test('awaitable tool facts serialize call/result before projection and terminal history settlement', async () => {
  const f = deferredToolFixture();
  try {
    const key = await f.create(); await f.send(key, 'hello');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'one', name: 'terminal', args: { secret: 'private' } });
    f.event('tool.complete', { tool_id: 'one', result: 'private' });
    await until(() => f.pending.length === 1);
    assert.equal(f.pending.length, 1);
    assert.equal(f.store.getMessages(key).some(m => m.role === 'tool'), false);
    const before = f.calls.length; f.complete();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.journal.current(key)?.phase, 'running');
    assert.equal(f.calls.slice(before).includes('session.history'), false);
    f.pending[0]!.commit(); await until(() => f.pending.length === 2);
    assert.equal(f.store.getMessages(key).filter(m => m.role === 'tool').length, 1);
    f.pending[1]!.commit(); await until(() => f.journal.current(key)?.phase === 'completed');
    const messages = f.store.getMessages(key).filter(m => m.role === 'tool');
    assert.deepEqual(messages.map(m => [m.toolPhase, m.toolName]), [['call', 'terminal'], ['result', 'terminal']]);
    assert.equal(JSON.stringify(messages).includes('private'), false);
    assert.equal(f.submits.length, 1);
  } finally { await f.close(); }
});

test('explicit history refresh waits original tool commit before taking a snapshot', async () => {
  const f = deferredToolFixture();
  try {
    const key = await f.create(); await f.send(key, 'hello');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'one', name: 'terminal' });
    const before = f.calls.filter(m => m === 'session.history').length;
    const refreshing = f.runtime.refreshSession(key);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(m => m === 'session.history').length, before);
    f.pending[0]!.commit(); await refreshing;
    assert.equal(f.store.getMessages(key).filter(m => m.role === 'tool').length, 1);
  } finally { await f.close(); }
});

test('failed tool ACK protects original execution and terminal does not replay or unlock', async () => {
  const f = deferredToolFixture();
  try {
    const key = await f.create(); await f.send(key, 'hello');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'one' }); f.complete();
    await until(() => f.pending.length === 1); f.pending[0]!.fail();
    await until(() => f.journal.current(key)?.phase === 'unknown');
    assert.equal(f.journal.canStart(key), false);
    assert.equal(f.store.getMessages(key).some(m => m.role === 'tool'), false);
    assert.equal(f.submits.length, 1);
  } finally { await f.close(); }
});

for (const action of ['disconnect', 'close', 'pause'] as const) test(`tool physical ACK is drained and fenced on ${action}`, async () => {
  const f = deferredToolFixture(); let closed = false;
  try {
    const key = await f.create(); await f.send(key, 'hello');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'one' });
    await until(() => f.pending.length === 1);
    let drained = false;
    if (action === 'disconnect') f.disconnect();
    const drain = action === 'close' ? f.runtime.close() : f.runtime.pauseQueueWorker().drained;
    void drain.then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
    f.pending[0]!.commit(); await drain;
    assert.equal(f.store.getMessages(key).some(m => m.role === 'tool'), action === 'pause');
    if (action !== 'pause') assert.equal(f.journal.current(key)?.phase, 'unknown');
    assert.equal(f.submits.length, 1);
    if (action === 'close') { f.db.close(); closed = true; }
  } finally { if (!closed) await f.close(); }
});

test('bounded pending tool events fail closed and never start queued writes after protection', async () => {
  const f = deferredToolFixture();
  try {
    const key = await f.create(); await f.send(key, 'hello');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 't-0' });
    await until(() => f.pending.length === 1);
    for (let i = 1; i < 65; i++) f.event('tool.start', { tool_id: `t-${i}` });
    assert.equal(f.journal.current(key)?.phase, 'unknown'); assert.equal(f.pending.length, 1);
    f.pending[0]!.commit(); await f.runtime.pauseQueueWorker().drained;
    assert.equal(f.pending.length, 1); assert.equal(f.submits.length, 1);
  } finally { await f.close(); }
});

test('Hermes deletion closes the exact live session, deletes the stored identity, persists cleanup and ACKs once', async () => {
  const f = fixture(); let acknowledgements = 0;
  try {
    const key = await f.create(); await f.send(key, 'hello');
    await until(() => f.journal.current(key)?.phase === 'running');
    assert.equal(f.store.getSession(key)?.runtime?.operation, 'message');
    f.complete();
    await until(() => f.journal.current(key)?.phase === 'completed');
    assert.equal(f.store.getSession(key)?.runtime?.operation, 'message');
    f.setDelete(async params => { assert.deepEqual(params, { session_id: 'stored' }); return { deleted: 'stored' }; });
    await f.runtime.remove(key, () => {}, () => { acknowledgements++; });
    assert.deepEqual(f.calls.slice(-3), ['session.activate', 'session.close', 'session.delete']);
    assert.equal(acknowledgements, 1); assert.equal(f.journal.deletion(key), 'accepted');
    assert.equal(f.journal.session(key), undefined); assert.deepEqual(f.journal.executions(key), []);
    assert.equal(f.store.getSession(key), undefined); assert.deepEqual(f.store.getMessages(key), []);
    await assert.rejects(f.send(key, 'no resurrection'));
    await assert.rejects(f.runtime.remove(key, () => {}, () => {}));
    assert.equal(f.calls.filter(c => c === 'session.delete').length, 1);
    // Recovered old projection must be removed even if the first cleanup failed.
    f.store.upsertSession({ sessionKey: key, source: 'hermes', agentId: 'hermes', title: 'stale projection', status: 'idle' });
    await f.runtime.close();
    const recovered = new HermesRuntime({ config, journal: new HermesJournal(f.db), turns: f.turns, store: f.store, authorize: () => true }, () => f.native);
    assert.equal(f.store.getSession(key), undefined); await recovered.close();
  } finally { await f.close(); }
});

test('Hermes empty session accepts typed native absence, not a generic error', async () => {
  for (const typed of [true, false]) {
    const f = fixture();
    try {
      const key = await f.create();
      f.setDelete(async () => { throw typed ? new HermesRemoteError(4007) : new Error('session not found (4007)'); });
      const deletion = f.runtime.remove(key, () => {}, () => {});
      if (typed) { await deletion; assert.equal(f.journal.deletion(key), 'accepted'); }
      else { await assert.rejects(deletion, /not be fully confirmed/); assert.equal(f.journal.deletion(key), 'pending'); }
    } finally { await f.close(); }
  }
});

test('Hermes deletion after restart uses stored identity without mounting and preserves other sessions', async () => {
  const f = fixture();
  try {
    const key = await f.create();
    const other = { ...f.journal.session(key)!, key: 'hermes:other', stored: 'other-stored' };
    f.journal.save(other);
    await f.runtime.close();
    const recovered = new HermesRuntime({ config, journal: f.journal, turns: f.turns, store: f.store, authorize: () => true }, () => f.native);
    try {
      await recovered.start();
      const before = f.calls.length;
      await recovered.remove(key, () => {}, () => {});
      assert.deepEqual(f.calls.slice(before), ['session.delete']);
      assert.deepEqual(f.journal.session(other.key), other);
      assert.ok(f.store.getSession(other.key));
      assert.equal(f.journal.session(key), undefined);
    } finally { await recovered.close(); }
  } finally { await f.close(); }
});

test('Hermes rejects running, queued and unknown sessions without native mutations', async () => {
  for (const mode of ['running', 'queued', 'unknown']) {
    const f = fixture();
    try {
      const key = await f.create();
      if (mode === 'queued') await f.runtime.pauseQueueWorker().drained;
      await f.send(key, 'keep');
      if (mode !== 'queued') await until(() => f.journal.current(key)?.phase === 'running');
      if (mode === 'unknown') f.disconnect();
      await assert.rejects(f.runtime.remove(key, () => {}, () => {}), /finish/);
      assert.equal(f.calls.includes('session.close'), false); assert.equal(f.calls.includes('session.delete'), false);
      assert.ok(f.journal.session(key));
    } finally { await f.close(); }
  }
});

test('Hermes lost or wrong deletion ACK remains fenced across restart, with no automatic replay', async () => {
  for (const mode of ['close-lost', 'delete-lost', 'wrong-identity', 'revoke-after-close']) {
    const f = fixture(); let allowed = true;
    try {
      const key = await f.create();
      if (mode === 'close-lost') f.setClose(async () => { throw new Error('lost'); });
      if (mode === 'delete-lost') f.setDelete(async () => { throw new Error('lost'); });
      if (mode === 'wrong-identity') f.setDelete(async () => ({ deleted: 'foreign' }));
      if (mode === 'revoke-after-close') f.setClose(async () => { allowed = false; return { closed: true }; });
      await assert.rejects(f.runtime.remove(key, () => { if (!allowed) throw new Error('revoked'); }, () => assert.fail('cannot ACK')), /not be fully confirmed/);
      assert.equal(f.journal.deletion(key), 'pending');
      const before = [...f.calls]; await f.runtime.refreshSession(key); await assert.rejects(f.send(key, 'no'));
      await assert.rejects(f.runtime.remove(key, () => {}, () => {})); assert.deepEqual(f.calls, before);
      await f.runtime.close();
      const recovered = new HermesRuntime({ config, journal: new HermesJournal(f.db), turns: f.turns, store: f.store, authorize: () => true }, () => f.native);
      await recovered.start(); await recovered.refreshSession(key);
      await assert.rejects(recovered.send(key, 'no', { actorId: 'owner', accept: () => () => {} }));
      assert.deepEqual(f.calls, before); await recovered.close();
    } finally { await f.close(); }
  }
});

test('Hermes deletion drains a slow history read, fences concurrent send/delete and never resurrects history', async () => {
  const f = fixture(); let release!: (value: unknown) => void;
  try {
    const key = await f.create();
    f.setHistory(() => new Promise(resolve => { release = resolve; }));
    const refresh = f.runtime.refreshSession(key); await until(() => !!release);
    const deletion = f.runtime.remove(key, () => {}, () => {});
    await assert.rejects(f.send(key, 'no')); await assert.rejects(f.runtime.remove(key, () => {}, () => {}));
    assert.equal(f.calls.includes('session.close'), false);
    release({ messages: [{ row_id: 1, role: 'assistant', text: 'stale' }] });
    await refresh; await deletion;
    assert.equal(f.journal.session(key), undefined); assert.equal(f.store.getSession(key), undefined);
    assert.deepEqual(f.store.getMessages(key), []);
  } finally { await f.close(); }
});

test('Hermes validates idle identity and rechecks authority before close', async () => {
  for (const mode of ['busy', 'foreign', 'foreign-info', 'revoked']) {
    const f = fixture(); let allowed = true;
    try {
      const key = await f.create();
      f.setSnapshot(async () => { if (mode === 'revoked') allowed = false;
        return { session_id: 'live', session_key: mode === 'foreign' ? 'foreign' : 'stored',
          info: { stored_session_id: mode === 'foreign-info' ? 'foreign' : 'stored' }, status: 'idle', running: mode === 'busy' }; });
      await assert.rejects(f.runtime.remove(key, () => { if (!allowed) throw new Error('revoked'); }, () => assert.fail('no ACK')));
      assert.equal(f.calls.includes('session.close'), false); assert.equal(f.journal.deletion(key), undefined);
    } finally { await f.close(); }
  }
});

test('maintenance preserves queued commands; resume starts once and expected-run interrupt is fenced', async () => {
  const f = fixture();
  try {
    const key = await f.create(); const pause = f.runtime.pauseQueueWorker(); await pause.drained;
    await f.send(key, 'pending'); assert.equal(f.submits.length, 0);
    assert.equal(pause.resume(), true); await until(() => f.journal.current(key)?.phase === 'running');
    await assert.rejects(f.runtime.interrupt(key, 'wrong-run', 'owner'));
    assert.equal(f.calls.includes('session.interrupt'), false);
    await f.runtime.interrupt(key, f.journal.current(key)!.id, 'owner');
    assert.equal(f.journal.current(key)?.phase, 'running', 'interrupt ACK is not completion');
    f.event('message.complete', { status: 'interrupted' });
    await until(() => f.journal.current(key)?.phase === 'interrupted');
  } finally { await f.close(); }
});

test('terminal history from a replaced native epoch freezes original run without dispatching successor', async () => {
  const f = fixture(); let entered = false, release!: (value: unknown) => void;
  try {
    const key = await f.create(); await f.send(key, 'first');
    await until(() => f.journal.current(key)?.phase === 'running');
    await f.send(key, 'next');
    f.setHistory(() => { entered = true; return new Promise(resolve => { release = resolve; }); });
    f.complete(); await until(() => entered);
    f.native.epoch = 'replacement-epoch'; release({ messages: f.rows });
    await until(() => f.journal.current(key)?.phase === 'unknown');
    assert.equal(f.journal.session(key)?.stored, 'stored');
    assert.equal(f.submits.length, 1); assert.equal(f.journal.canStart(key), false);
  } finally { await f.close(); }
});

test('terminal transaction failure leaves anchor/history intact and freezes without waking queued successor', async () => {
  const f = fixture();
  try {
    const key = await f.create(); await f.send(key, 'first');
    await until(() => f.journal.current(key)?.phase === 'running');
    await f.send(key, 'next');
    const before = f.journal.session(key);
    f.setSnapshot(async () => ({ session_id: 'live', session_key: 'rotated', running: false, status: 'idle' }));
    f.db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE ON hermes_executions WHEN NEW.phase = 'completed' BEGIN SELECT RAISE(ABORT, 'terminal-fault'); END");
    f.complete(); await until(() => f.journal.current(key)?.phase === 'unknown');
    assert.deepEqual(f.journal.session(key), before);
    assert.equal(f.submits.length, 1); assert.equal(f.journal.canStart(key), false);
  } finally { await f.close(); }
});

test('terminal waits for native worker finally; compaction reanchors the stable local identity', async () => {
  const f = fixture(); let reads = 0;
  try {
    f.setSnapshot(async () => ({ session_id: 'live', session_key: 'compacted', status: 'idle', running: ++reads === 1 }));
    const key = await f.create(); await f.send(key, '1'); await until(() => f.journal.current(key)?.phase === 'running');
    f.complete(); await until(() => f.journal.current(key)?.phase === 'completed');
    assert.equal(reads, 2); assert.equal(f.journal.session(key)?.stored, 'compacted');
    assert.equal(f.submits.length, 1);
  } finally { await f.close(); }
});

test('retained native error snapshot settles failed rather than unknown', async () => {
  const f = fixture();
  try {
    f.setSnapshot(async () => ({ session_id: 'live', session_key: 'stored', status: 'idle', running: false, inflight: { status: 'error', streaming: false } }));
    const key = await f.create(); await f.send(key, '1'); await until(() => f.journal.current(key)?.phase === 'running');
    f.event('message.complete', { status: 'error' }); await until(() => f.journal.current(key)?.phase === 'failed');
  } finally { await f.close(); }
});

test('global native reclamation freezes active work, never resumes or replays it', async () => {
  const f = fixture();
  try {
    const key = await f.create(); await f.send(key, '1'); await until(() => f.journal.current(key)?.phase === 'running');
    f.globalEvent('session.reclaimed', { session_id: 'live', stored_session_id: 'stored' });
    assert.equal(f.journal.current(key)?.phase, 'unknown');
    await f.runtime.refreshSession(key); assert.equal(f.calls.includes('session.resume'), false);
    assert.equal(f.submits.length, 1);
  } finally { await f.close(); }
});

test('OpenClaw list refresh cannot drop an owned Hermes session', async () => {
  const f = fixture();
  try { const key = await f.create(); f.store.replaceSessions([]); assert.ok(f.store.getSession(key)); }
  finally { await f.close(); }
});

test('late history refresh cannot replace the terminal durable snapshot', async () => {
  const f = fixture(); let release!: (value: unknown) => void;
  try {
    const key = await f.create(); await f.send(key, '1'); await until(() => f.journal.current(key)?.phase === 'running');
    f.setHistory(() => new Promise(resolve => { release = resolve; }));
    const refreshing = f.runtime.refreshSession(key); await until(() => !!release);
    f.setHistory(undefined); f.complete('durable final'); await until(() => f.journal.current(key)?.phase === 'completed');
    release({ messages: [] }); await refreshing;
    assert.ok(f.store.getMessages(key).some(m => m.text === 'durable final'));
  } finally { await f.close(); }
});

test('create → submit → stream/tool → history → complete; 2+3 wait and dispatch in one native turn', async () => {
  const f = fixture();
  try {
    const key = await f.create(); const first = await f.send(key, '1');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('message.delta', { text: 'hello' });
    assert.equal(f.store.getSession(key)?.status, 'running');
    f.event('tool.start', { tool_id: 'tool1', name: 'terminal', args: { secret: 'never-project' } });
    f.event('tool.complete', { tool_id: 'tool1', duration_s: 0.5 });
    await f.runtime.refreshSession(key);
    assert.ok(f.store.getMessages(key).some(m => m.text === 'hello'));
    assert.equal(f.store.getSession(key)?.status, 'running');
    assert.equal(f.store.getMessages(key).filter(m => m.toolName === 'terminal').length, 2);
    assert.equal(JSON.stringify(f.journal.session(key)).includes('never-project'), false);
    const second = await f.send(key, '2'), third = await f.send(key, '3');
    assert.equal(second.queueDisposition, 'waiting'); assert.equal(f.submits.length, 1);
    f.complete();
    await until(() => f.submits.length === 2 && f.journal.current(key)?.phase === 'running');
    assert.match(f.submits[1]!, /^2\n\n\[Queued message boundary .+\]\n\n3$/);
    assert.equal(f.turns.list('hermes', key).length, 0);
    f.complete('second reply'); await until(() => f.journal.current(key)?.phase === 'completed');
    assert.deepEqual(f.store.getMessages(key).filter(m => m.role === 'user').map(m => m.id), [first.idempotencyKey, second.idempotencyKey, third.idempotencyKey]);
    assert.equal(f.store.getMessages(key).some(m => m.id.startsWith('hermes-stream:')), false);
    assert.equal(f.journal.session(key)?.messages.filter(m => m.toolName === 'terminal').length, 2);
    await f.runtime.refreshSession(key);
    assert.equal(f.store.getMessages(key).filter(m => m.toolName === 'terminal').length, 2);
  } finally { await f.close(); }
});

test('native tool summaries reconcile event pairs and preserve pre-upgrade tools without arguments', async () => {
  const f = fixture();
  try {
    const key = await f.create(); await f.send(key, 'tools');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'one', name: 'terminal' });
    f.event('tool.complete', { tool_id: 'one', name: 'terminal' });
    f.setHistory(async () => ({ messages: [...f.rows, { role: 'tool', name: 'terminal', args: { secret: 'never-copy' } },
      { role: 'tool', name: 'read_file', args: { secret: 'never-copy' } }] }));
    await f.runtime.refreshSession(key);
    const messages = f.store.getMessages(key).filter(m => m.role === 'tool');
    assert.equal(messages.filter(m => m.toolName === 'terminal').length, 2);
    assert.equal(messages.filter(m => m.toolName === 'read_file').length, 1);
    assert.equal(JSON.stringify(messages).includes('never-copy'), false);
    await f.runtime.refreshSession(key);
    assert.deepEqual(f.store.getMessages(key).filter(m => m.role === 'tool'), messages);
  } finally { await f.close(); }
});

test('a lost Hermes tool result settles as unknown, including after recovery', async () => {
  const f = fixture();
  try {
    const key = await f.create(); await f.send(key, 'tools');
    await until(() => f.journal.current(key)?.phase === 'running');
    f.event('tool.start', { tool_id: 'one', name: 'terminal' });
    await f.runtime.close();
    const recovered = new HermesRuntime({ config, journal: f.journal, turns: f.turns, store: f.store, authorize: () => true }, () => f.native);
    try {
      const result = f.store.getMessages(key).find(m => m.toolPhase === 'result');
      assert.equal(result?.status, 'outcome_unknown');
      assert.match(result?.text ?? '', /not confirmed/i);
    } finally { await recovered.close(); }
  } finally { await f.close(); }
});

test('terminal before ACK, duplicate terminal, and next queued work do not strand the queue', async () => {
  const f = fixture(); let release!: (ack: unknown) => void;
  try {
    f.setSubmit(() => new Promise(resolve => { release = resolve; }));
    const key = await f.create(); await f.send(key, '1'); await until(() => f.submits.length === 1);
    await f.send(key, '2'); f.complete(); f.event('message.complete', { status: 'complete' });
    f.setSubmit(undefined); release({ status: 'streaming' });
    await until(() => f.submits.length === 2 && f.journal.current(key)?.phase === 'running');
    assert.equal(f.journal.executions(key)[0]?.phase, 'completed');
  } finally { await f.close(); }
});

test('queue edit/cancel is versioned; different actors never batch', async () => {
  const f = fixture();
  try {
    const key = await f.create(); await f.send(key, '1'); await until(() => f.journal.current(key)?.phase === 'running');
    const second = await f.send(key, '2'), third = await f.send(key, '3', 'other');
    const id = second.idempotencyKey as string, version = f.turns.version('hermes', key, id)!;
    assert.equal(f.runtime.editQueued(key, id, 'edited', version), true);
    assert.equal(f.runtime.cancelQueued(key, id, version), false);
    assert.equal(f.runtime.cancelQueued(key, id, f.turns.version('hermes', key, id)!), true);
    await f.send(key, '4'); f.complete();
    await until(() => f.submits.length === 2 && f.journal.current(key)?.phase === 'running');
    assert.equal(f.submits[1], '3'); assert.equal(f.turns.list('hermes', key).length, 1);
    assert.ok(third.idempotencyKey);
  } finally { await f.close(); }
});

for (const failure of ['lost_ack', 'native_queue', 'gap', 'disconnect'] as const) test(`${failure} freezes unknown execution without replay`, async () => {
  const f = fixture();
  try {
    if (failure === 'lost_ack') f.setSubmit(async () => { throw new Error('lost'); });
    if (failure === 'native_queue') f.setSubmit(async () => ({ status: 'queued' }));
    const key = await f.create(); await f.send(key, 'sensitive work');
    if (failure === 'gap' || failure === 'disconnect') {
      await until(() => f.journal.current(key)?.phase === 'running');
      if (failure === 'gap') { f.event('message.delta', { text: 'x' }, 1); f.event('message.complete', { status: 'complete' }, 3); }
      else f.disconnect();
    }
    await until(() => f.journal.current(key)?.phase === 'unknown');
    const calls = f.calls.length; await f.runtime.refreshSession(key); assert.equal(f.calls.length, calls);
    f.runtime.wake(); assert.equal(f.submits.length, 1);
    await assert.rejects(f.send(key, 'retry'));
  } finally { await f.close(); }
});

test('authorization revoked across history await prevents native submission', async () => {
  const f = fixture();
  try {
    f.setHistory(async () => { f.revoke(); return { messages: [] }; });
    const key = await f.create(); await f.send(key, '1');
    await until(() => f.turns.head('hermes', key)?.state === 'blocked');
    assert.equal(f.submits.length, 0);
  } finally { await f.close(); }
});

test('history failure before submit is visible and cancellable, never loops', async () => {
  const f = fixture();
  try {
    f.setHistory(async () => { throw new Error('offline'); });
    const key = await f.create(); const sent = await f.send(key, '1');
    await until(() => f.turns.head('hermes', key)?.state === 'blocked');
    assert.equal(f.submits.length, 0);
    assert.equal(f.store.getMessages(key)[0]?.status, 'failed');
    assert.equal(f.runtime.cancelQueued(key, sent.idempotencyKey as string, f.turns.version('hermes', key, sent.idempotencyKey as string)!), true);
  } finally { await f.close(); }
});

for (const change of ['session', 'execution', 'deletion', 'disconnect'] as const)
  test(`original runtime refresh across ${change} cannot overwrite new history or mark stale history ready`, async () => {
    const f = fixture();
    try {
      const key = await f.create();
      await f.runtime.refreshSession(key);
      assert.equal(f.runtime.isSessionHistoryReady(key), true);
      f.setHistory(async () => {
        if (change === 'session') f.journal.save({ ...f.journal.session(key)!, title: 'Newer' });
        if (change === 'execution') f.journal.update({ key, id: 'newer', live: 'live', epoch: 'epoch', members: [], phase: 'unknown', at: 1, updated: 1 });
        if (change === 'deletion') f.journal.beginDeletion(key);
        if (change === 'disconnect') f.disconnect();
        return { messages: [{ row_id: 1, role: 'assistant', text: 'stale reply', timestamp: 1 }] };
      });
      await f.runtime.refreshSession(key);
      assert.deepEqual(f.journal.session(key)?.messages, []);
      assert.equal(f.runtime.isSessionHistoryReady(key), false);
      assert.equal(f.submits.length, 0);
    } finally { await f.close(); }
  });

test('restart preserves cached history and unknown identity, never resumes unconfirmed work', async () => {
  const f = fixture(); const key = await f.create(); await f.send(key, '1');
  await until(() => f.journal.current(key)?.phase === 'running');
  await f.runtime.close();
  const recovered = fixture(f.db);
  try {
    await recovered.runtime.start(); await recovered.runtime.refreshSession(key);
    assert.equal(recovered.journal.current(key)?.phase, 'unknown');
    assert.deepEqual(recovered.calls, []);
    assert.ok(recovered.store.getMessages(key).some(m => m.text === '1'));
  } finally { await recovered.close(); }
});
