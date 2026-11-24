import assert from 'node:assert/strict';
import test from 'node:test';
import { isSdkCompactCommand } from './sdk-text-command.js';

test('SDK compact classifier includes arguments and whitespace without blocking prose', () => {
  for (const text of ['/compact', ' /compact ', '/compact focus on tests', '\n/compact\tkeep context', '/compact\nkeep context']) {
    assert.equal(isSdkCompactCommand(text), true, JSON.stringify(text));
  }
  for (const text of ['Explain /compact', '`/compact`', '/compaction', '/compact-test', 'text\n/compact', '']) {
    assert.equal(isSdkCompactCommand(text), false, JSON.stringify(text));
  }
});
