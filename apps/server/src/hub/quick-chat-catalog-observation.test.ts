import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { QuickChatStore } from './quick-chat-store.js';
import { QuickChatService } from './quick-chat-service.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

test('ignored catalog abort is bounded, coalesced and rejects late model publication', { timeout: 2000 }, async () => {
  const db = new DatabaseSync(':memory:');
  let calls = 0, cancelCount = 0, settle!: (response: Response) => void;
  const config = { url: 'https://provider.invalid/v1/responses', model: 'legacy', token: 'private', users: ['alice'] };
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private sink failure'); });
  const service = new QuickChatService(new QuickChatStore(db, Date.now, Buffer.alloc(32, 1)), config,
    async () => { calls++; return await new Promise<Response>(resolve => { settle = resolve; }); },
    45_000, { discoverModels: true, catalogTimeoutMs: 10, diagnostics });
  const keepAlive = setInterval(() => {}, 20);
  try {
    const values = await Promise.all([service.catalog('alice', true), service.catalog('alice', true)]);
    assert.ok(values.every(value => value?.catalogState === 'unavailable'));
    assert.deepEqual(values[0]!.models, [{ id: 'legacy', label: 'legacy' }]);
    assert.equal(calls, 1);
    assert.ok(diagnostics.snapshot().events.some(e => e.operation === 'hub-quick-chat' && e.step === 7 && e.unknown === 1));
    assert.ok(diagnostics.snapshot().totals.sinkFailures > 0);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private|provider\.invalid/);
    await service.catalog('alice', true);
    assert.equal(calls, 1);
    settle(new Response(new ReadableStream({ cancel() { cancelCount++; } }), { headers: { 'content-type': 'application/json' } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cancelCount, 1);
    assert.deepEqual(service.target('alice')!.models, [{ id: 'legacy', label: 'legacy' }]);
    assert.equal(db.isTransaction, false);
  } finally { clearInterval(keepAlive); service.close(); db.close(); }
});
