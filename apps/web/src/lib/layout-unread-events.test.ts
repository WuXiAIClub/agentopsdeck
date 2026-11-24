import assert from 'node:assert/strict';
import test from 'node:test';
import { createLayoutUnreadEvents } from './layout-unread-events.js';

test('inactive layouts retain the shared owner feed and completion wakes only relevant scopes', () => {
  const events = createLayoutUnreadEvents();
  let opens = 0, closes = 0, active = 0, inactive = 0, other = 0;
  events.configure(() => { opens++; return { close() { closes++; } }; });
  const stopA = events.subscribe('alice', new Set(['a']), () => active++);
  const stopB = events.subscribe('alice', new Set(['b']), () => inactive++);
  const stopOther = events.subscribe('bob', new Set(['b']), () => other++);
  assert.equal(opens, 1);
  events.receive('alice', { type: 'run.completed', hubSessionId: 'b' });
  assert.deepEqual([active, inactive, other], [0, 1, 0]);
  events.receive('alice', { type: 'run.updated', sessionKey: 'b' });
  events.receive('alice', { type: 'completion.read', sessionKey: 'b' });
  events.receive('alice', { type: 'message.updated', sessionKey: 'b' });
  events.receive('alice', { type: 'run.completed', sessionKey: 'unknown' });
  assert.equal(inactive, 3);
  events.receive('alice', { type: 'stream.reset' });
  assert.deepEqual([active, inactive, other], [1, 4, 0]);
  stopA(); stopOther(); assert.equal(closes, 0);
  stopB(); assert.equal(closes, 1);
  events.receive('alice', { type: 'run.completed', sessionKey: 'b' });
  assert.equal(inactive, 4);
});
