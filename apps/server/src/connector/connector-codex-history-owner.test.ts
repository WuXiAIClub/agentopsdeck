import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessage } from '@agentopsdeck/shared';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { createConnectorCodexHistoryCommands, validConnectorCodexHistoryInput, validConnectorCodexHistoryOutput } from './connector-codex-history-domain.js';
import { CodexAppServer } from '../codex/app-server.js';
import { DeckStore } from '../projection/deck-store.js';
import { appendTurnContext } from '../codex/turn-context.js';
import { describeBatch } from '../codex/queued-batch.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const key = 'codex:history';
const message = (text = 'native text', id = 'echo', turnId = 'run'): ChatMessage => ({ id, turnId, sessionKey: key,
  role: 'user', text, createdAt: 123 });
const entry = (id: string, text = id) => ({ id, sessionKey: key, createdAt: 1, state: 'queued' as const, payload: { text, images: [] } });
async function fixture(seed?: (store: ConnectorUserStore) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-history-owner-')), file = join(dir, 'connector.sqlite');
  const store = new ConnectorUserStore(file);
  try { await seed?.(store); } finally { store.close(); }
  const logs: any[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  // Owner RPC observations have their own sampling budget; ordinary command
  // volume must not make assertions about the reader's separate trace flaky.
  const owner = new AsyncConnectorOwner({ file }, new PerformanceDiagnostics(() => {})); await owner.open();
  const reader = new AsyncCodexHistory(owner, diagnostics);
  return { owner, reader, logs, diagnostics, dir,
    async close() { await reader.close(); await owner.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('file worker history reads the entire mixed queue, UTF-8 chunks and original frontend mapping without main SQL', async () => {
  const text = 'a'.repeat(65503) + '你好🌍' + 'b'.repeat(65536);
  const f = await fixture(async store => {
    for (let i = 0; i < 67; i++) await store.turns.enqueueAsync('codex', { ...entry(`queued-${i}`, i === 0 ? text : `body-${i}`),
      state: i === 1 ? 'blocked' : i === 2 ? 'outcome_unknown' : i === 3 ? 'dispatching' : 'queued' });
    await store.turns.enqueueAsync('codex', { ...entry('other'), sessionKey: 'codex:other' });
  });
  const local = new ConnectorUserStore(':memory:'), deck = new DeckStore();
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  const codex = new CodexAppServer({ enabled: false, command: 'must-not-launch', defaultCwd: f.dir,
    defaultModel: 'test', approvalPolicy: 'never', store: deck, turnQueue: local.turns,
    executions: local.codexExecutions, authorizeTurn: () => true, historyReader: f.reader });
  const runtime = codex as any;
  try {
    local.turns.list = () => assert.fail('async publication must not call the old list');
    local.turns.version = () => assert.fail('async publication must not call SQL version');
    local.codexExecutions.normalizeTurnContexts = () => assert.fail('context must be read by the worker');
    const plan = await runtime.prepareHistory(key, [message()]);
    assert.equal(plan.queue.length, 67); assert.equal(plan.queue[0].entry.payload.text, text);
    runtime.applyHistory(key, plan, true);
    const visible = new Map(deck.getMessages(key).map(row => [row.id, row]));
    assert.equal(visible.get('queued-0')?.text, text);
    assert.equal(visible.get('queued-1')?.status, 'failed');
    assert.equal(visible.get('queued-2')?.status, 'outcome_unknown');
    assert.equal(visible.get('queued-3')?.status, 'outcome_unknown');
    assert.equal(visible.get('queued-0')?.queueDisposition, 'preparing');
    assert.equal(visible.get('queued-66')?.queueDisposition, 'waiting');
    assert.ok(visible.get('queued-66')?.queueVersion);
    const serialized = JSON.stringify(f.logs);
    assert.ok(!serialized.includes('native text')); assert.ok(!serialized.includes('body-66')); assert.ok(!serialized.includes(f.dir));
    assert.ok(f.logs.some(row => row.operation === 'codex-history-read' && row.phase === 'finished'));
  } finally { await codex.close(); local.close(); await f.close(); }
});

test('history worker returns identity-only hash and ACK-bound batch evidence; original input expands exactly', async () => {
  const batch = describeBatch([entry('first', 'first input'), entry('second', 'second input')])!;
  const envelope = 'first input' + batch.separator + 'second input';
  const appended = appendTurnContext([{ type: 'text', text: envelope }], 'private context');
  const text = appended.input[0].text;
  const f = await fixture(store => {
    assert.equal(store.codexExecutions.begin(key, 'first', 'connection', false, batch, false, appended.proof), true);
    assert.equal(store.codexExecutions.acknowledge(key, 'first', 'connection', 'run', () => {}), true);
  });
  try {
    const plan = await f.reader.prepare(key, [message(text)]);
    assert.deepEqual(plan.messages.map(row => [row.id, row.text]), [['first', 'first input'], ['second', 'second input']]);
    assert.deepEqual(plan.sourceIds, ['echo']);
    const untouched = await f.reader.prepare(key, [message('unproven text without separator', 'unrelated', 'other-run')]);
    assert.equal(untouched.messages[0]?.text, 'unproven text without separator');
    assert.ok(!JSON.stringify(f.logs).includes('private context'));
  } finally { await f.close(); }
});

for (const mutation of ['queue', 'execution', 'unrelated'] as const) test(`history snapshot rejects changed ${mutation} scope without replay`, async () => {
  const store = new ConnectorUserStore(':memory:');
  try {
    await store.turns.enqueueAsync('codex', entry('first'));
    const commands = createConnectorCodexHistoryCommands(store);
    const token = commands('codexHistoryOpen', { sessionKey: key, token: randomUUID() });
    if (mutation === 'queue') {
      store.turns.complete('codex', 'first');
      await store.turns.enqueueAsync('codex', entry('first'));
    } else if (mutation === 'execution') store.codexExecutions.begin(key, 'first', 'connection');
    else await store.turns.enqueueAsync('codex', { ...entry('other'), sessionKey: 'codex:other' });
    assert.equal(commands('codexHistoryFinish', { token, abandon: false }), mutation === 'unrelated');
    const next = commands('codexHistoryOpen', { sessionKey: key, token: randomUUID() });
    assert.equal(commands('codexHistoryFinish', { token: next, abandon: true }), false);
  } finally { store.close(); }
});

for (const mutation of ['queue', 'execution'] as const) test(`history retries a rejected ${mutation} snapshot without replaying work`, async () => {
  const store = new ConnectorUserStore(':memory:');
  const commands = createConnectorCodexHistoryCommands(store);
  let opens = 0, finishes = 0;
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
    const result = commands(kind, input);
    if (kind === 'codexHistoryOpen') opens++;
    if (kind === 'codexHistoryEvidence' && opens === 1) {
      if (mutation === 'queue') await store.turns.enqueueAsync('codex', entry('new-input'));
      else store.codexExecutions.begin(key, 'accepted', 'connection');
    }
    if (kind === 'codexHistoryFinish' && !input.abandon) finishes++;
    return result;
  } } as any, new PerformanceDiagnostics(() => {}));
  try {
    const plan = await reader.prepare(key, [message()]);
    assert.equal(opens, 2);
    assert.equal(finishes, 2);
    assert.equal(plan.messages[0]?.text, 'native text');
    if (mutation === 'queue') assert.deepEqual(plan.queue.map(row => row.entry.id), ['new-input']);
    else {
      assert.equal(store.codexExecutions.get(key)?.commandId, 'accepted');
      assert.equal(store.codexExecutions.canStart(key), false);
    }
  } finally { await reader.close(); commands.dispose(); store.close(); }
});

test('history snapshot retries are bounded and never release a running execution', async () => {
  const store = new ConnectorUserStore(':memory:');
  const commands = createConnectorCodexHistoryCommands(store);
  let opens = 0, mutate = true;
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
    if (kind === 'codexHistoryOpen') opens++;
    if (kind === 'codexHistoryFinish' && !input.abandon && mutate)
      await store.turns.enqueueAsync('codex', entry(`pending-${opens}`));
    return commands(kind, input);
  } } as any, new PerformanceDiagnostics(() => {}));
  try {
    store.codexExecutions.begin(key, 'accepted', 'connection');
    const before = store.codexExecutions.get(key);
    await assert.rejects(reader.prepare(key, [message()]), /unavailable/);
    assert.equal(opens, 2);
    assert.deepEqual(store.codexExecutions.get(key), before);
    assert.equal(store.codexExecutions.canStart(key), false);
    mutate = false;
    assert.equal((await reader.prepare(key, [message()])).queue.length, 2);
  } finally { await reader.close(); commands.dispose(); store.close(); }
});

test('large history uses bounded evidence pages on the actual SQLite worker', async () => {
  const f = await fixture();
  let evidenceReads = 0;
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
    if (kind === 'codexHistoryEvidence') {
      evidenceReads++;
      assert.ok(input.identities.length <= 64);
    }
    return f.owner.command(kind, input);
  } } as any, f.diagnostics);
  const messages = Array.from({ length: 1025 }, (_, index) => message(`input-${index}`, `id-${index}`, `turn-${index}`));
  try {
    const plan = await reader.prepare(key, messages);
    assert.deepEqual(plan.messages, messages);
    assert.deepEqual(plan.sourceIds, messages.map(row => row.id));
    assert.equal(evidenceReads, 17);
    assert.deepEqual(plan.queue, []);
  } finally { await reader.close(); await f.close(); }
});

test('escaped history identities keep evidence commands within the original byte budget', async () => {
  const f = await fixture();
  let evidenceReads = 0;
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
    if (kind === 'codexHistoryEvidence') {
      evidenceReads++;
      assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 16384);
    }
    return f.owner.command(kind, input);
  } } as any, f.diagnostics);
  const messages = Array.from({ length: 65 }, (_, index) => message('original input',
    '\\'.repeat(500) + index, '"'.repeat(500) + index));
  try {
    assert.deepEqual((await reader.prepare(key, messages)).messages, messages);
    assert.ok(evidenceReads > 2);
  } finally { await reader.close(); await f.close(); }
});

test('close during a rejected history window prevents reopening it', async () => {
  const store = new ConnectorUserStore(':memory:');
  const commands = createConnectorCodexHistoryCommands(store);
  let opens = 0, closing: Promise<void> | undefined;
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
    if (kind === 'codexHistoryOpen') opens++;
    if (kind === 'codexHistoryFinish' && !input.abandon) {
      await store.turns.enqueueAsync('codex', entry('new-input'));
      const result = commands(kind, input);
      closing = reader.close();
      return result;
    }
    return commands(kind, input);
  } } as any, new PerformanceDiagnostics(() => {}));
  try {
    await assert.rejects(reader.prepare(key, [message()]), /unavailable/);
    await closing;
    assert.equal(opens, 1);
  } finally { await reader.close(); commands.dispose(); store.close(); }
});

test('a malformed history finish is not a retryable snapshot conflict', async () => {
  const store = new ConnectorUserStore(':memory:');
  const commands = createConnectorCodexHistoryCommands(store);
  let opens = 0;
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
    if (kind === 'codexHistoryOpen') opens++;
    const result = commands(kind, input);
    return kind === 'codexHistoryFinish' && !input.abandon ? null : result;
  } } as any, new PerformanceDiagnostics(() => {}));
  try {
    await assert.rejects(reader.prepare(key, [message()]), /unavailable/);
    assert.equal(opens, 1);
  } finally { await reader.close(); commands.dispose(); store.close(); }
});

test('stale token/colliding reader does not release another original window; corrupt chunks clean up', async () => {
  const store = new ConnectorUserStore(':memory:');
  try {
    await store.turns.enqueueAsync('codex', entry('first', 'a'.repeat(70000)));
    const commands = createConnectorCodexHistoryCommands(store), token = commands('codexHistoryOpen', { sessionKey: key, token: randomUUID() });
    assert.throws(() => commands('codexHistoryOpen', { sessionKey: key, token: randomUUID() }), /unavailable/);
    assert.throws(() => commands('codexHistoryFinish', { token: '00000000-0000-0000-0000-000000000000', abandon: true }), /unavailable/);
    assert.equal(commands('codexHistoryPage', { token, offset: 0 }).length, 1);
    commands('codexHistoryChunk', { token, index: 0, offset: 0 });
    assert.throws(() => commands('codexHistoryChunk', { token, index: 0, offset: 0 }), /unavailable/);
    const next = commands('codexHistoryOpen', { sessionKey: key, token: randomUUID() });
    assert.equal(commands('codexHistoryFinish', { token: next, abandon: false }), true);
    commands.dispose();
  } finally { store.close(); }
});

test('history DTO rejects unknown fields, huge groups, malformed proof and invalid batch metadata', () => {
  const token = '00000000-0000-0000-0000-000000000000';
  assert.equal(validConnectorCodexHistoryInput('codexHistoryOpen', { sessionKey: key, token }), true);
  assert.equal(validConnectorCodexHistoryInput('codexHistoryOpen', { sessionKey: key }), false);
  assert.equal(validConnectorCodexHistoryInput('codexHistoryOpen', { sessionKey: key, token: '-'.repeat(36) }), false);
  assert.equal(validConnectorCodexHistoryInput('codexHistoryOpen', { sessionKey: key, sql: 'not accepted' }), false);
  assert.equal(validConnectorCodexHistoryInput('codexHistoryPage', { token, offset: 1 }), false);
  assert.equal(validConnectorCodexHistoryInput('codexHistoryChunk', { token, index: 0, offset: 1 }), false);
  assert.equal(validConnectorCodexHistoryInput('codexHistoryEvidence', { token, identities: Array(64).fill({ id: 'id', turnId: null }) }), true);
  assert.equal(validConnectorCodexHistoryInput('codexHistoryEvidence', { token, identities: Array(65).fill({ id: 'id', turnId: null }) }), false);
  assert.equal(validConnectorCodexHistoryOutput('codexHistoryEvidence', [{ proof: { hash: 'invalid', originalLength: 1 }, batch: null }]), false);
  assert.equal(validConnectorCodexHistoryOutput('codexHistoryEvidence', Array(64).fill({ proof: null, batch: null })), true);
  assert.equal(validConnectorCodexHistoryOutput('codexHistoryEvidence', Array(65).fill({ proof: null, batch: null })), false);
  assert.equal(validConnectorCodexHistoryOutput('codexHistoryEvidence', [{ proof: null, batch: { separator: 'x', members: [] } }]), false);
});

test('physical close drains an accepted window and suppresses its publication; new reads are rejected', async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(ok => { entered = ok; }), gate = new Promise<void>(ok => { release = ok; });
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
    const result = await f.owner.command(kind, input);
    if (kind === 'codexHistoryPage') { entered(); await gate; }
    return result;
  } } as any, f.diagnostics);
  const reading = reader.prepare(key, [message()]);
  try {
    await arrived;
    let closed = false;
    const closing = reader.close().then(() => { closed = true; });
    await new Promise<void>(ok => setImmediate(ok)); assert.equal(closed, false);
    await assert.rejects(reader.prepare(key, []), /unavailable/);
    release(); await assert.rejects(reading, /unavailable/); await closing;
    assert.equal(closed, true);
    // Finish released the original worker window, without closing the owner.
    assert.equal((await f.reader.prepare(key, [])).messages.length, 0);
  } finally { release(); await reader.close(); await f.close(); }
});

for (const fault of ['chunk-failure', 'invalid-chunk'] as const) {
  test(`file worker ${fault} refuses a partial plan and releases its physical window`, async () => {
    const f = await fixture(store => store.turns.enqueueAsync('codex', entry('first', 'x'.repeat(140000))).then(() => {}));
    let chunks = 0;
    const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
      const result = await f.owner.command(kind, input);
      if (kind === 'codexHistoryChunk' && ++chunks === 1) {
        if (fault === 'chunk-failure') throw Error('injected transport read failure');
        if (fault === 'invalid-chunk') return 'not-base64';
      }
      return result;
    } } as any, f.diagnostics);
    try {
      await assert.rejects(reader.prepare(key, [message()]));
      assert.ok(chunks > 0);
      const next = await f.reader.prepare(key, []);
      assert.equal(next.queue.length, 1);
      assert.equal(next.queue[0]!.entry.payload.text.length, 140000);
    } finally { await reader.close(); await f.close(); }
  });
}

test('queue mutation during chunk consumption refuses mixed versions and releases the read window', async () => {
  const store = new ConnectorUserStore(':memory:');
  await store.turns.enqueueAsync('codex', entry('first', 'x'.repeat(140000)));
  const commands = createConnectorCodexHistoryCommands(store);
  let changed = false;
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
    const result = commands(kind, input);
    if (kind === 'codexHistoryChunk' && !changed) {
      changed = true;
      assert.equal(store.turns.edit<any>('codex', key, 'first', payload => ({ ...payload, text: 'changed' })), true);
    }
    return result;
  } } as any, new PerformanceDiagnostics(() => {}));
  try {
    await assert.rejects(reader.prepare(key, [message()]));
    assert.equal(changed, true);
    const next = await reader.prepare(key, []);
    assert.equal(next.queue[0]!.entry.payload.text, 'changed');
  } finally { await reader.close(); commands.dispose(); store.close(); }
});

test('reader accepts the complete 10000-row boundary without requesting an invalid next page', async () => {
  const payload = Buffer.from(JSON.stringify({ text: '', images: [] }));
  let pages = 0, bodies = 0;
  const reader = new AsyncCodexHistory({ command: async (kind: string, input: any) => {
    assert.ok(validConnectorCodexHistoryInput(kind as any, input));
    if (kind === 'codexHistoryOpen') return input.token;
    if (kind === 'codexHistoryPage') {
      pages++;
      return Array.from({ length: Math.min(64, 10000 - input.offset) }, (_, i) => {
        const n = input.offset + i + 1;
        return { sequence: String(n), id: `row-${n}`, sessionKey: key, createdAt: 1, state: 'queued',
          version: `${n}:1`, bytes: payload.length, headId: 'row-1', executionCommandId: null };
      });
    }
    if (kind === 'codexHistoryChunk') { bodies++; return payload.toString('base64'); }
    assert.equal(kind, 'codexHistoryFinish'); assert.equal(input.abandon, false); return true;
  } } as any, new PerformanceDiagnostics(() => {}));
  try {
    const plan = await reader.prepare(key, []);
    assert.equal(plan.queue.length, 10000); assert.equal(pages, 157); assert.equal(bodies, 10000);
  } finally { await reader.close(); }
});

for (const openFault of ['before-delivery', 'after-delivery', 'wrong-echo'] as const) {
  for (const cleanupFault of ['none', 'before-delivery', 'after-delivery'] as const) {
    test(`history recovers original window: open ${openFault}, cleanup ${cleanupFault}`, async () => {
      const f = await fixture(store => store.turns.enqueueAsync('codex', { ...entry('original'), state: 'dispatching' }).then(() => {}));
      let opens = 0, cleanups = 0, originalToken: string | undefined;
      const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
        if (kind === 'codexHistoryOpen' && ++opens === 1) {
          originalToken = input.token;
          if (openFault === 'before-delivery') throw Error('open transport unavailable');
          await f.owner.command(kind, input);
          if (openFault === 'after-delivery') throw Error('open ACK lost');
          return randomUUID();
        }
        if (kind === 'codexHistoryFinish' && input.abandon) {
          assert.equal(input.token, originalToken, 'cleanup retains original pre-delivery handle');
          if (++cleanups === 1 && cleanupFault === 'before-delivery') throw Error('cleanup transport unavailable');
          const result = await f.owner.command(kind, input);
          if (cleanups === 1 && cleanupFault === 'after-delivery') throw Error('cleanup ACK lost');
          return result;
        }
        return f.owner.command(kind, input);
      } } as any, f.diagnostics);
      try {
        await assert.rejects(reader.prepare(key, []));
        const next = await reader.prepare(key, []);
        assert.equal(opens, 2, 'a new read opens once; the uncertain open is never replayed');
        assert.equal(cleanups, cleanupFault === 'none' ? 1 : 2);
        assert.equal(next.queue[0]!.entry.state, 'dispatching', 'display cleanup cannot unlock execution');
      } finally { await reader.close(); await f.close(); }
    });
  }
}

test('lost final validation ACK disposes only the original read and permits the next read', async () => {
  const f = await fixture(); let lost = false;
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
    const result = await f.owner.command(kind, input);
    if (kind === 'codexHistoryFinish' && !input.abandon && !lost) { lost = true; throw Error('finish ACK lost'); }
    return result;
  } } as any, f.diagnostics);
  try {
    await assert.rejects(reader.prepare(key, []));
    assert.deepEqual((await reader.prepare(key, [])).queue, []);
  } finally { await reader.close(); await f.close(); }
});

test('unknown window cleanup never evicts a foreign reader, and recovers after its original finish', async () => {
  const store = new ConnectorUserStore(':memory:'), commands = createConnectorCodexHistoryCommands(store);
  const foreign = commands('codexHistoryOpen', { sessionKey: key, token: randomUUID() });
  const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => commands(kind, input) } as any,
    new PerformanceDiagnostics(() => {}));
  try {
    await assert.rejects(reader.prepare(key, []));
    await assert.rejects(reader.prepare(key, []));
    assert.deepEqual(commands('codexHistoryPage', { token: foreign, offset: 0 }), []);
    assert.equal(commands('codexHistoryFinish', { token: foreign, abandon: false }), true);
    assert.deepEqual((await reader.prepare(key, [])).queue, []);
    assert.throws(() => commands('codexHistoryFinish', { token: foreign, abandon: false }), /unavailable/);
  } finally { await reader.close(); commands.dispose(); store.close(); }
});

for (const recovered of [true, false]) {
  test(`close drains retained cleanup and reports unresolved transport, recovered=${recovered}`, async () => {
    const store = new ConnectorUserStore(':memory:'), commands = createConnectorCodexHistoryCommands(store);
    let allowCleanup = false, cleanups = 0;
    const reader = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
      if (kind === 'codexHistoryFinish' && input.abandon) {
        cleanups++;
        if (!allowCleanup) throw Error('cleanup unavailable');
      }
      const result = commands(kind, input);
      if (kind === 'codexHistoryOpen') throw Error('open ACK lost');
      return result;
    } } as any, new PerformanceDiagnostics(() => {}));
    try {
      await assert.rejects(reader.prepare(key, []));
      allowCleanup = recovered;
      const close = reader.close(); assert.equal(reader.close(), close);
      if (recovered) await close; else await assert.rejects(close, /cleanup unavailable/);
      assert.equal(cleanups, 2);
      await assert.rejects(reader.prepare(key, []));
    } finally { commands.dispose(); store.close(); }
  });
}
