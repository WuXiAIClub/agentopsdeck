import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseCandidateStartupArguments } from './candidate-startup-options.mjs';

const candidateRoot = resolve('isolated-candidate');
test('startup browser acceptance is opt-in; normal startup remains browser-free', () => {
  assert.deepEqual(parseCandidateStartupArguments([candidateRoot]), {
    candidateRoot, applicationBrowserRecovery: false,
  });
  assert.deepEqual(parseCandidateStartupArguments([candidateRoot, '--application-browser-recovery']), {
    candidateRoot, applicationBrowserRecovery: true,
  });
});
test('startup rejects relative roots, unknown flags and extra arguments before side effects', () => {
  for (const args of [undefined, [], ['relative'], [null], [candidateRoot, '--unknown'],
    [candidateRoot, '--application-browser-recovery', '--unknown']]) {
    assert.throws(() => parseCandidateStartupArguments(args), assert.AssertionError);
  }
});
