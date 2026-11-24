import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import { sessionChannelRoute } from './channel-routes.js';

test('channel inventory requires a native OpenClaw reference and does not decode Hub IDs', () => {
  const session: SessionSummary = { sessionKey: 'opaque', title: 'Chat', status: 'idle', sessionRef: { nodeId: 'node', runtimeId: 'openclaw', nativeSessionKey: 'agent:main:feishu:direct:person:123' } };
  assert.deepEqual(sessionChannelRoute(session), { channel: 'feishu', shape: 'direct', target: 'person:123' });
  assert.equal(sessionChannelRoute({ ...session, sessionRef: { ...session.sessionRef!, runtimeId: 'codex' } }), undefined);
  assert.equal(sessionChannelRoute({ ...session, sessionRef: { ...session.sessionRef!, nativeSessionKey: 'agent:main:dashboard:test' } }), undefined);
  assert.equal(sessionChannelRoute({ sessionKey: 'agent:main:feishu:direct:someone', title: 'Opaque', status: 'idle' }), undefined);
});
