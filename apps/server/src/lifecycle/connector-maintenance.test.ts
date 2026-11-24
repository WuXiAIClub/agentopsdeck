import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceMaintenance, newMaintenanceJob, recoverInterruptedMaintenance, validMaintenanceJob,
  requireMaintenanceObservation, type ArchiveBootstrap,
  type MaintenanceAdapter, type MaintenanceJob, type MaintenanceJournal, type MaintenanceStage,
} from './connector-maintenance.js';
import { MaintenanceObservationUnavailable } from './maintenance-observation-error.js';

const release = { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
const create = (operation: 'restart' | 'upgrade' | 'recover' = 'upgrade') => newMaintenanceJob({
  id: 'job:1', nodeId: 'node:1', actorId: 'owner:1', operation, createdAt: 1000, deadline: 60_000,
});

const archiveBootstrap: ArchiveBootstrap = { authorizationId: 'one-window', serviceInvocationId: 'c'.repeat(32),
  previous: { revision: 'd'.repeat(40), manifestSha256: 'e'.repeat(64) }, candidate: release,
  sessions: ['codex:01a0adde-49f0-7382-8068-c87f9b68d3fa'] };
test('archive bootstrap preserves exact nonzero pending, never excuses other work or stale evidence', () => {
  const job = { ...create(), archiveBootstrap };
  assert.equal(validMaintenanceJob(job), true);
  const proof = { nodeId: job.nodeId, observedAt: 2000, nativeVerified: true as const,
    activeRuns: 0, backgroundTerminals: 0, pendingExecutions: 1, queuedMessages: 0, inFlightWrites: 0 };
  assert.equal(requireMaintenanceObservation(proof, job, 2000, false), true);
  assert.equal(proof.pendingExecutions, 1, 'do not subtract or falsify the observation');
  assert.equal(requireMaintenanceObservation(proof, create(), 2000, false), false);
  for (const field of ['activeRuns', 'backgroundTerminals', 'queuedMessages', 'inFlightWrites'] as const)
    assert.equal(requireMaintenanceObservation({ ...proof, [field]: 1 }, job, 2000, false), false);
  for (const pendingExecutions of [0, 2])
    assert.equal(requireMaintenanceObservation({ ...proof, pendingExecutions }, job, 2000, false), false);
  assert.throws(() => requireMaintenanceObservation(proof, job, 8000, false));
  assert.throws(() => requireMaintenanceObservation(proof, { ...job, fenceId: 'ours' }, 2000, true));
  assert.throws(() => requireMaintenanceObservation({ ...proof, nativeVerified: false } as never, job, 2000, false));
});
test('archive bootstrap rejects malformed, widening, restart or mismatched candidate grants', () => {
  for (const patch of [{ sessions: [] }, { sessions: [...archiveBootstrap.sessions, ...archiveBootstrap.sessions] },
    { serviceInvocationId: 'guess' }, { anything: true }, { previous: release }])
    assert.equal(validMaintenanceJob({ ...create(), archiveBootstrap: { ...archiveBootstrap, ...patch } }), false);
  assert.equal(validMaintenanceJob({ ...create('restart'), archiveBootstrap }), false);
  assert.equal(validMaintenanceJob({ ...create(), stage: 'drain', release: archiveBootstrap.previous, archiveBootstrap }), false);
});

const recoveryRuns = [{ sessionKey: 'codex:interrupted', commandId: 'original', connectionId: 'connection', runId: 'run', revision: 7 }];
function fixture(operation: 'restart' | 'upgrade' | 'recover' = 'upgrade') {
  let state = create(operation);
  const calls: string[] = [];
  const journal: MaintenanceJournal = {
    async compareAndSwap(previous, next) {
      if (JSON.stringify(state) !== JSON.stringify(previous)) return false;
      assert.equal(validMaintenanceJob(next), true);
      state = structuredClone(next);
      return true;
    },
  };
  const effect = (name: string) => {
    assert.equal(state.executing, true, `${name} must have a persisted intent`);
    calls.push(name);
  };
  const adapter: MaintenanceAdapter = {
    async authorize() { effect('authorize'); return true; },
    async prepare() { effect('prepare'); return release; },
    async inspect(job) { effect('inspect'); return { nodeId: job.nodeId, observedAt: 2000, nativeVerified: true,
      activeRuns: 0, backgroundTerminals: 0, pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0,
      ...(job.fenceId ? { fenceId: job.fenceId } : {}),
      ...(operation === 'recover' ? { pendingExecutions: 1, queuedMessages: 2, recoveryRuns: structuredClone(recoveryRuns) } : {}) }; },
    async fence(job) { effect('fence'); return { nodeId: job.nodeId, fenceId: 'fence:1' }; },
    async releaseFence(job) { effect('releaseFence'); return { nodeId: job.nodeId, fenceId: job.fenceId!, released: true }; },
    async stop() { effect('stop'); },
    async stopped(job) { effect('stopped'); return { nodeId: job.nodeId, serviceStopped: true, descendantsStopped: true }; },
    async backup(job) { effect('backup'); return { nodeId: job.nodeId, backupId: 'backup:1', consistent: true, verified: true }; },
    async recover(job) { effect('recover'); return { nodeId: job.nodeId, recovered: true }; },
    async activate() { effect('activate'); return release; },
    async start() { effect('start'); },
    async ready(job) { effect('ready'); return { ...release, nodeId: job.nodeId,
      protocolCompatible: true, projectionVerified: true, businessReadVerified: true }; },
  };
  return { adapter, journal, calls, get state() { return structuredClone(state); },
    async step(now = () => 2000) { return advanceMaintenance(state, journal, adapter, now); },
    async until(stage: MaintenanceStage) {
      for (let i = 0; state.stage !== stage && i < 20; i++) await this.step();
      assert.equal(state.stage, stage);
    },
  };
}

test('explicit recovery pins exact interrupted runs, keeps queued successors fenced until backup/recovery/readiness', async () => {
  const f = fixture('recover');
  await f.until('recover');
  assert.deepEqual(f.state.recoveryRuns, recoveryRuns);
  assert.equal(f.state.backupId, 'backup:1');
  assert.equal(f.calls.includes('start'), false);
  assert.equal(f.calls.includes('releaseFence'), false);
  await f.until('succeeded');
  const ordered = f.calls.filter(call => ['stop', 'stopped', 'backup', 'recover', 'start', 'ready', 'releaseFence'].includes(call));
  assert.deepEqual(ordered, ['stop', 'stopped', 'backup', 'recover', 'start', 'ready', 'releaseFence']);
  assert.equal(f.calls.includes('activate'), false, 'recovery never changes selected release');
});

test('recovery refuses another active/unconfirmed execution and rechecks pinned run revisions before stop', async () => {
  for (const patch of [{ activeRuns: 1 }, { inFlightWrites: 1 }, { pendingExecutions: 2 }, { recoveryRuns: [] }]) {
    const f = fixture('recover'); await f.until('drain');
    const inspect = f.adapter.inspect;
    f.adapter.inspect = async job => ({ ...await inspect(job), ...patch });
    await f.step();
    assert.equal(f.state.stage, 'drain');
    assert.equal(f.calls.includes('stop'), false);
  }
  const f = fixture('recover'); await f.until('recheck');
  const inspect = f.adapter.inspect;
  f.adapter.inspect = async job => ({ ...await inspect(job), recoveryRuns: [{ ...recoveryRuns[0]!, revision: 8 }] });
  await f.step();
  assert.equal(f.state.stage, 'unfence');
  assert.equal(f.calls.includes('stop'), false);
});

test('lost recovery result acknowledgment and failed affected history never start/release or replay', async () => {
  const f = fixture('recover'); await f.until('recover');
  let writes = 0;
  await assert.rejects(advanceMaintenance(f.state, { async compareAndSwap(previous, next) {
    if (++writes === 2) throw new Error('result unavailable');
    return f.journal.compareAndSwap(previous, next);
  } }, f.adapter, () => 2000));
  assert.equal(f.state.executing, true);
  await f.step();
  await recoverInterruptedMaintenance(f.state, f.journal);
  await f.step();
  assert.equal(f.calls.filter(call => call === 'recover').length, 1);
  assert.equal(f.calls.includes('start'), false);
  assert.equal(f.calls.includes('releaseFence'), false);
  assert.equal(f.state.stage, 'attention');
  assert.deepEqual(f.state.recoveryRuns, recoveryRuns);
  const failed = fixture('recover'); await failed.until('ready');
  failed.adapter.ready = async () => { throw new Error('affected history unavailable'); };
  await failed.step();
  assert.equal(failed.state.stage, 'attention');
  assert.equal(failed.calls.includes('releaseFence'), false);
});

for (const stage of ['drain', 'recheck'] as const) {
  test(`${stage}: transient read backs off durably, then requires a fresh proof`, async () => {
    const f = fixture();
    await f.until(stage);
    const inspect = f.adapter.inspect;
    f.adapter.inspect = async () => { throw new MaintenanceObservationUnavailable('observation_unavailable'); };
    await f.step();
    assert.equal(f.state.stage, stage);
    assert.deepEqual(f.state.observationRetry, { attempts: 1, nextAttemptAt: 3000, code: 'observation_unavailable' });
    const snapshot = f.state, count = f.calls.length;
    await f.step(() => 2999);
    assert.deepEqual(f.state, snapshot);
    assert.equal(f.calls.length, count, 'backoff tick performs no IO');
    f.adapter.inspect = inspect;
    await f.step(() => 3000);
    assert.equal(f.state.stage, stage === 'drain' ? 'fence' : 'stop');
    assert.equal(f.state.observationRetry, undefined);
    assert.equal(f.calls.includes('stop'), false);
  });
}

test('five consecutive observation failures stop retries and retain sanitized stage/code', async () => {
  const f = fixture(); await f.until('drain');
  f.adapter.inspect = async () => { throw new MaintenanceObservationUnavailable('transport_unavailable'); };
  for (const at of [2000, 3000, 5000, 9000, 17000]) await f.step(() => at);
  assert.equal(f.state.stage, 'attention');
  assert.equal(f.state.failedStage, 'drain');
  assert.equal(f.state.failureCode, 'transport_unavailable');
  assert.equal(f.state.observationRetry, undefined);
  assert.equal(f.calls.includes('fence'), false);
  assert.equal(f.calls.includes('stop'), false);
});

test('original deadline and revoked authority still stop a pending observation retry', async () => {
  for (const revoked of [false, true]) {
    const f = fixture(); await f.until('drain');
    f.adapter.inspect = async () => { throw new MaintenanceObservationUnavailable('observation_unavailable'); };
    await f.step();
    if (revoked) f.adapter.authorize = async () => false;
    await f.step(() => revoked ? 3000 : 60_000);
    assert.equal(f.state.reason, revoked ? 'authorization_changed' : 'deadline');
    assert.equal(f.state.failedStage, 'drain');
    assert.equal(f.state.observationRetry, undefined);
  }
});

test('an effect throwing an observation-like error is never retried', async () => {
  for (const stage of ['fence', 'stop'] as const) {
    const f = fixture(); await f.until(stage);
    f.adapter[stage] = async () => { throw new MaintenanceObservationUnavailable('transport_unavailable'); };
    await f.step();
    assert.equal(f.state.stage, 'attention');
    assert.equal(f.state.failedStage, stage);
    assert.equal(f.state.observationRetry, undefined);
  }
});

for (const operation of ['restart', 'upgrade'] as const) {
  test(`${operation}: intent precedes every effect; stopped backup and business readiness precede success`, async () => {
    const f = fixture(operation);
    await f.until('succeeded');
    assert.deepEqual(f.calls.filter(call => call !== 'authorize'), ['prepare', 'inspect', 'fence', 'inspect', 'inspect',
      'stop', 'stopped', 'backup', ...(operation === 'upgrade' ? ['activate'] : []), 'start', 'ready', 'releaseFence']);
    const count = f.calls.length;
    await f.step();
    assert.equal(f.calls.length, count);
  });
}

test('busy native run, queued messages or in-flight writes never stop or cancel work', async () => {
  for (const field of ['activeRuns', 'queuedMessages', 'inFlightWrites'] as const) {
    const f = fixture();
    await f.until('drain');
    const inspect = f.adapter.inspect;
    f.adapter.inspect = async job => ({ ...await inspect(job), [field]: 1 });
    await f.step();
    assert.equal(f.state.stage, 'drain');
    assert.equal(f.calls.includes('fence'), false);
    assert.equal(f.calls.includes('stop'), false);
  }
});

test('work racing admission fence releases fence and resumes natural drain', async () => {
  const f = fixture();
  await f.until('recheck');
  const inspect = f.adapter.inspect;
  f.adapter.inspect = async job => ({ ...await inspect(job), queuedMessages: 1 });
  await f.step();
  assert.equal(f.state.stage, 'unfence');
  await f.step();
  assert.equal(f.state.stage, 'drain');
  assert.equal(f.state.fenceId, undefined);
  assert.equal(f.calls.includes('stop'), false);
});

test('stale/concurrent supervisors invoke only one side effect', async () => {
  const f = fixture();
  const before = f.state;
  const results = await Promise.all([1, 2, 3].map(() => advanceMaintenance(before, f.journal, f.adapter, () => 2000)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
  assert.equal(await advanceMaintenance(before, f.journal, f.adapter, () => 2000), undefined);
});

test('failed persistence before intent prevents all effects', async () => {
  const f = fixture();
  await assert.rejects(advanceMaintenance(f.state, { async compareAndSwap() { throw new Error('disk full'); } }, f.adapter));
  assert.deepEqual(f.calls, []);
});

test('lost intent acknowledgment never invokes or replays effect', async () => {
  const f = fixture();
  await assert.rejects(advanceMaintenance(f.state, { async compareAndSwap(previous, next) {
    await f.journal.compareAndSwap(previous, next);
    throw new Error('ack lost');
  } }, f.adapter, () => 2000));
  assert.equal(f.state.executing, true);
  await f.step();
  assert.deepEqual(f.calls, []);
  await recoverInterruptedMaintenance(f.state, f.journal);
  assert.equal(f.state.reason, 'interrupted');
  await f.step();
  assert.deepEqual(f.calls, []);
});

test('lost result persistence leaves executing intent and never repeats a completed stop', async () => {
  const f = fixture();
  await f.until('stop');
  let writes = 0;
  await assert.rejects(advanceMaintenance(f.state, { async compareAndSwap(previous, next) {
    if (++writes === 2) throw new Error('result unavailable');
    return f.journal.compareAndSwap(previous, next);
  } }, f.adapter, () => 2000));
  assert.equal(f.state.executing, true);
  await f.step();
  assert.equal(f.calls.filter(call => call === 'stop').length, 1);
  await recoverInterruptedMaintenance(f.state, f.journal);
  assert.equal(f.state.stage, 'attention');
  assert.equal(f.state.fenceId, 'fence:1');
});

test('authority is revalidated at every stage, including after service stop', async () => {
  for (const stage of ['prepare', 'stop', 'backup', 'activate', 'start', 'ready', 'release'] as const) {
    const f = fixture();
    await f.until(stage);
    f.adapter.authorize = async () => false;
    const before = f.calls.length;
    await f.step();
    assert.equal(f.state.reason, 'authorization_changed');
    assert.equal(f.calls.length, before);
  }
});

test('expired job never invokes adapter, including expiration during authorization', async () => {
  const f = fixture();
  await f.step(() => 60_000);
  assert.equal(f.state.reason, 'deadline');
  assert.deepEqual(f.calls, []);
  const g = fixture();
  let now = 2000;
  g.adapter.authorize = async () => { now = 60_000; return true; };
  await g.step(() => now);
  assert.equal(g.state.reason, 'deadline');
  assert.deepEqual(g.calls, []);
});

test('reject stale/future/foreign/unverified native evidence and fence mismatch', async () => {
  for (const patch of [{ observedAt: -4000 }, { observedAt: 2001 }, { nodeId: 'other' }, { nativeVerified: false },
    { activeRuns: -1 }, { backgroundTerminals: undefined }, { pendingExecutions: undefined },
    { backgroundTerminals: -1 }, { pendingExecutions: 0.5 },
    { queuedMessages: 0.1 }, { inFlightWrites: NaN }, { fenceId: 'other' }]) {
    const f = fixture();
    await f.until('recheck');
    const inspect = f.adapter.inspect;
    f.adapter.inspect = async job => ({ ...await inspect(job), ...patch } as Awaited<ReturnType<typeof inspect>>);
    await f.step();
    assert.equal(f.state.reason, 'invalid_evidence');
    assert.equal(f.calls.includes('stop'), false);
  }
});

test('background terminals and uncertain executions prevent stop even without an active foreground run', async () => {
  for (const field of ['backgroundTerminals', 'pendingExecutions'] as const) {
    for (const stage of ['drain', 'recheck', 'stop'] as const) {
      const f = fixture();
      await f.until(stage);
      const inspect = f.adapter.inspect;
      f.adapter.inspect = async job => ({ ...await inspect(job), [field]: 1 });
      await f.step();
      assert.equal(f.state.stage, stage === 'drain' ? 'drain' : 'unfence');
      assert.equal(f.calls.includes('stop'), false);
    }
  }
});

test('incomplete stopped/backup/activation/readiness/fence proofs cannot report success', async () => {
  const cases = [
    ['stopped', 'stopped', { descendantsStopped: false }],
    ['backup', 'backup', { consistent: false }],
    ['backup', 'backup', { verified: false }],
    ['activate', 'activate', { revision: 'c'.repeat(40) }],
    ['ready', 'ready', { nodeId: 'other' }],
    ['ready', 'ready', { projectionVerified: false }],
    ['ready', 'ready', { businessReadVerified: false }],
    ['ready', 'ready', { protocolCompatible: false }],
    ['ready', 'ready', { manifestSha256: 'd'.repeat(64) }],
    ['release', 'releaseFence', { released: false }],
  ] as const;
  for (const [stage, method, patch] of cases) {
    const f = fixture();
    await f.until(stage);
    const original = f.adapter[method];
    Object.assign(f.adapter, { [method]: async (job: MaintenanceJob) => ({ ...await original(job), ...patch }) });
    await f.step();
    assert.equal(f.state.reason, 'invalid_evidence', `${stage}: ${JSON.stringify(patch)}`);
    assert.equal(f.state.fenceId, 'fence:1');
  }
});

test('errors are sanitized and cannot leak credentials into receipts', async () => {
  const f = fixture();
  f.adapter.prepare = async () => { throw new Error('SECRET_TEST_VALUE'); };
  await f.step();
  assert.equal(f.state.reason, 'operation_failed');
  assert.equal(JSON.stringify(f.state).includes('SECRET_TEST_VALUE'), false);
});

test('adapter cannot mutate persisted command identity through its job argument', async () => {
  const f = fixture();
  f.adapter.authorize = async job => { (job as MaintenanceJob).nodeId = 'other'; return true; };
  f.adapter.prepare = async job => { assert.equal(job.nodeId, 'node:1'); return release; };
  await f.step();
  assert.equal(f.state.nodeId, 'node:1');
  assert.equal(f.state.stage, 'drain');
});

test('strict persisted schema rejects arbitrary executable inputs and contradictory proofs', async () => {
  const initial = create();
  for (const patch of [{ command: 'arbitrary' }, { version: 2 }, { operation: 'shell' }, { nodeId: '../bad' },
    { deadline: 1000 }, { deadline: 1000 + 86_400_001 }, { revision: 1.5 }, { executing: false },
    { stage: 'succeeded' }, { stage: 'attention' }, { release }, { fenceId: 'fence:1' }, { reason: 'unknown' }]) {
    assert.equal(validMaintenanceJob({ ...initial, ...patch }), false);
  }
  const f = fixture();
  await f.until('drain');
  assert.equal(validMaintenanceJob({ ...f.state, fenceId: 'stale' }), false);
  assert.equal(validMaintenanceJob({ ...f.state, release: { ...release, path: '/arbitrary' } }), false);
  const overflow = { ...initial, revision: Number.MAX_SAFE_INTEGER };
  await assert.rejects(advanceMaintenance(overflow, f.journal, f.adapter), /revision exhausted/);
  assert.deepEqual(f.calls, ['authorize', 'prepare']);
});
