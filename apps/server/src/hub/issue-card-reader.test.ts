import assert from 'node:assert/strict';
import test from 'node:test';
import { IssueCardReader, type IssueItem, type IssueQuery } from './issue-card-reader.js';
const query: IssueQuery = { connection: 'fixture', project: 'a/b', kind: 'issue', filter: '', order: 'updated_desc', limit: 50 };
const authority = () => ({ epoch: 'e1', origin: 'https://fixture.invalid' });
const item = (remoteId: string): IssueItem => ({ remoteId, title: '<script>text only</script>', state: 'open', url: `https://fixture.invalid/a/b/${remoteId}`, body: null, updatedAt: 1 });
test('read-only pagination deduplicates stable remote identity across changing pages', async () => {
  const reader = new IssueCardReader({ list: async (_, cursor) => ({ items: cursor ? [item('1'), item('2')] : [item('1')], nextCursor: cursor ? null : 'remote-2', completeness: 'complete', retryAfter: null }) }, authority);
  const first = await reader.list('alice', query), second = await reader.list('alice', query, first.nextCursor!);
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 1); assert.equal(second.items[0]!.identity.remoteId, '2');
  assert.equal(first.items[0]!.title, '<script>text only</script>'); assert.equal(first.consistency, 'best_effort');
  assert.equal((await reader.list('alice', query)).items[0]!.sourceKey, first.items[0]!.sourceKey);
});
test('cursor binds owner, exact filter and authority generation; revocation drops late response', async () => {
  let epoch = 'e1';
  const adapter = { list: async () => ({ items: [item('1')], nextCursor: 'next', completeness: 'complete' as const, retryAfter: null }) };
  const reader = new IssueCardReader(adapter, () => ({ ...authority(), epoch }));
  const cursor = (await reader.list('alice', query)).nextCursor!;
  await assert.rejects(reader.list('bob', query, cursor), /cursor/);
  await assert.rejects(reader.list('alice', { ...query, filter: 'changed' }, cursor), /cursor/);
  epoch = 'e2'; await assert.rejects(reader.list('alice', query, cursor), /cursor/);
  const revoked = new IssueCardReader({ list: async () => { epoch = 'e3'; return adapter.list(); } }, () => ({ ...authority(), epoch }));
  await assert.rejects(revoked.list('alice', query), /authority/);
});
test('oversize, off-origin and duplicate rows reject without silently truncating', async () => {
  for (const items of [[{ ...item('1'), body: 'x'.repeat(65537) }], [{ ...item('1'), url: 'https://other.invalid/private' }], [item('1'), item('1')]]) {
    const reader = new IssueCardReader({ list: async () => ({ items, nextCursor: null, completeness: 'partial', retryAfter: null }) }, authority);
    await assert.rejects(reader.list('alice', query));
  }
});
test('expired pagination is explicit and remote timeout does not start another request', async () => {
  let now = 1000, calls = 0;
  const reader = new IssueCardReader({ list: async () => ({ items: [], nextCursor: 'next', completeness: 'partial', retryAfter: 30 }) }, authority, () => now);
  const first = await reader.list('alice', query); now = 301000;
  await assert.rejects(reader.list('alice', query, first.nextCursor!), /cursor/);
  const slow = new IssueCardReader({ list: async () => { calls++; return new Promise(() => {}); } }, authority, Date.now, 10);
  await assert.rejects(slow.list('alice', query), /timeout/); assert.equal(calls, 1);
});
