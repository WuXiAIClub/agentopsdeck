import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DeckEvent } from '@agentopsdeck/shared';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorEventProjection } from './async-event-projection.js';
import { ConnectorOwnerUnavailable, encodeConnectorOwnerJson, encodeConnectorProjectionJson } from './connector-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { DeckStore } from '../projection/deck-store.js';
import { bindToolRecord, readIndexedToolMessage } from '../codex/indexed-tool-output.js';

const epoch = 'ce1_00000000-0000-4000-8000-000000000001:';
const factEpoch = 'cv1_00000000-0000-4000-8000-000000000001:';
const factHead = (revision = 0) => ({ cursor: epoch + '2', version: factEpoch + revision });
const event = (payload: unknown = 'private-body'): DeckEvent => ({ id: '', type: 'session.updated', ts: 1, payload });
const page = (seq = 0) => ({ cursor: epoch + seq, known: true, events: [] });
const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
// These memory-only fixtures have no external fact producers. Real assembly
// must supply all worker-backed consumers, not use this fixture callback.
const refreshMemoryFixture = async () => {};

test('read-only Codex history observations do not invalidate a directory snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'async-history-observation-projection-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, silence);
  await owner.open();
  const projection = new AsyncConnectorEventProjection(owner, silence);
  try {
    const before = await owner.command('eventProjectionHead', {});
    const captured = await projection.snapshot(cursor => cursor, async () => {
      assert.deepEqual(await owner.command('codexHistoryObservation', { sessionKey: 'codex:observed' }),
        { execution: null, deleted: false, outcomeUnknown: false });
    });
    assert.equal(captured, before.cursor);
    assert.deepEqual(await owner.command('eventProjectionHead', {}), before);
  } finally { await projection.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('empty automation planning does not invalidate a directory snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'async-empty-automation-projection-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, silence);
  await owner.open();
  const projection = new AsyncConnectorEventProjection(owner, silence);
  try {
    const before = await owner.command('eventProjectionHead', {});
    const captured = await projection.snapshot(cursor => cursor, async () => {
      assert.equal(await owner.command('automationBackgroundPlan', { after: '' }), null);
    });
    assert.equal(captured, before.cursor);
    assert.deepEqual(await owner.command('eventProjectionHead', {}), before);
    await projection.append([event()]);
    assert.notEqual((await owner.command('eventProjectionHead', {})).version, before.version);
  } finally { await projection.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('projection optional JSON fields preserve legacy wire without weakening command encoding', () => {
  const value = { retained: { a: 1, omitted: undefined }, values: [undefined, 2] };
  assert.deepEqual(JSON.parse(encodeConnectorProjectionJson(value)), { retained: { a: 1 }, values: [null, 2] });
  assert.throws(() => encodeConnectorOwnerJson(value), ConnectorOwnerUnavailable);
  assert.throws(() => encodeConnectorProjectionJson(undefined), ConnectorOwnerUnavailable);
  assert.throws(() => encodeConnectorProjectionJson({ longer: undefined }, 3), ConnectorOwnerUnavailable);
  assert.throws(() => encodeConnectorProjectionJson(Object.fromEntries(Array.from({ length: 32_769 }, (_, n) => [n, undefined])), 1_000_000), ConnectorOwnerUnavailable);
  let invoked = 0;
  for (const item of [Object.defineProperty({}, 'optional', { enumerable: true, get() { invoked++; } }),
    new Proxy({}, { ownKeys() { invoked++; return []; } }), { toJSON() { invoked++; return {}; } },
    { optional: () => {} }, { optional: 1n }, [,]]) {
    assert.throws(() => encodeConnectorProjectionJson(item), ConnectorOwnerUnavailable);
  }
  assert.equal(invoked, 0);
});

test('projection omits private symbol bindings without invoking them or weakening command encoding', () => {
  let invoked = 0;
  const value = Object.defineProperty({ retained: 1 }, Symbol('private'), { enumerable: true, get() { invoked++; throw Error('private binding'); } });
  assert.equal(encodeConnectorProjectionJson({ nested: value }), '{"nested":{"retained":1}}');
  assert.throws(() => encodeConnectorOwnerJson(value), ConnectorOwnerUnavailable);
  assert.throws(() => encodeConnectorProjectionJson(Object.fromEntries(Array.from({ length: 32_769 }, () => [Symbol(), undefined]))), ConnectorOwnerUnavailable);
  assert.equal(invoked, 0);
});

test('real Deck tool history retains its local binding while worker events and snapshots remain readable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'async-tool-projection-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, silence);
  await owner.open();
  const projection = new AsyncConnectorEventProjection(owner, silence);
  try {
    const file = join(directory, 'rollout.jsonl');
    const body = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'verified output' } });
    writeFileSync(file, body + '\n');
    const metadata = statSync(file);
    const message = bindToolRecord({ id: 'tool', sessionKey: 'codex:history', role: 'tool', text: 'preview', createdAt: 1, status: 'sent' }, file,
      { preview: 'preview', lines: 1, reference: { offset: 0, bytes: Buffer.byteLength(body), digest: createHash('sha256').update(body).digest('hex'), dev: metadata.dev, ino: metadata.ino, callId: 'call' } }, '');
    const deck = new DeckStore({ projectionEvents: projection.deckEvents });
    const start = await projection.snapshot(cursor => cursor, refreshMemoryFixture);
    deck.addMessage(message);
    const snapshot = await projection.snapshot(cursor => ({ cursor, messages: deck.getMessages(message.sessionKey) }), refreshMemoryFixture);
    assert.equal(snapshot.messages.length, 1);
    assert.ok((await readIndexedToolMessage(snapshot.messages[0]!)).text.includes('verified output'));
    const replay = await projection.replay(start);
    assert.equal(replay.cursor, snapshot.cursor);
    assert.equal(replay.events.length, 1);
    assert.deepEqual(replay.events[0]!.payload, { invalidation: true, revision: replay.cursor, id: 'tool' });
    assert.equal(JSON.stringify(replay).includes(file), false);
    assert.equal(projection.status().unavailable, false);
  } finally { await projection.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('real Deck large history hydration uses bounded invalidation and retains history and later live deltas', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'async-bulk-projection-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, silence);
  await owner.open();
  const inputs: unknown[] = [];
  const projection = new AsyncConnectorEventProjection({ command: (kind, input) => {
    if (kind === 'eventProjectionAppend') inputs.push(input);
    return owner.command(kind, input);
  } }, silence);
  try {
    const deck = new DeckStore({ projectionEvents: projection.deckEvents });
    const start = await projection.snapshot(cursor => cursor, refreshMemoryFixture);
    const sessionKey = 'codex:bulk-history';
    const messages = Array.from({ length: 5000 }, (_, index) => ({ id: `history-${index}`, sessionKey,
      role: 'assistant' as const, text: 'private history body\n'.repeat(100), createdAt: index + 1, status: 'sent' as const }));
    deck.replaceMessages(sessionKey, messages, { authoritative: true });
    const hydrated = await projection.snapshot(cursor => ({ cursor, messages: deck.getMessages(sessionKey) }), refreshMemoryFixture);
    assert.deepEqual(hydrated.messages, messages);
    const replay = await projection.replay(start);
    assert.equal(replay.cursor, hydrated.cursor);
    assert.equal(replay.events.length, 1);
    assert.equal(replay.events[0]!.type, 'stream.reset');
    assert.deepEqual(replay.events[0]!.payload, { reason: 'history_batch' });
    deck.addMessage({ id: 'large-live-message', sessionKey, role: 'assistant', text: 'private live body\n'.repeat(50_000), createdAt: 6000, status: 'sent' });
    const live = await projection.snapshot(cursor => ({ cursor, messages: deck.getMessages(sessionKey) }), refreshMemoryFixture);
    assert.equal(live.messages.length, 5001);
    assert.ok(live.messages.at(-1)!.text.startsWith('private live body'));
    const delta = await projection.replay(hydrated.cursor);
    assert.equal(delta.events.length, 1);
    assert.equal(delta.events[0]!.type, 'message.created');
    assert.deepEqual(delta.events[0]!.payload, { invalidation: true, revision: delta.cursor, id: 'large-live-message' });
    assert.equal(inputs.length, 2);
    assert.ok(inputs.every(input => Buffer.byteLength(JSON.stringify(input)) < 1024));
    assert.equal(JSON.stringify(inputs).includes('private'), false);
    assert.equal(projection.status().unavailable, false);
  } finally { await projection.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup(run: (kind: string, input: any) => unknown | Promise<unknown>, records?: string[]) {
  const calls: { kind: string; input: any }[] = [];
  const owner = { command: async (kind: string, input: unknown) => {
    calls.push({ kind, input });
    const value = await run(kind, input);
    // Legacy memory fixtures use the event sequence as their fact generation.
    // Explicit fact heads below exercise changes without any display event.
    if (kind === 'eventProjectionHead' && value && typeof value === 'object' && 'events' in value
      && 'cursor' in value && typeof value.cursor === 'string') {
      const cursor = value.cursor;
      return { cursor, version: factEpoch + cursor.slice(cursor.lastIndexOf(':') + 1) };
    }
    return value;
  } };
  const projection = new AsyncConnectorEventProjection(owner as unknown as Pick<AsyncConnectorOwner, 'command'>,
    records ? new PerformanceDiagnostics(line => records.push(line)) : silence);
  return { projection, calls };
}

test('construction and ordinary replay never implicitly reset/recover/append', async () => {
  const { projection, calls } = setup(() => page(3));
  assert.equal(calls.length, 0); assert.deepEqual(await projection.replay(null), page(3));
  assert.deepEqual(calls.map(c => c.kind), ['eventReplay']); await projection.close();
});

test('failed original read can explicitly recover the same journal without resetting a healthy epoch', async () => {
  let fail = true;
  const { projection, calls } = setup(kind => {
    if (kind === 'eventProjectionRecover') return { recovered: false, cursor: epoch + '3' };
    if (fail) throw Error('private transient read error');
    return page(3);
  });
  await assert.rejects(projection.replay(null), ConnectorOwnerUnavailable);
  assert.equal(projection.status().unavailable, true); assert.equal(projection.status().unknown, false);
  await assert.rejects(projection.replay(null), ConnectorOwnerUnavailable); assert.equal(calls.length, 1);
  fail = false;
  assert.equal(await projection.recover(), true);
  assert.deepEqual(await projection.replay(null), page(3));
  assert.deepEqual(calls.map(call => call.kind), ['eventReplay', 'eventProjectionRecover', 'eventReplay']);
  await projection.close();
});

test('memory mutation while read-fenced requires an explicit projection reset, never write replay', async () => {
  const { projection, calls } = setup(kind => {
    if (kind === 'eventReplay') throw Error('read unavailable');
    return kind === 'eventProjectionRecover' ? { recovered: false, cursor: epoch + '3' } : epoch + '0';
  });
  await assert.rejects(projection.replay(null), ConnectorOwnerUnavailable);
  await assert.rejects(projection.append([event()]), ConnectorOwnerUnavailable);
  assert.equal(await projection.recover(), true);
  assert.deepEqual(calls.map(call => call.kind), ['eventReplay', 'eventProjectionRecover', 'eventProjectionReset']);
  await projection.close();
});

test('async capture is refused before invocation; accidental rejected Promise is observed without accepting it', async () => {
  let captures = 0;
  const { projection } = setup(() => page());
  await assert.rejects(projection.snapshot(async () => { captures++; throw Error('not executed'); }, refreshMemoryFixture), ConnectorOwnerUnavailable);
  assert.equal(captures, 0);
  await assert.rejects(projection.snapshot(() => Promise.reject(Error('observed accidental rejection')), refreshMemoryFixture), ConnectorOwnerUnavailable);
  await tick(); await projection.close();
});

test('snapshot retries a stale watermark and captures memory only after matching its admitted revision', async () => {
  const first = deferred<unknown>(); let read = 0, memory = 1, captures = 0;
  const { projection } = setup(kind => kind === 'eventProjectionAppend' ? { cursor: epoch + '2' } : ++read === 1 ? first.promise : page(2));
  const snapshot = projection.snapshot(cursor => { captures++; return { memory, cursor }; }, refreshMemoryFixture); await tick();
  memory = 2; const append = projection.append([event()]);
  first.resolve(page(1)); await append;
  assert.deepEqual(await snapshot, { memory: 2, cursor: epoch + '2' }); assert.equal(captures, 1);
  await projection.close();
});

test('snapshot refuses a Promise or a reentrant mutation rather than publishing a mixed watermark', async () => {
  const { projection } = setup(kind => kind === 'eventProjectionAppend' ? { cursor: epoch + '1' } : page());
  await assert.rejects(projection.snapshot(async cursor => cursor, refreshMemoryFixture), ConnectorOwnerUnavailable);
  let append!: Promise<string>;
  await assert.rejects(projection.snapshot(() => { append = projection.append([event()]); return {}; }, refreshMemoryFixture), ConnectorOwnerUnavailable);
  await append; await projection.close();
});

test('snapshot retry yields to finite worker notification churn without accepting an old head', async () => {
  let revision = 0, refreshes = 0, moving = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const { projection } = setup(() => factHead(revision));
  try {
    const result = await projection.snapshot(() => revision, async () => {
      refreshes++;
      if (moving) {
        revision++;
        timer ??= setTimeout(() => { moving = false; }, 10);
      }
    });
    assert.equal(result, 1);
    assert.equal(refreshes, 2);
    assert.equal(projection.status().unavailable, false);
  } finally { clearTimeout(timer); await projection.close(); }
});

test('continuous mutation refuses snapshot after four bounded observations instead of spinning forever', async () => {
  let reads = 0, captures = 0;
  const { projection, calls } = setup(kind => {
    if (kind === 'eventProjectionAppend') return { cursor: epoch + reads };
    reads++; void projection.append([event()]).catch(() => {}); return page(reads);
  });
  await assert.rejects(projection.snapshot(() => { captures++; return {}; }, refreshMemoryFixture), ConnectorOwnerUnavailable);
  await projection.close(); assert.equal(reads, 4); assert.equal(captures, 0); assert.ok(calls.length <= 8);
});

test('missing authoritative refresh is refused before any worker read or capture', async () => {
  let captures = 0;
  const { projection, calls } = setup(() => page(2));
  // Deliberately exercise an untyped/old caller; no production legacy fallback.
  const legacy = projection.snapshot.bind(projection) as unknown as (capture: () => void) => Promise<void>;
  await assert.rejects(legacy(() => { captures++; }), ConnectorOwnerUnavailable);
  assert.equal(captures, 0); assert.equal(calls.length, 0); await projection.close();
});

test('already committed worker facts cannot be skipped while the memory notifier is delayed', async () => {
  const gate = deferred<void>(); let memory = 1, captures = 0, refreshing = false;
  const { projection, calls } = setup(() => page(2));
  const snapshot = projection.snapshot(cursor => { captures++; return { cursor, memory }; }, async () => {
    refreshing = true; await gate.promise; memory = 2;
  });
  await tick(); assert.equal(refreshing, true); assert.equal(captures, 0);
  assert.equal(projection.status().snapshots, 1);
  gate.resolve(); assert.deepEqual(await snapshot, { cursor: epoch + '2', memory: 2 });
  assert.deepEqual(calls.map(call => call.kind), ['eventProjectionHead', 'eventProjectionHead']); await projection.close();
});

test('a commit during authoritative refresh forces a new read-only bracket, never publishes the first cursor', async () => {
  let head = 2, memory = 1, refreshes = 0, captures = 0;
  const { projection, calls } = setup(() => page(head));
  const snapshot = await projection.snapshot(cursor => { captures++; return { cursor, memory }; }, async () => {
    memory = head;
    if (++refreshes === 1) head++;
  });
  assert.deepEqual(snapshot, { cursor: epoch + '3', memory: 3 });
  assert.equal(refreshes, 2); assert.equal(captures, 1);
  assert.deepEqual(calls.map(call => call.kind), Array(4).fill('eventProjectionHead')); await projection.close();
});

test('stable checkpoint avoids repeated full scans but never survives a changed head, refresh function or recovery', async () => {
  let head = 2, refreshes = 0;
  const { projection, calls } = setup(kind => kind === 'eventProjectionRecover'
    ? { recovered: false, cursor: epoch + head } : page(head));
  const refresh = async () => { refreshes++; };
  await projection.snapshot(cursor => cursor, refresh);
  assert.equal(calls.length, 2);
  await projection.snapshot(cursor => cursor, refresh);
  assert.equal(calls.length, 3); assert.equal(refreshes, 1);
  head++; await projection.snapshot(cursor => cursor, refresh); assert.equal(refreshes, 2);
  await projection.snapshot(cursor => cursor, async () => { refreshes++; }); assert.equal(refreshes, 3);
  await projection.snapshot(cursor => cursor, refresh); assert.equal(refreshes, 4);
  await projection.recover(); await projection.snapshot(cursor => cursor, refresh); assert.equal(refreshes, 5);
  await projection.close();
});

test('new event epoch invalidates an otherwise stable checkpoint', async () => {
  let current = page(2), refreshes = 0;
  const { projection } = setup(() => current);
  const refresh = async () => { refreshes++; };
  await projection.snapshot(cursor => cursor, refresh);
  current = { ...page(2), cursor: 'ce1_00000000-0000-4000-8000-000000000002:2' };
  assert.equal(await projection.snapshot(cursor => cursor, refresh), current.cursor);
  assert.equal(refreshes, 2); await projection.close();
});

test('facts without display events invalidate the checkpoint and a commit during refresh requires a successor', async () => {
  let revision = 0, memory = -1, refreshes = 0;
  const { projection } = setup(() => factHead(revision));
  const refresh = async () => { memory = revision; refreshes++; if (refreshes === 2) revision++; };
  assert.equal(await projection.snapshot(() => memory, refresh), 0);
  revision++;
  assert.equal(await projection.snapshot(() => memory, refresh), 2);
  assert.equal(refreshes, 3);
  assert.equal(await projection.snapshot(() => memory, refresh), 2);
  assert.equal(refreshes, 3);
  await projection.close();
});

test('a replacement fact owner cannot reuse a checkpoint at the same event cursor and revision', async () => {
  let current = factHead(0), refreshes = 0;
  const { projection } = setup(() => current);
  const refresh = async () => { refreshes++; };
  await projection.snapshot(cursor => cursor, refresh);
  current = { ...current, version: 'cv1_00000000-0000-4000-8000-000000000002:0' };
  await projection.snapshot(cursor => cursor, refresh);
  assert.equal(refreshes, 2); await projection.close();
});

for (const version of ['private-invalid', factEpoch + '-1', factEpoch + '9007199254740992'])
  test('malformed fact version fences the projection without capturing or leaking the reply', async () => {
    const logs: string[] = []; let captures = 0;
    const { projection } = setup(() => ({ ...factHead(), version }), logs);
    await assert.rejects(projection.snapshot(() => { captures++; }, refreshMemoryFixture), ConnectorOwnerUnavailable);
    assert.equal(captures, 0); assert.equal(projection.status().unknown, true);
    assert.equal(logs.join('').includes(version), false); await projection.close();
  });

test('continuous worker facts do not spin forever or dispatch any mutation', async () => {
  let head = 1, refreshes = 0, captures = 0;
  const logs: string[] = [];
  const { projection, calls } = setup(() => page(head), logs);
  await assert.rejects(projection.snapshot(() => { captures++; }, async () => { refreshes++; head++; }), ConnectorOwnerUnavailable);
  assert.equal(refreshes, 4); assert.equal(captures, 0); assert.equal(calls.length, 8);
  const failure = logs.map(line => JSON.parse(line)).find(row => row.category === 'failed' && row.startupStage === 6);
  assert.equal(failure?.records, 4);
  assert.equal(failure?.step, 3);
  assert.equal(logs.join('').includes(epoch), false);
  assert.ok(calls.every(call => call.kind === 'eventProjectionHead')); await projection.close();
});

test('startup drains a catalog burst before proving readiness, then restores normal backpressure', async () => {
  let committed = 0;
  const owner = {
    command: (kind: string) => Promise.resolve(kind === 'eventProjectionAppend'
      ? { cursor: epoch + ++committed }
      : { cursor: epoch + committed, version: factEpoch + committed }),
  };
  const projection = new AsyncConnectorEventProjection(owner, silence, true);
  try {
    const burst = Array.from({ length: 80 }, () => projection.append([event()]));
    await Promise.all([...burst, projection.startupSnapshot(refreshMemoryFixture)]);
    assert.equal(committed, 80);
    assert.equal(projection.status().unavailable, false);

    const overflow = await Promise.allSettled(Array.from({ length: 65 }, () => projection.append([event()])));
    assert.equal(overflow.at(-1)?.status, 'rejected');
    assert.equal(projection.status().unavailable, true);
    assert.equal(committed, 80);
  } finally { await projection.close(); }
});

test('startup waits for finite fact churn but still proves the same refreshed head', async () => {
  let revision = 0, refreshes = 0;
  const { projection, calls } = setup(() => factHead(revision));
  const refresh = async () => { if (++refreshes <= 5) revision++; };
  await projection.startupSnapshot(refresh);
  assert.equal(refreshes, 6);
  assert.equal(await projection.snapshot(() => revision, refresh), 5);
  assert.equal(refreshes, 6);
  assert.ok(calls.every(call => call.kind === 'eventProjectionHead'));
  await projection.close();
});

test('startup churn has a bounded stabilization window', async t => {
  let now = 0, revision = 0, refreshes = 0;
  t.mock.method(performance, 'now', () => now += 10_000);
  const { projection } = setup(() => factHead(revision));
  await assert.rejects(projection.startupSnapshot(async () => { revision++; refreshes++; }), ConnectorOwnerUnavailable);
  assert.ok(refreshes > 0 && refreshes < 4);
  assert.equal(projection.status().snapshots, 0);
  await projection.close();
});

test('startup does not retry failed refresh or owner reads', async () => {
  for (const failure of ['refresh', 'head']) {
    let refreshes = 0;
    const { projection, calls } = setup(() => { if (failure === 'head') throw Error('unavailable'); return factHead(); });
    await assert.rejects(projection.startupSnapshot(async () => { refreshes++; throw Error('unavailable'); }), ConnectorOwnerUnavailable);
    assert.equal(refreshes, failure === 'refresh' ? 1 : 0);
    assert.equal(calls.length, 1);
    await projection.close();
  }
});

test('close retains a startup refresh and rejects its late checkpoint', async () => {
  const entered = deferred<void>(), gate = deferred<void>();
  const { projection } = setup(() => factHead());
  const startup = projection.startupSnapshot(async () => { entered.resolve(); await gate.promise; });
  const rejected = assert.rejects(startup, ConnectorOwnerUnavailable);
  await entered.promise;
  let closed = false;
  const close = projection.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  gate.resolve(); await rejected; await close;
  assert.equal(projection.status().snapshots, 0);
});

test('failed authoritative refresh never caches success or logs private errors, and a new explicit read may succeed', async () => {
  const logs: string[] = []; let failed = true, captures = 0, refreshes = 0;
  const { projection, calls } = setup(() => page(2), logs);
  const refresh = async () => { refreshes++; if (failed) throw Error('PRIVATE-session-and-token'); };
  await assert.rejects(projection.snapshot(() => { captures++; }, refresh), ConnectorOwnerUnavailable);
  assert.equal(captures, 0); assert.equal(projection.status().unavailable, false);
  const failure = logs.map(line => JSON.parse(line)).find(row => row.category === 'failed' && row.startupStage === 3);
  assert.equal(failure?.records, 1);
  failed = false; await projection.snapshot(cursor => cursor, refresh);
  assert.equal(refreshes, 2); assert.ok(calls.every(call => call.kind === 'eventProjectionHead'));
  assert.equal(logs.join('').includes('PRIVATE'), false); assert.equal(logs.join('').includes(epoch), false);
  await projection.close();
});

test('close retains an original authoritative refresh and rejects its publication without closing the shared owner', async () => {
  const gate = deferred<void>(); let captures = 0, settled = false;
  const { projection, calls } = setup(() => page(2));
  const snapshot = projection.snapshot(() => { captures++; }, () => gate.promise);
  const rejected = assert.rejects(snapshot, ConnectorOwnerUnavailable);
  await tick(); const close = projection.close().then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  await assert.rejects(projection.snapshot(() => {}, refreshMemoryFixture), ConnectorOwnerUnavailable);
  gate.resolve(); await rejected; await close;
  assert.equal(captures, 0); assert.equal(projection.status().snapshots, 0);
  assert.deepEqual(calls.map(call => call.kind), ['eventProjectionHead']);
});

test('snapshot admission is bounded while original refreshes remain in flight', async () => {
  const gate = deferred<void>(); const { projection } = setup(() => page(2));
  const refresh = () => gate.promise;
  const jobs = Array.from({ length: 64 }, () => projection.snapshot(cursor => cursor, refresh));
  await assert.rejects(projection.snapshot(cursor => cursor, refresh), ConnectorOwnerUnavailable);
  assert.equal(projection.status().snapshots, 64);
  gate.resolve(); await Promise.all(jobs); await projection.close();
});

test('legacy cursor expiration is an explicit reset result and does not issue writes', async () => {
  const result = { cursor: epoch + '2', known: false, events: [] };
  const { projection, calls } = setup(() => result);
  assert.deepEqual(await projection.replay('legacy-v2.3.7-cursor'), result);
  assert.deepEqual(calls.map(c => c.kind), ['eventReplay']); await projection.close();
});

test('replay for a different original cursor closes this facade without a hidden recovery', async () => {
  const { projection, calls } = setup(() => ({ cursor: epoch + '3', known: true, events: [{ ...event(), id: epoch + '3' }] }));
  await assert.rejects(projection.replay(epoch + '0'), ConnectorOwnerUnavailable);
  assert.equal(projection.status().unknown, true);
  await assert.rejects(projection.recover(), ConnectorOwnerUnavailable); assert.equal(calls.length, 1); await projection.close();
});

test('append owns an immutable descriptor-safe payload at admission', async () => {
  const gate = deferred<unknown>(); const { projection, calls } = setup(() => gate.promise);
  const payload = { value: 'original' }, input = [event(payload)];
  const append = projection.append(input); payload.value = 'changed'; input.push(event()); await tick();
  assert.equal(calls[0]!.input.events.length, 1); assert.equal(calls[0]!.input.events[0].payload.value, 'original');
  gate.resolve({ cursor: epoch + '1' }); assert.equal(await append, epoch + '1'); await projection.close();
});

test('hostile admission never invokes accessors; explicit recovery resets only a readable original journal', async () => {
  let invoked = 0;
  const { projection, calls } = setup(kind => kind === 'eventProjectionRecover' ? { recovered: false, cursor: epoch + '4' } : epoch + '0');
  const value = Object.defineProperty(event(), 'payload', { enumerable: true, get() { invoked++; return 'private'; } });
  await assert.rejects(projection.append([value]), ConnectorOwnerUnavailable); assert.equal(invoked, 0); assert.equal(calls.length, 0);
  await assert.rejects(projection.snapshot(cursor => cursor, refreshMemoryFixture), ConnectorOwnerUnavailable);
  assert.equal(await projection.recover(), true);
  assert.deepEqual(calls.map(c => c.kind), ['eventProjectionRecover', 'eventProjectionReset']);
  assert.equal(projection.status().unavailable, false); await projection.close();
});

test('a broken port reply cannot invoke accessors or be published as an ACK', async () => {
  let invoked = 0; const result = Object.defineProperty({}, 'cursor', { enumerable: true, get() { invoked++; return epoch + '1'; } });
  const { projection } = setup(() => result);
  await assert.rejects(projection.append([event()]), ConnectorOwnerUnavailable);
  assert.equal(invoked, 0); assert.equal(projection.status().unknown, true); await projection.close();
});

test('optional projection failure requires explicit recovery, never retries the original append', async () => {
  const { projection, calls } = setup(kind => kind === 'eventProjectionAppend' ? { cursor: null } : { recovered: true, cursor: epoch + '0' });
  await assert.rejects(projection.append([event()]), ConnectorOwnerUnavailable);
  await assert.rejects(projection.replay(null), ConnectorOwnerUnavailable);
  assert.equal(await projection.recover(), true); assert.equal(projection.status().unavailable, false);
  assert.deepEqual(calls.map(c => c.kind), ['eventProjectionAppend', 'eventProjectionRecover']); await projection.close();
});

test('transaction-unavailable recovery stays unavailable and never issues an epoch reset', async () => {
  const { projection, calls } = setup(kind => kind === 'eventProjectionAppend' ? { cursor: null } : { recovered: false, cursor: null });
  await assert.rejects(projection.append([event()]), ConnectorOwnerUnavailable);
  assert.equal(await projection.recover(), false); assert.equal(projection.status().unavailable, true);
  assert.deepEqual(calls.map(c => c.kind), ['eventProjectionAppend', 'eventProjectionRecover']); await projection.close();
});

test('memory changes during recovery keep a gap and require another explicit recovery', async () => {
  const gate = deferred<unknown>(); let first = true;
  const { projection, calls } = setup(kind => kind === 'eventProjectionRecover'
    ? first ? (first = false, gate.promise) : { recovered: false, cursor: epoch + '0' } : epoch + '0');
  await assert.rejects(projection.append([]), ConnectorOwnerUnavailable);
  const recovering = projection.recover(); await tick();
  await assert.rejects(projection.append([event()]), ConnectorOwnerUnavailable);
  gate.resolve({ recovered: true, cursor: epoch + '0' }); assert.equal(await recovering, false);
  assert.equal(projection.status().unavailable, true); assert.equal(await projection.recover(), true);
  assert.equal(calls.filter(c => c.kind === 'eventProjectionReset').length, 1); await projection.close();
});

test('recovery observes failures in earlier accepted work, not just admission-time gap state', async () => {
  const gate = deferred<unknown>();
  const { projection, calls } = setup(kind => kind === 'eventProjectionAppend' ? gate.promise
    : kind === 'eventProjectionRecover' ? { recovered: false, cursor: epoch + '3' } : epoch + '0');
  const append = projection.append([event()]); const rejected = assert.rejects(append, ConnectorOwnerUnavailable); await tick();
  const recovery = projection.recover(); gate.resolve({ cursor: null }); await rejected;
  assert.equal(await recovery, true); assert.equal(projection.status().unavailable, false);
  assert.deepEqual(calls.map(c => c.kind), ['eventProjectionAppend', 'eventProjectionRecover', 'eventProjectionReset']); await projection.close();
});

test('unknown original ACK forbids recovery/replay and never dispatches accepted followers', async () => {
  const gate = deferred<unknown>(); const { projection, calls } = setup(() => gate.promise);
  const first = projection.append([event()]), second = projection.append([event()]);
  const rejected = [first, second].map(promise => assert.rejects(promise, ConnectorOwnerUnavailable)); await tick();
  gate.resolve({ cursor: 'not-an-ack' }); await Promise.all(rejected);
  await assert.rejects(projection.recover(), ConnectorOwnerUnavailable);
  assert.equal(calls.length, 1); assert.equal(projection.status().unknown, true); await projection.close();
});

test('pending admission is bounded, overflow fences the projection, and queued followers do not publish a gap', async () => {
  const gate = deferred<unknown>(); const { projection, calls } = setup(() => gate.promise);
  const work = [projection.append([event()])]; await tick();
  for (let index = 0; index < 64; index++) work.push(projection.append([event()]));
  const settled = Promise.allSettled(work);
  assert.equal(projection.status().pending, 64); assert.equal(projection.status().unavailable, true);
  gate.resolve({ cursor: epoch + '1' }); const outcomes = await settled; await projection.close();
  assert.equal(calls.length, 1); assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 64);
  assert.equal(projection.status().pending, 0); assert.equal(projection.status().inputBytes, 0);
});

test('input reservation is bounded independently of pending count', async () => {
  const gate = deferred<unknown>(); const { projection, calls } = setup(() => gate.promise);
  const work = [projection.append([event()])]; await tick();
  const batch = [event('x'.repeat(100_000)), event('x'.repeat(100_000)), event('x'.repeat(100_000))];
  for (let index = 0; index < 40; index++) work.push(projection.append(batch));
  const settled = Promise.allSettled(work);
  assert.ok(projection.status().pending < 64); assert.ok(projection.status().inputBytes <= 8 * 1024 * 1024);
  gate.resolve({ cursor: epoch + '1' }); await settled; await projection.close(); assert.equal(calls.length, 1);
});

test('close waits the actual original ACK without terminating/closing/replacing its owner', async () => {
  const gate = deferred<unknown>(); const { projection, calls } = setup(() => gate.promise);
  const append = projection.append([event()]); await tick(); let closed = false;
  const close = projection.close(); assert.equal(close, projection.close()); void close.then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(projection.status().pending, 1);
  await assert.rejects(projection.replay(null), ConnectorOwnerUnavailable);
  gate.resolve({ cursor: epoch + '1' }); await append; await close;
  assert.equal(closed, true); assert.deepEqual(calls.map(c => c.kind), ['eventProjectionAppend']);
});

test('local admission failure logs bounded numeric evidence without private event payload', async () => {
  const records: string[] = []; const { projection } = setup(() => page(), records);
  await assert.rejects(projection.append([event('private-payload'.repeat(100_000))]), ConnectorOwnerUnavailable);
  assert.ok(records.map(line => JSON.parse(line)).some(row => row.operation === 'connector-event-projection' && row.category === 'failed' && row.step === 1));
  assert.equal(records.join('\n').includes('private-payload'), false); await projection.close();
});

test('real worker persists event page and supplies a matching memory snapshot without opening a second writer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'async-event-projection-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, silence); await owner.open();
  const projection = new AsyncConnectorEventProjection(owner, silence);
  try {
    const start = await projection.snapshot(cursor => cursor, refreshMemoryFixture);
    await projection.append([event({ version: 1 })]);
    const snapshot = await projection.snapshot(cursor => ({ version: 1, cursor }), refreshMemoryFixture);
    const replay = await projection.replay(start);
    assert.equal(replay.events.length, 1); assert.equal(snapshot.cursor, replay.cursor);
    assert.deepEqual(replay.events[0]!.payload, { version: 1 });
  } finally { await projection.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('native catalog refresh reaches a fixed worker head without replaying unchanged session events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'async-catalog-head-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, silence);
  await owner.open();
  const projection = new AsyncConnectorEventProjection(owner, silence);
  const store = new DeckStore({ projectionEvents: projection.deckEvents });
  let title = 'Native catalog', refreshes = 0;
  const refresh = async () => {
    refreshes++;
    store.upsertSession({ sessionKey: 'codex:catalog', title, status: 'idle', source: 'codex', lastActiveAt: 1000 });
  };
  try {
    const start = await projection.snapshot(cursor => cursor, refreshMemoryFixture);
    const first = await projection.snapshot(cursor => ({ cursor, title: store.getSession('codex:catalog')?.title }), refresh);
    assert.equal(first.title, title);
    assert.ok(refreshes <= 2, 'one changed catalog is followed by a stable confirmation');
    for (let n = 0; n < 5; n++) {
      await refresh();
      assert.deepEqual(await projection.snapshot(cursor => ({ cursor, title: store.getSession('codex:catalog')?.title }), refresh), first);
    }
    assert.equal((await projection.replay(start)).events.length, 1);
    title = 'Renamed native catalog';
    await refresh();
    const changed = await projection.snapshot(cursor => ({ cursor, title: store.getSession('codex:catalog')?.title }), refresh);
    assert.equal(changed.title, title); assert.notEqual(changed.cursor, first.cursor);
    assert.equal((await projection.replay(first.cursor)).events.length, 1);
  } finally { await projection.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('deckEvents coalesces synchronous runtime bursts into bounded worker batches without overflowing MAX_PENDING', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'async-deck-burst-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite') }, silence);
  await owner.open();
  const batches: number[] = [];
  const projection = new AsyncConnectorEventProjection({
    command: (kind, input) => {
      if (kind === 'eventProjectionAppend') batches.push((input as { events: DeckEvent[] }).events.length);
      return owner.command(kind, input);
    },
  }, silence);
  const store = new DeckStore({ projectionEvents: projection.deckEvents });
  try {
    const start = await projection.snapshot(cursor => cursor, refreshMemoryFixture);
    // Emit 300 individual Deck mutations in one synchronous turn (> 64 MAX_PENDING).
    for (let i = 0; i < 300; i++) {
      store.upsertSession({ sessionKey: `codex:burst-${i}`, title: `Session ${i}`, status: 'idle', source: 'codex', lastActiveAt: i + 1 });
    }
    const snap = await projection.snapshot(cursor => ({ cursor, count: store.getSessionsState().groups.flatMap(g => g.sessions).length }), refreshMemoryFixture);
    assert.equal(snap.count, 300);
    assert.equal(projection.status().unavailable, false);
    assert.ok(batches.length < 64, `expected coalesced batches under MAX_PENDING, got ${batches.length}`);
    assert.equal(batches.reduce((a, b) => a + b, 0), 300);
    const replay = await projection.replay(start);
    assert.equal(replay.known, true);
    assert.equal(replay.events.length, 64);
  } finally { await projection.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Deck producer commits to the original worker journal and survives owner reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'async-deck-events-'));
  const file = join(directory, 'connector.sqlite');
  const owner = new AsyncConnectorOwner({ file }, silence); await owner.open();
  const projection = new AsyncConnectorEventProjection(owner, silence);
  const store = new DeckStore({ projectionEvents: projection.deckEvents });
  let reopened: AsyncConnectorOwner | undefined;
  try {
    const start = await projection.snapshot(cursor => cursor, refreshMemoryFixture);
    const local = store.append('session.updated', { version: 1 });
    store.replaceSessions([{ sessionKey: 'agent:test:dashboard:a', agentId: 'test', title: 'A', status: 'idle', updatedAt: 1 }]);
    const snapshot = await projection.snapshot(cursor => store.getSessionDirectory({}, cursor), refreshMemoryFixture);
    const replay = await projection.replay(start);
    assert.equal(replay.events.length, 2);
    assert.notEqual(replay.events[0]!.id, local.id, 'local observation is not a durable cursor');
    assert.deepEqual(replay.events[0]!.payload, { version: 1 });
    assert.ok(JSON.stringify(snapshot).includes('agent:test:dashboard:a'));
    assert.throws(() => store.latestEventId(), /awaited owner ports/);
    await projection.close(); await owner.close();
    reopened = new AsyncConnectorOwner({ file }, silence); await reopened.open();
    const restored = new AsyncConnectorEventProjection(reopened, silence);
    try { assert.deepEqual(await restored.replay(start), replay); }
    finally { await restored.close(); }
  } finally { await projection.close(); await owner.close(); await reopened?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Deck native callbacks retain pending commits through close without a synchronous cursor', async () => {
  const gate = deferred<unknown>(); const { projection, calls } = setup(() => gate.promise);
  const store = new DeckStore({ projectionEvents: projection.deckEvents });
  assert.doesNotThrow(() => store.append('session.updated', { native: 'already executed' }));
  assert.equal(projection.status().pending, 1); await tick();
  let drained = false; const close = projection.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.equal(calls.length, 1);
  gate.resolve({ cursor: epoch + '1' }); await close;
  assert.equal(projection.status().pending, 0);
  assert.equal(calls.length, 1, 'closing never replays a native event');
});

test('Deck sink absorbs unknown ACK but fences reads and never retries native events', async () => {
  const { projection, calls } = setup(() => ({ cursor: 'invalid-ack' }));
  const store = new DeckStore({ projectionEvents: projection.deckEvents });
  store.append('session.updated', { native: 'already executed' }); await tick();
  assert.equal(projection.status().unknown, true);
  assert.doesNotThrow(() => store.append('session.updated', { native: 'later execution' })); await tick();
  await assert.rejects(projection.replay(null), ConnectorOwnerUnavailable);
  await assert.rejects(projection.recover(), ConnectorOwnerUnavailable);
  await projection.close(); assert.equal(calls.length, 1);
});

test('Deck sink bounds queued callbacks and preserves the first physical operation under overflow', async () => {
  const gate = deferred<unknown>(); const { projection, calls } = setup(() => gate.promise);
  const store = new DeckStore({ projectionEvents: projection.deckEvents });
  const large = 'x'.repeat(200_000);
  for (let index = 0; index < 45; index++) store.append('session.updated', { index, large });
  assert.ok(projection.status().pending > 0 && projection.status().pending <= 64);
  assert.equal(projection.status().unavailable, true);
  await tick(); gate.resolve({ cursor: epoch + '1' }); await projection.close();
  assert.ok(calls.length <= 1); assert.equal(projection.status().pending, 0);
  assert.equal(projection.status().inputBytes, 0);
});
