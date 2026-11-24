import assert from 'node:assert/strict';

const runtimes = ['codex', 'claude-code', 'ghcp'];
const forced = 'forced-stop-pending-closed-no-replay';
const matrix = ['question-real-answer-and-duplicate-safe', 'allow-once', 'deny',
  'stop-pending-rejects-late-answer', 'restart-preserves-receipts-no-replay', forced];
const goals = ['native-goal-active-blocked-answer-completes',
  ...['paused', 'budgetLimited', 'usageLimited', 'changed-objective']
    .map(state => `native-goal-${state}-rejects-answer-no-resume`)];

export function nativeInteractionCoverage(scenario) {
  assert.ok(['matrix', 'goals', 'pending', 'questions', 'browser'].includes(scenario), 'Unknown native scenario');
  if (scenario === 'goals') return goals.map(label => ({ runtime: 'codex', label }));
  return runtimes.flatMap(runtime => (scenario === 'matrix' ? matrix
    : scenario === 'pending' ? [forced]
      : scenario === 'browser' ? ['actual-browser-Hub-Connector-native-answer-and-final']
        : [runtime === 'ghcp' ? 'native-freeform-unicode-answer' : 'native-two-questions-original-run'])
    .map(label => ({ runtime, label })));
}

// Exact semantic coverage, not a stale total or per-runtime count. Evidence is
// bound to one immutable candidate and the cleanup of THIS disposable probe.
export function verifyNativeInteractionEvidence({ scenario, code, result, rows, candidate, evidencePath }) {
  const expected = nativeInteractionCoverage(scenario);
  assert.equal(code, 0, 'Native process must exit successfully');
  assert.equal(result?.passed, true, 'Native scenario failed');
  assert.equal(result.scope, 'isolated-real-model-Hub-Connector-native-workers', 'Wrong native scope');
  assert.equal(result.productionTouched, false, 'Native probe must be isolated');
  assert.match(candidate?.manifestSha256 ?? '', /^[a-f0-9]{64}$/, 'Missing pinned candidate');
  assert.equal(result.candidate?.manifestSha256, candidate.manifestSha256, 'Wrong native candidate');
  assert.equal(result.hostClosed, true, 'Native host not closed');
  assert.ok(!result.streamFailed && !result.browserFailure && !result.failure, 'Native failure recorded');
  assert.ok(result.interactionEvents > 0, 'No native event delivery');
  const key = stage => `${stage.runtime}:${stage.label}`;
  assert.ok(Array.isArray(result.stages), 'Missing native checkpoints');
  assert.deepEqual(result.stages.map(key).sort(), expected.map(key).sort(), 'Incomplete or duplicate native coverage');
  for (const stage of result.stages) {
    assert.equal(stage.passed, true, 'Failed native checkpoint');
    if (['allow-once', 'deny'].includes(stage.label)) assert.equal(stage.actualFileEffectChecked, true, 'File effect unchecked');
    if (stage.label === forced) assert.equal(stage.sdkOwnershipFenced, stage.runtime !== 'codex', 'Ownership fence unchecked');
    if (stage.label === 'native-two-questions-original-run') assert.equal(stage.multiSelect, stage.runtime === 'claude-code', 'Question shape unchecked');
    if (scenario === 'browser') assert.ok(stage.viewport?.width > 0 && stage.viewport?.height > 0, 'Browser viewport unchecked');
  }
  // Forced pending-worker shutdown intentionally exits nonzero and retains
  // SDK ownership leases. Accept that diagnostic ONLY with every fence proof;
  // graceful scenarios must never silently swallow a close failure.
  if (result.hostCloseFailure) {
    assert.ok(['matrix', 'pending'].includes(scenario), 'Unexpected host close failure');
    assert.equal(result.hostCloseFailure.frames, undefined, 'Raw stack frames must not enter close diagnostic');
    assert.match(result.hostCloseFailure.name ?? '', /^[A-Za-z]{1,32}$/, 'Unallowlisted close diagnostic name');
    if (result.hostCloseFailure.code !== undefined) {
      assert.match(result.hostCloseFailure.code, /^(?:E[A-Z0-9_]{1,31}|ERR_[A-Z0-9_]{1,48})$/, 'Unallowlisted close diagnostic code');
    }
  }
  assert.ok(typeof evidencePath === 'string' && evidencePath.length > 0, 'Missing evidence path');
  assert.ok(rows.some(row => row.scope === 'isolated-real-model' && row.evidence === evidencePath), 'Unbound probe evidence');
  assert.ok(rows.some(row => row.processCleanupVerified === true && row.evidence === evidencePath), 'Native child cleanup unverified');
  return { scenario, checkpoints: expected.length, passed: true };
}
