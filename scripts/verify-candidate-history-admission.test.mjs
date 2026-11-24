import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHistoryAdmissionPolicy } from './verify-candidate-history-admission.mjs';
import { nativeGoalEvidence, nativeGoalProtection } from '../apps/server/src/codex/native-history.ts';
import { CodexExecutions } from '../apps/server/src/codex/executions.ts';

const policy = { nativeGoalEvidence, nativeGoalProtection, CodexExecutions };

test('admission release gate accepts normal source policy with a real isolated execution database', () => {
  assert.deepEqual(assertHistoryAdmissionPolicy(policy), [
    'goal-policy', 'restarted-existing-session-positive-and-negative-admission', 'invalidation-remains-fail-closed',
    'explicit-blocked-goal-input-and-identity-boundaries',
  ]);
});

test('admission gate rejects an older release missing explicit blocked-goal recovery', () => {
  class MissingRecovery extends CodexExecutions {
    canStart(key) { return super.canStart(key); }
  }
  assert.throws(() => assertHistoryAdmissionPolicy({ ...policy, CodexExecutions: MissingRecovery }),
    /Only blocked goals may admit explicitly authorized user input/);
});

test('admission gate rejects opt-in bypasses for other protected goals', () => {
  class UnsafeRecovery extends CodexExecutions {
    canStart(key, explicit) {
      return explicit && this.get(key)?.nativeHistory ? true : super.canStart(key, explicit);
    }
  }
  assert.throws(() => assertHistoryAdmissionPolicy({ ...policy, CodexExecutions: UnsafeRecovery }),
    /Only blocked goals may admit explicitly authorized user input/);
});

test('admission gate rejects stale connection dispatch despite an explicit user message', () => {
  class StaleConnection extends CodexExecutions {
    begin(key, command, connection, preparing, batch, explicit) {
      return super.begin(key, command, explicit ? this.get(key)?.nativeHistory?.connectionId ?? connection : connection,
        preparing, batch, explicit);
    }
  }
  assert.throws(() => assertHistoryAdmissionPolicy({ ...policy, CodexExecutions: StaleConnection }),
    /User-input exception must not bypass connection identity/);
});

test('admission gate rejects fallback-only goals even if fresh sessions would work', () => {
  assert.throws(() => assertHistoryAdmissionPolicy({ ...policy, nativeGoalProtection: () => 'goal-unknown' }),
    /Normal release must not inherit fallback-only goal protection/);
});

test('admission gate rejects a fallback that denies every checkpoint-bearing old session', () => {
  class DeniedCheckpoints extends CodexExecutions {
    canStart(key) { return this.get(key)?.nativeHistory ? false : super.canStart(key); }
  }
  assert.throws(() => assertHistoryAdmissionPolicy({ ...policy, CodexExecutions: DeniedCheckpoints }),
    /Verified old sessions must regain admission/);
});

test('admission gate rejects accepting blocked goals or treating malformed evidence as absence', () => {
  assert.throws(() => assertHistoryAdmissionPolicy({ ...policy, nativeGoalProtection: () => undefined }));
  assert.throws(() => assertHistoryAdmissionPolicy({ ...policy, nativeGoalEvidence: () => ({ status: 'absent' }) }));
});

test('admission gate rejects claiming dispatch readiness after checkpoint invalidation', () => {
  class MissedInvalidation extends CodexExecutions {
    invalidateNativeHistory() { /* simulate lost invalidation in a candidate */ }
  }
  assert.throws(() => assertHistoryAdmissionPolicy({ ...policy, CodexExecutions: MissedInvalidation }));
});

test('admission gate rejects replacing the original command ownership with a native successor', () => {
  class AdoptedSuccessor extends CodexExecutions {
    get(key) {
      const fact = super.get(key);
      return fact?.nativeHistory ? { ...fact, runId: fact.nativeHistory.turnId } : fact;
    }
  }
  assert.throws(() => assertHistoryAdmissionPolicy({ ...policy, CodexExecutions: AdoptedSuccessor }));
});
