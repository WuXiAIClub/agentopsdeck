import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertExactJointDirectory, assertJointReceivedGrants } from './permissions-joint-discovery.mjs';

test('exact directory acceptance requires the positive session and no foreign summaries', () => {
  assertExactJointDirectory({ sessions: [{ sessionId: 'node:original', title: 'Original' }], nextCursor: null }, 'node:original');
  for (const page of [{}, { sessions: [] }, { sessions: [{ sessionId: 'other:original' }] },
    { sessions: [{ sessionId: 'node:original' }, { sessionId: 'node:foreign', title: 'Private child' }] },
    { sessions: [{ sessionId: 'node:original' }], nextCursor: 'another-page' }]) {
    assert.throws(() => assertExactJointDirectory(page, 'node:original'));
  }
});

test('received grants distinguish narrow creation authority without ignoring extra grants', () => {
  const sessionId = 'node:' + Buffer.from('codex:original').toString('base64url');
  const exact = { connectionId: 'node', sessionId, policy: { runtime: 'codex', sessionKey: 'codex:original', actions: ['messages:read'] } };
  const creation = { ownerUserId: 'default', connectionId: 'node', sessionId: null, availability: 'available',
    policy: { runtime: 'codex', actions: ['sessions:create'] } };
  const verify = grants => assertJointReceivedGrants(grants, [{ key: sessionId }], ['node']);
  assert.deepEqual(verify([creation, exact]), { exact: [exact], creation: [creation] });
  for (const grants of [[exact], [creation], [creation, creation, exact],
    [creation, exact, { ...exact, sessionId: 'node:foreign' }],
    [{ ...creation, policy: { runtime: 'codex', actions: ['sessions:create', 'sessions:read'] } }, exact],
    [creation, { ...exact, policy: { runtime: 'codex', actions: ['messages:read'] } }]]) {
    assert.throws(() => verify(grants));
  }
});
