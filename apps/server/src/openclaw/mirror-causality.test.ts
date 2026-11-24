import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';
import { createMirrorDispatcher, type MirrorParams } from '../messages/mirror.js';
import { createOpenClawDispatch } from './dispatch.js';
import { parseOpenClawCliReply, startOpenClawAgentFallback } from './cli.js';

type Complete = NonNullable<Parameters<typeof startOpenClawAgentFallback>[5]>;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(context: TestContext) {
  const db = new ConnectorUserStore(':memory:'), store = new DeckStore();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  context.mock.method(console, 'log', () => {});
  context.mock.method(console, 'warn', () => {});
  const callbacks = new Map<string, Complete>(), calls: string[] = [];
  const params: MirrorParams = { actorId: 'writer', sessionKey: 'synthetic', after: 1, inputText: 'original input', idempotencyKey: 'one',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original' } };
  const dispatch = createOpenClawDispatch({ store, executions: db.openClawExecutions, mirrorOutbox: db.mirrorOutbox,
    allowCliFallback: true, authorizeTurn: () => true, message: text => text,
    gateway: { requestBound: async () => { throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write'); } } as any,
    startCli: async (_session, _agent, _display, _message, id, complete) => { assert.ok(complete); callbacks.set(id, complete); return { ok: true }; },
  });
  const mirror = createMirrorDispatcher(db.mirrorOutbox, { store, normalizeError: String, authorizeTarget: () => true,
    sendOutbound: async (_route, text) => { calls.push(text); } });
  context.after(async () => { await mirror.close(); await dispatch.close(); db.close(); context.mock.timers.reset(); });
  const begin = async (id = 'one') => {
    const request = { ...params, idempotencyKey: id };
    db.mirrorOutbox.upsert(request);
    assert.equal(db.openClawExecutions.begin(params.sessionKey, id), true);
    await dispatch({ id, sessionKey: params.sessionKey, createdAt: params.after, state: 'dispatching', payload: {
      actorId: params.actorId, message: params.inputText, deliveryMode: 'mirror', media: [], explicitRoute: params.explicitRoute,
    } }, []);
    return request;
  };
  const complete = async (id: string, result: Parameters<Complete>[0]) => { const callback = callbacks.get(id); assert.ok(callback); await callback(result); };
  const advance = async () => { await tick(); context.mock.timers.tick(3000); await tick(); };
  return { db, store, params, calls, dispatch, mirror, begin, complete, advance };
}

test('mirror uses original CLI stdout evidence, never later transcript or projection text', async context => {
  const setup = fixture(context);
  await setup.begin();
  await setup.complete('one', { ok: true, text: 'display-only text', replyText: 'original final', messages: [
    { id: 'later', sessionKey: 'synthetic', role: 'assistant', text: 'another run secret', createdAt: 99_999 },
  ] });
  assert.deepEqual(setup.db.mirrorOutbox.get('one')?.nativeReply, { source: 'cli', commandId: 'one', text: 'original final' });
  const sending = setup.mirror.mirrorAssistantReplyToChannel(setup.params);
  await setup.advance(); await sending;
  assert.deepEqual(setup.calls, ['Input:\noriginal input\n\nOutput:\noriginal final']);
  assert.equal(setup.db.mirrorOutbox.get('one')?.selectedMessageId, 'cli:one:assistant');
});

test('mirror does not infer Gateway reply from history, turnId, timestamps or current execution', async context => {
  const setup = fixture(context);
  setup.db.mirrorOutbox.upsert(setup.params);
  setup.db.openClawExecutions.begin('synthetic', 'one');
  setup.db.openClawExecutions.acknowledge('synthetic', 'one', 'native-run');
  setup.store.addMessage({ id: 'looks-correlated', sessionKey: 'synthetic', turnId: 'native-run', role: 'assistant', text: 'unproven reply', createdAt: 1 });
  const sending = setup.mirror.mirrorAssistantReplyToChannel(setup.params).catch(() => {});
  await setup.advance();
  assert.deepEqual(setup.calls, []);
  assert.equal(setup.db.mirrorOutbox.get('one')?.deliveryState, 'pending');
  await setup.mirror.close(); await sending;
});

test('CLI completion and reply evidence roll back together if outbox persistence fails', async context => {
  const setup = fixture(context);
  await setup.begin();
  const original = setup.db.openClawExecutions.get('synthetic');
  context.mock.method(setup.db.mirrorOutbox, 'recordCliReplyInTransaction', () => { throw new Error('synthetic storage failure'); });
  await setup.complete('one', { ok: true, text: 'final', replyText: 'final', messages: [] });
  assert.deepEqual(setup.db.openClawExecutions.get('synthetic'), original);
  assert.equal(setup.db.mirrorOutbox.get('one')?.nativeReply, undefined);
  assert.deepEqual(setup.calls, []);
});

test('late CLI callback cannot bind its output into another command', async context => {
  const setup = fixture(context);
  await setup.begin();
  await setup.complete('one', { ok: true, text: 'one', replyText: 'one', messages: [] });
  const original = setup.db.mirrorOutbox.get('one');
  await setup.begin('two');
  await setup.complete('one', { ok: true, text: 'late', replyText: 'late', messages: [] });
  assert.deepEqual(setup.db.mirrorOutbox.get('one'), original);
  assert.equal(setup.db.mirrorOutbox.get('two')?.nativeReply, undefined);
  await setup.complete('two', { ok: true, text: 'two', replyText: 'two', messages: [] });
  assert.equal(setup.db.mirrorOutbox.get('two')?.nativeReply?.text, 'two');
});

for (const boundary of ['restart', 'terminal-conflict'] as const) {
  test(`CLI ${boundary} cannot attach new mirror reply evidence`, async context => {
    const setup = fixture(context);
    await setup.begin();
    if (boundary === 'restart') setup.db.openClawExecutions.recoverInterrupted();
    else await setup.complete('one', { ok: false, error: 'original failure' });
    await setup.complete('one', { ok: true, text: 'late reply', replyText: 'late reply', messages: [] });
    assert.equal(setup.db.mirrorOutbox.get('one')?.nativeReply, undefined);
    assert.equal(setup.db.openClawExecutions.get('synthetic')?.reason, boundary === 'restart' ? 'restarted' : 'terminal_conflict');
    const sending = setup.mirror.mirrorAssistantReplyToChannel(setup.params).catch(() => {});
    await setup.advance(); assert.deepEqual(setup.calls, []);
    await setup.mirror.close(); await sending;
  });
}

for (const replyText of ['', 'NO_REPLY', '{"type":"thinking","text":"private reasoning"}']) {
  test(`non-forwardable original CLI output ${JSON.stringify(replyText)} never selects later history`, async context => {
    const setup = fixture(context);
    await setup.begin();
    await setup.complete('one', { ok: true, text: 'display fallback', replyText, messages: [
      { id: 'later', sessionKey: 'synthetic', role: 'assistant', text: 'later private reply', createdAt: 99_999 },
    ] });
    const sending = setup.mirror.mirrorAssistantReplyToChannel(setup.params).then(() => assert.fail('empty reply cannot be sent'), error => error);
    await setup.advance();
    assert.match(String(await sending), /no forwardable text/);
    assert.deepEqual(setup.calls, []);
    const intent = setup.db.mirrorOutbox.get('one');
    assert.equal(intent?.deliveryState, 'no_output');
    assert.equal(intent?.nativeReply?.text, replyText);
    assert.equal(intent?.selectedMessageId, undefined);
  });
}

test('unstructured successful CLI completion durably blocks mirror in the original completion transaction', async context => {
  const setup = fixture(context);
  await setup.begin();
  await setup.complete('one', { ok: true, text: 'display only', messages: [] });
  assert.equal(setup.db.openClawExecutions.get('synthetic')?.phase, 'completed');
  assert.equal(setup.db.mirrorOutbox.get('one')?.deliveryState, 'blocked');
  assert.equal(setup.db.mirrorOutbox.get('one')?.nativeReply, undefined);
  assert.deepEqual(setup.db.mirrorOutbox.recoveryPage('', 16), []);
  await assert.rejects(setup.mirror.mirrorAssistantReplyToChannel(setup.params), /structured reply/);
  assert.deepEqual(setup.calls, []);
});

for (const boundary of ['failed', 'restarted'] as const) test(`CLI ${boundary} mirror stops holding a recoverable intent`, async context => {
  const setup = fixture(context);
  await setup.begin();
  if (boundary === 'failed') await setup.complete('one', { ok: false, error: 'synthetic failure' });
  else setup.db.openClawExecutions.recoverInterrupted();
  assert.equal(setup.db.mirrorOutbox.get('one')?.deliveryState, 'blocked');
  assert.equal(setup.db.mirrorOutbox.get('one')?.nativeReply, undefined);
  await setup.mirror.reconcileSession('synthetic');
  assert.deepEqual(setup.calls, []);
});

for (const result of [{ ok: true as const, text: 'diagnostic, not a reply', messages: [] }, { ok: false as const, error: 'native failure' }]) {
  test(`CLI ${result.ok ? 'unproven stdout' : 'failure'} never produces mirror evidence`, async context => {
    const setup = fixture(context);
    await setup.begin(); await setup.complete('one', result);
    assert.equal(setup.db.mirrorOutbox.get('one')?.nativeReply, undefined);
    const sending = setup.mirror.mirrorAssistantReplyToChannel(setup.params).catch(() => {});
    await setup.advance(); assert.deepEqual(setup.calls, []);
    await setup.mirror.close(); await sending;
  });
}

test('CLI mirror parsing accepts only structured successful output and preserves explicit empty final', () => {
  assert.equal(parseOpenClawCliReply(JSON.stringify({ status: 'ok', result: { meta: { finalAssistantVisibleText: ' original ' } } })), 'original');
  assert.equal(parseOpenClawCliReply(JSON.stringify({ result: { payloads: [{ text: 'first' }, { text: 'second' }] } })), 'first\n\nsecond');
  assert.equal(parseOpenClawCliReply(JSON.stringify({ result: { meta: { finalAssistantVisibleText: '' }, payloads: [{ text: 'not final' }] } })), '');
  for (const output of ['diagnostic', '{}', 'null', '{"result":{}}', 'log\n{"result":{"payloads":[{"text":"secret"}]}}',
    '{"status":"error","result":{"payloads":[{"text":"secret"}]}}', '{"result":{"payloads":[{"text":3}]}}']) {
    assert.equal(parseOpenClawCliReply(output), undefined);
  }
});

test('inert CLI child stdout reaches the original completion as structured reply evidence', { timeout: 10_000 }, async context => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-cli-reply-'));
  const nativeSpawn = childProcess.spawn;
  let child: ChildProcess | undefined, lifetime: Promise<void> | undefined;
  let completion: Parameters<Complete>[0] | undefined;
  context.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await lifetime;
    context.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  });
  context.mock.method(childProcess, 'spawn', (command: string, args: string[]) => {
    assert.equal(command, 'openclaw');
    assert.equal(args[0], 'agent');
    assert.ok(args.includes('--json'));
    child = nativeSpawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({status:"ok",result:{payloads:[{text:"original child reply"}]}}))'],
      { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: directory } });
    return child;
  });
  context.mock.method(fsPromises, 'opendir', async () => ({ async *[Symbol.asyncIterator]() {} }));
  syncBuiltinESMExports();
  assert.deepEqual(await startOpenClawAgentFallback('synthetic', 'synthetic', 'synthetic', 'inert input', 'original-command',
    result => { completion = result; }, pending => { lifetime = pending; }), { ok: true });
  await lifetime;
  assert.ok(completion?.ok);
  assert.equal(completion.replyText, 'original child reply');
  assert.deepEqual(completion.messages, []);
});

for (const stream of ['stdout', 'stderr'] as const) {
  test(`real CLI ${stream} overflow durably blocks only the original mirror without retry`, { timeout: 10_000 }, async context => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-cli-budget-mirror-'));
    const file = join(directory, 'connector.sqlite');
    const nativeSpawn = childProcess.spawn;
    const db = new ConnectorUserStore(file), store = new DeckStore();
    const params: MirrorParams = { actorId: 'writer', sessionKey: 'synthetic', after: Date.now(), inputText: 'original',
      idempotencyKey: 'original', explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original' } };
    let child: ChildProcess | undefined, spawns = 0, sends = 0;
    const dispatch = createOpenClawDispatch({ store, executions: db.openClawExecutions, mirrorOutbox: db.mirrorOutbox,
      allowCliFallback: true, authorizeTurn: () => true, message: text => text,
      gateway: { requestBound: async () => { throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write'); } } as any });
    const mirror = createMirrorDispatcher(db.mirrorOutbox, { store, normalizeError: String, authorizeTarget: () => true,
      sendOutbound: async () => { sends++; } });
    context.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await dispatch.close(); await mirror.close(); db.close();
      context.mock.restoreAll(); syncBuiltinESMExports();
      rmSync(directory, { recursive: true, force: true });
    });
    context.mock.method(childProcess, 'spawn', (command: string, args: string[]) => {
      assert.equal(command, 'openclaw'); assert.equal(args[0], 'agent'); spawns++;
      child = nativeSpawn(process.execPath, ['-e', `
        process.stdout.write(JSON.stringify({ result: { payloads: [{ text: 'do not forward truncated reply' }] } }));
        process[${JSON.stringify(stream)}].write(Buffer.alloc(${stream === 'stdout' ? 1024 * 1024 + 1 : 64 * 1024 + 1}, 32));
        process.stderr.write('synthetic-private-diagnostic');
      `], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: directory } });
      return child;
    });
    context.mock.method(fsPromises, 'opendir', async () => { assert.fail('overflow must not consult unrelated transcript'); });
    syncBuiltinESMExports();
    db.mirrorOutbox.upsert(params);
    assert.equal(db.openClawExecutions.begin(params.sessionKey, params.idempotencyKey), true);
    await dispatch({ id: params.idempotencyKey, sessionKey: params.sessionKey, createdAt: params.after, state: 'dispatching', payload: {
      actorId: params.actorId, message: params.inputText, media: [], deliveryMode: 'mirror', explicitRoute: params.explicitRoute,
    } }, []);
    await dispatch.close();
    assert.equal(db.openClawExecutions.get(params.sessionKey)?.phase, 'failed');
    const original = db.mirrorOutbox.get(params.idempotencyKey);
    assert.equal(original?.deliveryState, 'blocked');
    assert.equal(original?.nativeReply, undefined);
    assert.equal(original?.attemptedAt, undefined);
    assert.equal(JSON.stringify(original).includes('synthetic-private-diagnostic'), false);
    await mirror.reconcileSession(params.sessionKey);
    assert.equal(spawns, 1); assert.equal(sends, 0);
    const reopened = new ConnectorUserStore(file);
    try {
      assert.deepEqual(reopened.mirrorOutbox.get(params.idempotencyKey), original);
      assert.deepEqual(reopened.mirrorOutbox.recoveryPage('', 16), []);
    } finally { reopened.close(); }
  });
}
