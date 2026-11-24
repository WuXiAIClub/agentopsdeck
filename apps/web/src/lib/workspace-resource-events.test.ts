import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceResourceEvents } from './workspace-resource-events.js';

const frame = (revision: number, resourceId = 'default') => ({ type: 'workspace.revisions', resourceType: 'taskboard', resources: [{ resourceId, revision }] });
test('metric card catalog coalesces each changed snapshot and isolates owners', () => {
  const events = createWorkspaceResourceEvents(), seen: number[] = [], other: number[] = [];
  const stop = events.subscribe('alice', 'catalog', n => seen.push(n), 'metric-card');
  const stopOther = events.subscribe('bob', 'catalog', n => other.push(n), 'metric-card');
  const value = { ...frame(1), resourceType: 'metric-card', resources: [{ resourceId: 'default', revision: 1 }, { resourceId: '00000000-0000-4000-8000-000000000001', revision: 1 }] };
  events.receive('alice', value); events.receive('alice', value);
  assert.deepEqual(seen, [1]); assert.deepEqual(other, []);
  events.connected('alice'); events.receive('alice', value); assert.deepEqual(seen, [1, 1]);
  stop(); stopOther();
});
test('resources share one transport, isolate owners, deduplicate snapshots and release last subscription', () => {
  const events = createWorkspaceResourceEvents();
  let opens = 0, closes = 0;
  events.configure(() => { opens++; return { close: () => { closes++; } }; });
  const a: number[] = [], b: number[] = [], other: number[] = [];
  const closeA = events.subscribe('alice', 'default', value => a.push(value));
  const closeB = events.subscribe('alice', 'default', value => b.push(value));
  const closeOther = events.subscribe('bob', 'default', value => other.push(value));
  assert.equal(opens, 1);
  events.receive('alice', frame(2)); events.receive('alice', frame(2)); events.receive('alice', frame(1));
  assert.deepEqual(a, [2]); assert.deepEqual(b, [2]); assert.deepEqual(other, []);
  const late: number[] = [];
  const closeLate = events.subscribe('alice', 'default', value => late.push(value));
  assert.deepEqual(late, [2], 'new panel receives known version');
  events.receive('alice', frame(9)); // Missed intermediate writes/reconnect converge to latest.
  assert.deepEqual(a, [2, 9]);
  events.connected('alice'); events.receive('alice', frame(9));
  assert.deepEqual(a, [2, 9, 9], 'first reconnect snapshot lets a failed consumer retry');
  events.receive('bob', frame(1)); assert.deepEqual(other, [1]);
  closeA(); closeB(); closeOther(); assert.equal(closes, 0);
  closeLate(); assert.equal(closes, 1);
  const reopened: number[] = [];
  const close = events.subscribe('alice', 'default', value => reopened.push(value));
  assert.deepEqual(reopened, [], 'last close drops cross-auth cached metadata');
  assert.equal(opens, 2); close();
});
test('invalid, oversized and unrelated frames never reach resource subscribers', () => {
  const events = createWorkspaceResourceEvents(), seen: number[] = [];
  const close = events.subscribe('alice', 'default', value => seen.push(value));
  for (const value of [null, {}, { ...frame(1), type: 'session.updated' }, frame(-1), frame(1.5), frame(1, '../private'),
    { ...frame(1), resources: [null] }, { ...frame(1), resources: Array.from({ length: 65 }, () => frame(1).resources[0]) }]) events.receive('alice', value);
  assert.deepEqual(seen, []); close();
});

test('same resource ID in different kinds shares transport but never versions or notifications', () => {
  const events = createWorkspaceResourceEvents(), board: number[] = [], drawing: number[] = [], native: number[] = [];
  let opens = 0;
  events.configure(() => { opens++; return { close() {} }; });
  const stops = [events.subscribe('alice', 'default', n => board.push(n)),
    events.subscribe('alice', 'default', n => drawing.push(n), 'drawing'),
    events.subscribe('alice', 'default', n => native.push(n), 'native-drawio')];
  events.receive('alice', frame(8));
  events.receive('alice', { ...frame(2), resourceType: 'drawing' });
  events.receive('alice', { ...frame(1), resourceType: 'native-drawio' });
  events.receive('alice', { ...frame(99), resourceType: 'unknown' });
  events.receive('alice', { ...frame(2), resourceType: 'drawing' });
  assert.equal(opens, 1); assert.deepEqual(board, [8]); assert.deepEqual(drawing, [2]); assert.deepEqual(native, [1]);
  const late: number[] = [];
  stops.push(events.subscribe('alice', 'default', n => late.push(n), 'native-drawio'));
  assert.deepEqual(late, [1]);
  events.connected('alice'); events.receive('alice', { ...frame(2), resourceType: 'drawing' });
  assert.deepEqual(drawing, [2, 2]); assert.deepEqual(native, [1]);
  stops.forEach(stop => stop());
});
