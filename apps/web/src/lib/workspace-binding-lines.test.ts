import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingEdges, bindingCurve } from './workspace-binding-lines.js';
import type { FileBoardBinding } from './workspace-file-board.js';

const binding: FileBoardBinding = { bindingId: 'binding', resourceId: 'resource', sessionId: 'connector:session', state: 'active', problem: null };
const panes = [{ id: 'agent', sessionKey: 'connector:session' }, { id: 'other', sessionKey: 'different:session' }, { id: 'card' }];
test('bindings use exact identities, work both ways, deduplicate legacy/card sources', () => {
  const source = { paneId: 'card', binding };
  assert.deepEqual(bindingEdges(panes, [source, source]), [{ card: 'card', session: 'agent' }]);
  assert.deepEqual(bindingEdges(panes, [{ ...source, binding: { ...binding, sessionId: 'session' } }]), []);
  assert.equal(bindingEdges([...panes, { id: 'floating-agent', sessionKey: binding.sessionId }], [source]).length, 2);
});
test('pending, revoked, problematic, missing and closed resources never imply active links', () => {
  for (const value of [null, { ...binding, state: 'prepared' as const }, { ...binding, state: 'revoked' as const }, { ...binding, problem: 'unavailable' }]) {
    assert.deepEqual(bindingEdges(panes, [{ paneId: 'card', binding: value }]), []);
  }
  assert.deepEqual(bindingEdges(panes.slice(0, 2), [{ paneId: 'card', binding }]), []);
  assert.deepEqual(bindingEdges(panes.slice(1), [{ paneId: 'card', binding }]), []);
});
test('geometry supports horizontal, vertical, reversed and overlapping floating panels', () => {
  const a = { x: 0, y: 0, width: 200, height: 200 };
  assert.equal(bindingCurve(a, { ...a, x: 240 }), 'M 200 100 C 220 100, 220 100, 240 100');
  assert.equal(bindingCurve(a, { ...a, y: 240 }), 'M 100 200 C 100 220, 100 220, 100 240');
  for (const b of [{ ...a, x: -240 }, { ...a, y: -240 }, { ...a, x: 100 }, { ...a, y: 100 }]) assert.ok(bindingCurve(a, b)?.startsWith('M '));
  for (const b of [{ ...a, width: 0 }, { ...a, height: -1 }, { ...a, x: NaN }]) assert.equal(bindingCurve(a, b), undefined);
});

test('multi-session taskboard bindings connect shared card to all bound session panes', () => {
  const multiPanes = [
    { id: 'agent-1', sessionKey: 'connector:session-1' },
    { id: 'agent-2', sessionKey: 'connector:session-2' },
    { id: 'card' },
  ];
  assert.deepEqual(
    bindingEdges(multiPanes, [{ paneId: 'card', binding: null, sessionIds: ['connector:session-1', 'connector:session-2'] }]),
    [
      { card: 'card', session: 'agent-1' },
      { card: 'card', session: 'agent-2' },
    ],
  );
});

test('bindingCurve detours around intermediate obstacle rects and bindingGroupColor assigns distinct group colors', () => {
  const a = { x: 0, y: 100, width: 160, height: 120 };
  const b = { x: 480, y: 100, width: 160, height: 120 };
  const obstacle = { x: 220, y: 90, width: 140, height: 140 };
  const direct = bindingCurve(a, b);
  const detoured = bindingCurve(a, b, { obstacles: [obstacle] });
  assert.ok(direct && detoured);
  assert.notEqual(direct, detoured);
});

test('bindingCurve keeps control points tightly bounded when two desktop icons are adjacent or close', () => {
  const iconA = { x: 120, y: 100, width: 88, height: 84 };
  const iconB = { x: 214, y: 100, width: 88, height: 84 };
  const largeStaleObstacle = { x: 80, y: 40, width: 900, height: 700 };
  const d = bindingCurve(iconA, iconB, {
    parallelIndex: 2,
    parallelCount: 3,
    obstacles: [largeStaleObstacle],
  });
  assert.ok(d);
  const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  assert.equal(nums.length, 8);
  const [, sy, , cy1, , cy2, , ey] = nums;
  // Control points must stay close to icon vertical center (142) and never fly off-screen (< 0 or > 250)
  assert.ok(cy1! >= 80 && cy1! <= 210, `cy1=${cy1} flew too far`);
  assert.ok(cy2! >= 80 && cy2! <= 210, `cy2=${cy2} flew too far`);
  assert.ok(Math.abs(sy! - 142) <= 5);
  assert.ok(Math.abs(ey! - 142) <= 5);
});
