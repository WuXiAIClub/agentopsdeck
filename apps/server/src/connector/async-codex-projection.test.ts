import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { DeckStore, type CodexExecutionProjection } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { CodexExecution } from '../codex/executions.js';
import type { CodexNativeNotification } from '../codex/native-notification.js';

const key = 'codex:display', connection = 'original-connection';
const event = (changes: Partial<CodexNativeNotification> = {}): CodexNativeNotification => ({ sessionKey: key,
  connectionId: connection, runId: 'original-run', kind: 'item', phase: null, successorItemTurnId: null,
  projectable: true, tool: null, ...changes });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ok => { resolve = ok; });
  return { promise, resolve };
}
async function fixture(records = 1, maxFacts?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-display-'));
  const config = { file: join(directory, 'connector.sqlite') }, logs: any[] = [];
  const seed = new ConnectorUserStore(config.file);
  for (let index = 0; index < records; index++) {
    const session = index ? `codex:page-${String(index).padStart(3, '0')}` : key;
    seed.codexExecutions.begin(session, 'original-command', connection);
    seed.codexExecutions.acknowledge(session, 'original-command', connection, 'original-run', () => {});
  }
  seed.close();
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  const owner = new AsyncConnectorOwner(config, diagnostics);
  await owner.open();
  const deck = new DeckStore();
  // Original discovered session exists before the async display binding opens.
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  let current: string | undefined = connection;
  let source!: CodexExecutionProjection;
  const bind = deck.bindCodexExecutionProjection.bind(deck);
  deck.bindCodexExecutionProjection = (projection, getter) => { source = projection; bind(projection, getter); };
  const projection = new AsyncCodexProjection({ owner, deck, connectionId: () => current, diagnostics,
    ...(maxFacts === undefined ? {} : { maxFacts }) });
  return { owner, deck, projection, source, config, logs,
    connection(value: string | undefined) { current = value; return projection.connectionChanged(); },
    async close() { await projection.close(); await owner.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('closing invalidates cached observations immediately while admitted physical work drains successfully', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred();
  const command = f.owner.command.bind(f.owner);
  let hold = false;
  f.owner.command = (async (kind: any, input: any) => {
    if (hold && kind === 'codexExecutionRead') { hold = false; entered.resolve(); await gate.promise; }
    return command(kind, input);
  }) as typeof f.owner.command;
  try {
    await f.projection.open();
    assert.ok(f.source.get(key));
    hold = true;
    const pending = f.projection.project(key); await entered.promise;
    let closed = false;
    const close = f.projection.close().then(() => { closed = true; });
    assert.throws(() => f.source.get(key), /unavailable/);
    assert.throws(() => f.source.sessionPage('', 16), /unavailable/);
    await assert.rejects(f.projection.project(key), /unavailable/);
    await tick(); assert.equal(closed, false);
    gate.resolve(); await pending; await close;
    assert.equal(f.projection.status().unavailable, false);
    assert.equal(f.projection.status().pending, 0);
    assert.throws(() => f.source.get(key), /unavailable/);
    assert.throws(() => f.source.sessionPage('', 16), /unavailable/);
  } finally { gate.resolve(); await f.close(); }
});

test('real worker bootstrap and native settlement retain original DeckStore wire semantics and isolate display facts', async () => {
  const f = await fixture(66);
  try {
    assert.throws(() => f.source.get(key), /unavailable/);
    await f.projection.open();
    assert.equal(f.projection.status().facts, 66);
    assert.equal(f.deck.getSession(key)?.runtime?.phase, 'running');
    const observed = f.source.get(key)!;
    observed.phase = 'completed'; observed.connectionId = 'forged';
    assert.equal(f.source.get(key)?.phase, 'running');
    await f.projection.project(key, observed); // caller cannot inject terminal display facts
    assert.equal(f.deck.getSession(key)?.runtime?.phase, 'running');
    await f.projection.settle(event({ kind: 'complete', phase: 'completed' }));
    assert.equal(f.deck.getSession(key)?.runtime?.phase, 'completed');
    assert.equal(f.deck.getSession(key)?.runtime?.sync, 'syncing');
    const fact = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    await f.owner.command('codexNativeHistorySettle', { expected: fact, checkpoint: {
      turnId: 'original-run', connectionId: connection, fingerprint: 'a'.repeat(64), state: 'verified', reason: 'settled',
    } });
    await f.projection.project(key);
    assert.equal(f.deck.getSession(key)?.runtime?.executionProtection?.state, 'verified');
    await f.projection.settle(event({ kind: 'start', runId: 'successor-run', phase: 'running' }));
    assert.equal(f.deck.getSession(key)?.runtime?.executionProtection?.state, 'blocked');
    assert.equal(f.source.get(key)?.runId, 'original-run', 'successor activity is not a new command ACK');
    assert.ok(f.logs.some(log => log.operation === 'codex-projection' && log.settled === 1));
    assert.doesNotMatch(JSON.stringify(f.logs), /original-command|original-run|original-connection|successor-run|codex:display/);
  } finally { await f.close(); }
});

test('original DeckStore forbids synchronous and worker display writers in either binding order', async () => {
  const f = await fixture();
  const legacy = new ConnectorUserStore(':memory:');
  try {
    assert.throws(() => f.deck.bindCodexExecutions(legacy.codexExecutions, () => connection), /already bound/);
    assert.throws(() => f.deck.bindCodexExecutionProjection(f.source, () => connection), /already bound/);
    const sync = new DeckStore();
    sync.bindCodexExecutions(legacy.codexExecutions, () => connection);
    sync.bindCodexExecutions(legacy.codexExecutions, () => connection); // original same-owner compatibility
    assert.throws(() => sync.bindCodexExecutionProjection(f.source, () => connection), /already bound/);
  } finally { legacy.close(); await f.close(); }
});

test('real connection pages preserve unknown ACK and blocked checkpoint without replay or unlock', async () => {
  const f = await fixture(66);
  try {
    await f.projection.open();
    let after = ''; const sizes: number[] = [];
    for (;;) {
      const page = await f.projection.invalidateConnectionPage(after, 64, connection, 'new-connection');
      if (!page.length) break;
      sizes.push(page.length); after = page.at(-1)!;
    }
    assert.deepEqual(sizes, [64, 2]);
    await f.connection('new-connection');
    const projected = f.deck.getSession(key)!;
    assert.equal(projected.runtime?.phase, 'unknown');
    assert.equal(projected.runtime?.reason, 'connection_replaced');
    assert.equal(f.source.get(key)?.commandId, 'original-command');
    assert.equal(f.source.get(key)?.runId, 'original-run');
    assert.equal((await f.owner.command('codexExecutionRead', { sessionKey: key }))?.phase, 'unknown');
  } finally { await f.close(); }
});

for (const mode of ['ABA', 'close'] as const) test(`held display read ${mode} keeps physical owner and fences stale publication`, async () => {
  const f = await fixture();
  const gate = deferred(), entered = deferred();
  const command = f.owner.command.bind(f.owner);
  let hold = false;
  f.owner.command = (async (kind: any, input: any) => {
    const result = await command(kind, input);
    if (hold && kind === 'codexExecutionRead') { hold = false; entered.resolve(); await gate.promise; }
    return result;
  }) as typeof f.owner.command;
  try {
    await f.projection.open();
    const publications: string[] = [];
    const original = f.deck.projectCodexExecution.bind(f.deck);
    f.deck.projectCodexExecution = session => { publications.push(session); return original(session); };
    const originalConnection = f.deck.projectCodexConnection.bind(f.deck);
    f.deck.projectCodexConnection = () => { publications.push('connection'); originalConnection(); };
    hold = true;
    const physical = f.projection.project(key);
    await entered.promise;
    if (mode === 'ABA') {
      const replaced = f.connection('replacement'); const restored = f.connection(connection);
      gate.resolve(); await physical; await replaced; await restored;
      assert.deepEqual(publications, ['connection'], 'only latest connection-wide publication survives ABA');
    } else {
      let closed = false;
      Object.defineProperty(physical, 'then', { value() { throw Error('public then is not physical completion'); } });
      const close = f.projection.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      await assert.rejects(f.projection.project(key), /unavailable/);
      gate.resolve(); await physical; await close;
      assert.equal(f.projection.status().pending, 0);
      assert.equal(f.projection.status().unavailable, false, 'normal close is not a storage failure');
    }
  } finally { gate.resolve(); await f.close(); }
});

test('committed notification survives readback failure and restart, without reissuing the accepted mutation', async () => {
  const f = await fixture();
  const command = f.owner.command.bind(f.owner);
  let writes = 0, failRead = false;
  f.owner.command = (async (kind: any, input: any) => {
    if (kind === 'codexNativeNotification') { writes++; failRead = true; }
    if (kind === 'codexExecutionRead' && failRead) throw Error('private readback details');
    return command(kind, input);
  }) as typeof f.owner.command;
  try {
    await f.projection.open();
    await assert.rejects(f.projection.settle(event({ kind: 'complete', phase: 'completed' })), /unavailable/);
    await assert.rejects(f.projection.settle(event({ kind: 'complete', phase: 'completed' })), /unavailable/);
    assert.equal(writes, 1);
    assert.throws(() => f.source.get(key), /unavailable/);
    await f.projection.close(); await f.owner.close();
    const reopened = new ConnectorUserStore(f.config.file);
    try {
      const fact = reopened.codexExecutions.get(key)!;
      assert.equal(fact.phase, 'completed'); assert.equal(fact.commandId, 'original-command');
      assert.equal(fact.runId, 'original-run'); assert.equal(fact.sync, 'syncing');
      assert.equal(reopened.codexExecutions.canStart(key), false);
    } finally { reopened.close(); }
    assert.doesNotMatch(JSON.stringify(f.logs), /private readback details/);
  } finally { await f.close(); }
});

test('original projection preserves active successor and historical sync error as separate dimensions', async () => {
  const f = await fixture();
  try {
    await f.projection.open();
    await f.projection.settle(event({ kind: 'complete', phase: 'completed' }));
    const fact = (await f.owner.command('codexExecutionRead', { sessionKey: key }))!;
    await f.owner.command('codexHistorySettle', { expected: { sessionKey: key, commandId: fact.commandId, runId: fact.runId! }, sync: 'error' });
    const session = f.deck.getSession(key)!;
    f.deck.upsertSession({ ...session, runtime: { ...session.runtime!, threadActivity: 'running' } });
    await f.projection.project(key);
    const projected = f.deck.getSession(key)!;
    assert.equal(projected.runtime?.phase, 'completed');
    assert.equal(projected.runtime?.sync, 'error');
    assert.equal(projected.runtime?.threadActivity, 'running');
    assert.equal(projected.hasActiveRun, true, 'old-turn history warning cannot stop successor activity');
  } finally { await f.close(); }
});

test('bounded projection backlog fails closed but close still drains the held physical command', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred();
  const command = f.owner.command.bind(f.owner);
  let hold = false;
  f.owner.command = (async (kind: any, input: any) => {
    if (hold && kind === 'codexExecutionRead') { hold = false; entered.resolve(); await gate.promise; }
    return command(kind, input);
  }) as typeof f.owner.command;
  try {
    await f.projection.open(); hold = true;
    const held = f.projection.project(key).catch(() => {}); await entered.promise;
    const queued = Array.from({ length: 127 }, () => f.projection.project(key).catch(() => {}));
    await assert.rejects(f.projection.project(key), /unavailable/);
    assert.equal(f.projection.status().pending, 128);
    let closed = false;
    const close = f.projection.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    gate.resolve(); await held; await Promise.all(queued); await close;
    assert.equal(f.projection.status().pending, 0);
    assert.equal(f.projection.status().unavailable, true);
  } finally { gate.resolve(); await f.close(); }
});

for (const mode of ['repeated', 'foreign', 'wrong-fact', 'rejected', 'capacity'] as const)
  test(`bootstrap ${mode} fails closed, never publishes a partial healthy snapshot`, async () => {
    const f = await fixture(66, mode === 'capacity' ? 64 : undefined);
    const command = f.owner.command.bind(f.owner);
    let pages = 0;
    f.owner.command = (async (kind: any, input: any) => {
      if (kind === 'executionSessionPage' && ++pages === 2) {
        if (mode === 'repeated') return [input.after];
        if (mode === 'foreign') return ['hermes:foreign'];
        if (mode === 'rejected') throw Error('secret database error');
      }
      const result = await command(kind, input);
      if (kind === 'codexExecutionRead' && mode === 'wrong-fact') return { ...result as CodexExecution, sessionKey: 'codex:wrong' };
      return result;
    }) as typeof f.owner.command;
    try {
      const before = f.deck.latestEventId();
      await assert.rejects(f.projection.open(), /unavailable/);
      assert.equal(f.deck.latestEventId(), before);
      assert.equal(f.projection.status().ready, false);
      assert.equal(f.projection.status().unavailable, true);
      assert.throws(() => f.source.get(key), /unavailable/);
      const count = pages;
      await assert.rejects(f.projection.open(), /unavailable/);
      assert.equal(pages, count, 'failure does not replay bootstrap');
      assert.doesNotMatch(JSON.stringify(f.logs), /secret database error|codex:wrong|hermes:foreign/);
    } finally { await f.close(); }
  });

test('accepted notification is snapshotted while queued; close drains original mutation and readback', async () => {
  const f = await fixture();
  const command = f.owner.command.bind(f.owner), gate = deferred(), entered = deferred();
  let hold = false;
  f.owner.command = (async (kind: any, input: any) => {
    if (hold && kind === 'codexExecutionRead') { hold = false; entered.resolve(); await gate.promise; }
    return command(kind, input);
  }) as typeof f.owner.command;
  try {
    await f.projection.open(); hold = true;
    const reading = f.projection.project(key); await entered.promise;
    const notification = event({ kind: 'complete', phase: 'completed' });
    const settlement = f.projection.settle(notification);
    notification.runId = 'caller-forged'; notification.phase = 'failed';
    const close = f.projection.close();
    gate.resolve(); await reading; await settlement; await close;
    assert.equal((await command('codexExecutionRead', { sessionKey: key }))?.phase, 'completed');
    assert.equal((await command('codexExecutionRead', { sessionKey: key }))?.runId, 'original-run');
    assert.throws(() => f.source.get(key), /unavailable/);
  } finally { gate.resolve(); await f.close(); }
});

test('bootstrap connection ABA publishes only the latest generation after every accepted page finishes', async () => {
  const f = await fixture(66), gate = deferred(), entered = deferred();
  const command = f.owner.command.bind(f.owner);
  let hold = true, pages = 0, publications = 0;
  f.owner.command = (async (kind: any, input: any) => {
    const result = await command(kind, input);
    if (kind === 'executionSessionPage') {
      pages++;
      if (hold) { hold = false; entered.resolve(); await gate.promise; }
    }
    return result;
  }) as typeof f.owner.command;
  const project = f.deck.projectCodexConnection.bind(f.deck);
  f.deck.projectCodexConnection = () => { publications++; project(); };
  try {
    const open = f.projection.open(); await entered.promise;
    const replaced = f.connection('replacement'), restored = f.connection(connection);
    gate.resolve(); await open; await replaced; await restored;
    assert.equal(pages, 3, '64 + 2 + final empty page physically read');
    assert.equal(f.projection.status().facts, 66);
    assert.equal(publications, 1);
  } finally { gate.resolve(); await f.close(); }
});
