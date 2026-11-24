import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { CommandReceipts } from '../commands/receipts.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { MirrorOutbox } from '../messages/mirror.js';
import { DeckStore } from '../projection/deck-store.js';
import { OpenClawExecutions } from './executions.js';
import { OpenClawTurnQueue, type OpenClawQueuedPayload } from './turn-queue.js';

const sessionKey = 'agent:main:synthetic:mirror-admission';
const turn = (id = 'original', deliveryMode: 'mirror' | 'web-only' = 'mirror') => ({ id, sessionKey, createdAt: 1,
  payload: { actorId: 'synthetic-actor', executionGrant: { id: 'synthetic-grant', actorId: 'synthetic-actor', issuerTokenId: 'synthetic-issuer' },
    message: 'original input', deliveryMode, media: [],
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', originatingAccountId: 'original-account', outboundTarget: 'original-target' } } });
const result = { status: 200, body: { idempotencyKey: 'original', status: 'queued' } };

function fixture(context: TestContext, file = ':memory:', capacity = 10_000) {
  const db = new DatabaseSync(file), receipts = new CommandReceipts(db), turns = new TurnQueue(db);
  const outbox = new MirrorOutbox(db, capacity), executions = new OpenClawExecutions(db), store = new DeckStore();
  store.upsertSession({ sessionKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
  const queue = new OpenClawTurnQueue({ turns, executions, store, mirrorOutbox: outbox, authorizeTurn: () => true,
    refreshSessions: async () => {}, refreshMessages: async () => {},
    send: async () => { throw new Error('Unexpected native send'); }, mirror: async () => { throw new Error('Unexpected channel send'); } });
  context.after(async () => { await queue.close(); db.close(); });
  return { db, receipts, turns, outbox, queue, executions, store };
}

test('mirror admission rolls queue, intent, receipt and capacity back before notifying observers', async context => {
  const { db, receipts, turns, outbox, queue, store } = fixture(context);
  receipts.claim('scope', 'key', {});
  const commit = receipts.queueCommit('scope', 'key', result);
  let wakes = 0;
  turns.onAdmission(() => {
    wakes += 1;
    assert.equal(outbox.get('original')?.actorId, 'synthetic-actor');
    assert.equal(receipts.get('scope', 'key')?.state, 'accepted');
  });
  const initialUsage = db.prepare('SELECT * FROM command_receipt_usage').get();
  assert.throws(() => queue.enqueue(turn(), database => { commit(database); throw new Error('synthetic post-receipt failure'); }), /post-receipt/);
  assert.deepEqual(turns.list('openclaw'), []);
  assert.deepEqual(outbox.list(), []);
  assert.equal(receipts.get('scope', 'key')?.state, 'outcome_unknown');
  for (const table of ['connector_turn_usage', 'connector_mirror_usage']) {
    assert.deepEqual({ ...db.prepare(`SELECT rows, bytes FROM ${table}`).get() }, { rows: 0, bytes: 0 });
  }
  assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), initialUsage);
  assert.equal(wakes, 0);
  assert.deepEqual(store.getMessages(sessionKey), []);
  queue.enqueue(turn(), commit);
  assert.equal(wakes, 1);
  assert.equal(outbox.get('original')?.executionGrant?.id, 'synthetic-grant');
  assert.deepEqual(outbox.get('original')?.explicitRoute, turn().payload.explicitRoute);
});

test('mirror capacity and missing actor reject the whole admission, not just forwarding', context => {
  const { db, receipts, turns, outbox, queue } = fixture(context, ':memory:', 1);
  queue.enqueue(turn());
  receipts.claim('scope', 'two', {});
  const commit = receipts.queueCommit('scope', 'two', { status: 200, body: { idempotencyKey: 'two' } });
  assert.throws(() => queue.enqueue(turn('two'), commit), /capacity/);
  const { actorId: _actor, executionGrant: _grant, ...unowned } = turn('two').payload;
  assert.throws(() => queue.enqueue({ ...turn('two'), payload: unowned }, commit), /original actor/);
  assert.equal(receipts.get('scope', 'two')?.state, 'outcome_unknown');
  assert.equal(turns.list('openclaw').length, 1);
  assert.equal(outbox.list().length, 1);
  assert.equal(db.prepare('SELECT rows FROM connector_mirror_usage').get()?.rows, 1);
});

test('mirror edit and cancel share the original receipt transaction and queue version', context => {
  const { receipts, turns, outbox, queue } = fixture(context);
  queue.enqueue(turn());
  const version = turns.version('openclaw', sessionKey, 'original');
  receipts.claim('scope', 'edit', {});
  const editCommit = receipts.queueCommit('scope', 'edit', result);
  assert.throws(() => queue.edit(sessionKey, 'original', 'changed', version, database => { editCommit(database); throw new Error('synthetic edit failure'); }), /edit failure/);
  assert.equal(turns.head<OpenClawQueuedPayload>('openclaw', sessionKey)?.payload.message, 'original input');
  assert.equal(outbox.get('original')?.inputText, 'original input');
  assert.equal(turns.version('openclaw', sessionKey, 'original'), version);
  assert.equal(receipts.get('scope', 'edit')?.state, 'outcome_unknown');
  assert.equal(queue.edit(sessionKey, 'original', 'changed', version, editCommit), true);
  assert.equal(outbox.get('original')?.inputText, 'changed');
  assert.equal(queue.cancel(sessionKey, 'original', version), false);
  const current = turns.version('openclaw', sessionKey, 'original');
  receipts.claim('scope', 'cancel', {});
  const cancelCommit = receipts.queueCommit('scope', 'cancel', result);
  assert.throws(() => queue.cancel(sessionKey, 'original', current, database => { cancelCommit(database); throw new Error('synthetic cancel failure'); }), /cancel failure/);
  assert.equal(outbox.get('original')?.inputText, 'changed');
  assert.equal(turns.version('openclaw', sessionKey, 'original'), current);
  assert.equal(receipts.get('scope', 'cancel')?.state, 'outcome_unknown');
  assert.equal(queue.cancel(sessionKey, 'original', current, cancelCommit), true);
  assert.deepEqual(outbox.list(), []);
  assert.deepEqual(turns.list('openclaw'), []);
  assert.equal(receipts.get('scope', 'cancel')?.state, 'accepted');
});

test('mirror missing or already selected evidence prevents edit and cancellation, while web-only remains usable', context => {
  const { turns, outbox, queue } = fixture(context);
  queue.enqueue(turn());
  const original = outbox.get('original'); assert.ok(original);
  outbox.remove('original');
  assert.throws(() => queue.edit(sessionKey, 'original', 'changed'), /missing/);
  assert.throws(() => queue.cancel(sessionKey, 'original'), /missing/);
  assert.equal(turns.head<OpenClawQueuedPayload>('openclaw', sessionKey)?.payload.message, 'original input');
  const restored = outbox.upsert(original);
  outbox.saveJob({ ...restored, deliveryState: 'outcome_unknown', selectedMessageId: 'reply', outputSha256: 'a'.repeat(64), attemptedAt: 2 });
  assert.throws(() => queue.edit(sessionKey, 'original', 'changed'), /conflict/);
  assert.throws(() => queue.cancel(sessionKey, 'original'), /evidence/);
  assert.equal(turns.list('openclaw').length, 1);
  queue.enqueue(turn('web', 'web-only'));
  assert.equal(queue.edit(sessionKey, 'web', 'web edit'), true);
  assert.equal(queue.cancel(sessionKey, 'web'), true);
  assert.equal(outbox.list().length, 1);
});

test('mirror dequeue rejects stale edit and cancel without changing the forwarding identity', context => {
  const { turns, outbox, queue } = fixture(context);
  queue.enqueue(turn());
  const version = turns.version('openclaw', sessionKey, 'original'), original = outbox.get('original');
  assert.equal(turns.start('openclaw', sessionKey, 'original'), true);
  assert.equal(queue.edit(sessionKey, 'original', 'late edit', version), false);
  assert.equal(queue.cancel(sessionKey, 'original', version), false);
  assert.deepEqual(outbox.get('original'), original);
});

for (const checkpoint of ['before-commit', 'after-commit', 'after-ack'] as const) {
  test(`mirror ${checkpoint} process exit preserves one consistent queue, receipt and intent`, context => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-mirror-admission-crash-')), file = join(dir, 'connector.sqlite');
    context.after(() => rmSync(dir, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', `
      import { ConnectorUserStore } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? '../connector/connector-user-store.ts' : '../connector/connector-user-store.js', import.meta.url).href)};
      import { DeckStore } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? '../projection/deck-store.ts' : '../projection/deck-store.js', import.meta.url).href)};
      import { OpenClawTurnQueue } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './turn-queue.ts' : './turn-queue.js', import.meta.url).href)};
      const owner = new ConnectorUserStore(${JSON.stringify(file)});
      const queue = new OpenClawTurnQueue({ turns: owner.turns, executions: owner.openClawExecutions, store: new DeckStore(), mirrorOutbox: owner.mirrorOutbox,
        authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {},
        send: async () => { throw new Error('Unexpected send'); }, mirror: async () => { throw new Error('Unexpected mirror'); } });
      await owner.commands.claimAsync('scope', 'key', {});
      const checkpoint = ${JSON.stringify(checkpoint)}, turn = ${JSON.stringify(turn())};
      const commit = owner.commands.queueCommit('scope', 'key', ${JSON.stringify(result)});
      await queue.enqueueAsync(turn, database => { commit(database); if (checkpoint === 'before-commit') process.exit(73); });
      if (checkpoint === 'after-ack') {
        owner.turns.start('openclaw', turn.sessionKey, turn.id);
        owner.openClawExecutions.begin(turn.sessionKey, turn.id);
        owner.openClawExecutions.acknowledge(turn.sessionKey, turn.id, 'original-run', () => owner.turns.complete('openclaw', turn.id));
      }
      process.exit(73);
    `], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir } });
    assert.equal(child.status, 73, child.stderr);
    const db = new DatabaseSync(file);
    try {
      const receipts = new CommandReceipts(db), turns = new TurnQueue(db), outbox = new MirrorOutbox(db);
      assert.equal(receipts.get('scope', 'key')?.state, checkpoint === 'before-commit' ? 'outcome_unknown' : 'accepted');
      assert.equal(turns.list('openclaw').length, checkpoint === 'after-commit' ? 1 : 0);
      assert.equal(outbox.list().length, checkpoint === 'before-commit' ? 0 : 1);
      if (checkpoint !== 'before-commit') {
        assert.equal(outbox.get('original')?.actorId, 'synthetic-actor');
        assert.equal(outbox.get('original')?.deliveryState, 'pending');
      }
    } finally { db.close(); }
  });
}
