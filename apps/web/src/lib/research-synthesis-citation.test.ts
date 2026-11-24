import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResearchResult, ResearchSynthesis } from '@agentopsdeck/shared';
import { synthesisCitation } from './research-synthesis-citation.js';

const result: ResearchResult = { searchId: '12345678-1234-4234-8234-123456789012', query: 'Query', fetchedAt: 123456789,
  sources: [1, 2, 3].map(i => ({ id: `S${i}`, title: `Source ${i}`, url: `https://example.com/${i}`, snippet: `Evidence ${i}` })) };
const answer: ResearchSynthesis = { searchId: result.searchId,
  paragraphs: [{ text: 'Mixed comparison', citations: ['S2', 'S1'] }, { text: 'Second claim', citations: ['S1'] }], caveat: 'Unverified' };

test('mixed synthesis keeps exact input snippets and per-paragraph provenance without opaque handles', () => {
  const value = JSON.parse(synthesisCitation(result, answer, ['S2', 'S1']));
  assert.equal(value.kind, 'search-synthesis'); assert.equal(value.mode, 'snippets'); assert.equal(value.summary.verified, false);
  assert.deepEqual(value.sources, [result.sources[1], result.sources[0]]);
  assert.deepEqual(value.summary.paragraphs, answer.paragraphs);
  assert.equal(value.query, result.query); assert.equal(value.fetchedAt, new Date(result.fetchedAt).toISOString());
  assert.ok(!JSON.stringify(value).includes(result.searchId)); assert.ok(!JSON.stringify(value).includes('Evidence 3'));
});
test('selected but uncited input remains attributed; extra provider properties are never exported', () => {
  const value = JSON.parse(synthesisCitation({ ...result, secret: 'secret' } as ResearchResult,
    { ...answer, paragraphs: answer.paragraphs.map(p => ({ ...p, hidden: 'secret' })) }, ['S1', 'S2', 'S3']));
  assert.equal(value.sources.length, 3); assert.ok(!JSON.stringify(value).includes('secret'));
});
test('mixed synthesis rejects stale, unknown, duplicate and unselected evidence', () => {
  for (const selected of [[], ['S1'], ['S1', 'S2', 'S2'], ['S1', 'S2', 'S9']]) assert.throws(() => synthesisCitation(result, answer, selected));
  assert.throws(() => synthesisCitation(result, { ...answer, searchId: 'old' }, ['S1', 'S2']));
  assert.throws(() => synthesisCitation(result, { ...answer, paragraphs: [{ text: 'Claim', citations: ['S9'] }] }, ['S1', 'S2']));
  assert.throws(() => synthesisCitation({ ...result, sources: [result.sources[1]!] }, answer, ['S2', 'S1']));
});
test('untrusted snippets remain literal JSON and valid maximal text is bounded', () => {
  const large: ResearchResult = { ...result, sources: Array.from({ length: 8 }, (_, i) => ({ id: `S${i + 1}`,
    title: '中'.repeat(240), snippet: '\u0000'.repeat(1200), url: `https://example.com/${i}?q=${'x'.repeat(1900)}` })) };
  const ids = large.sources.map(s => s.id);
  const largeAnswer: ResearchSynthesis = { ...answer, paragraphs: ids.map(id => ({ text: '中'.repeat(2000), citations: [id] })), caveat: '中'.repeat(1000) };
  const text = synthesisCitation(large, largeAnswer, ids);
  assert.ok(new TextEncoder().encode(text).byteLength <= 192 * 1024);
  assert.equal(JSON.parse(text).sources[0].snippet, large.sources[0]!.snippet);
  assert.throws(() => synthesisCitation(large, { ...largeAnswer, caveat: 'x'.repeat(1001) }, ids));
});
