import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

// Deliberately checks the shipped policy, not a source-file string match. Only
// an in-memory synthetic database is used; no native thread or goal is changed.
export function assertHistoryAdmissionPolicy({ nativeGoalEvidence, nativeGoalProtection, CodexExecutions }) {
  const database = new DatabaseSync(':memory:');
  const checks = [];

  try {
    for (const status of ['absent', 'complete']) {
      assert.equal(nativeGoalProtection(status), undefined, 'Normal release must not inherit fallback-only goal protection');
    }
    for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'unknown']) {
      assert.equal(nativeGoalProtection(status), `goal-${status}`);
    }
    assert.equal(nativeGoalEvidence({ goal: null }, 'session').status, 'absent');
    assert.equal(nativeGoalEvidence({}, 'session').status, 'unknown');
    assert.equal(nativeGoalEvidence({ goal: { status: 'complete', threadId: 'other' } }, 'session').status, 'unknown');
    checks.push('goal-policy');

    const executions = new CodexExecutions(database);
    assert.equal(executions.begin('session', 'owned-command', 'old-process'), true);
    executions.acknowledge('session', 'owned-command', 'old-process', 'owned-turn', () => {});
    executions.observe('session', 'old-process', 'owned-turn', 'completed');
    const original = executions.get('session');
    const checkpoint = { turnId: 'native-head', fingerprint: 'a'.repeat(64), connectionId: 'old-process', state: 'blocked', reason: 'goal-unknown' };
    assert.equal(executions.settleNativeHistory(original, checkpoint), true);
    assert.equal(executions.canStart('session'), false);
    executions.recoverInterrupted();
    assert.equal(executions.canStart('session'), false);
    for (const state of ['blocked', 'verified']) {
      const before = executions.get('session');
      assert.equal(executions.settleNativeHistory(before, { ...checkpoint, connectionId: 'new-process', state,
        reason: state === 'verified' ? 'settled' : 'goal-blocked' }), true);
      assert.equal(executions.canStart('session'), state === 'verified', 'Verified old sessions must regain admission');
      const after = executions.get('session');
      for (const field of ['commandId', 'connectionId', 'runId', 'phase']) assert.equal(after[field], original[field]);
    }
    checks.push('restarted-existing-session-positive-and-negative-admission');
    executions.invalidateNativeHistory('session');
    assert.equal(executions.canStart('session'), false);
    checks.push('invalidation-remains-fail-closed');

    // This is only the storage admission gate. The worker must additionally
    // prove native quiescence, current authority and durable explicit input.
    for (const status of ['blocked', 'active', 'paused', 'usageLimited', 'budgetLimited', 'unknown']) {
      const reason = `goal-${status}`;
      assert.equal(executions.settleNativeHistory(executions.get('session'), {
        ...checkpoint, connectionId: 'new-process', reason,
      }), true);
      assert.equal(executions.canStart('session'), false, 'User-input exception must never become default admission');
      assert.equal(executions.canStart('session', true), status === 'blocked',
        'Only blocked goals may admit explicitly authorized user input');
    }
    assert.equal(executions.settleNativeHistory(executions.get('session'), {
      ...checkpoint, connectionId: 'new-process', reason: 'goal-blocked',
    }), true);
    const blocked = executions.get('session');
    assert.equal(executions.begin('session', 'next-command', 'old-process', false, undefined, true), false,
      'User-input exception must not bypass connection identity');
    assert.equal(executions.begin('session', 'next-command', 'new-process', true, undefined, true), false,
      'User-input exception must not permit preparation');
    assert.equal(executions.begin('session', 'next-command', 'new-process'), false,
      'Default dispatch must still protect blocked goals');
    assert.deepEqual(executions.get('session'), blocked, 'Rejected dispatch must preserve prior ownership');
    assert.equal(executions.begin('session', 'next-command', 'new-process', false, undefined, true), true,
      'Shipped release must retain explicit blocked-goal user-input recovery');
    const started = executions.get('session');
    assert.equal(started.commandId, 'next-command');
    assert.equal(started.connectionId, 'new-process');
    assert.equal(started.runId, undefined, 'Never adopt the prior native turn as the new command');
    assert.equal(executions.canStart('session', true), false, 'Exception must not admit a concurrent execution');
    checks.push('explicit-blocked-goal-input-and-identity-boundaries');
    return checks;
  } finally {
    database.close();
  }
}

export async function verifyCandidateHistoryAdmission(directory) {
  assert.ok(directory && isAbsolute(directory), 'Provide one absolute candidate directory');
  const candidate = await verifyCandidateRelease(directory);
  const load = name => import(pathToFileURL(join(directory, 'apps/server/dist/codex', name)).href);
  const policy = await load('native-history.js');
  const execution = await load('executions.js');
  const checks = assertHistoryAdmissionPolicy({ ...policy, ...execution });
  assert.deepEqual(await verifyCandidateRelease(directory), candidate, 'Candidate changed during admission verification');
  return { passed: true, manifestSha256: candidate.manifestSha256, checks,
    nativeExecutionTested: false, requiresRealExistingSessionAcceptance: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Provide one absolute candidate directory');
  console.log(JSON.stringify(await verifyCandidateHistoryAdmission(process.argv[2])));
}
