import test from 'node:test';
import assert from 'node:assert/strict';
import { researchCitation, validResearchResult, validResearchSynthesis, type ResearchResult } from '@agentopsdeck/shared';
import { emptyWorkspace, openResourcePane, validPane, restoreWorkspace, paneSessionKey, paneKey } from './workspace-layout.js';

const result: ResearchResult = { searchId: '11111111-1111-4111-8111-111111111111', query: 'query', fetchedAt: 12345,
  sources: [{ id: 'S1', title: 'Example', url: 'https://example.org/', snippet: 'Snippet, not a full article.' }] };
test('synthesis response binds search and selected citations, bounds output, and rejects control text', () => {
  const answer = { searchId: result.searchId, paragraphs: [{ text: 'Summary', citations: ['S1'] }], caveat: 'Snippets only.' };
  assert.ok(validResearchSynthesis(answer, result, ['S1']));
  assert.equal(validResearchSynthesis(answer, result, []), false);
  for (const patch of [{ searchId: 'another-search' }, { caveat: '' }, { caveat: 'x'.repeat(1001) }, { paragraphs: [] }, { paragraphs: Array(9).fill(answer.paragraphs[0]) }])
    assert.equal(validResearchSynthesis({ ...answer, ...patch }, result, ['S1']), false);
  for (const paragraph of [{ text: 'x', citations: ['S9'] }, { text: 'x', citations: ['S1', 'S1'] }, { text: 'x', citations: [] },
    { text: 'x\u202e', citations: ['S1'] }, { text: 'x'.repeat(2001), citations: ['S1'] }, { text: 42, citations: ['S1'] }])
    assert.equal(validResearchSynthesis({ ...answer, paragraphs: [paragraph] }, result, ['S1']), false);
});
test('search projection rejects hostile IDs, URLs, duplicates, oversize and malformed content', () => {
  assert.ok(validResearchResult(result));
  for (const patch of [{ sources: Array(9).fill(result.sources[0]) }, { fetchedAt: -1 }, { fetchedAt: Number.MAX_SAFE_INTEGER },
    { query: '' }, { query: undefined }, { searchId: '<script>' }, { searchId: '-'.repeat(36) }]) assert.equal(validResearchResult({ ...result, ...patch }), false);
  for (const patch of [{ id: 'untrusted' }, { url: 'javascript:alert(1)' }, { title: 'x'.repeat(241) }, { snippet: 'x'.repeat(1201) }]) assert.equal(validResearchResult({ ...result, sources: [{ ...result.sources[0], ...patch }] }), false);
  assert.equal(validResearchResult({ ...result, sources: [result.sources[0], { ...result.sources[0], id: 'S2' }] }), false);
  const citation = JSON.parse(researchCitation(result, result.sources[0]!));
  assert.equal(citation.kind, 'search-snippet'); assert.equal(citation.source.id, 'S1'); assert.equal(citation.source.url, result.sources[0]!.url);
});
test('research is an independent resource; layout never persists query/results or creates chat readers', () => {
  const pane = { id: 'research', kind: 'research', resourceId: 'search' } as const;
  assert.ok(validPane(pane)); assert.equal(validPane({ ...pane, resourceId: 'arbitrary' }), false); assert.equal(validPane({ ...pane, sessionKey: 'codex:secret' }), false);
  assert.equal(paneSessionKey(pane), undefined); assert.equal(paneKey(pane), '\u0000research:search');
  const layout = openResourcePane(emptyWorkspace(), pane, 1200, 900);
  assert.equal(openResourcePane(layout, { ...pane, id: 'duplicate' }, 1200, 900).panes.length, 1);
  const restored = restoreWorkspace({ ...layout, panes: [{ ...pane, query: 'never-save', results: result }] }, new Set());
  assert.ok(restored); assert.ok(!JSON.stringify(restored).includes('never-save')); assert.ok(!JSON.stringify(restored).includes(result.searchId));
  assert.equal(restored.panes[0]!.kind, 'research');
});
