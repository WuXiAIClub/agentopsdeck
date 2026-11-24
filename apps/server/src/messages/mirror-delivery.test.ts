import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DeckStore } from '../projection/deck-store.js';
import { OpenClawExecutions } from '../openclaw/executions.js';
import { createMirrorDispatcher, MirrorDeliveryUnknown, MirrorDispatcherClosed, MirrorOutbox, type MirrorParams } from './mirror.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-mirror-delivery-')), file = join(dir, 'connector.sqlite');
  const db = new DatabaseSync(file), outbox = new MirrorOutbox(db);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {});
  const store = new DeckStore(), tasks: Promise<unknown>[] = [], calls: Array<{ route: unknown; text: string }> = [];
  store.addMessage({ id: 'reply-one', sessionKey: 'synthetic', role: 'assistant', text: 'original reply', createdAt: 1 });
  const params: MirrorParams = { actorId: 'original-actor', sessionKey: 'synthetic', after: 1, inputText: 'original input', idempotencyKey: 'one',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original' } };
  const deps = { store, authorizeTarget: () => true, normalizeError: (error: unknown) => error instanceof Error ? error.message : String(error),
    sendOutbound: async (route: unknown, text: string) => { calls.push({ route, text }); } };
  const launch = (dispatcher = createMirrorDispatcher(outbox, deps), input = params) => {
    outbox.upsert(input);
    if (!outbox.get(input.idempotencyKey)?.nativeReply && outbox.get(input.idempotencyKey)?.deliveryState === 'pending') {
      db.exec('BEGIN IMMEDIATE');
      try { outbox.recordCliReplyInTransaction(db, input, 'original reply'); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    const result = dispatcher.mirrorAssistantReplyToChannel(input).then(() => ({ ok: true }), error => ({ ok: false, error }));
    tasks.push(result); return result;
  };
  const advance = async () => { await tick(); t.mock.timers.tick(3000); await tick(); };
  const read = () => {
    const [first, ...rest] = outbox.list();
    assert.ok(first);
    return [first, ...rest] as [typeof first, ...typeof rest];
  };
  t.after(async () => {
    t.mock.timers.tick(500_000); await tick(); await Promise.all(tasks);
    t.mock.timers.reset(); db.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { file, db, outbox, params, deps, calls, store, launch, advance, read };
}

test('polling adopts the original deadline when completion precedes final after polling starts', async context => {
  const setup = fixture(context);
  setup.outbox.upsert(setup.params);
  const executions = new OpenClawExecutions(setup.db, undefined, undefined, undefined, undefined, undefined, setup.outbox);
  executions.begin('synthetic', 'one');
  executions.bindGatewayConnection('synthetic', 'one', 'socket');
  executions.acknowledge('synthetic', 'one', 'run');
  const dispatcher = createMirrorDispatcher(setup.outbox, setup.deps);
  context.after(() => dispatcher.close());
  const result = dispatcher.mirrorAssistantReplyToChannel(setup.params).then(() => ({ ok: true }), error => ({ ok: false, error }));
  await setup.advance();
  executions.observe('synthetic', { phase: 'completed', runId: 'run', gatewayConnectionId: 'socket' });
  const deadline = setup.outbox.get('one')?.replyDeadlineAt;
  assert.equal(deadline, 583_000);
  await setup.advance();
  executions.observe('synthetic', { phase: 'completed', runId: 'run', gatewayConnectionId: 'socket',
    replyOnly: true, reply: { text: 'original answer', sequence: 9 } });
  await setup.advance();
  assert.deepEqual(await result, { ok: true });
  assert.equal(setup.outbox.get('one')?.deliveryState, 'sent');
  assert.equal(setup.outbox.get('one')?.replyDeadlineAt, deadline);
  assert.equal(setup.calls.length, 1);
});

test('mirror persists original delivery identity before send and retains success across reopen', async t => {
  const f = fixture(t);
  const send = f.deps.sendOutbound;
  f.deps.sendOutbound = async (route, text) => {
    const [job] = f.read();
    assert.equal(job.deliveryState, 'outcome_unknown');
    assert.equal(job.selectedMessageId, 'cli:one:assistant');
    assert.equal(job.outputSha256, createHash('sha256').update(text).digest('hex'));
    await send(route, text);
  };
  const done = f.launch(); await f.advance();
  assert.equal(f.read()[0]?.deliveryState, 'sent');
  assert.equal((await done).ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.read()[0].deliveryState, 'sent');
  assert.equal((await f.launch()).ok, true);
  assert.equal(f.calls.length, 1, 'new dispatcher reads retained success without resending');
});

test('mirror ambiguous send is never retried in-loop, by duplicate call or by resume', async t => {
  const f = fixture(t);
  f.deps.sendOutbound = async (route, text) => { f.calls.push({ route, text }); throw new Error('synthetic lost ACK'); };
  const done = f.launch(); await f.advance();
  assert.equal(f.calls.length, 1);
  assert.equal(f.read()[0].deliveryState, 'outcome_unknown');
  assert.equal((await done).ok, false);
  assert.equal((await f.launch()).ok, false);
  createMirrorDispatcher(f.outbox, f.deps).resume(); await f.advance();
  assert.equal(f.calls.length, 1);
});

for (const phase of ['before-send', 'after-send']) test(`mirror save failure at ${phase} never permits another external attempt`, async t => {
  const f = fixture(t), save = MirrorOutbox.prototype.saveJob;
  t.mock.method(MirrorOutbox.prototype, 'saveJob', function (this: MirrorOutbox, next: Parameters<typeof save>[0]) {
    if ((next as any).deliveryState === (phase === 'before-send' ? 'outcome_unknown' : 'sent')) throw new Error('synthetic persistence failure');
    return save.call(this, next);
  });
  const done = f.launch(); await f.advance();
  assert.equal((await done).ok, false);
  assert.equal(f.calls.length, phase === 'before-send' ? 0 : 1);
  assert.equal(f.read()[0].deliveryState, phase === 'before-send' ? 'pending' : 'outcome_unknown');
  if (phase === 'after-send') {
    assert.equal((await f.launch()).ok, false); await f.advance(); assert.equal(f.calls.length, 1);
  }
});

test('mirror late presentation error cannot erase durable success or cause redelivery', async t => {
  const f = fixture(t), append = f.store.append.bind(f.store);
  t.mock.method(f.store, 'append', ((...args: Parameters<typeof append>) => {
    if (args[0] === 'queued_message.sent') throw new Error('synthetic projection failure');
    return append(...args);
  }) as typeof f.store.append);
  const done = f.launch(); await f.advance();
  assert.equal(f.read()[0]?.deliveryState, 'sent');
  assert.equal((await done).ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.read()[0].deliveryState, 'sent');
  assert.equal((await f.launch()).ok, true); assert.equal(f.calls.length, 1);
});

test('mirror old records have no evidence allowing resume or fresh-key replacement', async t => {
  const f = fixture(t);
  const { actorId: _actor, ...legacy } = f.params;
  const original = JSON.stringify({ jobs: [{ ...legacy, attempts: 0, createdAt: 1 }] });
  const file = `${f.file}.legacy.json`;
  writeFileSync(file, original);
  f.outbox.importLegacy(file);
  assert.throws(() => f.launch(), /conflict/i);
  createMirrorDispatcher(f.outbox, f.deps).resume(); await f.advance();
  assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('mirror concurrent duplicate shares original promise and distinct targets remain independent', async t => {
  const f = fixture(t), dispatcher = createMirrorDispatcher(f.outbox, f.deps);
  const one = f.launch(dispatcher), duplicate = f.launch(dispatcher);
  const other = f.launch(dispatcher, { ...f.params, idempotencyKey: 'two', explicitRoute: { ...f.params.explicitRoute, outboundTarget: 'second' } });
  await f.advance();
  assert.equal((await one).ok, true); assert.equal((await duplicate).ok, true); assert.equal((await other).ok, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.read().map((job: any) => [job.idempotencyKey, job.explicitRoute.outboundTarget, job.deliveryState]),
    [['one', 'original', 'sent'], ['two', 'second', 'sent']]);
});

test('mirror stale pending snapshot in another dispatcher cannot select the same send twice', async t => {
  const f = fixture(t);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const send = f.deps.sendOutbound;
  f.deps.sendOutbound = async (route, text) => { await send(route, text); await pending; };
  t.after(() => release());
  const first = f.launch(), second = f.launch();
  try {
    await f.advance();
    assert.equal(f.calls.length, 1);
    assert.equal((await second).ok, false);
  } finally { release(); }
  assert.equal((await first).ok, true);
  assert.equal(f.read()[0].deliveryState, 'sent');
});

test('mirror progress cannot clear or alter selected output, manufacture success or delete evidence', async t => {
  const f = fixture(t), outbox = new MirrorOutbox(f.db), original = outbox.upsert(f.params);
  const selected = { ...original, deliveryState: 'outcome_unknown' as const, selectedMessageId: 'reply-one', outputSha256: 'a'.repeat(64), attemptedAt: 100_000 };
  assert.throws(() => outbox.saveJob({ ...selected, deliveryState: 'sent', mirroredMessageIds: ['reply-one'], lastMirroredAt: 100_001 }), /conflict/);
  outbox.saveJob(selected);
  const bytes = JSON.stringify(f.read());
  for (const changed of [original, selected, { ...selected, selectedMessageId: 'other' }, { ...selected, outputSha256: 'b'.repeat(64) },
    { ...selected, deliveryState: 'sent' as const, mirroredMessageIds: ['other'], lastMirroredAt: 100_001 }]) {
    assert.throws(() => outbox.saveJob(changed));
    assert.equal(JSON.stringify(f.read()), bytes);
  }
  assert.throws(() => outbox.remove(f.params.idempotencyKey), /cannot be removed/);
  outbox.saveJob({ ...selected, deliveryState: 'sent', mirroredMessageIds: ['reply-one'], lastMirroredAt: 100_001 });
  assert.throws(() => outbox.saveJob(selected));
  assert.throws(() => outbox.remove(f.params.idempotencyKey), /cannot be removed/);
});

for (const checkpoint of ['selected', 'sending', 'saved'] as const) test(`mirror process exit at ${checkpoint} preserves evidence and never resends on reopen`, async t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', `
    import { mock } from 'node:test';
    import { appendFileSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { DeckStore } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? '../projection/deck-store.ts' : '../projection/deck-store.js', import.meta.url).href)};
    import { createMirrorDispatcher, MirrorOutbox } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './mirror.ts' : './mirror.js', import.meta.url).href)};
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const checkpoint = ${JSON.stringify(checkpoint)};
    const file = ${JSON.stringify(f.file)}, params = ${JSON.stringify(f.params)};
    const save = MirrorOutbox.prototype.saveJob;
    MirrorOutbox.prototype.saveJob = function(job) {
      save.call(this, job);
      if (checkpoint === 'selected' && job.deliveryState === 'outcome_unknown') process.exit(73);
      if (checkpoint === 'saved' && job.deliveryState === 'sent') process.exit(73);
    };
    const store = new DeckStore();
    store.addMessage({ id: 'reply-one', sessionKey: params.sessionKey, role: 'assistant', text: 'original reply', createdAt: 1 });
    const db = new DatabaseSync(file), outbox = new MirrorOutbox(db);
    outbox.upsert(params);
    db.exec('BEGIN IMMEDIATE'); outbox.recordCliReplyInTransaction(db, params, 'original reply'); db.exec('COMMIT');
    const task = createMirrorDispatcher(outbox, { store, authorizeTarget: () => true, normalizeError: String,
      sendOutbound: async () => {
        appendFileSync(file + '.synthetic-send', 'attempt\\n');
        if (checkpoint === 'sending') process.exit(73);
      }
    }).mirrorAssistantReplyToChannel(params);
    await new Promise(resolve => setImmediate(resolve));
    mock.timers.tick(3000);
    await task;
    process.exit(74);
  `], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', HOME: tmpdir(), NODE_ENV: 'test' } });
  assert.equal(child.status, 73, child.stderr);
  assert.equal(child.error, undefined);
  assert.equal(f.read()[0].deliveryState, checkpoint === 'saved' ? 'sent' : 'outcome_unknown');
  if (checkpoint === 'selected') assert.throws(() => readFileSync(`${f.file}.synthetic-send`), { code: 'ENOENT' });
  else assert.equal(readFileSync(`${f.file}.synthetic-send`, 'utf8'), 'attempt\n');
  const original = JSON.stringify(f.read());
  const result = await f.launch();
  assert.equal(result.ok, checkpoint === 'saved');
  if ('error' in result) assert.ok(result.error instanceof MirrorDeliveryUnknown);
  createMirrorDispatcher(f.outbox, f.deps).resume(); await f.advance();
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(f.read()), original);
});

test('mirror disabled gate makes no history or external calls and retains blocked record', async t => {
  const f = fixture(t);
  const history = t.mock.method(f.store, 'getMessages', () => { assert.fail('history must not supply native reply'); });
  assert.equal((await f.launch(createMirrorDispatcher(f.outbox, { ...f.deps, localOpenClawCli: false }))).ok, false);
  assert.equal(history.mock.callCount(), 0); assert.equal(f.calls.length, 0);
  assert.equal(f.read()[0].deliveryState, 'blocked');
});

test('mirror can retry native evidence reads before selecting an external send', async t => {
  const f = fixture(t);
  let polls = 0;
  const done = f.launch(), get = f.outbox.get.bind(f.outbox);
  t.mock.method(f.outbox, 'get', (id: string) => { if (++polls === 1) throw new Error('synthetic evidence unavailable'); return get(id); });
  await f.advance();
  assert.equal(f.calls.length, 0);
  assert.equal(f.read()[0].deliveryState, 'pending'); assert.equal(f.read()[0].attempts, 1);
  await f.advance();
  assert.equal((await done).ok, true); assert.equal(f.calls.length, 1);
});

test('mirror dispatcher cannot manufacture admission or recreate a cancelled intent', async context => {
  const setup = fixture(context), dispatcher = createMirrorDispatcher(setup.outbox, setup.deps);
  assert.throws(() => dispatcher.mirrorAssistantReplyToChannel(setup.params), /admission required/);
  setup.outbox.upsert(setup.params);
  setup.outbox.remove(setup.params.idempotencyKey);
  assert.throws(() => dispatcher.mirrorAssistantReplyToChannel(setup.params), /admission required/);
  await setup.advance();
  assert.deepEqual(setup.outbox.list(), []);
  assert.equal(setup.calls.length, 0);
  await dispatcher.close();
});

test('mirror pause aborts polling but resumes the original pending intent without a new dispatcher', async context => {
  const setup = fixture(context), dispatcher = createMirrorDispatcher(setup.outbox, setup.deps);
  const task = setup.launch(dispatcher);
  const pause = dispatcher.pauseAdmissions();
  assert.equal(dispatcher.pauseAdmissions(), pause);
  assert.equal(pause.resume(), false);
  await pause.drained;
  assert.equal((await task).ok, false);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'pending');
  await assert.rejects(dispatcher.reconcileSession('synthetic'), MirrorDispatcherClosed);
  await dispatcher.resume();
  assert.equal(setup.calls.length, 0);
  assert.equal(pause.resume(), true);
  const newer = dispatcher.pauseAdmissions();
  assert.equal(pause.resume(), false);
  await newer.drained;
  assert.equal(newer.resume(), true);
  await dispatcher.reconcileSession('synthetic');
  assert.equal(setup.calls.length, 1);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'sent');
  const last = dispatcher.pauseAdmissions();
  await last.drained;
  await dispatcher.close();
  assert.equal(last.resume(), false);
  await assert.rejects(dispatcher.mirrorAssistantReplyToChannel(setup.params), MirrorDispatcherClosed);
});

for (const lostAcknowledgement of [false, true]) test(`mirror pause owns selected send and final settlement, lost acknowledgement=${lostAcknowledgement}`, async context => {
  const setup = fixture(context);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const send = setup.deps.sendOutbound;
  const dispatcher = createMirrorDispatcher(setup.outbox, { ...setup.deps, sendOutbound: async (route, text) => {
    await send(route, text);
    await held;
    if (lostAcknowledgement) throw new Error('synthetic lost acknowledgement');
  } });
  const task = setup.launch(dispatcher);
  await setup.advance();
  assert.equal(setup.calls.length, 1);
  const pause = dispatcher.pauseAdmissions();
  let drained = false;
  void pause.drained.then(() => { drained = true; });
  try {
    await tick();
    assert.equal(drained, false);
    assert.equal(pause.resume(), false);
    assert.equal(setup.outbox.get('one')?.deliveryState, 'outcome_unknown');
  } finally { release(); }
  await task; await pause.drained;
  assert.equal(setup.outbox.get('one')?.deliveryState, lostAcknowledgement ? 'outcome_unknown' : 'sent');
  assert.equal(pause.resume(), true);
  await dispatcher.reconcileSession('synthetic');
  if (lostAcknowledgement) await assert.rejects(dispatcher.mirrorAssistantReplyToChannel(setup.params), MirrorDeliveryUnknown);
  else await dispatcher.mirrorAssistantReplyToChannel(setup.params);
  assert.equal(setup.calls.length, 1);
  await dispatcher.close();
});

test('mirror pause is installed before synchronous abort listeners can reenter admission', async context => {
  const setup = fixture(context), dispatcher = createMirrorDispatcher(setup.outbox, setup.deps);
  const task = setup.launch(dispatcher);
  let nestedPause: ReturnType<typeof dispatcher.pauseAdmissions> | undefined;
  let rejected: Promise<void> | undefined;
  const originalAbort = AbortController.prototype.abort;
  context.mock.method(AbortController.prototype, 'abort', function(this: AbortController, reason?: unknown) {
    this.signal.addEventListener('abort', () => {
      nestedPause = dispatcher.pauseAdmissions();
      rejected = assert.rejects(dispatcher.mirrorAssistantReplyToChannel(setup.params), MirrorDispatcherClosed);
    }, { once: true });
    return originalAbort.call(this, reason);
  });
  const pause = dispatcher.pauseAdmissions();
  assert.equal(nestedPause, pause);
  await rejected; await pause.drained; await task;
  assert.equal(setup.calls.length, 0);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'pending');
  await dispatcher.close();
});

test('mirror close cancels polling and fences new work without consuming pending evidence', async context => {
  const setup = fixture(context), dispatcher = createMirrorDispatcher(setup.outbox, setup.deps);
  const task = setup.launch(dispatcher);
  await tick();
  const closing = dispatcher.close();
  assert.equal(dispatcher.close(), closing);
  await closing;
  const result = await task;
  assert.equal(result.ok, false);
  if ('error' in result) assert.ok(result.error instanceof MirrorDispatcherClosed);
  dispatcher.resume();
  await assert.rejects(dispatcher.mirrorAssistantReplyToChannel(setup.params), MirrorDispatcherClosed);
  await setup.advance();
  assert.equal(setup.outbox.get('one')?.deliveryState, 'pending');
  assert.equal(setup.calls.length, 0);
});

test('mirror close waits for in-flight send before releasing its owner', async context => {
  const setup = fixture(context);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const send = setup.deps.sendOutbound;
  setup.deps.sendOutbound = async (route, text) => { await send(route, text); await held; };
  const dispatcher = createMirrorDispatcher(setup.outbox, setup.deps);
  const task = setup.launch(dispatcher);
  await setup.advance();
  let closed = false;
  const closing = dispatcher.close().then(() => { closed = true; });
  try {
    await tick();
    assert.equal(closed, false);
    assert.equal(setup.outbox.get('one')?.deliveryState, 'outcome_unknown');
  } finally { release(); }
  await closing;
  await task;
  assert.equal(setup.calls.length, 1);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'sent');
});

for (const policy of ['absent', 'revoked', 'throws', 'closes'] as const) test(`mirror ${policy} target policy prevents external side effects`, async context => {
  const setup = fixture(context);
  let allowed = true;
  const { authorizeTarget: _policy, ...deps } = setup.deps;
  const dispatcher = createMirrorDispatcher(setup.outbox, { ...deps, ...(policy === 'absent' ? {} : {
    authorizeTarget: () => {
      if (policy === 'throws') throw new Error('synthetic revoked policy');
      if (policy === 'closes') dispatcher.stopAdmissions();
      return allowed;
    },
  }) });
  const sending = setup.launch(dispatcher);
  if (policy === 'revoked') allowed = false;
  await setup.advance();
  assert.equal((await sending).ok, false);
  assert.equal(setup.calls.length, 0);
  assert.equal(setup.outbox.get('one')?.deliveryState, policy === 'closes' ? 'pending' : 'blocked');
  await dispatcher.close();
});

test('mirror policy failure is durably quarantined without leaking provider details or retrying after recovery', async context => {
  const setup = fixture(context);
  const failures: unknown[] = [];
  let checks = 0;
  context.mock.method(console, 'warn', (...args: unknown[]) => { failures.push(args); });
  const dispatcher = createMirrorDispatcher(setup.outbox, { ...setup.deps, authorizeTarget: () => {
    checks += 1;
    throw new Error('synthetic-private-provider-detail');
  } });
  const sending = setup.launch(dispatcher);
  await setup.advance();
  const result = await sending;
  assert.equal(result.ok, false);
  const stored = setup.outbox.get('one')!;
  assert.equal(stored.deliveryState, 'blocked');
  assert.equal(stored.lastError, 'Mirror original target authorization unavailable; intent retained, not retried');
  assert.equal(stored.nativeReply?.text, 'original reply');
  assert.equal(stored.attemptedAt, undefined);
  assert.equal(JSON.stringify(failures).includes('synthetic-private-provider-detail'), false);
  assert.deepEqual(setup.outbox.recoveryPage('', 16), []);
  await dispatcher.reconcileSession(setup.params.sessionKey);
  await dispatcher.close();
  const recovered = createMirrorDispatcher(new MirrorOutbox(setup.db), setup.deps);
  await recovered.resume();
  assert.equal((await setup.launch(recovered)).ok, false);
  assert.equal(checks, 1);
  assert.equal(setup.calls.length, 0);
  await recovered.close();
});
