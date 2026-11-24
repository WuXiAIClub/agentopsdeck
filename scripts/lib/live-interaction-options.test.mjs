import assert from 'node:assert/strict';
import test from 'node:test';
import { liveInteractionOptions, newTurnFailed } from './live-interaction-options.mjs';

const args = ['/private/settings.json', '/bin/codex', 'http://127.0.0.1:4141'];
test('live acceptance validates scope before credentials or worker startup', () => {
  assert.deepEqual(liveInteractionOptions(args).runtimes, ['codex', 'claude-code', 'ghcp']);
  for (const scenario of ['matrix', 'pending', 'goals', 'questions', 'browser']) {
    assert.equal(liveInteractionOptions([...args, 'codex', scenario]).scenario, scenario);
  }
  for (const extra of [['claude-code', 'goals'], ['codex,codex'], ['hermes'], [''], ['codex', 'invalid'], ['codex', 'matrix', 'extra']]) {
    assert.throws(() => liveInteractionOptions([...args, ...extra]));
  }
  for (const url of ['http://example.com:4141', 'http://secret@127.0.0.1:4141', 'http://127.0.0.1:4141/path', 'http://127.0.0.1:4141/?key=value', 'https://127.0.0.1:4141']) {
    assert.throws(() => liveInteractionOptions([args[0], args[1], url]));
  }
  assert.throws(() => liveInteractionOptions(['relative', ...args.slice(1)]));
});
test('previous stopped snapshot cannot fail a newly accepted command', () => {
  for (const phase of ['failed', 'unknown', 'interrupted']) {
    assert.equal(newTurnFailed({ turnId: 'old', phase }, 'old'), false);
    assert.equal(newTurnFailed({ turnId: 'new', phase }, 'old'), true);
    assert.equal(newTurnFailed({ phase }, 'old'), false);
  }
  assert.equal(newTurnFailed(undefined, undefined), false);
  assert.equal(newTurnFailed({ turnId: 'new', phase: 'running' }, 'old'), false);
});
test('live acceptance optionally pins a frozen release without broadening scenario scope', () => {
  assert.equal(liveInteractionOptions([...args, 'codex', 'matrix', '/releases/candidate']).candidateRoot, '/releases/candidate');
  assert.equal(liveInteractionOptions(args).candidateRoot, undefined);
  assert.throws(() => liveInteractionOptions([...args, 'codex', 'matrix', 'relative']));
  assert.throws(() => liveInteractionOptions([...args, 'codex', 'matrix', '/releases/candidate', 'extra']));
});
