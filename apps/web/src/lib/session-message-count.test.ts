import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import { sessionMessageCount } from './session-message-count.js';

const session: SessionSummary = { sessionKey: 's', agentId: 'codex', title: 'Test', status: 'idle' };
test('message metric uses the authoritative total including actual zero', () => {
  assert.equal(sessionMessageCount({ ...session, messageCount: 1820 }), 1820);
  assert.equal(sessionMessageCount({ ...session, messageCount: 0 }), 0);
  assert.equal(sessionMessageCount(session), undefined);
});
test('legacy totals are supported without interpreting unknown or invalid totals as zero', () => {
  const legacy = (value: unknown) => ({ ...session, messagesCount: value }) as SessionSummary;
  assert.equal(sessionMessageCount(legacy('82')), 82);
  for (const value of [null, undefined, '', ' ', false, -1, 2.5, NaN, Infinity, 'unknown']) {
    assert.equal(sessionMessageCount(legacy(value)), undefined);
  }
  assert.equal(sessionMessageCount({ ...legacy(200), messageCount: 0 }), 0);
});
