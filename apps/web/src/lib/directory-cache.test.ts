import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryCache, parentDirectory } from './directory-cache.js';
test('directory metadata cache expires, is bounded, LRU and explicitly clearable', () => {
  let now = 0;
  const cache = new DirectoryCache<{ entries: number[] }>(15000, () => now);
  const value = { entries: [1] };
  cache.set('root', value); assert.equal(cache.get('root'), value);
  now = 15000; assert.equal(cache.get('root'), undefined);
  for (let i = 0; i < 16; i++) cache.set(String(i), value);
  cache.get('0'); cache.set('new', value);
  assert.equal(cache.get('1'), undefined); assert.equal(cache.get('0'), value);
  cache.set('large', { entries: Array(5001).fill(1) }); assert.equal(cache.get('large'), undefined);
  cache.set('a', { entries: Array(3000).fill(1) }); cache.set('b', { entries: Array(3000).fill(1) });
  assert.equal(cache.get('a'), undefined); assert.ok(cache.get('b'));
  cache.clear(); assert.equal(cache.get('b'), undefined);
});
test('directory paths remain relative wire paths including Windows-hosted unicode folders', () => {
  assert.equal(parentDirectory(''), ''); assert.equal(parentDirectory('docs'), '');
  assert.equal(parentDirectory('工作区/含 空格/笔记.md'), '工作区/含 空格');
});
