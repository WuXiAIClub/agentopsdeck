import assert from 'node:assert/strict';
import test from 'node:test';
import { boardViewKey, readBoardHideDone, saveBoardHideDone } from './board-view-preference.js';

test('board view keys isolate accounts and resources without delimiter collisions', () => {
  assert.notEqual(boardViewKey('a', 'board'), boardViewKey('b', 'board'));
  assert.notEqual(boardViewKey('a', 'board'), boardViewKey('a', 'other'));
  assert.notEqual(boardViewKey('a:b', 'c'), boardViewKey('a', 'b:c'));
});
test('display preference persists only a boolean choice; malformed values default to visible', () => {
  const data = new Map<string, string>(), key = boardViewKey('test', 'board');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => data.get(k), setItem: (k: string, v: string) => data.set(k, v) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  try {
    assert.equal(readBoardHideDone(key), false);
    saveBoardHideDone(key, true);
    assert.equal(readBoardHideDone(key), true);
    assert.deepEqual([...data], [[key, 'hide-done']]);
    assert.equal(readBoardHideDone(boardViewKey('other', 'board')), false);
    saveBoardHideDone(key, false);
    assert.equal(readBoardHideDone(key), false);
    data.set(key, '{invalid'); assert.equal(readBoardHideDone(key), false);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('blocked'); } });
    saveBoardHideDone(key, true); assert.equal(readBoardHideDone(key), true);
    saveBoardHideDone(key, false); assert.equal(readBoardHideDone(key), false);
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
