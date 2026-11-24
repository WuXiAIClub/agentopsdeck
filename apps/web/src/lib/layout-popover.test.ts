import assert from 'node:assert/strict';
import test from 'node:test';
import { computeAnchoredPopoverStyle } from './layout-popover.js';

test('shifts rail popover upward on scaled 2.5K (1536x864) so bottom never clips', () => {
  const pos = computeAnchoredPopoverStyle({
    anchor: { top: 560, left: 8, right: 48, bottom: 600, width: 40, height: 40 },
    viewport: { width: 1536, height: 864 },
    popoverSize: { width: 356, height: 480 },
    placement: 'right-start',
    gap: 10,
    margin: 12,
  });

  assert.equal(pos.position, 'fixed');
  assert.equal(pos.left, 58);
  assert.equal(pos.top, 864 - 480 - 12);
  assert.ok(pos.top + 480 <= 864 - 12);
  assert.equal(pos.maxHeight, 840);
});

test('clamps oversized popover height and keeps top >= margin on 1756x987 and 1920x1080', () => {
  for (const viewport of [
    { width: 1756, height: 987 },
    { width: 1920, height: 1080 },
  ]) {
    const pos = computeAnchoredPopoverStyle({
      anchor: { top: 720, left: 12, right: 52, bottom: 760, width: 40, height: 40 },
      viewport,
      popoverSize: { width: 356, height: 1200 },
      placement: 'right-start',
      gap: 10,
      margin: 12,
    });

    assert.equal(pos.top, 12);
    assert.equal(pos.maxHeight, viewport.height - 24);
    assert.equal(pos.left, 62);
  }
});

test('flips toolbar bottom-end popover above trigger when near bottom edge', () => {
  const pos = computeAnchoredPopoverStyle({
    anchor: { top: 810, left: 1450, right: 1490, bottom: 842, width: 40, height: 32 },
    viewport: { width: 1536, height: 864 },
    popoverSize: { width: 320, height: 280 },
    placement: 'bottom-end',
    gap: 8,
    margin: 12,
  });

  assert.equal(pos.left, 1490 - 320);
  assert.equal(pos.top, 810 - 8 - 280);
  assert.ok(pos.top >= 12);
});
