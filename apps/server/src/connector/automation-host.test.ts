import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorAutomationHost } from './automation-host.js';

type Service = ReturnType<ConstructorParameters<typeof ConnectorAutomationHost>[0]>;
// Lifecycle tests intentionally supply only the scheduler surface the host uses.
function schedulerFixture(tick: () => Promise<unknown>) {
  let running = false, starts = 0, stops = 0;
  return { service: { pollCompleted: async () => {}, scheduler: {
    start(timer: boolean) { assert.equal(timer, false); if (!running) { running = true; starts++; } },
    stop() { running = false; stops++; }, tick,
  } } as unknown as Service, starts: () => starts, stops: () => stops };
}
test('host serializes owners and overlapping ticks, then drains before close', async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const a = schedulerFixture(async () => { calls++; await gate; });
  const b = schedulerFixture(async () => { calls++; });
  const host = new ConnectorAutomationHost(owner => owner === 'a' ? a.service : b.service, () => true);
  host.start(['a', 'b'], false); host.start(['a', 'b'], false);
  assert.equal(a.starts(), 1);
  const first = host.tick(); assert.equal(host.tick(), first); await Promise.resolve(); assert.equal(calls, 1);
  let closed = false; const closing = host.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); await closing;
  assert.equal(calls, 1, 'second owner never starts after shutdown');
  assert.ok(a.stops() > 0); assert.ok(b.stops() > 0);
  assert.throws(() => host.service('a'), /closed/);
});
test('revoked owner cannot tick, restoration starts future cursors, one owner failure is isolated', async () => {
  let allowed = true, aCalls = 0, bCalls = 0;
  const a = schedulerFixture(async () => { aCalls++; throw Error('failure'); });
  const b = schedulerFixture(async () => { bCalls++; });
  const host = new ConnectorAutomationHost(owner => owner === 'a' ? a.service : b.service,
    owner => owner !== 'a' || allowed);
  host.start(['a', 'b'], false);
  await host.tick(); assert.equal(aCalls, 1); assert.equal(bCalls, 1);
  allowed = false; await host.tick(); assert.equal(aCalls, 1); assert.equal(bCalls, 2);
  assert.throws(() => host.service('a'), /forbidden/);
  allowed = true; await host.tick(); assert.equal(aCalls, 2); assert.equal(a.starts(), 2);
  await host.close();
});
test('no work before explicit start; lazy owners are bounded and closed permanently', async () => {
  let calls = 0;
  const f = schedulerFixture(async () => { calls++; });
  const host = new ConnectorAutomationHost(() => f.service, () => true);
  host.service('first'); await host.tick(); assert.equal(calls, 0);
  host.start([], false); await host.tick(); assert.equal(calls, 1);
  for (let i = 1; i < 128; i++) host.service(String(i));
  assert.throws(() => host.service('overflow'), /capacity/);
  await host.close(); await host.tick(); assert.equal(calls, 1);
});
