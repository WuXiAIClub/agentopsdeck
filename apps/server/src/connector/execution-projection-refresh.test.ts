import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { CONNECTOR_COMMAND_BYTES } from './connector-owner-domain.js';
import { claimOpenClawOwnerTurn, seedOpenClawOwnerTurns } from './openclaw-owner-test-fixture.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { AsyncOpenClawProjection } from './async-openclaw-projection.js';
import { AsyncConnectorEventProjection } from './async-event-projection.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { executionProjectionInventory, ExecutionProjectionChanged } from './execution-projection-inventory.js';
import { createAsyncRuntimeProjection } from './async-runtime-projection.js';

const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
type Runtime = 'codex' | 'openclaw';
type Command = AsyncConnectorOwner['command'];
async function fixture(runtime: Runtime, count = 1, maxFacts?: number) {
  const root = mkdtempSync(join(tmpdir(), 'execution-refresh-')), file = join(root, 'connector.sqlite');
  const keys = Array.from({ length: count }, (_, n) => runtime === 'codex'
    ? `codex:refresh-${String(n).padStart(3, '0')}` : `agent:main:dashboard:refresh-${String(n).padStart(3, '0')}`);
  const seed = new ConnectorUserStore(file);
  for (const key of keys) {
    if (runtime === 'codex') {
      seed.codexExecutions.begin(key, 'command', 'connection');
      seed.codexExecutions.acknowledge(key, 'command', 'connection', 'run', () => {});
    }
  }
  const config = runtime === 'openclaw' ? await seedOpenClawOwnerTurns(seed, root,
    keys.map((key, n) => ({ key, id: `command-${n}` }))) : {};
  seed.close();
  const owner = new AsyncConnectorOwner({ file, ...config }, silent); await owner.open();
  if (runtime === 'openclaw') for (const key of keys) {
    const claimed = await claimOpenClawOwnerTurn(owner, key, 'connection');
    assert.equal(await owner.command('openClawExecutionAcknowledge', { sessionKey: key,
      commandId: claimed.turn.id, transport: 'gateway', connectionId: 'connection', runId: 'run' }), true);
    assert.equal(await owner.command('openClawExecutionObserve', { sessionKey: key,
      event: { runId: 'run', phase: 'running', gatewayConnectionId: 'connection' } }), true);
  }
  const original = owner.command.bind(owner);
  const calls: string[] = [];
  let hook: ((kind: string, input: any, run: () => Promise<any>) => Promise<any>) | undefined;
  owner.command = (async (kind: any, input: any) => {
    calls.push(kind); const run = () => original(kind, input);
    return hook ? hook(kind, input, run) : run();
  }) as Command;
  const deck = new DeckStore();
  const options = { owner, deck, diagnostics: silent, connectionId: () => 'connection', ...(maxFacts ? { maxFacts } : {}) };
  const projection = runtime === 'codex' ? new AsyncCodexProjection(options)
    : new AsyncOpenClawProjection({ ...options, observe: async () => false });
  await projection.open();
  for (const key of keys) deck.upsertSession({ sessionKey: key, agentId: runtime, title: 'Original', status: 'idle' });
  const phase = (key = keys[0]!) => deck.getSession(key)?.runtime?.phase;
  return { owner, projection, deck, keys, calls, phase,
    hook(next: typeof hook) { hook = next; },
    // ACKed Codex runs reject send-uncertain; a missed disconnect commit is
    // the real transition to unknown for an already acknowledged execution.
    uncertain: () => runtime === 'codex' ? original('codexExecutionDisconnect', { sessionKey: keys[0]!, connectionId: 'connection' })
      : original('openClawExecutionUncertain', { sessionKey: keys[0]!, commandId: 'command-0' }),
    head: () => original('eventProjectionHead', {}),
    async close() { hook = undefined; await projection.close(); await owner.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${runtime}: refresh reads missed commits over multiple pages without writing events or changing connection display`, async () => {
    const f = await fixture(runtime, 66);
    try {
      assert.equal(f.phase(), 'running');
      assert.equal(await f.uncertain(), true);
      assert.equal(f.phase(), 'running', 'no notifier delivered');
      const head = await f.head(), cursor = f.deck.latestEventId();
      const last = f.deck.getSession(f.keys.at(-1)!)!;
      f.calls.length = 0;
      await f.projection.refreshProjection();
      assert.equal(f.phase(), 'unknown', 'unknown must not manufacture idle/completion');
      assert.equal(f.projection.status().facts, 66);
      assert.deepEqual(await f.head(), head);
      assert.equal(f.deck.latestEventId(), cursor);
      assert.deepEqual(f.deck.getSession(f.keys.at(-1)!), last, 'no connection timestamp churn');
      assert.equal(f.calls.filter(k => k === 'executionSessionPage').length, 3);
      assert.equal(f.calls.length, 10, '66 facts: 2 heads, 3 key pages, and 5 fact batches');
      assert.ok(f.calls.every(k => ['executionSessionPage', 'eventProjectionHead', 'executionFactBatch'].includes(k)));
    } finally { await f.close(); }
  });

  test(`${runtime}: moving head is bounded and recoverable, never installs an unproven map`, async () => {
    const f = await fixture(runtime);
    try {
      await f.uncertain(); let heads = 0;
      f.hook(async (kind, _input, run) => {
        const value = await run();
        if (kind !== 'eventProjectionHead') return value;
        heads++; return { ...value, version: value.version.replace(/:\d+$/, `:${heads}`) };
      });
      await assert.rejects(f.projection.refreshProjection());
      assert.equal(heads, 8); assert.equal(f.phase(), 'running');
      assert.equal(f.projection.status().unavailable, false);
      f.hook(undefined); await f.projection.refreshProjection();
      assert.equal(f.phase(), 'unknown');
    } finally { await f.close(); }
  });

  test(`${runtime}: original snapshot barrier refreshes a missed commit and reuses only the proven head`, async () => {
    const f = await fixture(runtime), events = new AsyncConnectorEventProjection(f.owner, silent);
    try {
      const capture = () => f.phase(), refresh = f.projection.refreshProjection;
      assert.equal(await events.snapshot(capture, refresh), 'running');
      await f.uncertain(); const head = await f.head();
      assert.equal(await events.snapshot(capture, refresh), 'unknown');
      const pages = f.calls.filter(k => k === 'executionSessionPage').length;
      assert.equal(await events.snapshot(capture, refresh), 'unknown');
      assert.equal(f.calls.filter(k => k === 'executionSessionPage').length, pages);
      assert.deepEqual(await f.head(), head);
      assert.equal(events.status().unavailable, false);
    } finally { await events.close(); await f.close(); }
  });

  test(`${runtime}: snapshot retries transient moving inventory from a fresh original head`, async () => {
    const f = await fixture(runtime), events = new AsyncConnectorEventProjection(f.owner, silent);
    try {
      await f.uncertain();
      let heads = 0;
      f.hook(async (kind, _input, run) => {
        const value = await run();
        if (kind !== 'eventProjectionHead') return value;
        heads++;
        return heads >= 2 && heads <= 9 ? { ...value, version: value.version.replace(/:\d+$/, `:${100 + heads}`) } : value;
      });
      assert.equal(await events.snapshot(() => f.phase(), f.projection.refreshProjection), 'unknown');
      assert.equal(heads, 13);
      assert.equal(f.projection.status().unavailable, false);
      assert.equal(events.status().unavailable, false);
    } finally { await events.close(); await f.close(); }
  });

  test(`${runtime}: production combined projection retains moving inventory for event-barrier retry`, async () => {
    const f = await fixture(runtime), events = new AsyncConnectorEventProjection(f.owner, silent);
    const combined = createAsyncRuntimeProjection([f.projection.refreshProjection]);
    try {
      await f.uncertain();
      let heads = 0;
      f.hook(async (kind, _input, run) => {
        const value = await run();
        if (kind !== 'eventProjectionHead') return value;
        heads++;
        return heads >= 2 && heads <= 9 ? { ...value, version: value.version.replace(/:\d+$/, `:${100 + heads}`) } : value;
      });
      assert.equal(await events.snapshot(() => f.phase(), () => combined.refresh()), 'unknown');
      assert.equal(heads, 13);
      combined.assertCurrent();
      assert.equal(f.projection.status().unavailable, false);
      assert.equal(events.status().unavailable, false);
    } finally { await events.close(); await combined.close(); await f.close(); }
  });

  test(`${runtime}: snapshot bounds persistent movement without publishing an unproven map`, async () => {
    const f = await fixture(runtime), events = new AsyncConnectorEventProjection(f.owner, silent);
    try {
      await f.uncertain();
      let heads = 0;
      f.hook(async (kind, _input, run) => {
        const value = await run();
        if (kind !== 'eventProjectionHead') return value;
        heads++;
        return { ...value, version: value.version.replace(/:\d+$/, `:${100 + heads}`) };
      });
      await assert.rejects(events.snapshot(() => { assert.fail('Unproven capture'); }, f.projection.refreshProjection));
      assert.equal(heads, 36);
      assert.equal(f.phase(), 'running');
      assert.equal(f.projection.status().unavailable, false);
      f.hook(undefined);
      assert.equal(await events.snapshot(() => f.phase(), f.projection.refreshProjection), 'unknown');
    } finally { await events.close(); await f.close(); }
  });

  test(`${runtime}: snapshot does not retry an unavailable original owner`, async () => {
    const f = await fixture(runtime), events = new AsyncConnectorEventProjection(f.owner, silent);
    try {
      let pages = 0;
      f.hook(async (kind, _input, run) => {
        if (kind === 'executionSessionPage') { pages++; throw new Error('owner unavailable'); }
        return run();
      });
      await assert.rejects(events.snapshot(() => { assert.fail('Failed owner capture'); }, f.projection.refreshProjection));
      assert.equal(pages, 1);
      assert.equal(f.projection.status().unavailable, true);
    } finally { await events.close(); await f.close(); }
  });

  test(`${runtime}: full map replacement drops vanished keys and permits their later reappearance`, async () => {
    // A bounded owner-directory visibility fixture, not a session-deletion
    // implementation: deletion metadata is a separate global-refresh fragment.
    const f = await fixture(runtime, 2);
    try {
      f.hook(async (kind, _input, run) => kind === 'executionSessionPage' ? [] : run());
      await f.projection.refreshProjection(); assert.equal(f.projection.status().facts, 0);
      f.hook(undefined); await f.projection.refreshProjection();
      assert.equal(f.projection.status().facts, 2); assert.equal(f.phase(), 'running');
    } finally { await f.close(); }
  });

  test(`${runtime}: directory growth respects capacity before reading an over-budget fact`, async () => {
    const f = await fixture(runtime, 1, 1); let reads = 0;
    try {
      f.hook(async (kind, _input, run) => {
        if (kind === 'executionSessionPage') return [f.keys[0], f.keys[0] + '-next'];
        if (kind === 'executionFactBatch') reads++;
        return run();
      });
      await assert.rejects(f.projection.refreshProjection());
      assert.equal(reads, 0); assert.equal(f.projection.status().unavailable, true);
    } finally { await f.close(); }
  });

  test(`${runtime}: overlapping refreshes share work but require a new scan after the later request`, async () => {
    const f = await fixture(runtime), entered = deferred(), release = deferred();
    let held = false, pages = 0;
    try {
      f.hook(async (kind, _input, run) => {
        const value = await run();
        if (kind === 'executionSessionPage') {
          pages++;
          if (!held) { held = true; entered.resolve(); await release.promise; }
        }
        return value;
      });
      const first = f.projection.refreshProjection(); await entered.promise;
      const second = f.projection.refreshProjection(); assert.equal(second, first);
      release.resolve(); await Promise.all([first, second]);
      assert.equal(pages, 4, 'two full scans, not one stale shared result');
      assert.equal(f.projection.status().pending, 0);
    } finally { release.resolve(); await f.close(); }
  });

  test(`${runtime}: direct projection close waits for physical scan and rejects late cache installation`, async () => {
    const f = await fixture(runtime), entered = deferred(), release = deferred(); let held = false;
    try {
      f.hook(async (kind, _input, run) => {
        if (kind === 'executionSessionPage' && !held) { held = true; entered.resolve(); await release.promise; }
        return run();
      });
      const work = assert.rejects(f.projection.refreshProjection()); await entered.promise;
      let closed = false; const closing = f.projection.close().then(() => { closed = true; });
      await assert.rejects(f.projection.refreshProjection()); await tick(); assert.equal(closed, false);
      release.resolve(); await work; await closing;
      assert.equal(f.projection.status().pending, 0); assert.equal(f.projection.status().unavailable, false);
    } finally { release.resolve(); await f.close(); }
  });

  for (const invalid of ['foreign-key', 'duplicate-key', 'wrong-fact', 'worker-error'] as const) {
    test(`${runtime}: ${invalid} fails closed without replacing execution facts`, async () => {
      const f = await fixture(runtime);
      try {
        f.hook(async (kind, _input, run) => {
          if (kind === 'executionSessionPage') {
            if (invalid === 'worker-error') throw Error('private worker failure');
            if (invalid === 'foreign-key') return [runtime === 'codex' ? 'agent:foreign' : 'codex:foreign'];
            if (invalid === 'duplicate-key') return [f.keys[0], f.keys[0]];
          }
          const value = await run();
          return invalid === 'wrong-fact' && kind === 'executionFactBatch'
            ? [{ ...value[0], sessionKey: f.keys[0] + '-forged' }] : value;
        });
        await assert.rejects(f.projection.refreshProjection());
        assert.equal(f.projection.status().unavailable, true);
        await assert.rejects(f.projection.refreshProjection());
      } finally { await f.close(); }
    });
  }
}

test('inventory bounds missing keys before reading and distinguishes concurrent deletion from corruption', async () => {
  const epoch = 'cv1_01234567-89ab-4def-8123-456789abcdef:', cursor = 'ce1_01234567-89ab-4def-8123-456789abcdef:0';
  let heads = 0, reads = 0, stable = false;
  const owner = { command: (async (kind: string, input: any) => {
    if (kind === 'eventProjectionHead') return { cursor, version: epoch + (stable ? 1 : ++heads) };
    if (kind === 'executionSessionPage') return input.after ? [] : ['codex:a'];
    if (kind === 'executionFactBatch') { reads++; return [null]; }
    throw Error('unexpected effect');
  }) as Command };
  const options = { owner, runtime: 'codex' as const, validKey: (key: unknown): key is string => typeof key === 'string',
    decode: (fact: unknown) => { assert.equal(fact, null); return null; }, maxFacts: 1, maxBytes: 1024 };
  await assert.rejects(executionProjectionInventory(options), ExecutionProjectionChanged);
  assert.equal(heads, 8); assert.equal(reads, 4);
  stable = true; await assert.rejects(executionProjectionInventory(options));
  reads = 0; await assert.rejects(executionProjectionInventory({ ...options, maxFacts: 0 }));
  assert.equal(reads, 0, 'over-budget facts cannot trigger a read');
});

test('inventory groups long keys within the command byte budget and rejects a truncated batch', async () => {
  const keys = Array.from({ length: 10 }, (_, n) => `codex:${n}${'"'.repeat(4000)}`);
  const received: string[] = [];
  let truncate = false;
  const owner = { command: (async (kind: string, input: { after?: string; keys?: string[] }) => {
    if (kind === 'eventProjectionHead') return { cursor: 'ce1_01234567-89ab-4def-8123-456789abcdef:0',
      version: 'cv1_01234567-89ab-4def-8123-456789abcdef:0' };
    if (kind === 'executionSessionPage') return input.after ? [] : keys;
    assert.equal(kind, 'executionFactBatch');
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= CONNECTOR_COMMAND_BYTES);
    const batch = input.keys!;
    received.push(...batch);
    return (truncate ? batch.slice(0, -1) : batch).map(sessionKey => ({ sessionKey }));
  }) as Command };
  const options = { owner, runtime: 'codex' as const, validKey: (key: unknown): key is string => typeof key === 'string',
    decode: (fact: unknown, key: string) => { assert.deepEqual(fact, { sessionKey: key }); return { sessionKey: key }; },
    maxFacts: keys.length, maxBytes: 128 * 1024 };
  assert.deepEqual([...((await executionProjectionInventory(options)).facts.keys())], keys);
  assert.deepEqual(received, keys);
  truncate = true;
  await assert.rejects(executionProjectionInventory(options));
});
