import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalDiagnostics } from './goal-diagnostics.js';
import { conflictingNativeNotificationIdentity, nativeNotificationThread, nativeNotificationTurn } from './terminal-history-activity.js';

test('missing and matching redundant native aliases remain valid', () => {
  for (const params of [{}, { threadId: 'thread' }, { turnId: 'turn' },
    { threadId: 'thread', thread: { id: 'thread' }, turn: { id: 'turn', threadId: 'thread' },
      item: { threadId: 'thread' }, turnId: 'turn' }]) {
    assert.equal(conflictingNativeNotificationIdentity(params), false);
  }
  assert.equal(nativeNotificationThread({}), undefined);
  assert.equal(nativeNotificationTurn({}), undefined);
  assert.equal(nativeNotificationThread({ item: { threadId: 'thread' } }), 'thread');
  assert.equal(nativeNotificationTurn({ turnId: 'turn' }), 'turn');
});

test('whitespace-only supplied native identities are malformed, never absent or usable evidence', () => {
  for (const identity of ['', ' ', '\t', '\r\n', '\u00a0', '\u3000']) {
    for (const params of [{ threadId: identity }, { thread: { id: identity } }, { turn: { threadId: identity } },
      { item: { threadId: identity } }, { turnId: identity }, { turn: { id: identity } }]) {
      assert.equal(conflictingNativeNotificationIdentity(params), true);
    }
    assert.equal(nativeNotificationThread({ threadId: identity }), undefined);
    assert.equal(nativeNotificationTurn({ turnId: identity }), undefined);
  }
});

test('native identity rejection emits only allowlisted bounded metadata', () => {
  const lines: string[] = [];
  const diagnostics = new GoalDiagnostics(line => lines.push(line));
  diagnostics.trace('codex:unscoped', undefined, 'invalid')('native_identity_rejected',
    { version: 1, payload: 'PRIVATE-PAYLOAD', threadId: 'PRIVATE-ID', error: 'PRIVATE-ERROR' } as any);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.event, 'native_identity_rejected');
  assert.equal(entry.action, 'invalid');
  assert.equal(entry.connection, null);
  assert.equal(entry.version, 1);
  assert.match(entry.session, /^[0-9a-f]{16}$/);
  assert.ok(!lines[0]!.includes('PRIVATE'));
  assert.ok(!lines[0]!.includes('unscoped'));
});

test('broken native identity diagnostic sink cannot change rejection', () => {
  const diagnostics = new GoalDiagnostics(() => { throw new Error('sink'); });
  assert.doesNotThrow(() => diagnostics.trace('codex:unscoped', undefined, 'invalid')('native_identity_rejected'));
  assert.equal(conflictingNativeNotificationIdentity({ threadId: 'thread', thread: { id: 'other' } }), true);
});
