import assert from 'node:assert/strict';
import test from 'node:test';
import { IssueCardReader, type IssueQuery, type IssuePage } from './issue-card-reader.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function held<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const query: IssueQuery = { connection: 'fixture', project: '12', kind: 'issue', filter: '', order: 'updated_desc', limit: 50 };
const authority = () => ({ epoch: 'e1', origin: 'https://fixture.invalid', provider: 'gitlab' });
const page = (): IssuePage => ({ items: [{ remoteId: '1', title: 'PRIVATE TITLE', body: null, state: 'open', url: 'https://fixture.invalid/issues/1', updatedAt: 1,
  labels: ['original'], assignees: ['first'] }], nextCursor: 'next', completeness: 'complete', retryAfter: null });
for (const phase of [1, 2, 3]) for (const ending of ['timeout', 'abort', 'close'] as const) {
  test(`issue ${ending} at phase ${phase} retains original and cannot publish cursor`, async () => {
    const gate = held<void>(), entered = held<void>(), abort = new AbortController(); let calls = 0, permissionCalls = 0;
    const stage = async (step: number) => { calls++; if (step === phase) { entered.resolve(); await gate.promise; } };
    const reader = new IssueCardReader({ list: async (_, __, signal) => { await stage(2); if (phase === 2) assert.equal(signal.aborted, true); return page(); } },
      async () => { await stage(++permissionCalls === 1 ? 1 : 3); return authority(); }, Date.now, ending === 'timeout' ? 10 : 1000);
    const read = reader.list('actor', query, undefined, new Request('http://synthetic.invalid', { signal: abort.signal }));
    const observed = assert.rejects(read, /timeout|unavailable|cancelled/); await entered.promise;
    if (ending === 'abort') abort.abort();
    const close = ending === 'close' ? reader.close() : undefined;
    if (ending !== 'close') await observed;
    assert.equal(reader.pending, 1); assert.equal(reader.pendingFor('actor'), true);
    let drained = false; const drain = close ?? reader.close(); void drain.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    gate.resolve(); await observed; await drain; assert.equal(reader.pending, 0); assert.equal(reader.pendingFor('actor'), false); assert.equal(calls, phase);
    assert.equal((reader as unknown as { cursors: Map<string, unknown> }).cursors.size, 0);
  });
}
test('mutable initial authority DTO cannot erase revocation evidence', async () => {
  const mutable = authority(); const reader = new IssueCardReader({ list: async () => { mutable.epoch = 'revoked'; return page(); } }, async () => mutable);
  await assert.rejects(reader.list('actor', query), /authority/); await reader.close();
});
test('input is captured before async permission and normalized metadata does not alias provider', async () => {
  const gate = held<void>(), raw = { ...query }, value = page(); let permissions = 0;
  const reader = new IssueCardReader({ list: async actual => { assert.equal(actual.project, '12'); assert.equal(Object.isFrozen(actual), true); return value; } },
    async () => { if (++permissions === 1) await gate.promise; return authority(); });
  const read = reader.list('actor', raw); raw.project = 'must not replace original'; gate.resolve(); const result = await read;
  value.items[0]!.labels![0] = 'must not change delivered copy'; value.items[0]!.assignees!.push('late');
  assert.deepEqual(result.items[0]!.labels, ['original']); assert.deepEqual(result.items[0]!.assignees, ['first']); await reader.close();
});
test('late provider rejection retains per-owner and total capacity without unhandled rejection', async () => {
  const gate = held<IssuePage>(); let starts = 0;
  const reader = new IssueCardReader({ list: () => { starts++; return gate.promise; } }, authority, Date.now, 10);
  await assert.rejects(reader.list('actor', query), /timeout/); assert.equal(reader.pendingFor('actor'), true);
  await assert.rejects(reader.list('actor', query), /busy/); assert.equal(starts, 1);
  const drain = reader.close(); gate.reject(Error('PRIVATE provider failure')); await drain;
  assert.equal(reader.pending, 0); await assert.rejects(reader.list('actor', query), /unavailable/);
});
test('retained eight original readers cannot be replaced by timed-out HTTP callers', async () => {
  const gate = held<IssuePage>(); let starts = 0;
  const reader = new IssueCardReader({ list: () => { starts++; return gate.promise; } }, authority, Date.now, 10);
  await Promise.all(Array.from({ length: 8 }, (_, index) => assert.rejects(reader.list('actor-' + index, query), /timeout/)));
  await assert.rejects(reader.list('ninth', query), /unavailable/); assert.equal(starts, 8); assert.equal(reader.pending, 8);
  const drain = reader.close(); gate.resolve(page()); await drain; assert.equal(reader.pending, 0);
});
