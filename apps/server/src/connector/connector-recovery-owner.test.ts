import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { TurnWorker } from '../commands/turn-worker.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { executeConnectorRecovery, validConnectorRecoveryInput, validConnectorRecoveryOutput } from './connector-recovery-domain.js';

const silence = new PerformanceDiagnostics(() => {});
const input = { runtime: 'codex' as const, after: '', limit: 16, connectionId: 'synthetic-connection', mirror: false };

test('recovery envelope cannot supply SQL, unlocks, authority, callbacks, paths or invalid pages', () => {
  assert.equal(validConnectorRecoveryInput('turnRecoveryPage', input), true);
  for (const extra of ['sql', 'file', 'authorized', 'repair', 'resume', 'callback'])
    assert.equal(validConnectorRecoveryInput('turnRecoveryPage', { ...input, [extra]: true }), false);
  for (const patch of [{ runtime: 'claude-code' }, { mirror: true }, { limit: 0 }, { limit: 65 }, { limit: 1.5 },
    { after: '\0' }, { after: 'x'.repeat(4097) }, { connectionId: '' }, { connectionId: 'x'.repeat(129) }])
    assert.equal(validConnectorRecoveryInput('turnRecoveryPage', { ...input, ...patch }), false);
  assert.equal(validConnectorRecoveryInput('turnRecoveryPage', { ...input, connectionId: null }), true);
  assert.equal(validConnectorRecoveryOutput('turnRecoveryPage', ['a', '\uE000', '😀']), true);
  for (const page of [['b', 'a'], ['a', 'a'], [''], ['\0'], ['x'.repeat(4097)], Array(65).fill('a'), { keys: [] }])
    assert.equal(validConnectorRecoveryOutput('turnRecoveryPage', page), false);
});

test('combined OpenClaw history/recovery/mirror page reads only original stores with bounded binary merge', () => {
  const calls: unknown[] = [];
  const owner = {
    codexExecutions: { recoveryPage: (...args: unknown[]) => { calls.push(['codex', ...args]); return ['a']; } },
    openClawExecutions: {
      recoveryPage: (...args: unknown[]) => { calls.push(['recovery', ...args]); return ['a', '\uE000']; },
      historyPage: (...args: unknown[]) => { calls.push(['history', ...args]); return ['b', '😀']; },
    },
    mirrorOutbox: { recoveryPage: (...args: unknown[]) => { calls.push(['mirror', ...args]); return ['a', '\u{10000}']; } },
  } as unknown as Parameters<typeof executeConnectorRecovery>[1];
  assert.deepEqual(executeConnectorRecovery({ ...input, runtime: 'openclaw', limit: 2, mirror: true }, owner), ['a', 'b']);
  assert.deepEqual(calls, [['recovery', 'synthetic-connection', '', 2], ['history', '', 2], ['mirror', '', 2]]);
  calls.length = 0;
  assert.deepEqual(executeConnectorRecovery({ ...input, runtime: 'openclaw', limit: 2 }, owner), ['a', 'b']);
  assert.equal(calls.length, 2, 'disabled mirror cannot read the outbox');
  calls.length = 0;
  assert.deepEqual(executeConnectorRecovery(input, owner), ['a']);
  assert.deepEqual(calls, [['codex', '', 16, 'synthetic-connection']]);
});

test('original recovery read failure propagates without repair, next-source reads or empty-page fallback', () => {
  let later = 0;
  const original = Error('synthetic-private-error');
  const owner = { openClawExecutions: { recoveryPage: () => { throw original; }, historyPage: () => { later++; return []; } },
    mirrorOutbox: { recoveryPage: () => { later++; return []; } } } as unknown as Parameters<typeof executeConnectorRecovery>[1];
  assert.throws(() => executeConnectorRecovery({ ...input, runtime: 'openclaw', mirror: true }, owner), error => error === original);
  assert.equal(later, 0);
});

for (const [name, page] of [
  ['non-array', {}], ['oversize', ['b', 'c']], ['duplicate', ['b', 'b']],
  ['behind-cursor', ['a']], ['empty-key', ['']], ['nul', ['b\0']], ['non-string', [1]],
] as const) test(`original recovery source ${name} cannot be hidden by merge or slicing`, () => {
  let later = 0;
  const owner = {
    codexExecutions: { recoveryPage: () => page },
    openClawExecutions: { recoveryPage: () => page, historyPage: () => { later++; return ['c']; } },
    mirrorOutbox: { recoveryPage: () => { later++; return ['d']; } },
  } as unknown as Parameters<typeof executeConnectorRecovery>[1];
  for (const runtime of ['codex', 'openclaw'] as const)
    assert.throws(() => executeConnectorRecovery({ ...input, runtime, after: 'a', limit: 1, mirror: runtime === 'openclaw' }, owner),
      { message: 'connector_storage_unavailable' });
  assert.equal(later, 0, 'the next original read never starts after corrupted source data');
});

test('real sole-owner async pages preserve existing runs and durable queues across close/reopen', async t => {
  const root = mkdtempSync(join(tmpdir(), 'connector-recovery-pages-')), file = join(root, 'connector.sqlite');
  let original: ConnectorUserStore | undefined = new ConnectorUserStore(file), owner: AsyncConnectorOwner | undefined;
  t.after(async () => { try { if (owner) await owner.closeForShutdown(); original?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); } });
  for (const key of ['a', '\uE000', '😀']) {
    original.codexExecutions.begin(key, `command:${key}`, input.connectionId);
    original.codexExecutions.acknowledge(key, `command:${key}`, input.connectionId, `run:${key}`, () => {});
    original.codexExecutions.observe(key, input.connectionId, `run:${key}`, 'completed');
  }
  original.openClawExecutions.begin('history', 'openclaw-command');
  original.openClawExecutions.acknowledge('history', 'openclaw-command', 'openclaw-run');
  original.openClawExecutions.observe('history', { runId: 'openclaw-run', phase: 'completed' });
  await original.turns.enqueueAsync('codex', { id: 'original-pending', sessionKey: 'queued', createdAt: Date.now(), payload: { message: 'private-original-message' } });
  const saved = ['a', '\uE000', '😀'].map(key => original!.codexExecutions.get(key));
  const history = original.openClawExecutions.get('history'), nodeId = original.nodeId;
  original.close(); original = undefined;
  const rows: string[] = []; owner = new AsyncConnectorOwner({ file }, new PerformanceDiagnostics(line => rows.push(line)));
  await owner.open();
  assert.deepEqual(await owner.command('turnRecoveryPage', { ...input, limit: 2 }), ['a', '\uE000']);
  assert.deepEqual(await owner.command('turnRecoveryPage', { ...input, after: '\uE000', limit: 2 }), ['😀']);
  assert.deepEqual(await owner.command('turnRecoveryPage', { ...input, runtime: 'openclaw', connectionId: null }), ['history']);
  assert.deepEqual(await owner.command('turnSessionPage', { runtime: 'codex', after: '', limit: 16 }), ['queued']);
  assert.equal(await owner.command('nodeIdentity', {}), nodeId);
  const logged = rows.join('\n');
  assert.doesNotMatch(logged, /private-original-message|synthetic-connection|connector\.sqlite|SELECT|UPDATE|run:/);
  await owner.closeForShutdown(); owner = undefined;
  original = new ConnectorUserStore(file);
  assert.deepEqual(['a', '\uE000', '😀'].map(key => original!.codexExecutions.get(key)), saved);
  const recoveredHistory = original.openClawExecutions.get('history')!;
  assert.deepEqual({ ...recoveredHistory, historySync: history!.historySync,
    revision: history!.revision, updatedAt: history!.updatedAt }, history,
  'terminal execution identity and evidence survive startup history invalidation');
  assert.equal(recoveredHistory.revision, history!.revision! + 1);
  assert.deepEqual(recoveredHistory.historySync, { revision: history!.historySync!.revision + 1, state: 'pending' });
  assert.equal(original.turns.maintenanceCount('codex'), 1);
  assert.equal(original.nodeId, nodeId);
});

test('TurnWorker consumes actual owner promises without native dispatch or a second SQLite connection', async t => {
  const root = mkdtempSync(join(tmpdir(), 'connector-worker-scheduling-')), file = join(root, 'connector.sqlite');
  const seed = new ConnectorUserStore(file);
  await seed.turns.enqueueAsync('codex', { id: 'retained-original', sessionKey: 'synthetic-session', createdAt: Date.now(), payload: { message: 'private-message' } });
  seed.close();
  const owner = new AsyncConnectorOwner({ file }, silence); let worker: TurnWorker | undefined;
  t.after(async () => { try { await worker?.close(); await owner.closeForShutdown(); }
    finally { rmSync(root, { recursive: true, force: true }); } });
  await owner.open();
  let observed!: () => void;
  const read = new Promise<void>(resolve => { observed = resolve; }), seen: string[] = [];
  worker = new TurnWorker({ runtime: 'codex', diagnostics: silence,
    queue: { sessionPage: (runtime, after, limit) => owner.command('turnSessionPage', { runtime, after, limit }), onAdmission: () => () => {} },
    additionalSessionPage: (after, limit) => owner.command('turnRecoveryPage', { ...input, after, limit }),
    reconcile: async key => { seen.push(key); worker!.pause(); observed(); } });
  worker.start();
  // TurnWorker deliberately has no referenced idle timer. Keep only this test
  // alive, not a production timer or a deadline which releases the owner.
  const deadline = setTimeout(() => observed(), 5000);
  try { await read; assert.deepEqual(seen, ['synthetic-session']); await worker.pause().drained;
    assert.equal(await owner.command('turnMaintenanceCount', { runtime: 'codex' }), 1, 'observation never acknowledges or removes original work'); }
  finally { clearTimeout(deadline); }
});
