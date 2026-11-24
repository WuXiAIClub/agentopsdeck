import assert from 'node:assert/strict';
import test from 'node:test';
import { focusedPaneRect } from './pane-focus-geometry.js';

test('focus is centered at roughly half the workspace with an accessible backdrop', () => {
  for (const [w, h] of [[1600, 1000], [800, 700]]) {
    const r = focusedPaneRect(w!, h!);
    assert.equal(r.x * 2 + r.width, w);
    assert.equal(r.y * 2 + r.height, h);
    assert.ok(r.width * r.height / (w! * h!) < .6);
    assert.ok(r.x >= 16 && r.y >= 16);
  }
});
test('small workspaces retain reachable margins without overflowing', () => {
  for (const [w, h] of [[300, 400], [200, 200], [0, 0]]) {
    const r = focusedPaneRect(w!, h!);
    assert.ok(r.width >= 0 && r.height >= 0);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= w! && r.y + r.height <= h!);
  }
});
