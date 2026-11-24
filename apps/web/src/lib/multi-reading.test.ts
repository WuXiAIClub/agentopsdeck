import test from 'node:test';
import assert from 'node:assert/strict';
import { readingDocuments, multiReadingCitation, type ReadingDocument, type MultiReadingAnswer } from './multi-reading.js';
import type { ResearchResult } from '@agentopsdeck/shared';
const result: ResearchResult = { searchId: 'search', query: 'question', fetchedAt: 1,
  sources: [1, 2, 3].map(i => ({ id: `S${i}`, title: `Title ${i}`, url: `https://article.example/${i}`, snippet: 'excluded snippet' })) };
const docs: ReadingDocument[] = result.sources.slice(0, 2).map((source, i) => {
  const articleId = `11111111-1111-4111-8111-11111111111${i}`;
  return { article: { articleId, searchId: result.searchId, sourceId: source.id, title: source.title, url: source.url, fetchedAt: 2, text: i ? 'Second article' : 'Before 😀 after', truncated: i === 0 },
    selection: i ? { articleId, mode: 'full' } : { articleId, mode: 'selection', range: { start: 7, end: 9 } } };
});
function answer(): MultiReadingAnswer { return { searchId: result.searchId, paragraphs: [{ text: 'Combined summary', citations: ['S1', 'S2'] }], caveat: 'Unverified', evidence: readingDocuments(result, docs).map(d => d.evidence) }; }
test('multi export preserves exact mixed scopes and provenance, strips unselected text and opaque IDs', () => {
  const text = multiReadingCitation(result, docs, { ...answer(), secret: 'extra-field' }), copy = JSON.parse(text);
  assert.deepEqual(copy.sources.map((s: any) => s.text), ['😀', 'Second article']); assert.equal(copy.sources[0].truncated, true);
  assert.deepEqual(copy.sources[0].range, { start: 7, end: 9, unit: 'UTF-16' }); assert.equal(copy.summary.verified, false);
  for (const absent of ['Before', 'after', 'excluded snippet', 'extra-field', docs[0]!.article.articleId!, 'S3']) assert.ok(!text.includes(absent));
});
test('reject forged evidence, valid but different range, reordered evidence and unselected citations', () => {
  for (const patch of [{ start: 0 }, { end: 10 }, { mode: 'full' }, { sourceId: 'S2' }, { articleId: 'fake' }, { truncated: false }]) {
    const a = answer(); Object.assign(a.evidence[0]!, patch); assert.throws(() => multiReadingCitation(result, docs, a));
  }
  for (const evidence of [undefined, [], answer().evidence.slice(1), answer().evidence.reverse()]) assert.throws(() => multiReadingCitation(result, docs, { ...answer(), evidence }));
  assert.throws(() => multiReadingCitation(result, docs, { ...answer(), paragraphs: [{ text: 'bad', citations: ['S3'] }] }));
});
test('selection validation: count, unique sources, surrogate boundaries, aggregate UTF-8 and binding', () => {
  for (const values of [[], docs.slice(0, 1), [...docs, ...docs], [docs[0]!, docs[0]!]]) assert.throws(() => readingDocuments(result, values));
  for (const range of [{ start: 8, end: 9 }, { start: 7, end: 8 }, { start: 2, end: 2 }, { start: -1, end: 2 }, { start: 0, end: 100 }])
    assert.throws(() => readingDocuments(result, [{ ...docs[0]!, selection: { ...docs[0]!.selection, range } }, docs[1]!]));
  const large = docs.map(d => ({ article: { ...d.article, text: '中'.repeat(6000) }, selection: { articleId: d.article.articleId!, mode: 'full' as const } }));
  assert.throws(() => readingDocuments(result, large));
  large[0]!.article.text = 'x'.repeat(14000); assert.equal(readingDocuments(result, large).length, 2); // Exactly 32,000 bytes.
  large[0]!.article.text += 'x'; assert.throws(() => readingDocuments(result, large));
  assert.throws(() => readingDocuments(result, [{ ...docs[0]!, selection: { articleId: 'other', mode: 'full' } }, docs[1]!]));
});
