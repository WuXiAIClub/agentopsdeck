import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkCommands, type SdkCommandOptions } from './sdk-commands.js';
import { SdkExecutionJournal, type SdkAgentId } from './sdk-execution-journal.js';
import { SdkAttachmentStore } from './sdk-attachment-store.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { SdkExecutionDriver, type SdkDriverOptions, type SdkOwnedTurn } from './sdk-execution-driver.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { SdkDispatch } from './sdk-dispatch.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

function fixture(runtime: SdkAgentId) {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
  db.exec('CREATE TABLE connector_users(id TEXT); CREATE TABLE late_effect(value INTEGER)');
  const turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, runtime, undefined, undefined,
    { available: () => true, beforeBegin() {} });
  const key = `${runtime}:fixture`;
  journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 0 });
  const first = { key, id: 'first', epoch: 'epoch' };
  turns.enqueue(runtime, { id: first.id, sessionKey: key, createdAt: 0, payload: {} });
  journal.begin(first, [first.id], turns); journal.observeTerminal(first, 'completed', turns); journal.confirmSettled(first);
  const store = { turns, sdkAttachments: new SdkAttachmentStore(db),
    commands: { sessionDeletion() { return undefined; }, sessionSettingsPending() { return false; } } } as unknown as ConnectorUserStore;
  let changes = 0, wakes = 0;
  const options: SdkCommandOptions<SdkAgentId> = { runtime, store, journal, models: { model: 'default', modelChoices: ['other'] },
    assertAvailable() {}, authorize: () => true, changed() { changes++; }, driver: {
      wake: async () => { wakes++; }, interrupt: async () => 'accepted',
      compact: (session, id, actor, commit) => !!journal.beginCompact({ key: session, id, epoch: 'epoch' }, actor, turns, commit),
    } };
  const commands = new SdkCommands(options);
  const snapshot = () => ['sdk_agent_sessions', 'sdk_agent_executions', 'connector_turns', 'sdk_attachments', 'late_effect']
    .map(table => raw.prepare(`SELECT * FROM ${table}`).all());
  return { raw, db, turns, journal, commands, key, options, snapshot, effects: () => ({ changes, wakes }) };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  for (const kind of ['async', 'promise', 'truthy'] as const) {
    test(`${runtime} actual queued dispatch rejects ${kind} permission without native work`, async () => {
      const f = fixture(runtime); let calls = 0, sends = 0, getterReads = 0;
      const thenable = Object.defineProperty({}, 'then', { get() { getterReads++; throw Error('private getter'); } });
      const authorize = kind === 'async' ? async () => { calls++; return true; } : () => {
        calls++; return kind === 'promise' ? Promise.resolve(true) : thenable;
      };
      const dispatch = new SdkDispatch({ journal: f.journal, turns: f.turns, deadlineMs: 1000,
        authorize: authorize as unknown as (key: string, payload: unknown, action: string) => boolean,
        adapter: { epoch: 'epoch', ready: true,
          send: async () => { sends++; return { nativeRequestId: 'never' }; },
          inspectSettlement: async () => assert.fail('No settlement'), interrupt: async () => assert.fail('No interrupt') } });
      try {
        f.turns.enqueue(runtime, { id: 'denied', sessionKey: f.key, createdAt: 1,
          payload: { actorId: 'owner', text: 'input', images: [] } });
        const before = f.snapshot();
        if (kind === 'truthy') assert.equal(await dispatch.dispatch(f.key), 'blocked');
        else await assert.rejects(dispatch.dispatch(f.key), AuthPersistenceError);
        assert.equal(sends, 0); assert.equal(getterReads, 0); assert.equal(calls, kind === 'async' ? 0 : 1);
        if (kind !== 'truthy') assert.deepEqual(f.snapshot(), before);
        assert.equal(connectionRecoverySnapshot(f.db).state === 'close-required', kind === 'promise');
      } finally { f.db.close(); }
    });
  }
  for (const failure of ['async-receipt', 'escaped-receipt', 'async-authority'] as const) {
    test(`${runtime} actual compact driver denies ${failure} before native launch`, async () => {
      const f = fixture(runtime);
      let starts = 0, bodies = 0, release!: () => void, late: Promise<void> | undefined;
      const held = new Promise<void>(resolve => { release = resolve; });
      const insert = f.db.prepare('INSERT INTO late_effect VALUES(1)');
      const options: SdkDriverOptions<SdkOwnedTurn> = {
        journal: f.journal, turns: f.turns, deadlineMs: 1000,
        authorize: failure === 'async-authority' ? (async () => { bodies++; return true; }) as unknown as SdkDriverOptions<SdkOwnedTurn>['authorize'] : () => true,
        start: () => assert.fail('No ordinary native turn'), endStreams() {},
        adapter: () => ({ runtime, epoch: 'epoch', ready: true, close() {},
          send: async () => assert.fail('No native send'),
          inspectSettlement: async () => assert.fail('No settlement'), interrupt: async () => assert.fail('No interrupt') }),
        startCompact: () => { starts++; return assert.fail('No native compact'); },
      };
      const driver = new SdkExecutionDriver(options);
      try {
        const before = f.snapshot();
        const commit = failure === 'async-receipt' ? async () => { bodies++; } : () => {
          bodies++; late = (async () => { await held; insert.run(); })(); return late;
        };
        if (failure === 'async-authority') {
          assert.equal(driver.compact(f.key, 'compact-denied', 'owner', commit), false);
        } else {
          assert.throws(() => driver.compact(f.key, 'compact-denied', 'owner', commit),
            failure === 'async-receipt' ? AuthPersistenceError : /must be synchronous/);
        }
        assert.equal(starts, 0); assert.equal(f.raw.isTransaction, false); assert.deepEqual(f.snapshot(), before);
        if (failure === 'escaped-receipt') {
          assert.equal(bodies, 1); assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
          const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
        } else {
          assert.equal(bodies, 0); assert.notEqual(connectionRecoverySnapshot(f.db).state, 'close-required');
        }
        await driver.close();
        assert.equal(starts, 0); assert.deepEqual(f.snapshot(), before);
      } finally { release(); await late?.catch(() => {}); await driver.close(); f.db.close(); }
    });
  }
  for (const operation of ['create', 'model', 'send', 'compact', 'cancel'] as const) {
    test(`${runtime} command ${operation} preserves the original SQL participant Promise and rolls back`, async () => {
      const f = fixture(runtime);
      let release!: () => void, late: Promise<void> | undefined;
      const held = new Promise<void>(resolve => { release = resolve; });
      const insert = f.db.prepare('INSERT INTO late_effect VALUES(1)');
      const callback = () => { late = (async () => { await held; insert.run(); })(); return late; };
      try {
        const queued = operation === 'cancel' ? f.commands.send(f.key, 'input', { actorId: 'owner', accept: () => () => {} }) : undefined;
        const version = queued && f.turns.version(runtime, f.key, queued.idempotencyKey)!;
        const before = f.snapshot(), effects = f.effects();
        assert.throws(() => {
          switch (operation) {
            case 'create': return f.commands.createSession('new', { authorize() {}, accept: () => callback });
            case 'model': return f.commands.updateModel(f.key, 'other', () => {}, callback);
            case 'send': return f.commands.send(f.key, 'input', { actorId: 'owner', accept: () => callback });
            case 'compact': return f.commands.compact(f.key, { actorId: 'owner', accept: () => callback });
            case 'cancel': return f.commands.cancelQueued(f.key, queued!.idempotencyKey, version!, { actorId: 'owner' }, callback);
          }
        }, /must be synchronous/);
        assert.equal(f.raw.isTransaction, false); assert.deepEqual(f.snapshot(), before);
        assert.deepEqual(f.effects(), effects, 'No projection/native wake before SQL success');
        assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
        const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
        assert.deepEqual(f.snapshot(), before);
      } finally { release(); await late?.catch(() => {}); f.db.close(); }
    });
  }

  for (const operation of ['create', 'model', 'send'] as const) {
    test(`${runtime} command ${operation} rejects known async authority before its body`, () => {
      const f = fixture(runtime); let calls = 0, receipts = 0;
      const asyncAuthority = async () => { calls++; return true; };
      try {
        const before = f.snapshot();
        assert.throws(() => {
          if (operation === 'create') return f.commands.createSession('new', {
            authorize: asyncAuthority, accept: () => { receipts++; return () => {}; },
          });
          if (operation === 'model') return f.commands.updateModel(f.key, 'other', asyncAuthority, () => { receipts++; });
          f.options.authorize = asyncAuthority as unknown as typeof f.options.authorize;
          return f.commands.send(f.key, 'input', { actorId: 'owner', accept: () => { receipts++; return () => {}; } });
        });
        assert.equal(calls, 0); assert.equal(receipts, 0); assert.deepEqual(f.snapshot(), before);
        assert.notEqual(connectionRecoverySnapshot(f.db).state, 'close-required', 'Never-started work needs no retirement');
      } finally { f.db.close(); }
    });
  }

  test(`${runtime} permission requires literal true, preserves receiver/arguments, and never reads then`, () => {
    const f = fixture(runtime); let reads = 0, calls = 0;
    const thenable = Object.defineProperty({}, 'then', { get() { reads++; throw Error('must not read'); } });
    try {
      f.options.authorize = function (key, actor, action) {
        assert.equal(this, f.options); assert.equal(key, f.key); assert.equal(actor.actorId, 'owner');
        assert.equal(actor.text, 'input'); assert.equal(action, 'messages:send'); calls++;
        return thenable as boolean;
      };
      assert.throws(() => f.commands.send(f.key, 'input', { actorId: 'owner', accept: () => () => {} }));
      assert.equal(reads, 0); assert.equal(calls, 1);
      f.options.authorize = function () { assert.equal(this, f.options); return true; };
      const sent = f.commands.send(f.key, 'input', { actorId: 'owner', accept: () => () => {} });
      assert.ok(f.turns.version(runtime, f.key, sent.idempotencyKey));
      const createOptions = { authorize() { assert.equal(this, createOptions); }, accept: () => () => {} };
      assert.ok(f.commands.createSession('new', createOptions).key);
      assert.deepEqual(f.effects(), { changes: 2, wakes: 1 });
    } finally { f.db.close(); }
  });
}
