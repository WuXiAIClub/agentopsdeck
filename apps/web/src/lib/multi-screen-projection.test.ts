import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProjectionUrl,
  computeProjectionWindowFeatures,
  moveWindowToScreen,
  parseProjectionSearch,
  requestFullscreenOnScreen,
  type ScreenDetailed,
  type ScreenPlacementRect,
} from './multi-screen-projection.js';

test('buildProjectionUrl and parseProjectionSearch roundtrip projected pane metadata', () => {
  const url = buildProjectionUrl('https://deck.example.invalid', '/', {
    paneId: 'pane-1',
    kind: 'session',
    title: 'Argon Test 3',
    sessionKey: 'codex:123',
  });
  const parsed = parseProjectionSearch(new URL(url).search);
  assert.ok(parsed);
  assert.equal(parsed.paneId, 'pane-1');
  assert.equal(parsed.kind, 'session');
  assert.equal(parsed.title, 'Argon Test 3');
  assert.equal(parsed.sessionKey, 'codex:123');
});

test('computeProjectionWindowFeatures enforces minimum bounds and coordinates', () => {
  const features = computeProjectionWindowFeatures({ left: 1920, top: 0, width: 1600, height: 900 });
  assert.ok(features.includes('left=1920'));
  assert.ok(features.includes('width=1600'));
  assert.ok(features.includes('height=900'));
});

test('buildProjectionUrl encodes autoFullscreen and detectSecondaryScreenRect returns displays fallback', async () => {
  const url = buildProjectionUrl('https://deck.example.invalid', '/', {
    paneId: 'pane-2',
    kind: 'notebook',
    title: 'Notes',
    autoFullscreen: true,
  });
  const parsed = parseProjectionSearch(new URL(url).search);
  assert.equal(parsed?.autoFullscreen, true);
});

test('requestFullscreenOnScreen passes native ScreenDetailed to element.requestFullscreen({ screen })', async () => {
  let receivedOptions: unknown = null;
  const mockNativeScreen = {
    availLeft: 1920,
    availTop: 0,
    availWidth: 2560,
    availHeight: 1440,
    left: 1920,
    top: 0,
    width: 2560,
    height: 1440,
    isPrimary: false,
    isInternal: false,
    devicePixelRatio: 2,
    label: 'DELL U2723QE',
  } as unknown as ScreenDetailed;
  const targetScreen: ScreenPlacementRect = {
    id: 'screen-1',
    label: 'DELL U2723QE',
    left: 1920,
    top: 0,
    width: 2560,
    height: 1440,
    availLeft: 1920,
    availTop: 0,
    availWidth: 2560,
    availHeight: 1440,
    isPrimary: false,
    nativeScreen: mockNativeScreen,
  };
  const fakeElement = {
    requestFullscreen: async (options?: unknown) => {
      receivedOptions = options;
    },
  } as unknown as Element;

  const res = await requestFullscreenOnScreen(fakeElement, targetScreen);
  assert.equal(res, true);
  assert.deepEqual(receivedOptions, { navigationUI: 'hide', screen: mockNativeScreen });
});

test('moveWindowToScreen moves and resizes window to target display coordinates', () => {
  const calls: Array<{ fn: string; a: number; b: number }> = [];
  const fakeWin = {
    moveTo: (x: number, y: number) => calls.push({ fn: 'moveTo', a: x, b: y }),
    resizeTo: (w: number, h: number) => calls.push({ fn: 'resizeTo', a: w, b: h }),
    focus: () => calls.push({ fn: 'focus', a: 0, b: 0 }),
  } as unknown as Window;

  const ok = moveWindowToScreen(fakeWin, {
    id: 'screen-1',
    label: 'Display 2',
    left: 1920,
    top: 0,
    width: 1920,
    height: 1080,
    availLeft: 1920,
    availTop: 24,
    availWidth: 1920,
    availHeight: 1056,
    isPrimary: false,
  });
  assert.equal(ok, true);
  assert.deepEqual(calls[0], { fn: 'moveTo', a: 1920, b: 24 });
  assert.deepEqual(calls[1], { fn: 'resizeTo', a: 1920, b: 1056 });
});

test('isSecondaryDisplayWindow, readSecondaryWindowIds, and writeSecondaryWindowIds manage cross-screen window placement', async () => {
  const {
    isSecondaryDisplayWindow,
    readSecondaryWindowIds,
    writeSecondaryWindowIds,
  } = await import('./multi-screen-projection.js');

  assert.equal(isSecondaryDisplayWindow('?os_display=2&autoFullscreen=1'), true);
  assert.equal(isSecondaryDisplayWindow('?cp_display=primary'), false);
  assert.equal(isSecondaryDisplayWindow(''), false);

  const store = new Map<string, string>();
  const prevStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() { return store.size; },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  });
  try {
    assert.deepEqual(readSecondaryWindowIds(), []);
    writeSecondaryWindowIds(['pane-1', 'app:explorer', 'pane-1']);
    assert.deepEqual(readSecondaryWindowIds(), ['pane-1', 'app:explorer']);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: prevStorage,
    });
  }
});
