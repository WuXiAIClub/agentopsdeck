import test from 'node:test';
import assert from 'node:assert/strict';
import { applyContextMenuPosition, computeContextMenuPosition } from './context-menu-position.js';

test('applyContextMenuPosition publishes the same height through the AOD CSS variable', context => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 390, innerHeight: 640 } });
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const properties = new Map<string, string>();
  const style = {
    left: '', top: '', maxHeight: '', transformOrigin: '',
    setProperty(name: string, value: string) { properties.set(name, value); },
  };
  const node = {
    offsetWidth: 292,
    offsetHeight: 540,
    getBoundingClientRect: () => ({ width: 292, height: 540 }),
    style,
  } as unknown as HTMLElement;
  const computed = applyContextMenuPosition(node, { x: 380, y: 630 }, { bottomInset: 48 });
  assert.equal(style.left, `${computed.left}px`);
  assert.equal(style.top, `${computed.top}px`);
  assert.equal(style.maxHeight, `${computed.maxHeight}px`);
  assert.equal(style.transformOrigin, computed.transformOrigin);
  assert.deepEqual([...properties], [['--aod-ctx-max-h', `${computed.maxHeight}px`]]);
  assert.ok(computed.top + 540 <= 640 - 8 - 48);
});

test('computeContextMenuPosition opens bottom-right when viewport space is sufficient', () => {
  const pos = computeContextMenuPosition({
    point: { x: 240, y: 180 },
    menuSize: { width: 268, height: 320 },
    viewport: { width: 1440, height: 900 },
    margin: 8,
    offset: 2,
  });
  assert.equal(pos.left, 242);
  assert.equal(pos.top, 182);
  assert.equal(pos.transformOrigin, 'top left');
});

test('computeContextMenuPosition flips left and up near bottom-right corner without overflowing', () => {
  const pos = computeContextMenuPosition({
    point: { x: 1796, y: 1096 },
    menuSize: { width: 292, height: 540 },
    viewport: { width: 1800, height: 1100 },
    margin: 8,
    offset: 2,
  });
  assert.ok(pos.left >= 0 && pos.left + 292 <= 1800);
  assert.ok(pos.top >= 0 && pos.top + 540 <= 1100);
  assert.ok(pos.left > 1000 && pos.top > 200);
  assert.equal(pos.transformOrigin, 'bottom right');
});

test('computeContextMenuPosition respects bottomInset for OS taskbar clearance', () => {
  const pos = computeContextMenuPosition({
    point: { x: 400, y: 778 },
    menuSize: { width: 276, height: 260 },
    viewport: { width: 1280, height: 800 },
    margin: 8,
    bottomInset: 48,
    offset: 2,
  });
  assert.ok(pos.top + 260 <= 800 - 8 - 48);
  assert.equal(pos.transformOrigin, 'bottom left');
});

test('computeContextMenuPosition clamps oversized menus cleanly within safe margins', () => {
  const pos = computeContextMenuPosition({
    point: { x: 12, y: 10 },
    menuSize: { width: 520, height: 780 },
    viewport: { width: 390, height: 640 },
    margin: 8,
  });
  assert.equal(pos.left, 8);
  assert.equal(pos.top, 8);
  assert.equal(pos.maxWidth, 374);
  assert.equal(pos.maxHeight, 624);
});
