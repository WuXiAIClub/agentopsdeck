import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from './connector-user-store.js';

for (const runtime of ['openclaw', 'codex'] as const) {
  test(`${runtime} stop-starts preserves pending payloads and allows admitted writes until storage closes`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-stop-starts-'));
    const file = join(dir, 'synthetic.sqlite'), sessionKey = `${runtime}:synthetic`;
    let users = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    try {
      const first = { id: 'first', sessionKey, createdAt: 1, payload: { text: 'keep me', actorId: 'synthetic-owner' } };
      await users.turns.enqueueAsync(runtime, first);
      const version = users.turns.version(runtime, sessionKey, first.id);
      users.stopTurnStarts(); users.stopTurnStarts();
      await users.turns.enqueueAsync(runtime, { ...first, id: 'admitted-before-shutdown' });
      assert.equal(users.turns.start(runtime, sessionKey, first.id), false);
      assert.equal(users.turns.version(runtime, sessionKey, first.id), version);
      assert.equal(users.codexExecutions.begin(sessionKey, first.id, 'synthetic-connection'), false);
      assert.equal(users.openClawExecutions.begin(sessionKey, first.id), false);
      assert.equal(users.codexExecutions.get(sessionKey), undefined);
      assert.equal(users.openClawExecutions.get(sessionKey), undefined);
      const before = users.turns.list(runtime, sessionKey);
      users.close(); users = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      assert.deepEqual(users.turns.list(runtime, sessionKey), before);
      assert.equal(users.turns.start(runtime, sessionKey, first.id), true, 'new owner may resume unchanged queued work');
      assert.deepEqual(users.turns.head(runtime, sessionKey)?.payload, first.payload);
    } finally { users.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${runtime} stop-starts still permits the original execution ACK to atomically retire its queued input`, () => {
    const users = new ConnectorUserStore(':memory:'), sessionKey = `${runtime}:synthetic`;
    try {
      for (const id of ['running', 'successor']) users.turns.enqueue(runtime, { id, sessionKey, createdAt: 1, payload: { text: id } });
      assert.equal(users.turns.start(runtime, sessionKey, 'running'), true);
      assert.equal(runtime === 'codex' ? users.codexExecutions.begin(sessionKey, 'running', 'connection')
        : users.openClawExecutions.begin(sessionKey, 'running'), true);
      users.stopTurnStarts();
      const commit = () => users.turns.complete(runtime, 'running');
      assert.equal(runtime === 'codex' ? users.codexExecutions.acknowledge(sessionKey, 'running', 'connection', 'native', commit)
        : users.openClawExecutions.acknowledge(sessionKey, 'running', 'native', commit), true);
      assert.equal(users.turns.head(runtime, sessionKey)?.id, 'successor');
      assert.equal(users.turns.start(runtime, sessionKey, 'successor'), false);
      assert.equal(users.turns.head(runtime, sessionKey)?.state, 'queued');
    } finally { users.close(); }
  });
}

test('stop-starts does not erase prepared native work or let ready preparation become a new send', () => {
  const users = new ConnectorUserStore(':memory:'), sessionKey = 'codex:synthetic';
  try {
    assert.equal(users.codexExecutions.begin(sessionKey, 'preparing', 'connection', true), true);
    users.stopTurnStarts();
    assert.equal(users.codexExecutions.finishPreparation(users.codexExecutions.get(sessionKey)!), true);
    const ready = users.codexExecutions.get(sessionKey)!;
    assert.equal(ready.preparation, 'ready');
    assert.equal(users.codexExecutions.begin(sessionKey, 'preparing', 'connection'), false);
    assert.deepEqual(users.codexExecutions.get(sessionKey), ready);
  } finally { users.close(); }
});
