import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { ConnectorUserStore } from './connector-user-store.js';
import { ClaudeOwnedRuntime } from '../claude/owned-runtime.js';
import { CopilotOwnedRuntime } from '../copilot/owned-runtime.js';
import { ClaudeSessionProjection } from '../claude/session-projection.js';
import { CopilotSessionProjection } from '../copilot/session-projection.js';
import { DeckStore } from '../projection/deck-store.js';
import type { SdkPreflight } from './sdk-owned-runtime.js';

const passed = (): SdkPreflight => ({ ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close() {} });

for (const runtime of ['claude-code', 'ghcp'] as const) {
  async function fixture(materialized = false, deleteNative: () => SdkPreflight = passed) {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-deletion-')), file = join(root, 'connector.sqlite');
    const homeDirectory = join(root, 'home'); mkdirSync(homeDirectory, { mode: 0o700 });
    const store = new ConnectorUserStore(file, () => true, { runtimeOwner: true });
    const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
    const key = `${runtime}:${randomUUID()}`, deck = new DeckStore();
    journal.create({ key, nativeSessionId: randomUUID(), title: 'Deletion fixture', createdAt: 1 });
    const config = { homeDirectory, workspace: root, sdkDirectory: root, startupTimeoutMs: 100,
      apiKeyFile: join(root, 'absent-key'), model: 'fixture', baseUrl: 'http://127.0.0.1:1', auth: { mode: 'github' as const, credentialFile: join(root, 'absent-key') } };
    if (materialized) {
      await store.turns.enqueueAsync(runtime, { id: 'input', sessionKey: key, createdAt: 1, payload: { text: 'fixture', actorId: 'owner' } });
      const ref = { key, id: randomUUID(), epoch: randomUUID() };
      journal.begin(ref, ['input'], store.turns); journal.observeTerminal(ref, 'completed', store.turns); journal.confirmSettled(ref);
    }
    let calls = 0;
    const options = { store, config, projection: deck, authorize: () => true };
    const build = () => runtime === 'ghcp'
      ? new CopilotOwnedRuntime(options, () => assert.fail('No inference allowed'), passed, () => { calls++; return deleteNative(); })
      : new ClaudeOwnedRuntime(options, () => assert.fail('No inference allowed'), passed, () => { calls++; return deleteNative(); });
    const owner = build(); assert.equal(await owner.initialize(), true);
    return { root, file, store, journal, key, owner, deck, build, calls: () => calls,
      close: async () => { await owner.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
  }

  test(`${runtime}: deletion tombstone and receipt commit together; refresh/reopen cannot resurrect`, async () => {
    const f = await fixture(true);
    const scope = JSON.stringify(['session.delete', 'owner', f.key]);
    try {
      (await f.store.commands.claimAsync(scope, 'remove', {}));
      await f.owner.remove(f.key, () => {}, () => {
        assert.equal(f.store.commands.settle(scope, 'remove', { status: 200, body: { ok: true } }).state, 'accepted');
      });
      assert.equal(f.calls(), 1); assert.equal(f.journal.session(f.key), undefined);
      assert.equal(f.journal.deletion(f.key)?.phase, 'deleted'); assert.equal(f.journal.pendingCount(), 0);
      assert.equal(f.journal.current(f.key)?.phase, 'completed', 'Execution audit is retained');
      assert.equal(f.deck.getSession(f.key), undefined);
      f.owner.refreshDirectory(); assert.equal(f.deck.getSession(f.key), undefined);
      const projection = runtime === 'ghcp' ? new CopilotSessionProjection(f.store, f.deck)
        : new ClaudeSessionProjection(f.store, f.deck);
      assert.equal(projection.publish(f.key, true), undefined, 'Late history publication cannot resurrect a tombstone');
      assert.equal(f.deck.getSession(f.key), undefined);
      assert.deepEqual(f.deck.getMessages(f.key), []);
      await assert.rejects(f.owner.remove(f.key, () => {}, () => {})); assert.equal(f.calls(), 1);
      await f.owner.close();
      const reopened = f.build();
      try { await reopened.initialize(); reopened.refreshDirectory(); assert.equal(f.deck.getSession(f.key), undefined); }
      finally { await reopened.close(); }
    } finally { await f.close(); }
  });

  test(`${runtime}: never-materialized deletion is local and refuses revoked/queued/maintenance commands`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.owner.remove(f.key, () => { throw new Error('revoked'); }, () => {}));
      assert.equal(f.journal.deletion(f.key), undefined);
      const pause = f.owner.pauseQueueWorker(); await pause.drained;
      await assert.rejects(f.owner.remove(f.key, () => {}, () => {})); assert.equal(pause.resume(), true);
      const resume = f.store.pauseTurnStarts();
      await assert.rejects(f.owner.remove(f.key, () => {}, () => {})); resume();
      await f.store.turns.enqueueAsync(runtime, { id: 'waiting', sessionKey: f.key, createdAt: 1, payload: { text: 'fixture', actorId: 'owner' } });
      await assert.rejects(f.owner.remove(f.key, () => {}, () => {}));
      f.store.turns.cancel(runtime, f.key, 'waiting', f.store.turns.version(runtime, f.key, 'waiting')!);
      let accepted = 0; await f.owner.remove(f.key, () => {}, () => { accepted++; });
      assert.equal(accepted, 1); assert.equal(f.calls(), 0); assert.equal(f.journal.deletion(f.key)?.phase, 'deleted');
    } finally { await f.close(); }
  });

  test(`${runtime}: native failure and receipt rollback remain unknown, fenced after restart, never retried`, async () => {
    for (const failNative of [true, false]) {
      const f = await fixture(true, () => ({ ...passed(), ready: Promise.resolve(!failNative) }));
      try {
        await assert.rejects(f.owner.remove(f.key, () => {}, () => { throw new Error('receipt write failed'); }), /unknown/);
        assert.equal(f.journal.deletion(f.key)?.phase, 'unknown'); assert.equal(f.journal.pendingCount(), 1);
        assert.equal(f.journal.canStart(f.key), false); assert.equal(f.store.canDeleteSession(f.key), false);
        assert.equal(f.deck.getSession(f.key)?.runtime?.phase, 'unknown');
        await assert.rejects(f.owner.remove(f.key, () => {}, () => {})); assert.equal(f.calls(), 1);
        await f.owner.close();
        const reopened = f.build();
        try { await reopened.initialize(); await assert.rejects(reopened.remove(f.key, () => {}, () => {})); assert.equal(f.calls(), 1); }
        finally { await reopened.close(); }
      } finally { await f.close(); }
    }
  });

  test(`${runtime}: maintenance drains delete worker and blocks concurrent mutation`, async () => {
    let done!: () => void, quiet = false;
    const finished = new Promise<void>(resolve => { done = () => { quiet = true; resolve(); }; });
    const worker = { ready: finished.then(() => true), finished, inspectQuiescence: () => quiet, close: () => done() };
    const f = await fixture(true, () => worker);
    try {
      const remove = f.owner.remove(f.key, () => {}, () => {});
      assert.equal(f.journal.deletion(f.key)?.phase, 'pending');
      assert.equal(f.owner.inspectMaintenance().startupWorkers, 1);
      assert.equal(f.owner.ready, true, 'Deleting one idle session must not pause unrelated queues or Stop controls');
      const other = `${runtime}:${randomUUID()}`;
      f.journal.create({ key: other, nativeSessionId: randomUUID(), title: 'Unrelated session', createdAt: 1 });
      f.owner.commands.updateModel(other, null, () => {}, () => {});
      assert.throws(() => f.owner.commands.updateModel(f.key, null, () => {}, () => {}));
      await assert.rejects(f.owner.remove(f.key, () => {}, () => {}));
      let drained = false; const pause = f.owner.pauseQueueWorker(); void pause.drained.then(() => { drained = true; });
      await setImmediate(); assert.equal(drained, false);
      done(); await remove; await pause.drained;
      assert.equal(f.owner.inspectMaintenance().startupWorkers, 0); assert.equal(f.calls(), 1);
      assert.equal(pause.resume(), true);
    } finally { await f.close(); }
  });

  test(`${runtime}: close waits for deletion cleanup and preserves an uncertain outcome`, async () => {
    let finish!: () => void, quiet = false;
    const finished = new Promise<void>(resolve => { finish = () => { quiet = true; resolve(); }; });
    const worker = { ready: finished.then(() => false), finished, inspectQuiescence: () => quiet, close: () => finish() };
    const f = await fixture(true, () => worker);
    try {
      const removed = assert.rejects(f.owner.remove(f.key, () => {}, () => assert.fail('Cannot accept cancelled deletion')), /unknown/);
      assert.equal(f.journal.deletion(f.key)?.phase, 'pending');
      await f.owner.close(); await removed;
      assert.equal(quiet, true); assert.equal(f.journal.deletion(f.key)?.phase, 'unknown');
      assert.equal(f.journal.pendingCount(), 1); assert.equal(f.calls(), 1);
    } finally { await f.close(); }
  });

  test(`${runtime}: unconfirmed deletion cleanup fences runtime admission`, async () => {
    let quiet = false;
    const worker = { ...passed(), inspectQuiescence: () => quiet };
    const f = await fixture(true, () => worker);
    try {
      await assert.rejects(f.owner.remove(f.key, () => {}, () => assert.fail('Unclean worker cannot be accepted')), /unknown/);
      assert.equal(f.owner.ready, false);
      assert.equal(f.owner.inspectMaintenance().startupWorkers, 1);
      assert.equal(f.journal.deletion(f.key)?.phase, 'unknown');
      const pause = f.owner.pauseQueueWorker(); await assert.rejects(pause.drained);
      assert.equal(pause.resume(), false);
    } finally { quiet = true; await f.close(); }
  });
}
