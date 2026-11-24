import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHeldRecoveryQueue } from './verify-maintenance-recovery-native.mjs';

const fixture = () => ({ queueId: 'original-queue-id', marker: 'FIXTURE_SUCCESSOR',
  queue: [{ id: 'original-queue-id', state: 'queued' }],
  events: [{ type: 'user_message', message: 'Previous native turn' }] });

test('a durable queued message without a native event is held', () => {
  assert.doesNotThrow(() => assertHeldRecoveryQueue(fixture()));
});
test('a native successor dispatched behind the fence fails even if projection still says queued', () => {
  const f = fixture(); f.events.push({ type: 'user_message', message: f.marker });
  assert.throws(() => assertHeldRecoveryQueue(f));
});
for (const mutation of ['missing', 'different-id', 'sending', 'blocked', 'duplicate-queue'])
  test(`held queue evidence rejects ${mutation}`, () => {
    const f = fixture();
    if (mutation === 'missing') f.queue = [];
    if (mutation === 'different-id') f.queue[0].id = 'replacement';
    if (mutation === 'sending') f.queue[0].state = 'sending';
    if (mutation === 'blocked') f.queue[0].state = 'blocked';
    if (mutation === 'duplicate-queue') f.queue.push({ ...f.queue[0] });
    assert.throws(() => assertHeldRecoveryQueue(f));
  });
