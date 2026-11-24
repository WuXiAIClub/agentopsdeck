import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { QuickChatStore } from './quick-chat-store.js';
import { QuickChatService } from './quick-chat-service.js';

const config = { url: 'https://provider.invalid/v1/responses', model: 'fixture', token: 'fixture', users: ['alice', 'bob', 'carol'] };
for (const mode of ['timeout', 'close'] as const) {
  test(`ignored provider cancellation ends ${mode} observation without releasing the original permit`, { timeout: 2000 }, async () => {
    const db = new DatabaseSync(':memory:'), store = new QuickChatStore(db, Date.now, Buffer.alloc(32, 1));
    const pending: Array<(response: Response) => void> = [];
    let calls = 0, cancellations = 0;
    const service = new QuickChatService(store, config, async () => {
      calls++; return await new Promise<Response>(resolve => pending.push(resolve));
    }, mode === 'timeout' ? 10 : 10_000);
    const profileId = randomUUID(), requestIds = [randomUUID(), randomUUID(), randomUUID()];
    const keepAlive = setInterval(() => {}, 20);
    try {
      for (const owner of config.users) service.saveProfile(owner, 0, { id: profileId, name: 'Fixture', target: 'hub-standalone', model: config.model, outputLimit: 100 });
      const first = service.send('alice', requestIds[0]!, profileId, 1, 'input', () => true);
      const second = service.send('bob', requestIds[1]!, profileId, 1, 'input', () => true);
      const both = Promise.all([first, second]);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(calls, 2);
      if (mode === 'close') service.close();
      const results = await both;
      assert.ok(results.every(result => result.receipt.state === 'unknown'));
      assert.equal(db.isTransaction, false);
      assert.equal(service.inspect('alice', requestIds[0]!).receipt.state, 'unknown');
      if (mode === 'timeout') {
        assert.equal((await service.send('alice', requestIds[0]!, profileId, 1, 'input', () => true)).receipt.state, 'unknown');
        await assert.rejects(service.send('carol', requestIds[2]!, profileId, 1, 'input', () => true), /provider-capacity/);
      }
      assert.equal(calls, 2);
      for (const settle of pending) settle(new Response(new ReadableStream({ cancel() { cancellations++; } }), { headers: { 'content-type': 'application/json' } }));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(cancellations, 2);
      assert.equal(service.inspect('alice', requestIds[0]!).receipt.state, 'unknown');
      assert.equal(service.inspect('alice', requestIds[0]!).output, null);
    } finally {
      clearInterval(keepAlive); service.close(); db.close();
    }
  });
}
