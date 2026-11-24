import assert from 'node:assert/strict';
import test from 'node:test';
import { cardDraftKey, parseCardDraft, readCachedWorkspaceCard, writeCachedWorkspaceCard, readCachedWorkspaceCardsCatalog, writeCachedWorkspaceCardsCatalog, clearCachedWorkspaceCards } from './workspace-card-draft.js';
test('card drafts keep incomplete input and uncertain mutation, never cross owner keys', () => {
  const content = { title: '', value: '<script>literal</script>', detail: '', tone: 'blue', progress: null };
  const draft = { content, revision: 0 };
  assert.deepEqual(parseCardDraft(JSON.stringify(draft)), draft);
  assert.notEqual(cardDraftKey('alice', 'x'), cardDraftKey('bob', 'x'));
  const pending = { ...content, title: 'Saved', revision: 1, mutationId: '00000000-0000-4000-8000-000000000001' };
  assert.ok(parseCardDraft(JSON.stringify({ content: { ...content, title: 'Saved' }, revision: 1, pending })));
  assert.equal(parseCardDraft(JSON.stringify({ ...draft, pending })), undefined);
  for (const raw of ['null', '{}', 'broken', JSON.stringify({ ...draft, revision: -1 }), JSON.stringify({ content: { ...content, progress: 101 }, revision: 0 })]) assert.equal(parseCardDraft(raw), undefined);
});

test('workspace metric card cache preserves documents and updates catalog summaries per scope', () => {
  clearCachedWorkspaceCards();
  const cardId = '00000000-0000-4000-8000-000000000099';
  assert.deepEqual(readCachedWorkspaceCard('scope-a', cardId), { hit: false, document: undefined });

  writeCachedWorkspaceCardsCatalog('scope-a', []);
  const doc = {
    resourceId: cardId,
    title: 'Latency',
    value: '18ms',
    detail: 'P95 response time',
    tone: 'green' as const,
    progress: 90,
    revision: 4,
    updatedAt: 1700000000123,
  };
  writeCachedWorkspaceCard('scope-a', cardId, doc);
  assert.deepEqual(readCachedWorkspaceCard('scope-a', cardId), { hit: true, document: doc });
  assert.deepEqual(readCachedWorkspaceCard('scope-b', cardId), { hit: false, document: undefined });
  assert.equal(readCachedWorkspaceCardsCatalog('scope-a')?.length, 1);
  assert.equal(readCachedWorkspaceCardsCatalog('scope-a')?.[0]?.title, 'Latency');

  clearCachedWorkspaceCards();
  assert.deepEqual(readCachedWorkspaceCard('scope-a', cardId), { hit: false, document: undefined });
  assert.equal(readCachedWorkspaceCardsCatalog('scope-a'), undefined);
});
