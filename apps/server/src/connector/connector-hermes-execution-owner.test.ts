import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesExecution } from './async-hermes-execution.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, connectorOwnerLargeInput } from './connector-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { executeConnectorHermesExecution, validConnectorHermesExecutionInput, type ConnectorHermesExecutionKind } from './connector-hermes-execution-domain.js';
import type { HermesExecution } from '../hermes/journal.js';
import type { HermesHistoryRow } from '../hermes/history.js';

const silence = new PerformanceDiagnostics(() => {}), tick = () => new Promise<void>(resolve => setImmediate(resolve));
const original = (key = 'hermes:original'): HermesExecution => ({ id: `run-${key}`, key, live: 'live', epoch: 'epoch', phase: 'starting', members: [`m-${key}`], at: 1, updated: 1 });
const running = (e = original()): HermesExecution => ({ ...e, phase: 'running', row: 1, updated: 2 });
const rows: HermesHistoryRow[] = [{ row_id: 1, role: 'user', text: 'private prompt', timestamp: 1 },
  { row_id: 2, role: 'assistant', text: 'private reply', timestamp: 2 }];
const terminal = () => ({ execution: running(), phase: 'completed' as const, stored: 'rotated', rows });
async function disk(work: (file: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-original-owner-'));
  try { await work(join(root, 'connector.sqlite')); } finally { rmSync(root, { recursive: true, force: true }); }
}
async function seed(store: ConnectorUserStore, e = original()) {
  store.hermesJournal.save({ key: e.key, title: 'Original', stored: 'stored', started: false, messages: [] });
  for (const id of e.members) await store.turns.enqueueAsync('hermes', { id, sessionKey: e.key, createdAt: 1, payload: { text: 'private prompt', actorId: 'owner' } });
  assert.equal(store.hermesJournal.begin(e, store.turns), true);
}
class Fake extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { return Promise.resolve(0); }
  reply(index: number, value: unknown) {
    const request = this.messages[index]!;
    this.emit('message', { id: request.id, kind: request.kind, ok: true, body: JSON.stringify(value) });
  }
}

test('Hermes fixed commands refuse caller authority, callbacks, SQL and malformed lineage before touching owner', () => {
  const unavailable = new Proxy({}, { get() { throw Error('owner touched'); } }) as ConnectorUserStore;
  const inputs = { hermesExecutionRead: { sessionKey: original().key }, hermesExecutionPage: { after: '', limit: 64 },
    hermesRecoveryPage: { after: '', limit: 64 }, hermesExecutionAdmitted: { execution: running() },
    hermesExecutionUnknown: { execution: original() }, hermesExecutionTerminal: terminal(),
    hermesExecutionTool: { execution: running(), observation: { toolId: 'tool', phase: 'call', at: 1 } } };
  for (const kind of Object.keys(inputs) as ConnectorHermesExecutionKind[]) {
    assert.equal(validConnectorHermesExecutionInput(kind, inputs[kind]), true);
    for (const name of ['sql', 'authorized', 'callback', 'dispatch', 'unlock', 'replay']) {
      const input = { ...inputs[kind], [name]: true };
      assert.equal(validConnectorHermesExecutionInput(kind, input), false);
      assert.throws(() => executeConnectorHermesExecution(kind, input as never, unavailable), /connector_storage_unavailable/);
    }
  }
  for (const input of [{ ...terminal(), rows: rows.slice(1) }, { ...terminal(), execution: original() },
    { ...terminal(), rows: [rows[0], rows[0]] }, { ...terminal(), stored: '' }, { ...terminal(), rows: [{ ...rows[0], hidden: 'yes' }] }])
    assert.equal(validConnectorHermesExecutionInput('hermesExecutionTerminal', input), false);
  assert.equal(validConnectorHermesExecutionInput('hermesRecoveryPage', { after: '', limit: 65 }), false);
  assert.equal(validConnectorHermesExecutionInput('hermesExecutionRead', { sessionKey: 'codex:foreign' }), false);
});

test('real Hermes worker commits original native receipt and rotated history, then reopens without replay', () => disk(async file => {
  const source = new ConnectorUserStore(file);
  try { await seed(source); await seed(source, original('hermes:unknown')); await seed(source, original('hermes:recover')); } finally { source.close(); }
  const owner = new AsyncConnectorOwner({ file }, silence), facade = new AsyncHermesExecution(owner);
  try {
    await owner.open(); assert.deepEqual(await facade.read(original().key), original());
    assert.equal(await facade.admitted(running()), true);
    const call = await facade.tool(running(), { toolId: 'one', phase: 'call', name: 'terminal', at: 3 });
    assert.ok(call);
    assert.deepEqual(await facade.tool(running(), { toolId: 'one', phase: 'call', name: 'changed', at: 999 }), call);
    const result = await facade.tool(running(), { toolId: 'one', phase: 'result', at: 4 });
    assert.equal(result?.toolName, 'terminal');
    for (const field of ['id', 'live', 'epoch', 'at', 'members'] as const) {
      const changed = { ...running(), [field]: field === 'members' ? ['foreign'] : field === 'at' ? 999 : 'foreign' };
      assert.equal(await facade.tool(changed, { toolId: 'foreign', phase: 'call', at: 5 }), null);
    }
    assert.equal(await facade.terminal(running(), 'completed', 'rotated', rows), true);
    assert.equal(await facade.terminal(running(), 'completed', 'foreign', rows), false);
    assert.equal(await facade.tool(running(), { toolId: 'late', phase: 'call', at: 6 }), null);
    const unknown = original('hermes:unknown');
    assert.ok(await facade.tool(unknown, { toolId: 'lost', phase: 'call', at: 7 }));
    assert.equal(await facade.unknown(unknown), true);
    assert.equal(await facade.unknown(unknown), true);
    assert.equal(await facade.tool(unknown, { toolId: 'unknown', phase: 'call', at: 6 }), null);
    assert.equal(await facade.admitted(running(unknown)), false);
    assert.equal(await facade.terminal(running(unknown), 'completed', 'foreign', rows), false);
    assert.ok(await facade.tool(original('hermes:recover'), { toolId: 'lost', phase: 'call', at: 8 }));
    const keys = await facade.recoverPage('', 2); assert.deepEqual(keys, ['hermes:original', 'hermes:recover']);
    assert.equal((await facade.read('hermes:recover'))?.phase, 'unknown');
    await facade.recoverPage('', 2);
  } finally { await owner.close(); }
  const reopened = new AsyncConnectorOwner({ file }, silence);
  try { await reopened.open(); assert.equal((await reopened.command('hermesExecutionRead', { sessionKey: original().key }))?.phase, 'completed'); }
  finally { await reopened.close(); }
  const inspect = new ConnectorUserStore(file);
  try {
    const session = inspect.hermesJournal.session(original().key)!;
    assert.equal(session.stored, 'rotated'); assert.equal(session.messages.find(m => m.role === 'assistant')?.text, 'private reply');
    assert.equal(session.messages.find(m => m.role === 'user')?.id, original().members[0]);
    assert.deepEqual(session.messages.filter(m => m.role === 'tool').map(m => [m.toolPhase, m.toolName, m.createdAt]),
      [['call', 'terminal', 3], ['result', 'terminal', 4]]);
    assert.deepEqual(inspect.turns.list('hermes', original().key), []);
    for (const key of ['hermes:unknown', 'hermes:recover']) {
      const messages = inspect.hermesJournal.session(key)!.messages;
      assert.deepEqual(messages.filter(m => m.toolPhase === 'result').map(m => [m.toolCallId, m.status]),
        [[`run-${key}:lost`, 'outcome_unknown']]);
      assert.equal(inspect.hermesJournal.canStart(key), false);
      assert.equal(inspect.turns.list('hermes', key)[0]?.state, 'outcome_unknown');
    }
    for (const key of ['hermes:unknown', 'hermes:recover']) {
      assert.equal(inspect.hermesJournal.current(key)?.phase, 'unknown');
      assert.equal(inspect.turns.list('hermes', key)[0]?.state, 'outcome_unknown');
      assert.equal(inspect.hermesJournal.canStart(key), false);
    }
  } finally { inspect.close(); }
}));

test('Hermes recovery validates ALL original page facts before any freeze mutation', async () => {
  const store = new ConnectorUserStore(':memory:');
  try {
    await seed(store, original('hermes:a')); await seed(store, original('hermes:z'));
    store.hermesJournal.update({ ...original('hermes:z'), members: [] });
    assert.throws(() => executeConnectorHermesExecution('hermesRecoveryPage', { after: '', limit: 64 }, store), /unavailable/);
    assert.equal(store.hermesJournal.current('hermes:a')?.phase, 'starting');
    assert.equal(store.turns.list('hermes', 'hermes:a')[0]?.state, 'dispatching');
  } finally { store.close(); }
});

for (const field of ['toolId', 'phase'] as const) test(`Hermes tool owner retires on foreign ${field} ACK without replay`, () => disk(async file => {
  const fake = new Fake(), owner = new AsyncConnectorOwner({ file }, silence, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  const observation = { toolId: 'one', phase: 'call' as const, name: 'terminal', at: 3 };
  const pending = owner.command('hermesExecutionTool', { execution: running(), observation });
  const rejected = assert.rejects(pending, ConnectorOwnerUnavailable);
  observation.toolId = 'mutated-after-submit';
  await tick();
  const toolId = field === 'toolId' ? 'foreign' : 'one', phase = field === 'phase' ? 'result' : 'call';
  const toolCallId = `${original().id}:${toolId}`;
  fake.reply(0, { key: original().key, id: original().id, live: 'live', epoch: 'epoch', changed: true,
    message: { id: `hermes-tool:${toolCallId}:${phase}`, sessionKey: original().key, turnId: original().id,
      role: 'tool', toolCallId, toolName: 'terminal', toolPhase: phase,
      text: `Tool: terminal\n${phase === 'call' ? 'Started' : 'Completed'}`, status: phase === 'call' ? 'sending' : 'sent', createdAt: 3 } });
  await rejected;
  await assert.rejects(owner.command('hermesExecutionRead', { sessionKey: original().key }), ConnectorOwnerUnavailable);
  assert.equal(fake.messages.length, 1);
  const stopped = owner.closeForShutdown(); fake.emit('exit', 1); await stopped;
}));

test('Hermes tool fixed command rejects arbitrary content and invalid observation before original writer', () => {
  const unavailable = new Proxy({}, { get() { throw Error('owner touched'); } }) as ConnectorUserStore;
  for (const observation of [
    { toolId: '', phase: 'call', at: 1 }, { toolId: 'one\nprivate', phase: 'call', at: 1 },
    { toolId: 'one', phase: 'call', at: Infinity }, { toolId: 'one', phase: 'other', at: 1 },
    { toolId: 'one', phase: 'call', at: 1, name: 'x'.repeat(257) },
    ...['args', 'result', 'message', 'sql', 'authorized'].map(field => ({ toolId: 'one', phase: 'call', at: 1, [field]: 'private' })),
  ]) {
    const input = { execution: running(), observation };
    assert.equal(validConnectorHermesExecutionInput('hermesExecutionTool', input), false);
    assert.throws(() => executeConnectorHermesExecution('hermesExecutionTool', input as never, unavailable), /unavailable/);
  }
});

for (const field of ['key', 'id', 'live', 'epoch'] as const) test(`Hermes supervisor rejects foreign ${field} response and never retries native settlement`, () => disk(async file => {
  const fake = new Fake(), owner = new AsyncConnectorOwner({ file }, silence, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  const pending = owner.command('hermesExecutionTerminal', terminal());
  const rejected = assert.rejects(pending, ConnectorOwnerUnavailable);
  await tick();
  fake.reply(0, { key: original().key, id: original().id, live: 'live', epoch: 'epoch', changed: true, [field]: field === 'key' ? 'hermes:foreign' : 'foreign' });
  await rejected; assert.equal(fake.messages.length, 1);
  const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
}));

for (const kind of ['hermesExecutionRead', 'hermesExecutionPage', 'hermesRecoveryPage'] as const)
  test(`Hermes supervisor correlates ${kind} to original requested key and page boundary`, () => disk(async file => {
    const fake = new Fake(), owner = new AsyncConnectorOwner({ file }, silence, () => fake as unknown as Worker);
    fake.emit('message', { kind: 'ready' });
    const pending = kind === 'hermesExecutionRead' ? owner.command(kind, { sessionKey: 'hermes:original' })
      : owner.command(kind, { after: 'hermes:m', limit: 1 });
    const rejected = assert.rejects(pending, ConnectorOwnerUnavailable); await tick();
    fake.reply(0, kind === 'hermesExecutionRead' ? original('hermes:foreign') : ['hermes:a']);
    await rejected; assert.equal(fake.messages.length, 1);
    const stopped = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await stopped;
  }));

test('Hermes native snapshot uses shared single-flight large-input budget with no history truncation', () => disk(async file => {
  const fake = new Fake(), owner = new AsyncConnectorOwner({ file }, silence, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  const input = { ...terminal(), rows: [{ ...rows[0]!, text: 'x'.repeat(128 * 1024) }, rows[1]!] };
  assert.equal(connectorOwnerCommandBytes('hermesExecutionTerminal'), 64 * 1024 * 1024);
  assert.equal(connectorOwnerLargeInput('hermesExecutionTerminal', 128 * 1024), true);
  const pending = owner.command('hermesExecutionTerminal', input);
  await assert.rejects(owner.command('hermesExecutionTerminal', input), ConnectorOwnerUnavailable);
  await tick(); assert.equal(fake.messages.length, 1);
  assert.equal(JSON.parse(fake.messages[0]!.body).rows[0].text.length, 128 * 1024);
  fake.reply(0, { key: original().key, id: original().id, live: 'live', epoch: 'epoch', changed: true });
  await pending;
  const close = owner.close(); await tick(); fake.reply(1, null); fake.emit('exit', 0); await close;
}));
