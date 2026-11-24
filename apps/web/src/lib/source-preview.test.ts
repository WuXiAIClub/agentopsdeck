import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSourceReference, sourceReferences } from '@agentopsdeck/shared';
import { sourceLink, isSourceMediaUrl, isSourcePreview } from './source-preview.js';

test('source references support Unix, Mac, Windows, encoded spaces and line anchors without host hardcoding', () => {
  for (const [href, path, line] of [['/work/code.ts:118', '/work/code.ts', 118], ['/Users/me/my%20project/a.py#L2-L4', '/Users/me/my project/a.py', 2],
    ['C:/project/a.ts:3:2', 'C:/project/a.ts', 3], ['/work/a.md', '/work/a.md', 1]] as const) {
    assert.equal(parseSourceReference(href)?.path, path); assert.equal(parseSourceReference(href)?.line, line);
  }
  assert.equal(sourceLink('https://example.test/work/a.ts:4', 'https://example.test')?.line, 4);
  assert.equal(sourceLink('https://other.test/work/a.ts:4', 'https://example.test'), undefined);
});

test('invalid, web, credential, traversal and malformed local references are not preview addresses', () => {
  for (const href of ['https://example.test/a.ts:2', '//host/a.ts:2', 'javascript:alert(1)', '/a/../b.ts:1', '/a/%2e%2e/b.ts:1', '/a.ts?x=1', '/a.ts:0', '/a.ts:10000001', '/a.ts#L9-L3', '/a%00.ts:1', '/a%ZZ.ts:1', '/.env', '/a.pem', '/a.json']) assert.equal(parseSourceReference(href), undefined, href);
  assert.deepEqual(sourceReferences('[one](/work/a.ts:2) ![image](/work/image.ts:1) [one](/work/a.ts:2) [space](</work/a b.ts:3>)').map(ref => ref.path), ['/work/a.ts', '/work/a b.ts']);
  assert.equal(sourceReferences(Array.from({ length: 30 }, (_, i) => `[x](/work/${i}.ts:1)`).join(' ')).length, 16);
});

test('preview response and fetch destination are bounded and restricted to Hub message media', () => {
  const value = { path: '/a.ts', line: 2, startLine: 1, totalLines: 10, text: 'one\ntwo', modifiedAt: 1 };
  assert.equal(isSourcePreview(value), true);
  for (const extra of [{ line: 99 }, { text: 'x' }, { text: 'a'.repeat(100_000) }, { startLine: 0 }, { modifiedAt: NaN }]) assert.equal(isSourcePreview({ ...value, ...extra }), false);
  assert.equal(isSourceMediaUrl(`/api/hub/v1/sessions/remote%3Aabc/messages/message%3A1/media/${'a'.repeat(64)}`), true);
  for (const url of ['https://other.test/api/media', '/api/auth/status', '//other.test/a', '/api/hub/v1/sessions/../messages/a/media/' + 'a'.repeat(64)]) assert.equal(isSourceMediaUrl(url), false);
});

test('inline absolute file references gain previews without guessing filenames or parsing fenced examples', () => {
  assert.deepEqual(sourceReferences('See `/Users/me/report.md` and `C:\\work\\a.ts:2`, but not `report.md`.\n```sh\n`/work/example.ts`\n```').map(ref => ref.path), ['/Users/me/report.md', 'C:\\work\\a.ts']);
  assert.equal(sourceReferences(Array.from({ length: 30 }, (_, i) => '`/work/' + i + '.ts`').join(' ')).length, 16);
});

test('complete Markdown documents may exceed snippet lines while byte and consistency limits remain enforced', () => {
  const value = { path: '/work/report.md', line: 1, startLine: 1, totalLines: 194, text: Array(194).fill('报告').join('\n'), modifiedAt: 1 };
  assert.equal(isSourcePreview(value), true);
  for (const extra of [{ path: '/work/code.ts' }, { totalLines: 195 }, { startLine: 2 }, { text: '界'.repeat(40_000), totalLines: 1 }]) {
    assert.equal(isSourcePreview({ ...value, ...extra }), false);
  }
});
