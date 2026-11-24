import assert from 'node:assert/strict';
import test from 'node:test';
import { newMaintenanceJob, type MaintenanceJob } from './connector-maintenance.js';
import { cancelPreFenceMaintenance, cancelSupersededPreFenceMaintenance, reconcilePreFenceMaintenance, reconcileReleasedReadiness, type SupersededPreFenceProof, type ReleasedReadinessProof, type PreFenceReconciliationProof } from './maintenance-reconciliation.js';

const job: MaintenanceJob = { ...newMaintenanceJob({ id: 'job:1', nodeId: 'node:1', actorId: 'actor:1',
  operation: 'upgrade', createdAt: 1000, deadline: 60_000 }), revision: 94, stage: 'attention', reason: 'operation_failed',
  release: { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) } };
const proof: PreFenceReconciliationProof = { nodeId: job.nodeId, observedAt: 100_000, workerStopped: true,
  serviceStartedAt: 500, serviceRunning: true, originalReleaseVerified: true, candidate: job.release!,
  admissionReleased: true, failedInvocationFenceAbsent: true };

test('superseded cancellation requires exact externally installed candidate, new generation and fresh authority', async () => {
  const failed: MaintenanceJob = { ...job, failedStage: 'drain' };
  const verified: SupersededPreFenceProof = { ...proof, serviceStartedAt: 2000, serviceInvocationId: 'a'.repeat(32),
    previousReleaseVerified: true, currentRelease: job.release! };
  let writes = 0;
  const deps = { now: () => 100_000, authorize: async () => true, inspect: async () => verified,
    journal: { cancelSupersededObservation(previous: MaintenanceJob, evidence: SupersededPreFenceProof, at: number) {
      assert.deepEqual(previous, failed); assert.deepEqual(evidence, verified); assert.equal(at, 100_000); writes++; return undefined;
    } } };
  for (const patch of [{ stage: 'drain' }, { failedStage: undefined }, { failedStage: 'ready' }, { executing: true },
    { operation: 'recover' }, { reason: 'interrupted' }, { release: undefined }, { fenceId: 'fence' }, { backupId: 'backup' },
    { revision: Number.MAX_SAFE_INTEGER }])
    await assert.rejects(cancelSupersededPreFenceMaintenance({ ...failed, ...patch } as MaintenanceJob, deps));
  for (const patch of [{ nodeId: 'other' }, { serviceStartedAt: 1000 }, { serviceStartedAt: 100_001 },
    { observedAt: 94_999 }, { observedAt: 100_001 }, { workerStopped: false }, { serviceRunning: false },
    { previousReleaseVerified: false }, { admissionReleased: false }, { failedInvocationFenceAbsent: false },
    { serviceInvocationId: 'invalid' }, { candidate: { ...job.release, revision: 'c'.repeat(40) } },
    { currentRelease: { ...job.release, manifestSha256: 'c'.repeat(64) } }])
    await assert.rejects(cancelSupersededPreFenceMaintenance(failed, { ...deps,
      inspect: async () => ({ ...verified, ...patch }) as SupersededPreFenceProof }));
  let checks = 0;
  await assert.rejects(cancelSupersededPreFenceMaintenance(failed, { ...deps, authorize: async () => ++checks < 2 }));
  let clock = 0;
  await assert.rejects(cancelSupersededPreFenceMaintenance(failed, { ...deps, now: () => ++clock === 1 ? 100_000 : 105_001 }));
  assert.equal(writes, 0);
  await cancelSupersededPreFenceMaintenance(failed, deps); assert.equal(writes, 1);
});

test('different replacement requires receipt-bound proof and retains pre-fence, generation and authorization guards', async () => {
  const failed: MaintenanceJob = { ...job, failedStage: 'drain' };
  const currentRelease = { revision: 'c'.repeat(40), manifestSha256: 'd'.repeat(64) };
  const replacementAcceptance = { release: currentRelease, deploymentSha256: 'e'.repeat(64), acceptanceSha256: 'f'.repeat(64) };
  const verified: SupersededPreFenceProof = { ...proof, serviceStartedAt: 2000, serviceInvocationId: 'a'.repeat(32),
    previousReleaseVerified: true, currentRelease, replacementAcceptance };
  let writes = 0;
  const deps = { now: () => 100_000, authorize: async () => true, inspect: async () => verified,
    journal: { cancelSupersededObservation() { writes++; return undefined; } } };
  for (const patch of [{ replacementAcceptance: undefined }, { admissionReleased: false }, { workerStopped: false },
    { serviceStartedAt: 1000 }, { observedAt: 94_999 }, { currentRelease: job.release },
    { replacementAcceptance: { ...replacementAcceptance, deploymentSha256: 'bad' } },
    { replacementAcceptance: { ...replacementAcceptance, acceptanceSha256: '' } },
    { replacementAcceptance: { ...replacementAcceptance, release: job.release } }])
    await assert.rejects(cancelSupersededPreFenceMaintenance(failed, { ...deps, inspect: async () => ({ ...verified, ...patch }) as SupersededPreFenceProof }));
  for (const patch of [{ fenceId: 'fence' }, { backupId: 'backup' }, { failedStage: 'ready' }, { executing: true }])
    await assert.rejects(cancelSupersededPreFenceMaintenance({ ...failed, ...patch } as MaintenanceJob, deps));
  await assert.rejects(cancelSupersededPreFenceMaintenance(failed, { ...deps, authorize: async () => false }));
  assert.equal(writes, 0);
  await cancelSupersededPreFenceMaintenance(failed, deps); assert.equal(writes, 1);
});

test('post-ready reconciliation is observation-only, narrowly bound and requires released native and business proof', async () => {
  const failed: MaintenanceJob = { ...job, failedStage: 'ready', fenceId: 'fence:1', backupId: 'backup:1' };
  const verified: ReleasedReadinessProof = { nodeId: job.nodeId, observedAt: 100_000, workerStopped: true,
    serviceStartedAt: 2000, serviceRunning: true, release: job.release!, backupId: 'backup:1', backupVerified: true,
    fenceId: 'fence:1', releaseAccepted: true, originalSessionReadVerified: true,
    native: { nodeId: job.nodeId, observedAt: 100_000, nativeVerified: true,
      activeRuns: 0, backgroundTerminals: 0, pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0 } };
  let writes = 0;
  const deps = { now: () => 100_000, authorize: async () => true, inspect: async () => verified,
    journal: { completeReleasedReadiness(previous: MaintenanceJob, at: number) {
      assert.deepEqual(previous, failed); assert.equal(at, 100_000); writes++; return undefined;
    } } };
  const invalid: Partial<MaintenanceJob>[] = [{ failedStage: 'release' }, { reason: 'interrupted' }, { stage: 'ready' },
    { executing: true }, { operation: 'recover' }];
  for (const patch of invalid) await assert.rejects(reconcileReleasedReadiness({ ...failed, ...patch }, deps));
  for (const key of ['fenceId', 'backupId', 'release'] as const) {
    const missing = { ...failed };
    delete missing[key];
    await assert.rejects(reconcileReleasedReadiness(missing, deps));
  }
  for (const patch of [{ nodeId: 'other' }, { observedAt: 94_999 }, { observedAt: 100_001 }, { workerStopped: false },
    { serviceStartedAt: 999 }, { serviceRunning: false }, { release: { ...job.release, manifestSha256: 'c'.repeat(64) } },
    { backupId: 'other' }, { backupVerified: false }, { fenceId: 'other' }, { releaseAccepted: false }, { originalSessionReadVerified: false }]) {
    await assert.rejects(reconcileReleasedReadiness(failed, { ...deps, inspect: async () => ({ ...verified, ...patch }) as ReleasedReadinessProof }));
  }
  for (const patch of [{ nodeId: 'other' }, { observedAt: 94_999 }, { nativeVerified: false }, { activeRuns: 1 },
    { backgroundTerminals: 1 }, { pendingExecutions: 1 }, { queuedMessages: 1 }, { inFlightWrites: 1 }, { fenceId: 'fence:1' }]) {
    await assert.rejects(reconcileReleasedReadiness(failed, { ...deps,
      inspect: async () => ({ ...verified, native: { ...verified.native, ...patch } }) as ReleasedReadinessProof }));
  }
  let checks = 0;
  await assert.rejects(reconcileReleasedReadiness(failed, { ...deps, authorize: async () => ++checks < 2 }));
  let clock = 0;
  await assert.rejects(reconcileReleasedReadiness(failed, { ...deps, now: () => ++clock === 1 ? 100_000 : 105_001 }));
  assert.equal(writes, 0);
  assert.equal(await reconcileReleasedReadiness(failed, deps), undefined);
  assert.equal(writes, 1);
});

test('local reconciliation preserves identity and rearms only natural drain after independent proof', async () => {
  let checks = 0, writes = 0;
  const result = await reconcilePreFenceMaintenance(job, {
    now: () => 100_000, authorize: async () => { checks++; return true; }, inspect: async () => proof,
    journal: { resumeObservation(previous, deadline, at) {
      writes++; assert.deepEqual(previous, job); assert.equal(deadline, 1_900_000); assert.equal(at, 100_000);
      return { ...previous, stage: 'drain', deadline, revision: previous.revision + 1 };
    } },
  });
  assert.equal(checks, 2); assert.equal(writes, 1); assert.equal(result?.id, job.id);
});

test('unknown effects, post-fence jobs and changed evidence never authorize reconciliation', async () => {
  const invalidJobs: Partial<MaintenanceJob>[] = [{ executing: true }, { reason: 'interrupted' }, { reason: 'deadline' },
    { fenceId: 'fence:1' }, { backupId: 'backup:1' }, { operation: 'recover' }, { failedStage: 'fence' },
    { failedStage: 'stop' }, { stage: 'drain' }];
  let writes = 0;
  const deps = { now: () => 100_000, authorize: async () => true, inspect: async () => proof,
    journal: { resumeObservation() { writes++; return undefined; } } };
  for (const patch of invalidJobs) await assert.rejects(reconcilePreFenceMaintenance({ ...job, ...patch }, deps));
  for (const patch of [{ nodeId: 'other' }, { observedAt: 94999 }, { observedAt: 100001 }, { workerStopped: false },
    { serviceStartedAt: 1001 }, { serviceStartedAt: 0 }, { serviceRunning: false }, { originalReleaseVerified: false },
    { candidate: { ...proof.candidate, revision: 'c'.repeat(40) } }, { admissionReleased: false }, { failedInvocationFenceAbsent: false }]) {
    await assert.rejects(reconcilePreFenceMaintenance(job, { ...deps,
      inspect: async () => ({ ...proof, ...patch }) as PreFenceReconciliationProof }));
  }
  let checks = 0;
  await assert.rejects(reconcilePreFenceMaintenance(job, { ...deps, authorize: async () => ++checks < 2 }));
  assert.equal(writes, 0);
});

const draining: MaintenanceJob = { ...job, stage: 'drain' };
delete draining.reason;

test('operator cancellation preserves the candidate and request identity even after the observation deadline', async () => {
  let checks = 0, writes = 0;
  const result = await cancelPreFenceMaintenance(draining, {
    now: () => 100_000, authorize: async () => { checks++; return true; }, inspect: async () => proof,
    journal: { cancelObservation(previous, at) {
      writes++; assert.deepEqual(previous, draining); assert.equal(at, 100_000);
      return { ...previous, stage: 'cancelled', revision: previous.revision + 1 };
    } },
  });
  assert.equal(checks, 2); assert.equal(writes, 1); assert.equal(result?.stage, 'cancelled');
  assert.equal(result?.id, draining.id); assert.deepEqual(result?.release, draining.release);
});

test('cancellation refuses unknown effects, changed/stale proof and revoked authority without journal writes', async () => {
  let writes = 0;
  const deps = { now: () => 100_000, authorize: async () => true, inspect: async () => proof,
    journal: { cancelObservation() { writes++; return undefined; } } };
  const patches: Partial<MaintenanceJob>[] = [{ executing: true }, { stage: 'fence' }, { stage: 'attention', reason: 'deadline' },
    { stage: 'cancelled' }, { fenceId: 'unknown' }, { backupId: 'backup' },
    { operation: 'recover' }, { revision: Number.MAX_SAFE_INTEGER }];
  for (const patch of patches) await assert.rejects(cancelPreFenceMaintenance({ ...draining, ...patch }, deps));
  const missingRelease = { ...draining }; delete missingRelease.release;
  await assert.rejects(cancelPreFenceMaintenance(missingRelease, deps));
  for (const patch of [{ nodeId: 'other' }, { observedAt: 94_999 }, { observedAt: 100_001 }, { workerStopped: false },
    { serviceStartedAt: 1001 }, { serviceStartedAt: 0 }, { serviceRunning: false }, { originalReleaseVerified: false },
    { candidate: { ...proof.candidate, manifestSha256: 'c'.repeat(64) } }, { admissionReleased: false },
    { failedInvocationFenceAbsent: false }]) {
    await assert.rejects(cancelPreFenceMaintenance(draining, { ...deps,
      inspect: async () => ({ ...proof, ...patch }) as PreFenceReconciliationProof }));
  }
  let checks = 0;
  await assert.rejects(cancelPreFenceMaintenance(draining, { ...deps, authorize: async () => ++checks < 2 }));
  let clock = 0;
  await assert.rejects(cancelPreFenceMaintenance(draining, { ...deps, now: () => ++clock === 1 ? 100_000 : 105_001 }));
  clock = 0;
  await assert.rejects(cancelPreFenceMaintenance(draining, { ...deps, now: () => ++clock === 1 ? 100_000 : 99_999 }));
  assert.equal(writes, 0);
});

test('cancellation loses CAS without retrying or mutating the callers snapshot', async () => {
  const input = structuredClone(draining);
  const result = await cancelPreFenceMaintenance(input, {
    now: () => 100_000, authorize: async snapshot => { (snapshot as MaintenanceJob).actorId = 'mutated'; return true; },
    inspect: async snapshot => { snapshot.release!.revision = 'c'.repeat(40); return proof; },
    journal: { cancelObservation(previous) { assert.deepEqual(previous, draining); return undefined; } },
  });
  assert.equal(result, undefined); assert.deepEqual(input, draining);
});
