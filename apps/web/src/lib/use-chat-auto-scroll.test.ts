import assert from 'node:assert/strict';
import test from 'node:test';
import { computeResizeFollowScrollTop, shouldReenterBottomFollow } from './use-chat-auto-scroll.js';

test('shouldReenterBottomFollow re-arms follow when user scrolls down into bottom zone even after content growth', () => {
  const decision = shouldReenterBottomFollow({
    downwardIntent: true,
    previous: { top: 420, height: 1200, viewport: 600 },
    next: { top: 560, height: 1260, viewport: 600 },
    gap: 100,
    following: false,
    touching: false,
  });
  assert.equal(decision.reenter, true);
  assert.equal(decision.snapToBottom, true);
});

test('shouldReenterBottomFollow re-arms follow when momentum scroll reaches the bottom edge without prior intent flag', () => {
  const decision = shouldReenterBottomFollow({
    downwardIntent: false,
    previous: { top: 550, height: 1200, viewport: 600 },
    next: { top: 598, height: 1200, viewport: 600 },
    gap: 2,
    following: false,
    touching: false,
  });
  assert.equal(decision.reenter, true);
  assert.equal(decision.snapToBottom, true);
});

test('shouldReenterBottomFollow does not re-arm on programmatic positioning above the bottom edge without downward intent', () => {
  const decision = shouldReenterBottomFollow({
    downwardIntent: false,
    previous: { top: 300, height: 1200, viewport: 600 },
    next: { top: 540, height: 1200, viewport: 600 },
    gap: 60,
    following: false,
    touching: false,
  });
  assert.equal(decision.reenter, false);
  assert.equal(decision.snapToBottom, false);
});

test('computeResizeFollowScrollTop synchronously compensates composer/viewport resize in the same frame', () => {
  // When composer grows by 20px, clientHeight drops from 600 -> 580 while scrollTop is still 600 (scrollHeight 1200)
  assert.equal(
    computeResizeFollowScrollTop({
      scrollTop: 600,
      scrollHeight: 1200,
      clientHeight: 580,
      enabled: true,
      following: true,
      selecting: false,
      touching: false,
    }),
    620,
  );

  // Already aligned within 1px -> no unnecessary scroll write
  assert.equal(
    computeResizeFollowScrollTop({
      scrollTop: 619.5,
      scrollHeight: 1200,
      clientHeight: 580,
      enabled: true,
      following: true,
      selecting: false,
      touching: false,
    }),
    null,
  );

  // Hidden pane, paused follow, active text selection, or touch gesture -> null
  for (const override of [
    { clientHeight: 0 },
    { enabled: false },
    { following: false },
    { selecting: true },
    { touching: true },
  ]) {
    assert.equal(
      computeResizeFollowScrollTop({
        scrollTop: 500,
        scrollHeight: 1200,
        clientHeight: 580,
        enabled: true,
        following: true,
        selecting: false,
        touching: false,
        ...override,
      }),
      null,
    );
  }
});

test('shouldReenterBottomFollow does not re-arm on upward scroll inside the bottom zone', () => {
  const decision = shouldReenterBottomFollow({
    downwardIntent: true,
    previous: { top: 590, height: 1200, viewport: 600 },
    next: { top: 550, height: 1200, viewport: 600 },
    gap: 50,
    following: false,
    touching: false,
  });
  assert.equal(decision.reenter, false);
  assert.equal(decision.snapToBottom, false);
});
