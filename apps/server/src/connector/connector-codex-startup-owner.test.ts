import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexStartup, codexStartupDeckPublisher } from './async-codex-startup.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { validConnectorCodexStartupInput, validConnectorCodexStartupOutput, createConnectorCodexStartupCommands } from './connector-codex-startup-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { CodexAppServer } from '../codex/app-server.js';
import { DeckStore } from '../projection/deck-store.js';
import { recoverCodexStartup, readCodexStartupQueue } from '../codex/startup-recovery.js';
import { codexQueueDisposition, codexQueuedTurnMessage } from '../codex/queued-turn-projection.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { AsyncCodexScheduling } from './async-codex-scheduling.js';
import { AsyncCodexQueue } from './async-codex-queue.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { AsyncConnectorExecutionReads } from './async-execution-reads.js';

const key = 'codex:original';
const payload = (text = 'original text') => ({ text, images: [] });
const tick = () => new Promise<void>(ok => setImmediate(ok));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ok => { resolve = ok; });
  return { promise, resolve };
}
async function fixture(seed?: (store: ConnectorUserStore, queueFile: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-startup-'));
  const config = { file: join(directory, 'connector.sqlite'), codexQueueFile: join(directory, 'original.json') };
  const store = new ConnectorUserStore(config.file);
  try { await seed?.(store, config.codexQueueFile); }
  catch (error) { store.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  store.close();
  const logs: any[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  const owner = new AsyncConnectorOwner(config, diagnostics); await owner.open();
  return { owner, directory, config, logs, diagnostics,
    async close() { await owner.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('startup DTO is fixed, rejects caller paths/SQL/authority and malformed cursors/chunks', () => {
  assert.equal(validConnectorCodexStartupInput('codexStartupRecover', {}), true);
  for (const field of ['queueFile', 'sql', 'authorized', 'release', 'callback', 'replay']) {
    assert.equal(validConnectorCodexStartupInput('codexStartupRecover', { [field]: 'forged' }), false);
  }
  for (const after of ['', '-1', '01', '1.0', '9223372036854775808', '9'.repeat(100)]) {
    assert.equal(validConnectorCodexStartupInput('codexStartupQueuePage', { after, limit: 64 }), false);
  }
  for (const limit of [0, 65, 1.5]) assert.equal(validConnectorCodexStartupInput('codexStartupQueuePage', { after: '0', limit }), false);
  assert.equal(validConnectorCodexStartupOutput('codexStartupQueueChunk', 'YQ=='), true);
  for (const part of ['', 'YQ', 'Y Q==', 'YR==', 'a'.repeat(90000)]) assert.equal(validConnectorCodexStartupOutput('codexStartupQueueChunk', part), false);
  assert.equal(validConnectorCodexStartupInput('codexStartupQueueChunk', { sessionKey: key, id: 'x', version: '1:0', offset: 1 }), false);
});

test('real worker restores >64 original queued/blocked/unknown rows and ACK protection without dispatch', async () => {
  const f = await fixture(async store => {
    for (let i = 0; i < 67; i++) await store.turns.enqueueAsync('codex', { id: `turn-${i}`, sessionKey: i % 2 ? key : 'codex:other',
      createdAt: i, state: i === 0 ? 'blocked' : i === 1 ? 'dispatching' : 'queued', payload: payload() });
    store.codexExecutions.begin(key, 'original-command', 'old-connection');
    store.codexExecutions.acknowledge(key, 'original-command', 'old-connection', 'original-run', () => {});
  });
  const published: any[] = [];
  const startup = new AsyncCodexStartup({ owner: f.owner, diagnostics: f.diagnostics,
    publish: (turn, metadata) => { published.push({ turn, metadata }); } });
  try {
    await startup.open(); assert.equal(startup.status().ready, true); assert.equal(published.length, 67);
    assert.equal(published[0].turn.state, 'blocked'); assert.equal(published[1].turn.state, 'outcome_unknown');
    assert.deepEqual(published.map(row => row.turn.id), Array.from({ length: 67 }, (_, i) => `turn-${i}`));
    for (const row of published) assert.match(row.metadata.version, new RegExp(`^${row.metadata.sequence}:`));
    const fact = await f.owner.command('codexExecutionRead', { sessionKey: key });
    assert.equal(fact?.phase, 'unknown'); assert.equal(fact?.reason, 'restarted'); assert.equal(fact?.runId, 'original-run');
    // Repeating the fixed startup command must NOT rerun recovery against a live execution.
    await f.owner.command('codexNativeNotification', { sessionKey: key, connectionId: 'new-connection', runId: 'original-run',
      kind: 'start', phase: 'running', successorItemTurnId: null, projectable: true, tool: null });
    const before = await f.owner.command('codexExecutionRead', { sessionKey: key });
    await f.owner.command('codexStartupRecover', {});
    assert.deepEqual(await f.owner.command('codexExecutionRead', { sessionKey: key }), before);
    assert.ok(f.logs.some(row => row.operation === 'codex-startup' && row.phase === 'finished' && row.settled === 1));
    assert.ok(!JSON.stringify(f.logs).includes('original text'));
  } finally { await startup.close(); await f.close(); }
});

test('legacy payload beyond aggregate response budget reads in UTF-8 byte chunks and imports only once', async () => {
  // Larger than the 16MiB aggregate response reservation. No response limit is raised.
  const text = 's'.repeat(65503) + '你好🌍' + 'x'.repeat(17 * 1024 * 1024);
  let original = '';
  const f = await fixture((_store, queueFile) => {
    original = JSON.stringify({ queues: { [key]: [{ id: 'legacy', createdAt: 1, text, images: [], dispatchState: 'dispatching' }] } });
    writeFileSync(queueFile, original);
  });
  const rows: any[] = [], startup = new AsyncCodexStartup({ owner: f.owner, publish: turn => { rows.push(turn); } });
  try {
    await startup.open(); assert.equal(rows.length, 1); assert.equal(rows[0].payload.text, text);
    assert.equal(rows[0].state, 'outcome_unknown'); assert.equal(readFileSync(f.config.codexQueueFile, 'utf8'), original);
    await startup.close(); await f.owner.close();
    writeFileSync(f.config.codexQueueFile, '{broken file ignored after original marker');
    const reopened = new AsyncConnectorOwner(f.config); await reopened.open();
    const again: any[] = [], next = new AsyncCodexStartup({ owner: reopened, publish: turn => { again.push(turn); } });
    try { await next.open(); assert.equal(again.length, 1); assert.equal(again[0].payload.text, text); }
    finally { await next.close(); await reopened.close(); }
  } finally { await startup.close(); await f.close(); }
});

test('original Codex constructor uses shared bounded startup chain and original frontend queue mapping', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-original-startup-'));
  const store = new ConnectorUserStore(join(directory, 'connector.sqlite')), deck = new DeckStore();
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  for (let i = 0; i < 66; i++) await store.turns.enqueueAsync('codex', { id: `message-${i}`, sessionKey: key, createdAt: i,
    state: i === 0 ? 'dispatching' : i === 1 ? 'blocked' : 'queued', payload: payload() });
  const list = store.turns.list;
  store.turns.list = () => assert.fail('startup must not use unbounded list');
  let codex: CodexAppServer | undefined;
  try {
    codex = new CodexAppServer({ enabled: false, command: 'must-not-launch', defaultCwd: directory,
      defaultModel: 'model', approvalPolicy: 'never', store: deck, turnQueue: store.turns,
      executions: store.codexExecutions, authorizeTurn: () => true });
    const messages = deck.getMessages(key);
    assert.equal(messages.length, 66); assert.equal(messages[0]?.status, 'outcome_unknown');
    assert.equal(messages[1]?.status, 'failed'); assert.equal(messages[2]?.status, 'queued');
    assert.equal(messages[2]?.queueDisposition, 'waiting');
    for (const message of messages) assert.equal(message.queueVersion, store.turns.version('codex', key, message.id));
  } finally { store.turns.list = list; await codex?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real worker publishes complete startup through original DeckStore mapping without synchronous journal', async () => {
  const image = { filePath: '/private/image-path', media: { kind: 'image', url: '/media/original' } };
  const f = await fixture(async store => {
    for (let i = 0; i < 66; i++) await store.turns.enqueueAsync('codex', { id: `display-${i}`, sessionKey: key,
      createdAt: i, state: i === 0 ? 'blocked' : i === 1 ? 'dispatching' : 'queued',
      payload: { text: `private text ${i}`, images: [image], actorId: 'original-actor' } });
    store.codexExecutions.begin(key, 'display-0', 'original-connection');
  });
  const deck = new DeckStore();
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  const startup = new AsyncCodexStartup({ owner: f.owner, diagnostics: f.diagnostics, publish: codexStartupDeckPublisher(deck) });
  try {
    await startup.open();
    const messages = deck.getMessages(key);
    assert.equal(messages.length, 66); assert.equal(messages[0]?.status, 'failed');
    assert.equal(messages[0]?.queueDisposition, 'preparing');
    assert.equal(messages[1]?.status, 'outcome_unknown'); assert.equal(messages[1]?.queueDisposition, 'waiting');
    assert.equal(messages[65]?.status, 'queued'); assert.equal(messages[65]?.queueDisposition, 'waiting');
    assert.deepEqual(messages[0]?.media, [image.media]);
    assert.ok(messages.every(message => typeof message.queueVersion === 'string'));
    assert.ok(!JSON.stringify(f.logs).includes('private'));
    assert.ok(!JSON.stringify(f.logs).includes('original-actor'));
    // Display messages have neither raw attachment paths nor execution authority.
    assert.ok(!JSON.stringify(messages).includes('image-path'));
    assert.ok(!JSON.stringify(messages).includes('original-actor'));
  } finally { await startup.close(); await f.close(); }
});

test('shared queue mapping preserves active Goal/thread activity and blocked frontend semantics', () => {
  const deck = new DeckStore();
  const facts = { version: '1:0', headId: 'row', executionCommandId: null };
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'running' });
  assert.equal(codexQueueDisposition('row', facts, deck.getSession(key)), 'waiting');
  assert.equal(codexQueueDisposition('row', { ...facts, executionCommandId: 'row' }, deck.getSession(key)), 'preparing');
  assert.equal(codexQueueDisposition('tail', facts, undefined), 'waiting');
  assert.equal(codexQueueDisposition('row', facts, undefined), 'preparing');
  for (const patch of [
    { sync: 'error' as const },
    { phase: 'unknown' as const },
    { threadActivity: 'unknown' as const },
    { connection: 'disconnected' as const },
    { executionProtection: { state: 'blocked' as const, nativeTurnId: 't', reason: 'background-work' as const } },
  ]) {
    const blockedSession = {
      sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' as const,
      runtime: { turnId: 't', phase: 'completed' as const, sync: 'current' as const, threadActivity: 'idle' as const, connection: 'connected' as const, lastEventAt: 1, ...patch },
    };
    assert.equal(codexQueueDisposition('row', facts, blockedSession), 'waiting', JSON.stringify(patch));
  }
  const message = codexQueuedTurnMessage({ id: 'row', sessionKey: key, createdAt: 1, state: 'blocked', payload: payload() },
    facts, deck.getSession(key), 42);
  assert.equal(message.status, 'failed'); assert.equal(message.updatedAt, 42); assert.equal(message.queueVersion, '1:0');
  assert.equal(typeof message.failureReason, 'string'); assert.equal('media' in message, false);
});

test('worker startup page reads metadata only and chunk lease rejects interleaving and edits', () => {
  const store = new ConnectorUserStore(':memory:');
  try {
    store.turns.enqueue('codex', { id: 'row', sessionKey: key, createdAt: 0, payload: payload('a'.repeat(70000)) });
    const execute = createConnectorCodexStartupCommands(store);
    execute('codexStartupRecover', {});
    store.turns.head = () => assert.fail('metadata must not parse head payload');
    const page = execute('codexStartupQueuePage', { after: '0', limit: 64 });
    assert.equal(page[0]?.headId, 'row');
    const version = page[0]!.version;
    execute('codexStartupQueueChunk', { sessionKey: key, id: 'row', version, offset: 0 });
    assert.equal(store.turns.edit('codex', key, 'row', () => payload('edited'), version), true);
    assert.throws(() => execute('codexStartupQueueChunk', { sessionKey: key, id: 'row', version, offset: 65536 }), /unavailable/);
    assert.throws(() => execute('codexStartupQueuePage', { after: '0', limit: 64 }), /unavailable/);
    execute.dispose();
  } finally { store.close(); }
});

for (const interleave of [false, true]) test(`startup body is read once and private buffer wiped after ${interleave ? 'interleaved read failure' : 'last chunk'}`, () => {
  const store = new ConnectorUserStore(':memory:');
  try {
    store.turns.enqueue('codex', { id: 'row', sessionKey: key, createdAt: 0, payload: payload('a'.repeat(70000)) });
    const original = store.turns.bootstrapBody.bind(store.turns);
    let reads = 0, body: Buffer | undefined;
    store.turns.bootstrapBody = (...args) => { reads++; return body = original(...args); };
    const execute = createConnectorCodexStartupCommands(store);
    execute('codexStartupRecover', {});
    const version = execute('codexStartupQueuePage', { after: '0', limit: 64 })[0]!.version;
    assert.equal(Buffer.from(execute('codexStartupQueueChunk', { sessionKey: key, id: 'row', version, offset: 0 }), 'base64').length, 65536);
    if (interleave) assert.throws(() => execute('codexStartupQueuePage', { after: '0', limit: 64 }), /unavailable/);
    else assert.ok(Buffer.from(execute('codexStartupQueueChunk', { sessionKey: key, id: 'row', version, offset: 65536 }), 'base64').length > 0);
    assert.equal(reads, 1); assert.ok(body?.every(byte => byte === 0));
    execute.dispose();
  } finally { store.close(); }
});

for (const fault of ['read-failure', 'stale-proof']) test(`accepted chunk ${fault} does not publish torn prompt or retry`, async () => {
  const f = await fixture(store => store.turns.enqueueAsync('codex', { id: 'row', sessionKey: key, createdAt: 0,
    payload: payload('a'.repeat(70000)) }));
  const physical = f.owner.command.bind(f.owner);
  let chunks = 0;
  const publications: any[] = [];
  const wrapped = { command: async (kind: any, input: any) => {
    if (kind === 'codexStartupQueueChunk' && ++chunks === 2) {
      if (fault === 'read-failure') throw Error('private prompt/path');
      return physical(kind, { ...input, version: '999999:0' });
    }
    return physical(kind, input);
  } } as Pick<AsyncConnectorOwner, 'command'>;
  const startup = new AsyncCodexStartup({ owner: wrapped, diagnostics: f.diagnostics, publish: row => { publications.push(row); } });
  try {
    await assert.rejects(startup.open(), /unavailable/); assert.equal(publications.length, 0);
    assert.equal(startup.status().ready, false); assert.equal(startup.status().unavailable, true);
    await assert.rejects(startup.open(), /unavailable/); assert.equal(chunks, 2);
    assert.ok(!JSON.stringify(f.logs).includes('private'));
  } finally { await startup.close(); await f.close(); }
});

test('physical original queue chunks detect edit and delete/reinsert revisions', () => {
  const store = new ConnectorUserStore(':memory:');
  try {
    store.turns.enqueue('codex', { id: 'row', sessionKey: key, createdAt: 0, payload: payload('a'.repeat(70000)) });
    recoverCodexStartup(store);
    const before = store.turns.bootstrapPage('codex')[0]!;
    assert.ok(store.turns.bootstrapBody('codex', key, 'row', before.version));
    assert.equal(store.turns.edit('codex', key, 'row', () => payload('edited'), before.version), true);
    assert.throws(() => store.turns.bootstrapBody('codex', key, 'row', before.version), /unavailable/);
    const edited = store.turns.bootstrapPage('codex')[0]!;
    assert.equal(store.turns.cancel('codex', key, 'row', edited.version), true);
    store.turns.enqueue('codex', { id: 'row', sessionKey: key, createdAt: 0, payload: payload('replacement') });
    assert.throws(() => store.turns.bootstrapBody('codex', key, 'row', edited.version), /unavailable/);
    assert.notEqual(store.turns.bootstrapPage('codex')[0]!.sequence, before.sequence);
  } finally { store.close(); }
});

test('close drains accepted physical read and publication despite public Promise method replacement', async () => {
  const f = await fixture(store => store.turns.enqueueAsync('codex', { id: 'row', sessionKey: key, createdAt: 0, payload: payload() }));
  const held = deferred(), reached = deferred();
  const startup = new AsyncCodexStartup({ owner: f.owner, publish: async () => { reached.resolve(); await held.promise; } });
  const opened = startup.open(); await reached.promise;
  const originalThen = opened.then;
  opened.then = () => { throw Error('public then must not own physical drain'); };
  let drained = false; const close = startup.close().then(() => { drained = true; });
  try {
    await tick(); assert.equal(drained, false); held.resolve(); await close;
    assert.equal(startup.status().ready, false);
    await assert.rejects(startup.open(), /unavailable/);
  } finally { opened.then = originalThen; held.resolve(); await opened; await startup.close(); await f.close(); }
});

for (const broken of ['invalid-json', 'invalid-entry', 'too-many-rows'] as const) test(`legacy ${broken} fails closed, keeps original file and import transaction`, async () => {
  let original = '';
  const f = await fixture((_store, file) => {
    original = broken === 'invalid-json' ? '{invalid' : JSON.stringify({ queues: { [key]: broken === 'invalid-entry'
      ? [{ id: 'valid', text: 'one', images: [], createdAt: 1 }, { id: 'bad', text: 'two', images: null, createdAt: 2 }]
      : Array.from({ length: 10001 }, (_, i) => ({ id: String(i), text: 'one', images: [], createdAt: i })) } });
    writeFileSync(file, original);
  });
  const startup = new AsyncCodexStartup({ owner: f.owner, publish: () => assert.fail('failed import must not publish') });
  try {
    await assert.rejects(startup.open(), /unavailable/); assert.equal(startup.status().ready, false);
    assert.equal(await f.owner.command('turnMaintenanceCount', { runtime: 'codex' }), 0);
    assert.equal(readFileSync(f.config.codexQueueFile, 'utf8'), original);
    await f.owner.close(); const store = new ConnectorUserStore(f.config.file);
    try {
      // No marker was written on failure: a repaired legacy file can recover.
      writeFileSync(f.config.codexQueueFile, JSON.stringify({ queues: { [key]: [{ id: 'repaired', text: 'one', images: [], createdAt: 1 }] } }));
      recoverCodexStartup(store, f.config.codexQueueFile);
      assert.equal([...readCodexStartupQueue(store.turns)][0]?.id, 'repaired');
    } finally { store.close(); }
  } finally { await startup.close(); await f.close(); }
});

test('startup domain rejects reads before recovery and latches a failed bootstrap', () => {
  const store = new ConnectorUserStore(':memory:');
  try {
    const execute = createConnectorCodexStartupCommands(store);
    assert.throws(() => execute('codexStartupQueuePage', { after: '0', limit: 64 }), /unavailable/);
    assert.throws(() => execute('codexStartupRecover', {}), /unavailable/);
  } finally { store.close(); }
});

/** Exercise the original executor bootstrap, not just startup.open in isolation.
 * No legacy SQL recovery/import/display read is available even in construction. */
async function originalStartupFixture(options: { enabled?: boolean; beforeOpen?: () => Promise<void>;
  beforeProjection?: () => Promise<void> } = {}) {
  const f = await fixture(async store => {
    await store.turns.enqueueAsync('codex', { id: 'original-row', sessionKey: key, createdAt: 1, payload: payload() });
    store.codexExecutions.begin(key, 'interrupted-command', 'old-connection');
  });
  const deck = new DeckStore();
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  let runtime: any, opens = 0;
  const projection = new AsyncCodexProjection({ owner: f.owner, deck, bind: false,
    connectionId: () => runtime?.connectionId });
  const consumer = new AsyncCodexStartup({ owner: f.owner, diagnostics: f.diagnostics,
    projection: { async open() { await options.beforeProjection?.(); await projection.open(); } },
    publish: codexStartupDeckPublisher(deck) });
  const scheduling = new AsyncCodexScheduling(f.owner);
  const queuedConsumer = new AsyncCodexQueue({ owner: f.owner, local() {},
    dispatch: { async dispatch() { assert.fail('startup fixture cannot dispatch native work'); } },
    async prepare() { assert.fail('startup fixture cannot prepare native work'); } });
  const codex = new CodexAppServer({ enabled: options.enabled ?? true, command: 'must-not-launch', defaultCwd: f.directory,
    defaultModel: 'synthetic', approvalPolicy: 'never', store: deck,
    nativeJournal: projection.nativeJournal(), authorizeTurn: () => assert.fail('host permission is not authority'),
    scheduling, queuedConsumer, historyReader: new AsyncCodexHistory(f.owner, f.diagnostics),
    credentialExecutionReader: new AsyncConnectorExecutionReads(f.owner).codex,
    startup: { async open() { opens++; await options.beforeOpen?.(); await consumer.open(); },
      close: () => consumer.close() } });
  runtime = codex as any;
  return { ...f, codex, runtime, deck, opens: () => opens, async close() {
    await codex.close(); await projection.close(); await f.close();
  } };
}

test('projection readiness failure latches bootstrap before original message publication or activation', async () => {
  let projections = 0;
  const f = await originalStartupFixture({ beforeProjection: async () => {
    projections++; throw Error('projection unavailable');
  } });
  f.runtime.turnWorker.start = () => assert.fail('failed projection cannot activate scheduler');
  try {
    f.codex.startQueueWorker();
    await assert.rejects(f.codex.ready());
    await assert.rejects(f.codex.ready());
    assert.equal(projections, 1);
    assert.equal(f.deck.getMessages(key).length, 0);
    assert.equal(f.runtime.executionUnavailable, true);
  } finally { await f.close(); }
});

test('original async bootstrap gates queue activation, admission and inspection on one complete worker import', async () => {
  const gate = deferred(), f = await originalStartupFixture({ beforeOpen: () => gate.promise });
  let starts = 0;
  f.runtime.turnWorker.start = () => { starts++; };
  try {
    const first = f.codex.ready(), second = f.codex.ready();
    assert.equal(first, second);
    f.codex.startQueueWorker();
    const admission = assert.rejects(f.codex.send(key, ''), /message or image/);
    const inspecting = f.codex.inspectMaintenance();
    await tick(); assert.equal(f.opens(), 1); assert.equal(starts, 0);
    assert.equal(f.deck.getMessages(key).length, 0);
    gate.resolve(); await first; await admission;
    const snapshot = await inspecting;
    assert.equal(snapshot.pendingExecutions, 1); assert.equal(snapshot.queuedMessages, 1);
    assert.equal(starts, 1);
    assert.equal(f.deck.getMessages(key)[0]?.text, 'original text');
    assert.equal(f.runtime.executionUnavailable, false);
    assert.ok(f.logs.some(log => log.step === 249));
  } finally { gate.resolve(); await f.close(); }
});

test('original async bootstrap failure latches all later producers without synchronous recovery or retry', async () => {
  const f = await originalStartupFixture({ beforeOpen: async () => { throw Error('startup-failure'); } });
  f.runtime.turnWorker.start = () => assert.fail('failed startup must not activate queue');
  try {
    await assert.rejects(f.codex.ready(), /startup-failure/);
    f.codex.startQueueWorker();
    await assert.rejects(f.codex.ready(), /startup-failure/);
    await assert.rejects(f.codex.send(key, 'must not enqueue'), /startup-failure/);
    await assert.rejects(f.codex.inspectMaintenance(), /startup-failure/);
    assert.equal(f.opens(), 1); assert.equal(f.runtime.executionUnavailable, true);
    assert.equal(f.deck.getMessages(key).length, 0);
  } finally { await f.close(); }
});

for (const mode of ['disabled', 'closed'] as const) test(`original async bootstrap does not open a ${mode} executor`, async () => {
  const f = await originalStartupFixture({ enabled: mode !== 'disabled' });
  try {
    if (mode === 'closed') { await f.codex.close(); await assert.rejects(f.codex.ready(), /closed/); }
    else { await f.codex.ready(); f.codex.startQueueWorker(); }
    assert.equal(f.opens(), 0); assert.equal(f.deck.getMessages(key).length, 0);
  } finally { await f.close(); }
});

test('original close drains physical bootstrap even when caller replaces public Promise.then', async () => {
  const gate = deferred(), f = await originalStartupFixture({ beforeOpen: () => gate.promise });
  try {
    const opening = f.codex.ready(), rejected = assert.rejects(opening, /unavailable/);
    await tick();
    opening.then = (() => Promise.resolve()) as typeof opening.then;
    let closed = false;
    const closing = f.codex.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    gate.resolve(); await rejected; await closing;
    assert.equal(closed, true); assert.equal(f.opens(), 1);
  } finally { gate.resolve(); await f.close(); }
});
