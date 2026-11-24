import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createAsyncRuntimeProjection } from './async-runtime-projection.js';
import { createAsyncRuntimeMaintenanceProbe } from './async-runtime-maintenance-probe.js';

function gate() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() }; }
const tick = () => new Promise<void>(r => setImmediate(r));
function fixture(t: TestContext, sdk = false) {
  const calls: string[] = [], logs: string[] = [], deck = new DeckStore(), key = sdk ? 'claude-code:owned' : 'codex:owned';
  deck.upsertSession({ sessionKey: key, agentId: sdk ? 'claude-code' : 'codex', source: sdk ? 'claude-code' : 'codex', title: 'Original', status: 'idle',
    runtime: { phase: 'completed', sync: 'current', connection: 'connected', lastEventAt: 1, turnId: 'original-run' } });
  for (const role of ['user', 'assistant'] as const) deck.addMessage({ id: role, sessionKey: key, role,
    text: `PRIVATE_${role}`, status: 'sent', createdAt: 1 });
  let revision = 'a'.repeat(40), paused = true, unsupported = false, authorized = true, changedNative = false;
  let inspections = 0, hook: ((stage: string) => Promise<void>) | undefined;
  const step = async (name: string) => { calls.push(name); await hook?.(name); };
  const projection = createAsyncRuntimeProjection([() => step('projection')]);
  const deps: Parameters<typeof createAsyncRuntimeMaintenanceProbe>[0] = {
    nodeId: 'original-node', revision: () => revision, unsupportedNative: () => unsupported,
    requests: { isStopping: () => false, isPaused: () => paused }, deck, projection,
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)),
    codex: { enabled: true, owns: value => value.startsWith('codex:'), isSessionListReady: () => true,
      isSessionHistoryReady: () => true,
      refreshMaintenanceSessionsAsync: async authority => { await authority.authorize(); await step('list'); authority.local(); },
      recoverMaintenanceHistoryAsync: async (value, authority) => { await authority.authorize(); await step(`recover:${value}`); authority.local(); },
      refreshMaintenanceSessionAsync: async (_value, authority) => { await authority.authorize(); await step('history'); authority.local(); } },
    sdk: sdk ? [{ id: 'claude-code', refreshSession: async () => { await step('sdk-history'); }, isSessionHistoryReady: () => true }] : [],
    resumes: () => ({ prepareResume: async () => null, beginResume: async () => false, finishResume: async () => false }),
    persistence: { command: (async (kind: string, input: any, local: () => void) => {
      local(); await step(kind); local();
      if (kind === 'runtimeMaintenanceHistory') return ['codex:predecessor', 'codex:other'];
      if (kind === 'runtimeMaintenanceInteractions') return [key];
      if (kind === 'runtimeMaintenanceSdkSession') { assert.equal(input.runtime, 'claude-code'); return true; }
      if (kind === 'runtimeMaintenancePreservation') return { sessionKey: key, queueSha256: 'b'.repeat(64), execution: null };
      assert.fail('unexpected maintenance command');
    }) as any },
    inspect: async (authorize, local, recovering = false) => {
      await authorize(); local(); inspections++; await step(recovering ? 'inspect-recovery' : 'inspect-strict'); local();
      return { nodeId: 'original-node', observedAt: Date.now(), nativeVerified: true, activeRuns: 0, backgroundTerminals: 0,
        pendingExecutions: 0, queuedMessages: 3, inFlightWrites: 1, fenceId: 'original-fence',
        assertCurrent() { if (changedNative) throw Error('native changed'); } };
    },
  };
  const probe = createAsyncRuntimeMaintenanceProbe(deps);
  const authorize = async () => { if (!authorized) throw Error('revoked'); };
  t.after(async () => { await probe.close(); await projection.close(); });
  return { probe, deps, key, calls, logs, deck, authorize, inspections: () => inspections,
    hook(fn: NonNullable<typeof hook>) { hook = fn; }, revoke() { authorized = false; },
    revision() { revision = 'c'.repeat(40); }, resume() { paused = false; }, unsupported() { unsupported = true; },
    native() { changedNative = true; } };
}

for (const sdk of [false, true]) test(`complete original probe sequence and payload-free frontend proof, sdk=${sdk}`, async t => {
  const f = fixture(t, sdk), result = await f.probe.probe(f.key, f.authorize);
  assert.equal(result.nodeId, 'original-node'); assert.equal(result.messageCount, 2);
  assert.equal(result.businessReadVerified, true); assert.equal(f.inspections(), 2);
  assert.deepEqual(f.calls, ['inspect-recovery', 'projection', 'list', ...(sdk ? ['runtimeMaintenanceSdkSession'] : []),
    'runtimeMaintenanceHistory', 'recover:codex:predecessor', 'recover:codex:other', sdk ? 'sdk-history' : 'history',
    'runtimeMaintenanceInteractions', 'runtimeMaintenancePreservation', 'inspect-strict']);
  assert.doesNotMatch(JSON.stringify(result) + f.logs.join(''), /PRIVATE_|Bearer/);
  assert.equal(f.probe.probes(), 0);
});

for (const change of ['revision', 'resume', 'unsupported', 'revoke', 'native'] as const)
test(`probe rejects ${change} during final asynchronous inspection`, async t => {
  const f = fixture(t);
  f.hook(async stage => { if (stage === 'inspect-strict') f[change](); });
  await assert.rejects(f.probe.probe(f.key, f.authorize)); assert.equal(f.probe.probes(), 0);
});

for (const changed of ['queuedMessages', 'fenceId', 'activeRuns', 'backgroundTerminals', 'pendingExecutions', 'inFlightWrites'] as const)
test(`probe refuses changed ${changed} rather than certifying a partial idle state`, async t => {
  const f = fixture(t), inspect = f.deps.inspect;
  f.deps.inspect = async (...args) => {
    const value = await inspect(...args);
    return args[2] ? value : { ...value, [changed]: changed === 'fenceId' ? 'new-fence' : value[changed] + 1 };
  };
  await assert.rejects(f.probe.probe(f.key, f.authorize));
});

test('probe retains original full-history requirement instead of certifying only a session row', async t => {
  const f = fixture(t); f.deck.replaceMessages(f.key, [], { authoritative: true });
  await assert.rejects(f.probe.probe(f.key, f.authorize), /business history unavailable/);
});

test('active native work fails before projection, history recovery or interaction settlement', async t => {
  const f = fixture(t), inspect = f.deps.inspect;
  f.deps.inspect = async (...args) => ({ ...await inspect(...args), activeRuns: 1 });
  await assert.rejects(f.probe.probe(f.key, f.authorize)); assert.deepEqual(f.calls, ['inspect-recovery']);
});

test('resume composition failure releases probe ownership and allows a fresh attempt', async t => {
  const f = fixture(t), resumes = f.deps.resumes;
  f.deps.resumes = local => { local(); throw Error('resume composition unavailable'); };
  await assert.rejects(f.probe.probe(f.key, f.authorize), /resume composition unavailable/);
  assert.equal(f.probe.probes(), 0);
  assert.deepEqual(f.calls, []);
  f.deps.resumes = resumes;
  assert.equal((await f.probe.probe(f.key, f.authorize)).businessReadVerified, true);
});

test('single probe and physical close drain retain accepted recovery despite a hidden public then', async t => {
  const f = fixture(t), held = gate(), entered = gate(); let closed = false;
  f.hook(async stage => { if (stage === 'recover:codex:predecessor') { entered.resolve(); await held.promise; } });
  const work = f.probe.probe(f.key, f.authorize); void work.catch(() => {}); await entered.promise;
  await assert.rejects(f.probe.probe(f.key, f.authorize));
  Object.defineProperty(work, 'then', { value: undefined });
  const closing = f.probe.close().then(() => { closed = true; });
  try {
    await tick(); assert.equal(closed, false); assert.equal(f.probe.probes(), 1);
    held.resolve(); await assert.rejects(async () => { await work; }); await closing;
    assert.equal(closed, true); assert.equal(f.probe.probes(), 0);
    assert.equal(f.calls.includes('runtimeMaintenanceInteractions'), false);
  } finally { held.resolve(); await closing; }
});
