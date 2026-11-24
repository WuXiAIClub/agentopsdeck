import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { scheduleSourcePreviewHover, SOURCE_PREVIEW_HOVER_DELAY_MS } from './source-preview-hover.js';

test('source hover waits beyond two seconds, leaving click-to-enlarge unobstructed', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let shown = 0;
  assert.equal(SOURCE_PREVIEW_HOVER_DELAY_MS, 2200);
  scheduleSourcePreviewHover(() => shown++);
  t.mock.timers.tick(2000); assert.equal(shown, 0);
  t.mock.timers.tick(199); assert.equal(shown, 0);
  t.mock.timers.tick(1); assert.equal(shown, 1);
});

test('leaving, clicking or disposing cancels the pending hover; re-entry gets a fresh delay', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let shown = 0;
  const first = scheduleSourcePreviewHover(() => shown++);
  t.mock.timers.tick(1000); clearTimeout(first);
  scheduleSourcePreviewHover(() => shown++);
  t.mock.timers.tick(1200); assert.equal(shown, 0);
  t.mock.timers.tick(1000); assert.equal(shown, 1);
  const disposed = scheduleSourcePreviewHover(() => shown++);
  clearTimeout(disposed); t.mock.timers.tick(10000); assert.equal(shown, 1);
});

test('narrow preview warms before delayed rendering and preserves explicit click/keyboard opening', () => {
  const component = readFileSync('src/components/NarrowSourcePreview.tsx', 'utf8');
  const content = readFileSync('src/components/SourceReferencePreviewContent.tsx', 'utf8');
  assert.match(component, /clear\(\); warm\(\); timer.current = scheduleSourcePreviewHover/);
  assert.match(component, /onClick=\{\(\) => \{ clear\(\); warm\(\); setFocused\(true\); setOpen\(true\);/);
  assert.match(component, /matches\(':focus-visible'\)/);
  assert.match(component, /event.pointerType !== 'touch'/);
  assert.match(component, /\[path, line, prewarm\]/);
  assert.match(content, /sourcePreviewCache.subscribe\(key/);
  assert.match(content, /scope !== recoveryScope\(\)/);
  assert.match(content, /sourcePreviewCache.load\(key, signal => sourcePreviewUrl\(url, signal\)\)/);
  assert.match(content, /prewarm=\{prewarm\}/);
});
