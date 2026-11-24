import test from 'node:test';
import assert from 'node:assert/strict';
import { readingCitation, readingSelection } from './workspace-article.js';
import type { ResearchArticle, ResearchReadingEvidence, ResearchResult, ResearchSynthesis } from '@agentopsdeck/shared';

test('readonly article navigation preserves anchors and UTF-16 pairs in both directions', () => {
  const text = 'A😀B\nNext', caret = { start: 1, end: 1, backward: false };
  const right = readingSelection(text, caret, 'ArrowRight', true, false);
  assert.deepEqual(right, { start: 1, end: 3, backward: false });
  assert.deepEqual(readingSelection(text, right, 'ArrowLeft', true, false), caret);
  const left = readingSelection(text, { start: 3, end: 3, backward: false }, 'ArrowLeft', true, false);
  assert.deepEqual(left, { start: 1, end: 3, backward: true });
  assert.deepEqual(readingSelection(text, left, 'ArrowRight', true, false), { start: 3, end: 3, backward: false });
  assert.deepEqual(readingSelection(text, right, 'ArrowLeft', false, false), caret);
  assert.deepEqual(readingSelection(text, right, 'ArrowRight', false, false), { start: 3, end: 3, backward: false });
  assert.equal(readingSelection(text, caret, 'End', true, false).end, 4);
  assert.equal(readingSelection(text, caret, 'End', true, true).end, text.length);
  assert.equal(readingSelection(text, { start: 8, end: 8, backward: false }, 'Home', false, false).start, 5);
  assert.equal(readingSelection(text, caret, 'Home', false, true).start, 0);
  assert.equal(readingSelection(text, { start: 0, end: 0, backward: false }, 'ArrowLeft', true, false).start, 0);
  assert.equal(readingSelection(text, { start: text.length, end: text.length, backward: false }, 'ArrowRight', true, false).end, text.length);
});

test('copied reading evidence contains exact selected text and source, not surrounding private text or opaque handles', () => {
  const result: ResearchResult = { searchId: 'test', query: 'question', fetchedAt: 1, sources: [{ id: 'S1', title: 'Title', url: 'https://article.example/', snippet: 'unused' }] };
  const article: ResearchArticle = { articleId: '11111111-1111-4111-8111-111111111111', searchId: 'test', sourceId: 'S1', title: 'Title', url: 'https://article.example/', fetchedAt: 2, text: 'Before 😀 after', truncated: true };
  const evidence: ResearchReadingEvidence = { articleId: article.articleId!, sourceId: 'S1', start: 7, end: 9, mode: 'selection', truncated: true };
  const answer: ResearchSynthesis & { evidence: ResearchReadingEvidence } = { searchId: 'test', paragraphs: [{ text: 'Summary', citations: ['S1'] }], caveat: 'Not verified', evidence };
  const text = readingCitation(result, article, answer), copy = JSON.parse(text);
  assert.equal(copy.source.text, '😀'); assert.equal(copy.source.url, article.url); assert.equal(copy.source.truncated, true);
  assert.deepEqual(copy.source.range, { start: 7, end: 9, unit: 'UTF-16' }); assert.equal(copy.summary.verified, false);
  for (const absent of ['Before', 'after', article.articleId!, 'unused']) assert.ok(!text.includes(absent));
  for (const patch of [{ start: 8 }, { end: 8 }, { sourceId: 'S2' }, { articleId: 'fake' }, { mode: 'full' as const }, { truncated: false }])
    assert.throws(() => readingCitation(result, article, { ...answer, evidence: { ...evidence, ...patch } }));
  assert.throws(() => readingCitation(result, article, { ...answer, paragraphs: [{ text: 'fake', citations: ['S2'] }] }));
  const long = { ...article, text: '中'.repeat(11000) };
  assert.throws(() => readingCitation(result, long, { ...answer, evidence: { ...evidence, mode: 'full', start: 0, end: long.text.length } }));
});
