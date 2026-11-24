import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSafeSecretDirective, GUIDANCE_TEMPLATES } from './session-guidance.js';

test('GUIDANCE_TEMPLATES provides built-in agent guidance presets and formatSafeSecretDirective formats envelopes safely', () => {
  assert.ok(GUIDANCE_TEMPLATES.length >= 4);
  const secretDirective = formatSafeSecretDirective('OPENAI_API_KEY', 'sk-test-1234567890', 'secret');
  assert.equal(secretDirective, 'Credential OPENAI_API_KEY: [[AOD_SECRET:sk-test-1234567890]]');
  const pathDirective = formatSafeSecretDirective('DB_PASS', '/run/secrets/db_pass', 'path');
  assert.match(pathDirective, /private file \/run\/secrets\/db_pass/);
});
