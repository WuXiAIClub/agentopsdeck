import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import type { DeckEvent } from '@agentopsdeck/shared';
import { ConnectorEventLog } from './event-log.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { connectorOwnerCommandBytes, ConnectorOwnerUnavailable, connectorOwnerSteps, createConnectorOwnerCommands,
  validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { connectorEventReplayMatches, executeConnectorEvent, CONNECTOR_EVENT_COMMAND_BYTES, CONNECTOR_EVENT_BATCH_LIMIT,
  validConnectorEventInput, validConnectorEventOutput } from './connector-event-domain.js';

const epoch = 'ce1_00000000-0000-4000-8000-000000000001:';
const otherEpoch = 'ce1_00000000-0000-4000-8000-000000000002:';
const event = (payload: unknown = { state: 'running' }): DeckEvent => ({ id: '', type: 'session.updated', ts: 1, payload });
const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function disk(work: (file: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'connector-event-owner-'));
  try { await work(join(directory, 'connector.sqlite')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
function memory(work: (db: DatabaseSync, log: ConnectorEventLog) => void) {
  const db = new DatabaseSync(':memory:');
  try { work(db, new ConnectorEventLog(db)); } finally { db.close(); }
}
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { this.stops++; return Promise.resolve(1); }
  ready() { this.emit('message', { kind: 'ready' }); }
  reply(index: number, value: unknown) {
    const original = this.messages[index]!;
    this.emit('message', { id: original.id, kind: original.kind, ok: true, body: JSON.stringify(value) });
  }
}

test('event commands append stable diagnostic numbers and bounded fixed envelopes', () => {
  assert.deepEqual([connectorOwnerSteps.eventReplay, connectorOwnerSteps.eventProjectionAppend,
    connectorOwnerSteps.eventProjectionReset, connectorOwnerSteps.eventProjectionRecover], [92, 93, 94, 95]);
  assert.equal(connectorOwnerCommandBytes('eventProjectionAppend'), CONNECTOR_EVENT_COMMAND_BYTES);
  assert.equal(validConnectorOwnerInput('eventReplay', { after: null }), true);
  assert.equal(validConnectorOwnerInput('eventReplay', { after: epoch + '0' }), true);
  for (const after of [epoch + '1\0', 'x'.repeat(4097), 1, {}])
    assert.equal(validConnectorOwnerInput('eventReplay', { after }), false);
  for (const after of ['', epoch + '01', epoch + '-1', epoch + '9007199254740992', 'legacy-cursor'])
    assert.equal(validConnectorOwnerInput('eventReplay', { after }), true);
  assert.equal(validConnectorOwnerInput('eventReplay', { after: epoch + '0', sql: 'SELECT 1' }), false);
  assert.equal(validConnectorEventInput('unknown' as never, {}), false);
  assert.equal(validConnectorEventOutput('unknown' as never, {}), false);
  assert.equal(validConnectorOwnerInput('eventProjectionAppend', { events: [] }), false);
  assert.equal(validConnectorOwnerInput('eventProjectionAppend', { events: Array.from({ length: CONNECTOR_EVENT_BATCH_LIMIT + 1 }, () => event()) }), false);
  assert.equal(validConnectorOwnerInput('eventProjectionAppend', { events: [event('x'.repeat(CONNECTOR_EVENT_COMMAND_BYTES))] }), false);
  for (const invalid of [{ ...event(), type: 'exec' }, { ...event(), ts: -1 }, { ...event(), agentId: 'bad\0' },
    { ...event(), authority: true }, { ...event(), ts: Number.MAX_SAFE_INTEGER + 1 }])
    assert.equal(validConnectorOwnerInput('eventProjectionAppend', { events: [invalid] }), false);
  assert.equal(validConnectorOwnerOutput('eventProjectionRecover', { recovered: true, cursor: null }), false);
  assert.equal(validConnectorOwnerOutput('eventProjectionReset', epoch + '1'), false);
});

test('one replay observes head/retention/page and preserves current/wrong/future epoch resets', () => memory((_db, log) => {
  const start = log.latestEventId();
  assert.deepEqual(executeConnectorEvent('eventReplay', { after: null }, log), { cursor: start, known: true, events: [] });
  const result = executeConnectorEvent('eventProjectionAppend', { events: [event(), event({ n: 2 })] }, log);
  const page = executeConnectorEvent('eventReplay', { after: start }, log);
  assert.equal(page.cursor, result.cursor); assert.equal(page.known, true); assert.equal(page.events.length, 2);
  assert.equal(connectorEventReplayMatches(start, page), true);
  for (const after of [otherEpoch + '0', start.replace(/:0$/, ':3'), 'legacy-cursor', '']) {
    assert.deepEqual(executeConnectorEvent('eventReplay', { after }, log), { cursor: page.cursor, known: false, events: [] });
  }
  assert.deepEqual(executeConnectorEvent('eventReplay', { after: page.cursor }, log), { cursor: page.cursor, known: true, events: [] });
}));

test('replay pages are bounded, continuous and never jump to head before rows have been consumed', () => memory((_db, log) => {
  const start = log.latestEventId();
  for (let n = 0; n < 70; n++) log.append(event(n));
  const first = executeConnectorEvent('eventReplay', { after: start }, log);
  assert.equal(first.events.length, 64); assert.notEqual(first.events.at(-1)!.id, first.cursor);
  const second = executeConnectorEvent('eventReplay', { after: first.events.at(-1)!.id }, log);
  assert.equal(second.events.length, 6); assert.equal(second.events.at(-1)!.id, second.cursor);
  assert.deepEqual([...first.events, ...second.events].map(row => row.payload), Array.from({ length: 70 }, (_, n) => n));
}));

test('retention eviction is explicit reset, not an empty successful replay', () => memory((db, _log) => {
  const log = new ConnectorEventLog(db, 3), start = log.latestEventId();
  log.appendBatch(Array.from({ length: 5 }, () => event()));
  assert.equal(executeConnectorEvent('eventReplay', { after: start }, log).known, false);
  const floor = start.replace(/:0$/, ':2');
  assert.equal(executeConnectorEvent('eventReplay', { after: floor }, log).events.length, 3);
}));

test('large projection batches remain one atomic original change rather than splitting at replay-page size', () => memory((db, log) => {
  const start = log.latestEventId(), original = db.exec.bind(db), statements: string[] = [];
  db.exec = sql => { statements.push(sql); original(sql); };
  const result = executeConnectorEvent('eventProjectionAppend', { events: Array.from({ length: 200 }, () => event()) }, log);
  assert.deepEqual(statements, ['BEGIN IMMEDIATE', 'COMMIT']);
  assert.equal(result.cursor, start.replace(/:0$/, ':200'));
  assert.equal(executeConnectorEvent('eventReplay', { after: start }, log).events.length, 64);
}));

test('bounded replay byte budget and envelope corruption fail closed without partial delivery', () => memory((db, log) => {
  const start = log.latestEventId();
  for (let n = 0; n < 8; n++) log.append(event('x'.repeat(100 * 1024)));
  const page = executeConnectorEvent('eventReplay', { after: start }, log);
  assert.equal(page.events.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(page.events)) < 512 * 1024);
  db.prepare('UPDATE connector_events SET body = ? WHERE seq = 1').run(JSON.stringify({ ...event(), id: otherEpoch + '1' }));
  assert.throws(() => executeConnectorEvent('eventReplay', { after: start }, log), /connector_storage_unavailable/);
}));

test('projection append keeps original one-transaction invalidations and oversized reset semantics', () => memory((db, log) => {
  const original = db.exec.bind(db), statements: string[] = [], start = log.latestEventId();
  db.exec = sql => { statements.push(sql); original(sql); };
  const result = executeConnectorEvent('eventProjectionAppend', { events: [
    { ...event({ id: 'message-1', text: 'private-message-body' }), type: 'message.updated' }, event('x'.repeat(130 * 1024)),
  ] }, log);
  assert.deepEqual(statements, ['BEGIN IMMEDIATE', 'COMMIT']);
  assert.equal(result.cursor, log.latestEventId());
  const page = executeConnectorEvent('eventReplay', { after: start }, log);
  assert.deepEqual(page.events.map(row => row.type), ['message.updated', 'stream.reset']);
  assert.equal(JSON.stringify(page).includes('private-message-body'), false);
  assert.equal((page.events[0]!.payload as { invalidation: boolean }).invalidation, true);
}));

test('projection failure stays closed; only explicit original-owner recovery retires its epoch', () => memory((db, log) => {
  const start = log.latestEventId();
  db.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'private-db-error'); END");
  assert.deepEqual(executeConnectorEvent('eventProjectionAppend', { events: [event()] }, log), { cursor: null });
  assert.throws(() => executeConnectorEvent('eventReplay', { after: start }, log));
  assert.deepEqual(executeConnectorEvent('eventProjectionRecover', {}, log), { recovered: false, cursor: null });
  db.exec('DROP TRIGGER reject_projection');
  const recovered = executeConnectorEvent('eventProjectionRecover', {}, log);
  assert.equal(recovered.recovered, true); assert.ok(recovered.cursor?.endsWith(':0')); assert.notEqual(recovered.cursor, start);
  assert.equal(executeConnectorEvent('eventReplay', { after: start }, log).known, false);
  assert.ok(executeConnectorEvent('eventProjectionAppend', { events: [event()] }, log).cursor?.endsWith(':1'));
}));

test('transaction failure cannot be healed by projection recovery or reset', () => memory((db, log) => {
  db.exec('BEGIN IMMEDIATE');
  assert.deepEqual(executeConnectorEvent('eventProjectionAppend', { events: [event()] }, log), { cursor: null });
  assert.equal(db.isTransaction, true); db.exec('ROLLBACK');
  assert.deepEqual(executeConnectorEvent('eventProjectionRecover', {}, log), { recovered: false, cursor: null });
  assert.throws(() => executeConnectorEvent('eventProjectionReset', {}, log));
}));

test('execution fact/event rollback remains in original transaction, not an independent append command', () => memory((db, log) => {
  const start = log.latestEventId(); db.exec('CREATE TABLE original_fact(id TEXT PRIMARY KEY)');
  db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO original_fact VALUES (?)').run('fact');
  log.appendInTransaction(db, event({ execution: 'fact' })); db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM original_fact').get()!.n, 0);
  assert.deepEqual(executeConnectorEvent('eventReplay', { after: start }, log), { cursor: start, known: true, events: [] });
}));

test('malformed replay pages never acknowledge another request, sequence or epoch', () => {
  const saved = (n: number): DeckEvent => ({ ...event(), id: epoch + n });
  const reply = { cursor: epoch + '3', known: true, events: [saved(1), saved(2)] };
  assert.equal(connectorEventReplayMatches(epoch + '0', reply), true);
  for (const invalid of [
    { ...reply, events: [saved(2)] }, { ...reply, events: [saved(1), saved(3)] },
    { ...reply, events: [saved(0)] }, { ...reply, events: [saved(4)] },
    { ...reply, events: [{ ...saved(1), id: otherEpoch + '1' }] }, { ...reply, known: false },
    { ...reply, events: [] }, { ...reply, events: [saved(1), saved(1)] },
  ]) assert.equal(connectorEventReplayMatches(epoch + '0', invalid), false);
  assert.equal(connectorEventReplayMatches(otherEpoch + '0', reply), false);
  assert.equal(connectorEventReplayMatches(null, reply), false);
});

test('original complete store commands compose with shared execution and queue participants', () => disk(async file => {
  const store = new ConnectorUserStore(file);
  try {
    const command = createConnectorOwnerCommands(store), start = await command('eventReplay', { after: null });
    await command('eventProjectionAppend', { events: [event()] });
    assert.equal((await command('eventReplay', { after: start.cursor })).events.length, 1);
    assert.equal(typeof await command('interactionCount', {}), 'number');
    const reset = await command('eventProjectionReset', {});
    assert.equal((await command('eventReplay', { after: start.cursor })).known, false);
    assert.equal((await command('eventProjectionRecover', {})).cursor, reset);
  } finally { store.close(); }
}));

test('real complete-owner worker persists event pages and reopens without hidden write replay', () => disk(async file => {
  const owner = new AsyncConnectorOwner({ file }, silence); await owner.open();
  const start = await owner.command('eventReplay', { after: null });
  try {
    const appended = await owner.command('eventProjectionAppend', { events: [event({ marker: 'committed-once' })] });
    const page = await owner.command('eventReplay', { after: start.cursor });
    assert.equal(page.events.length, 1); assert.equal(page.cursor, appended.cursor);
  } finally { await owner.close(); }
  const next = new AsyncConnectorOwner({ file }, silence); await next.open();
  try {
    const page = await next.command('eventReplay', { after: start.cursor });
    assert.equal(page.events.length, 1); assert.deepEqual(page.events[0]!.payload, { marker: 'committed-once' });
  } finally { await next.close(); }
}));

for (const kind of ['getter', 'proxy', 'toJSON', 'too-many', 'too-large'] as const)
  test(`event append rejects ${kind} before dispatch`, () => disk(async file => {
    const fake = new FakeWorker(), owner = new AsyncConnectorOwner({ file }, silence, () => fake as unknown as Worker); fake.ready();
    let invoked = 0;
    const body = kind === 'getter' ? Object.defineProperty({}, 'events', { enumerable: true, get() { invoked++; return []; } })
      : kind === 'proxy' ? new Proxy({}, { ownKeys() { invoked++; return []; } })
      : kind === 'toJSON' ? { events: [event({ toJSON() { invoked++; return 'private'; } })] }
      : { events: kind === 'too-many' ? Array.from({ length: CONNECTOR_EVENT_BATCH_LIMIT + 1 }, () => event()) : [event('x'.repeat(CONNECTOR_EVENT_COMMAND_BYTES))] };
    try {
      await assert.rejects(owner.command('eventProjectionAppend', body as never), ConnectorOwnerUnavailable);
      assert.equal(invoked, 0); assert.equal(fake.messages.length, 0); assert.equal(owner.snapshot().accepted, 0);
    } finally { const close = owner.close(); await tick(); fake.reply(0, null); fake.emit('exit', 0); await close; }
  }));

test('replay transport rejects a structurally valid page for a different original cursor', () => disk(async file => {
  const fake = new FakeWorker(), owner = new AsyncConnectorOwner({ file }, silence, () => fake as unknown as Worker); fake.ready();
  const pending = owner.command('eventReplay', { after: epoch + '0' }); await tick();
  fake.reply(0, { cursor: epoch + '2', known: true, events: [{ ...event(), id: epoch + '2' }] });
  await assert.rejects(pending, ConnectorOwnerUnavailable); assert.equal(owner.snapshot().unavailable, true);
  const close = owner.close(); fake.emit('exit', 1); await assert.rejects(close, ConnectorOwnerUnavailable);
}));

test('projection-unavailable reply emits redacted failure evidence but does not replace or poison the owner', () => disk(async file => {
  const records: string[] = [], diagnostics = new PerformanceDiagnostics(line => records.push(line));
  const fake = new FakeWorker(), owner = new AsyncConnectorOwner({ file }, diagnostics, () => fake as unknown as Worker); fake.ready();
  const pending = owner.command('eventProjectionAppend', { events: [event('private-projection-body')] }); await tick();
  fake.reply(0, { cursor: null }); assert.deepEqual(await pending, { cursor: null });
  assert.equal(owner.snapshot().unavailable, false); assert.equal(fake.messages.length, 1); assert.equal(fake.stops, 0);
  const lines = records.map(line => JSON.parse(line));
  assert.ok(lines.some(line => line.operation === 'connector-sqlite-command' && line.step === 93 && line.unknown === 1 && line.category === 'failed'));
  assert.equal(records.join('\n').includes('private-projection-body'), false);
  const close = owner.close(); await tick(); fake.reply(1, null); fake.emit('exit', 0); await close;
}));

test('unknown append ACK never replays and retains owner reservation until real exit', () => disk(async file => {
  const records: string[] = [], diagnostics = new PerformanceDiagnostics(line => records.push(line));
  const fake = new FakeWorker(), owner = new AsyncConnectorOwner({ file }, diagnostics, () => fake as unknown as Worker); fake.ready();
  const pending = owner.command('eventProjectionAppend', { events: [event('private-event-payload')] }); await tick();
  fake.emit('message', { id: fake.messages[0]!.id, kind: 'eventProjectionAppend', ok: true, body: '{bad' });
  await assert.rejects(pending, ConnectorOwnerUnavailable);
  await assert.rejects(owner.command('eventProjectionAppend', { events: [event()] }), ConnectorOwnerUnavailable);
  assert.equal(fake.messages.length, 1); assert.equal(owner.snapshot().ownerExitConfirmed, false);
  assert.throws(() => new AsyncConnectorOwner({ file }, silence, () => new FakeWorker() as unknown as Worker), ConnectorOwnerUnavailable);
  const close = owner.close(); fake.emit('exit', 1); await assert.rejects(close, ConnectorOwnerUnavailable);
  assert.ok(records.length > 0);
  assert.equal(records.join('\n').includes('private-event-payload'), false);
  assert.equal(records.join('\n').includes(file), false);
}));
