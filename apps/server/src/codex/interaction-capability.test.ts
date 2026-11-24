import assert from 'node:assert/strict';
import test from 'node:test';
import { probeDefaultModeQuestions, supportsDefaultModeQuestions } from './interaction-capability.js';

for (const stage of ['under development', 'experimental', 'stable']) test(`question capability: ${stage}`, () => {
  for (const enabled of ['true', 'false']) assert.equal(supportsDefaultModeQuestions(`other stable true\r\ndefault_mode_request_user_input\t${stage}\t${enabled}\r\n`), true);
});
test('unknown, removed, substring and oversized feature metadata fail closed', () => {
  for (const output of ['', 'default_mode_request_user_input removed true', 'xdefault_mode_request_user_input stable true',
    'default_mode_request_user_input newstage true', 'default_mode_request_user_input stable unknown', 'x'.repeat(65537)]) {
    assert.equal(supportsDefaultModeQuestions(output), false);
  }
});
test('missing executable is unsupported, not a rejected startup', async () => {
  assert.equal(await probeDefaultModeQuestions('/nonexistent/agentopsdeck-test-cli', process.cwd()), false);
});
