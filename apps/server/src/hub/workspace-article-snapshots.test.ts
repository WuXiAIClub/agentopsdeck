import assert from 'node:assert/strict';
import test from 'node:test';
import { ARTICLE_SNAPSHOT_TTL, WorkspaceArticleSnapshots } from './workspace-article-snapshots.js';
import { ResearchError } from './workspace-research.js';
import { validResearchReadingRange, type ResearchArticle, type ResearchResult } from '@agentopsdeck/shared';
const result: ResearchResult = { searchId: 'search', query: 'q', fetchedAt: 1, sources: [{ id: 'S1', title: 't', url: 'https://source.example/', snippet: 's' }] };
const article: ResearchArticle = { searchId: 'search', sourceId: 'S1', title: 't', url: 'https://source.example/', text: 'First. 😀 Selected paragraph. Last.', fetchedAt: 1, truncated: false };
const status = (code: number) => (error: unknown) => error instanceof ResearchError && error.status === code;
test('retains three sources, expires independently, rejects fourth without eviction and preserves default replace-all', () => {
  let now = 1; const store = new WorkspaceArticleSnapshots(() => now);
  const search = { ...result, sources: Array.from({ length: 4 }, (_, i) => ({ ...result.sources[0]!, id: `S${i + 1}`, url: `https://source.example/${i}` })) };
  const save = (i: number, retain = true) => store.save('alice', search, { ...article, sourceId: search.sources[i]!.id, url: search.sources[i]!.url }, retain);
  try {
    const a = save(0); now += 100; const b = save(1); const c = save(2);
    assert.throws(() => save(3), status(429)); store.assertCurrent('alice', search, a.articleId!);
    const newer = save(1); assert.throws(() => store.assertCurrent('alice', search, b.articleId!), status(409)); store.assertCurrent('alice', search, c.articleId!);
    now = ARTICLE_SNAPSHOT_TTL + 1; assert.throws(() => store.assertCurrent('alice', search, a.articleId!), status(409)); store.assertCurrent('alice', search, newer.articleId!);
    const d = save(3); store.assertCurrent('alice', search, d.articleId!);
    const single = save(0, false); assert.throws(() => store.assertCurrent('alice', search, d.articleId!), status(409)); store.assertCurrent('alice', search, single.articleId!);
  } finally { store.close(); }
});
test('snapshots bind exact search/source/owner and offsets, clone, replace, expire, close', () => {
  let now = 1; const store = new WorkspaceArticleSnapshots(() => now);
  try {
    const saved = store.save('alice', result, article), id = saved.articleId!;
    saved.text = 'browser replacement';
    assert.equal(store.resolve('alice', result, id, 'full').text, article.text);
    assert.equal(store.resolve('alice', result, id, 'selection', { start: 10, end: 18 }).text, article.text.slice(10, 18));
    assert.throws(() => store.get('bob', result, id), status(409));
    assert.throws(() => store.get('alice', { ...result, searchId: 'new' }, id), status(409));
    assert.throws(() => store.get('alice', { ...result, sources: [{ ...result.sources[0]!, url: 'https://other.example/' }] }, id), status(409));
    const replacement = store.save('alice', result, article); assert.notEqual(id, replacement.articleId);
    assert.throws(() => store.get('alice', result, id), status(409));
    now += ARTICLE_SNAPSHOT_TTL; assert.throws(() => store.get('alice', result, replacement.articleId!), status(409));
    const latest = store.save('alice', result, article); store.close(); assert.throws(() => store.get('alice', result, latest.articleId!), status(409));
  } finally { store.close(); }
});
test('reject invalid, surrogate-splitting, empty and oversized ranges without silent truncation', () => {
  const store = new WorkspaceArticleSnapshots();
  try {
    const { articleId } = store.save('alice', result, article);
    for (const range of [{ start: -1, end: 1 }, { start: 2, end: 1 }, { start: 1.5, end: 3 }, { start: 0, end: 1000 }, { start: 6, end: 7 }, { start: 8, end: 10 }, { start: 0, end: 8 }]) {
      assert.equal(validResearchReadingRange(article.text, range), false);
      assert.throws(() => store.resolve('alice', result, articleId!, 'selection', range), status(400));
    }
    assert.throws(() => store.resolve('alice', result, articleId!, 'full', { start: 0, end: 1 }), status(400));
    const long = store.save('alice', result, { ...article, text: '中'.repeat(11000), truncated: true });
    assert.throws(() => store.resolve('alice', result, long.articleId!, 'full'), status(413));
    const selected = store.resolve('alice', result, long.articleId!, 'selection', { start: 0, end: 10000 });
    assert.equal(selected.text.length, 10000); assert.equal(selected.evidence.truncated, true);
  } finally { store.close(); }
});
test('bounded owner count and bytes, expired capacity reusable, other owners never silently evicted', () => {
  let now = 1; const store = new WorkspaceArticleSnapshots(() => now);
  try {
    const ids = Array.from({ length: 16 }, (_, i) => store.save(String(i), result, article).articleId!);
    assert.throws(() => store.save('extra', result, article), status(429));
    assert.equal(store.get('0', result, ids[0]!).text, article.text);
    now += ARTICLE_SNAPSHOT_TTL; store.save('extra', result, article);
    store.close();
    const big = { ...article, text: '😀'.repeat(40000) };
    // 80k UTF-16, 160k UTF-8 each fits; owner cap remains effective.
    for (let i = 0; i < 16; i++) store.save(String(i), result, big);
    assert.throws(() => store.save('extra', result, big), status(429));
  } finally { store.close(); }
});
test('aggregate retained-source bytes are bounded and rejected admission preserves every current snapshot', () => {
  const store = new WorkspaceArticleSnapshots();
  const search = { ...result, sources: Array.from({ length: 3 }, (_, i) => ({ ...result.sources[0]!, id: `S${i + 1}`, url: `https://source.example/${i}` })) };
  const records: { owner: string; id: string }[] = [];
  let rejected = false;
  try {
    for (let user = 0; user < 16 && !rejected; user++) for (const source of search.sources) {
      try {
        const saved = store.save(String(user), search, { ...article, sourceId: source.id, url: source.url, text: '😀'.repeat(40000) }, true);
        records.push({ owner: String(user), id: saved.articleId! });
      } catch (error) { assert.ok(status(429)(error)); rejected = true; break; }
    }
    assert.equal(rejected, true); assert.ok(records.length > 16 && records.length < 48);
    for (const row of records) store.assertCurrent(row.owner, search, row.id);
    store.drop('0');
    assert.doesNotThrow(() => store.save('extra', search, { ...article, url: search.sources[0]!.url, text: '😀'.repeat(40000) }, true));
  } finally { store.close(); }
});
