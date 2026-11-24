import assert from 'node:assert/strict';
import test from 'node:test';
import { computeViewportKeyboardMetrics } from './viewport-keyboard.js';

test('keeps composer lifted while an editable field owns the keyboard-sized visual viewport gap', () => {
  const metrics = computeViewportKeyboardMetrics({
    windowInnerHeight: 1024,
    documentClientHeight: 1024,
    visualViewportHeight: 660,
    visualViewportOffsetTop: 0,
    editableFocused: true,
  });

  assert.equal(metrics.layoutHeight, 1024);
  assert.equal(metrics.rawKeyboardOffset, 364);
  assert.equal(metrics.keyboardOffset, 364);
});

test('resets stale visual viewport gap after the composer blurs', () => {
  const metrics = computeViewportKeyboardMetrics({
    windowInnerHeight: 1024,
    documentClientHeight: 1024,
    visualViewportHeight: 660,
    visualViewportOffsetTop: 0,
    editableFocused: false,
  });

  assert.equal(metrics.rawKeyboardOffset, 364);
  assert.equal(metrics.keyboardOffset, 0);
});

test('ignores small visual viewport jitters even while focused', () => {
  const metrics = computeViewportKeyboardMetrics({
    windowInnerHeight: 1024,
    documentClientHeight: 1024,
    visualViewportHeight: 1000,
    visualViewportOffsetTop: 0,
    editableFocused: true,
  });

  assert.equal(metrics.rawKeyboardOffset, 24);
  assert.equal(metrics.keyboardOffset, 0);
});
