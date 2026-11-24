import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundedMarkdownCache, isPlainTextMarkdown } from './markdown-fast-path.js';

test('isPlainTextMarkdown accepts ordinary CJK and English chat paragraphs', () => {
  assert.equal(isPlainTextMarkdown(''), true);
  assert.equal(isPlainTextMarkdown('你好，测试通过，一切正常。'), true);
  assert.equal(isPlainTextMarkdown('Hello world!\nSecond paragraph\n\nThird paragraph.'), true);
});

test('isPlainTextMarkdown rejects any CommonMark or GFM syntax triggers', () => {
  for (const sample of [
    '**bold**',
    '*italic*',
    '_underline_',
    '`code`',
    '~~strike~~',
    '[link](https://example.com)',
    'https://example.com/test',
    'www.example.com',
    '# Heading',
    '> quote',
    '- bullet',
    '1. numbered',
    '2) paren list',
    '| a | b |',
    'a &amp; b',
    '    indented code',
    'line\\escape',
  ]) {
    assert.equal(isPlainTextMarkdown(sample), false, `expected false for: ${sample}`);
  }
});

test('createBoundedMarkdownCache evicts LRU entries and skips oversized texts', () => {
  const cache = createBoundedMarkdownCache<string>(3, 20);
  cache.set('default', 'a', 'A');
  cache.set('default', 'b', 'B');
  cache.set('default', 'c', 'C');
  assert.equal(cache.get('default', 'a'), 'A');
  cache.set('default', 'd', 'D');
  assert.equal(cache.get('default', 'b'), undefined);
  assert.equal(cache.get('default', 'a'), 'A');
  assert.equal(cache.get('default', 'c'), 'C');
  assert.equal(cache.get('default', 'd'), 'D');

  cache.set('default', 'x'.repeat(25), 'oversized');
  assert.equal(cache.get('default', 'x'.repeat(25)), undefined);
});
