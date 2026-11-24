import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeInteractionCoverage, verifyNativeInteractionEvidence } from './native-interaction-evidence.mjs';

function fixture(scenario = 'matrix') {
  const evidencePath = '/tmp/disposable-native-proof', candidate = { manifestSha256: 'a'.repeat(64) };
  return { scenario, code: 0, candidate, evidencePath,
    rows: [{ evidence: evidencePath, scope: 'isolated-real-model' }, { evidence: evidencePath, processCleanupVerified: true }],
    result: { passed: true, scope: 'isolated-real-model-Hub-Connector-native-workers', productionTouched: false,
      candidate: { ...candidate }, hostClosed: true, interactionEvents: 1,
      stages: nativeInteractionCoverage(scenario).map(stage => ({ ...stage, passed: true,
        actualFileEffectChecked: true, sdkOwnershipFenced: stage.runtime !== 'codex',
        multiSelect: stage.runtime === 'claude-code', viewport: { width: 1440, height: 900 } })) } };
}
for (const [scenario, count] of Object.entries({ matrix: 18, goals: 5, pending: 3, questions: 3, browser: 3 })) {
  test(`${scenario} validates exact semantic coverage (${count})`, () => {
    const proof = fixture(scenario);
    proof.result.stages.reverse();
    assert.equal(verifyNativeInteractionEvidence(proof).checkpoints, count);
  });
}
const mutations = {
  'old 15 checkpoint matrix': p => p.result.stages.splice(15),
  'same count duplicated checkpoint': p => { p.result.stages[1] = p.result.stages[0]; },
  'same count wrong label': p => { p.result.stages[0].label = 'unrelated'; },
  'wrong runtime': p => { p.result.stages[0].runtime = 'hermes'; },
  'failed checkpoint': p => { p.result.stages[0].passed = false; },
  'failed process': p => { p.code = 1; },
  'failed scenario': p => { p.result.passed = false; },
  'production mutation': p => { p.result.productionTouched = true; },
  'wrong scope': p => { p.result.scope = 'production'; },
  'candidate drift': p => { p.result.candidate.manifestSha256 = 'b'.repeat(64); },
  'unpinned candidate': p => { p.candidate = {}; p.result.candidate = {}; },
  'missing host cleanup': p => { p.result.hostClosed = false; },
  'failed stream': p => { p.result.streamFailed = true; },
  'no events': p => { p.result.interactionEvents = 0; },
  'file effects unchecked': p => { delete p.result.stages.find(s => s.label === 'deny').actualFileEffectChecked; },
  'missing SDK fence': p => { p.result.stages.find(s => s.label.startsWith('forced-') && s.runtime === 'ghcp').sdkOwnershipFenced = false; },
  'missing cleanup receipt': p => { p.rows.pop(); },
  'another probes cleanup': p => { p.rows[1].evidence = '/tmp/another'; },
  'another probes startup': p => { p.rows[0].evidence = '/tmp/another'; },
  'unknown scenario': p => { p.scenario = 'unknown'; },
};
for (const [label, mutate] of Object.entries(mutations)) test(`rejects ${label}`, () => {
  const proof = fixture(); mutate(proof); assert.throws(() => verifyNativeInteractionEvidence(proof));
});
test('forced shutdown diagnostic accepted only for fenced negative scenarios', () => {
  for (const scenario of ['matrix', 'pending', 'goals', 'questions', 'browser']) {
    const proof = fixture(scenario);
    proof.result.hostCloseFailure = formatHostCloseDiagnostic(Object.assign(new Error('private path /secret/token'), {
      name: 'SecretProviderError',
      code: 'ERR_IPC_CHANNEL_CLOSED',
      stack: 'SecretProviderError: token\n    at /private/file.js:1:1',
    }));
    assert.deepEqual(proof.result.hostCloseFailure, { name: 'Error', code: 'ERR_IPC_CHANNEL_CLOSED' });
    if (['matrix', 'pending'].includes(scenario)) assert.ok(verifyNativeInteractionEvidence(proof).passed);
    else assert.throws(() => verifyNativeInteractionEvidence(proof));
  }
  const unallowlisted = fixture('matrix');
  unallowlisted.result.hostCloseFailure = { name: 'Error', frames: ['at /private/file.js:1:1'] };
  assert.throws(() => verifyNativeInteractionEvidence(unallowlisted), /Raw stack frames/);
});
test('questions and browser require actual shape and viewport evidence', () => {
  const questions = fixture('questions'); questions.result.stages[1].multiSelect = false;
  assert.throws(() => verifyNativeInteractionEvidence(questions));
  const browser = fixture('browser'); delete browser.result.stages[0].viewport;
  assert.throws(() => verifyNativeInteractionEvidence(browser));
});
import { formatHostCloseDiagnostic } from './sdk-service-host.mjs';
