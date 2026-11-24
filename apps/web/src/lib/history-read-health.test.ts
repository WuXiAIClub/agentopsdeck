import assert from 'node:assert/strict';
import test from 'node:test';
import { failedRead, healthyRead, isCancelledRead } from './history-read-health.js';

test('scope/transport cancellation is not a sync failure or recovery', () => {
  const abort = new DOMException('Preview mode changed', 'AbortError');
  assert.equal(isCancelledRead(abort), true);
  assert.equal(failedRead(healthyRead, abort, false), healthyRead);
  const failed = failedRead(healthyRead, new Error('offline'), false);
  assert.equal(failedRead(failed, abort, true), failed);
});
test('background degradation remains visible and consecutive failures escalate', () => {
  const first = failedRead(healthyRead, new Error('network timeout'), true);
  assert.deepEqual(first, { failures: 1, detail: 'network timeout', severity: 'warning' });
  assert.equal(failedRead(first, new Error('network timeout'), true).severity, 'error');
  assert.equal(failedRead(healthyRead, new Error('after a successful read'), true).severity, 'warning');
});
test('no content, manual retry and authorization errors are immediate failures', () => {
  assert.equal(failedRead(healthyRead, new Error('offline'), false).severity, 'error');
  assert.equal(failedRead(healthyRead, new Error('offline'), true, true).severity, 'error');
  for (const status of [401, 403]) assert.equal(failedRead(healthyRead, Object.assign(new Error('denied'), { status }), true).severity, 'error');
  assert.equal(failedRead(healthyRead, Object.assign(new Error('sign in'), { name: 'AuthRequiredError' }), true).severity, 'error');
  assert.equal(isCancelledRead(new Error('AbortError is just text')), false);
});
