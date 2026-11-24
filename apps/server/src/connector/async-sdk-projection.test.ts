import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createConnectorOwnerCommands, CONNECTOR_PENDING_LIMIT, CONNECTOR_PENDING_INPUT_BYTES } from './connector-owner-domain.js';
import { AsyncSdkProjection } from './async-sdk-projection.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import { AsyncSdkMessages } from './async-sdk-messages.js';
import { validConnectorSdkTranscriptInput } from './connector-sdk-transcript-domain.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { projectClaudeToolDetails } from '../claude/tool-details.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import type { SdkDispatchAdapter } from './sdk-dispatch.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const token = 'isolated-projection-test', authorization = `Bearer ${token}`;
const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const rows = (text = 'original reply', uuid = 'native-message') => projectClaudeMessage({ type: 'assistant', uuid,
  session_id: 'native', parent_tool_use_id: null, message: { role: 'assistant', content: text } }, 'native');
const row = (text = 'original reply', nativeEventId = 'native-event') => ({ nativeEventId, role: 'assistant' as const,
  messageId: nativeEventId, text, truncated: false, createdAt: 10 });
const refFor = (runtime: SdkAgentId): SdkCompactRef => ({ key: `${runtime}:original`, id: 'execution', epoch: 'epoch', nativeSessionId: 'native' });
function fixture(runtime: SdkAgentId) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-projection-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal;
  const ref = refFor(runtime);
  journal.create({ key: ref.key, nativeSessionId: ref.nativeSessionId, title: 'Original', createdAt: 0 });
  store.turns.enqueue(runtime, { id: 'first', sessionKey: ref.key, createdAt: 0, payload: {} });
  assert.ok(journal.begin(ref, ['first'], store.turns));
  const owner = { command: createConnectorOwnerCommands(store, tokens) };
  const projection = new AsyncSdkProjection({ owner, runtime, diagnostics: silence });
  const append = () => runtime === 'claude-code' ? { runtime, ref, rows: rows() } : { runtime, ref, row: row(), submittedText: 'input' };
  return { store, journal, ref, owner, projection, append,
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: fixed transcript domain rejects caller authority, stale four-tuple and nonwritable phases`, async () => {
    const f = fixture(runtime);
    try {
      assert.equal(validConnectorSdkTranscriptInput('sdkTranscriptAppend', f.append()), true);
      for (const field of ['actorId', 'authorized', 'sql', 'method', 'options']) {
        assert.equal(validConnectorSdkTranscriptInput('sdkTranscriptAppend', { ...f.append(), [field]: true }), false);
      }
      for (const field of ['key', 'id', 'epoch', 'nativeSessionId'] as const) {
        const ref = { ...f.ref, [field]: field === 'key' ? `${runtime}:other` : 'other' };
        assert.equal((await f.owner.command('sdkTranscriptAppend', { ...f.append(), ref })).applied, false);
      }
      assert.equal((await f.owner.command('sdkTranscriptAppend', f.append())).applied, true);
      assert.equal((await f.owner.command('sdkTranscriptAppend', f.append())).applied, true); // Original dedup.
      assert.equal(f.journal.observeTerminal(f.ref, 'completed', f.store.turns), true);
      assert.equal((await f.owner.command('sdkTranscriptAppend', f.append())).applied, true); // Settling accepts final callbacks.
      assert.equal(f.journal.confirmSettled(f.ref), true);
      assert.equal((await f.owner.command('sdkTranscriptAppend', f.append())).applied, false);
      assert.equal((await f.owner.command('sdkTranscriptEnd', { runtime, ref: f.ref })).applied, true);
    } finally { f.close(); }
  });

  test(`${runtime}: original stream, final and duplicate metrics keep durable history and valid barrier`, async () => {
    const f = fixture(runtime);
    try {
      if (runtime === 'claude-code') {
        const callbacks = f.projection.claude(f.ref);
        callbacks.stream({ messageId: 'native-message', parentToolUseId: null, blocks: [{ blockIndex: 0, text: 'partial', truncated: false }] });
        callbacks.project(rows(), { messageId: 'native-message', blockIndexes: [0] });
        callbacks.metrics({ eventId: 'usage', sequence: 2, context: { used: 10, basis: 'native-context' } });
        callbacks.metrics({ eventId: 'usage', sequence: 2, context: { used: 10, basis: 'native-context' } });
      } else {
        const callbacks = f.projection.copilot(f.ref, 'input');
        callbacks.stream({ messageId: 'native-event', text: 'partial', truncated: false });
        callbacks.project(row());
        callbacks.metrics({ eventId: 'usage', sequence: 2, context: { used: 10, basis: 'native-context' } });
        callbacks.metrics({ eventId: 'older', sequence: 1, context: { used: 9, basis: 'native-context' } });
      }
      assert.equal(await f.projection.flush(f.ref), true);
      assert.equal(f.journal.session(f.ref.key)?.metrics?.sequence, 2);
      const transcript = runtime === 'claude-code' ? f.store.claudeTranscript : f.store.copilotTranscript;
      assert.equal(transcript.page(f.ref.key)?.messages.length, 1);
      assert.equal(await f.projection.release(f.ref), true);
      assert.equal(transcript.liveMessages(f.ref.key).length, 0);
      assert.equal(await f.projection.flush(f.ref), false);
      assert.equal(await f.projection.close(), true);
    } finally { f.close(); }
  });

  test(`${runtime}: original worker callback writes survive reopen and precede terminal/settlement, without repeated effect`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-projection-chain-')), file = join(directory, 'connector.sqlite');
    const owner = new AsyncConnectorOwner({ file, tokenFile: join(directory, 'tokens.json'), bootstrapToken: token,
      sdkModels: { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } } }, silence);
    const projection = new AsyncSdkProjection({ owner, runtime, diagnostics: silence });
    let effects = 0, execution: SdkCompactRef | undefined, work: Promise<unknown> | undefined;
    const adapter: SdkDispatchAdapter = { ready: true, epoch: 'epoch',
      send: async ref => {
        execution = ref; effects++;
        if (runtime === 'claude-code') projection.claude(ref).project(rows());
        else projection.copilot(ref, 'original input').project(row());
        return { nativeRequestId: 'original-native-request' };
      }, interrupt: async () => { throw Error('unexpected interrupt'); },
      inspectSettlement: async ref => ({ ...ref, historyPersisted: true, nativeQuiescent: true }),
    };
    const dispatch = new AsyncSdkDispatch({ owner, runtime, adapter, persistence: projection, deadlineMs: 10_000, diagnostics: silence });
    const messages = new AsyncSdkMessages(owner, (_runtime, key) => { work = dispatch.dispatch(key); });
    let reopened: ConnectorUserStore | undefined;
    try {
      await owner.open();
      const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'allocate', payloadJson: '{}' });
      assert.ok('receipt' in created && created.key);
      const input = { runtime, key: created.key, authorization, commandKey: 'send-original', payloadJson: '{"message":"original input"}' };
      const accepted = await messages.send(input, { timeoutMs: 10_000 });
      assert.ok('receipt' in accepted && accepted.receipt?.state === 'accepted');
      assert.equal(await work, 'accepted'); assert.ok(execution);
      assert.equal(await dispatch.terminal(execution, 'completed'), true);
      assert.equal(await dispatch.settle(execution), true);
      const duplicate = await messages.send(input, { timeoutMs: 10_000 });
      assert.ok('admitted' in duplicate && !duplicate.admitted); assert.equal(effects, 1);
      assert.equal(await projection.close(), true);
      await owner.close(); // Never open a second store beside the worker.
      reopened = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      const transcript = runtime === 'claude-code' ? reopened.claudeTranscript : reopened.copilotTranscript;
      assert.equal(transcript.page(input.key)?.messages.length, 1);
      const journal = runtime === 'claude-code' ? reopened.claudeJournal : reopened.copilotJournal;
      assert.equal(journal.current(input.key)?.phase, 'completed');
      assert.equal(journal.session(input.key)?.nativeState, 'ready');
    } finally {
      await work; await projection.close(); await owner.close(); reopened?.close(); rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('Claude tool details and summaries use the original atomic append and conflict rules', async () => {
  const f = fixture('claude-code');
  try {
    const event = { type: 'assistant', uuid: 'tool-message', session_id: 'native', parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'private-file' } }] } };
    const input = { runtime: 'claude-code' as const, ref: f.ref, rows: projectClaudeMessage(event, 'native'), details: projectClaudeToolDetails(event, 'native') };
    assert.equal((await f.owner.command('sdkTranscriptAppend', input)).applied, true);
    assert.equal((await f.owner.command('sdkTranscriptAppend', input)).applied, true);
    await assert.rejects(f.owner.command('sdkTranscriptAppend', { ...input, details: input.details.map(d => ({ ...d, text: 'changed' })) }));
    assert.match(f.store.claudeTranscript.toolDetail(f.ref.key, { nativeMessageId: 'tool-message', blockIndex: 0, parentToolUseId: null })!.text, /private-file/);
    assert.equal(f.store.claudeTranscript.page(f.ref.key).messages.length, 1);
  } finally { f.close(); }
});

test('callbacks freeze input before return, serialize physical ACKs, and only publish after correlated ACK', async () => {
  const first = deferred<unknown>(), calls: unknown[] = [], changed: string[] = [], ref = refFor('claude-code');
  const owner = { command: (async (kind, input) => {
    calls.push(input);
    if (calls.length === 1) return first.promise;
    return { runtime: 'claude-code', ref, applied: true };
  }) as AsyncConnectorOwner['command'] };
  const projection = new AsyncSdkProjection({ owner, runtime: 'claude-code', changed: key => changed.push(key), diagnostics: silence });
  const callbacks = projection.claude(ref), original = rows();
  callbacks.project(original); original[0]!.text = 'mutated'; callbacks.project(rows('second', 'second'));
  await tick(); assert.equal(calls.length, 1); assert.equal(changed.length, 0);
  assert.equal((calls[0] as { rows: Array<{ text: string }> }).rows[0]!.text, 'original reply');
  let flushed = false; const barrier = projection.flush(ref).then(value => { flushed = true; return value; });
  await tick(); assert.equal(flushed, false); assert.equal(projection.snapshot().pending, 2);
  first.resolve({ runtime: 'claude-code', ref, applied: true });
  assert.equal(await barrier, true); assert.equal(calls.length, 2); assert.equal(changed.length, 2);
  assert.equal(await projection.close(), true); callbacks.project(rows('late')); await tick();
  assert.equal(calls.length, 3); assert.equal(projection.snapshot().pending, 0);
});

for (const fault of ['wrong-ref', 'wrong-runtime', 'throw', 'false', 'budget', 'invalid'] as const) {
  test(`callback ${fault} fails closed; original physical work drains and no later write replays`, async () => {
    const first = deferred<unknown>(), ref = refFor('claude-code'); let calls = 0, faults = 0;
    const owner = { command: (async (_kind, _input) => {
      calls++; if (calls === 1) return first.promise;
      return { runtime: 'claude-code', ref, applied: true };
    }) as AsyncConnectorOwner['command'] };
    const projection = new AsyncSdkProjection({ owner, runtime: 'claude-code', faulted: () => { faults++; throw Error('observer failed'); }, diagnostics: silence });
    const callbacks = projection.claude(ref);
    callbacks.project(rows()); await tick();
    if (fault === 'budget') for (let i = 0; i < CONNECTOR_PENDING_LIMIT; i++) callbacks.project(rows('queued', `event-${i}`));
    else if (fault === 'invalid') callbacks.project([{ ...rows()[0]!, text: 123 } as never]);
    else callbacks.project(rows('later', 'later'));
    const close = projection.close(); await tick(); assert.ok(projection.snapshot().pending > 0);
    first.resolve(fault === 'throw' ? Promise.reject(Error('physical failed')) : { runtime: fault === 'wrong-runtime' ? 'ghcp' : 'claude-code',
      ref: fault === 'wrong-ref' ? { ...ref, epoch: 'replacement' } : ref, applied: fault !== 'false' });
    assert.equal(await close, false); assert.equal(faults, 1);
    assert.equal(projection.snapshot().pending, 0); assert.equal(projection.snapshot().inputBytes, 0);
    assert.ok(calls <= 2); assert.equal(projection.snapshot().executions, 0);
  });
}

test('aggregate UTF-8 input bytes bound callbacks before individual command budget is exhausted', async () => {
  const gate = deferred<unknown>(), ref = refFor('claude-code'); let calls = 0;
  const owner = { command: (async () => { calls++; return gate.promise; }) as AsyncConnectorOwner['command'] };
  const projection = new AsyncSdkProjection({ owner, runtime: 'claude-code', diagnostics: silence });
  const callbacks = projection.claude(ref);
  for (let i = 0; i < 20; i++) callbacks.project(rows('中'.repeat(100_000), `event-${i}`));
  assert.ok(projection.snapshot().inputBytes <= CONNECTOR_PENDING_INPUT_BYTES);
  // 20 * 300KB is still valid; grow until the ORIGINAL aggregate budget refuses it.
  for (let i = 20; i < 60; i++) callbacks.project(rows('中'.repeat(100_000), `event-${i}`));
  assert.equal(projection.snapshot().faulted, true);
  assert.ok(projection.snapshot().inputBytes <= CONNECTOR_PENDING_INPUT_BYTES);
  gate.resolve({ runtime: 'claude-code', ref, applied: true });
  assert.equal(await projection.close(), false); assert.ok(calls <= 1); assert.equal(projection.snapshot().inputBytes, 0);
});

for (const stage of ['terminal', 'settlement', 'timeout', 'epoch'] as const) {
  test(`dispatch ${stage} must wait for exact projection barrier; failures never advance original intent`, async () => {
    const f = fixture('claude-code'), gate = deferred<boolean>(); let inspections = 0, waits = 0, epoch = 'epoch';
    const adapter: SdkDispatchAdapter = { get epoch() { return epoch; }, ready: true, send: async () => ({ nativeRequestId: 'native-request' }),
      interrupt: async () => {}, inspectSettlement: async ref => { inspections++; return { ...ref, historyPersisted: true, nativeQuiescent: true }; } };
    const dispatch = new AsyncSdkDispatch({ owner: f.owner, runtime: 'claude-code', adapter, deadlineMs: stage === 'timeout' ? 20 : 1000,
      persistence: { flush: async ref => { assert.deepEqual(ref, f.ref); waits++; return gate.promise; } }, diagnostics: silence });
    const keepAlive = setInterval(() => {}, 1000);
    try {
      if (stage === 'settlement') assert.equal(f.journal.observeTerminal(f.ref, 'completed', f.store.turns), true);
      let finished = false;
      const work = (stage === 'settlement' ? dispatch.settle(f.ref) : dispatch.terminal(f.ref, 'completed')).then(value => { finished = true; return value; });
      await tick(); assert.equal(finished, false); assert.equal(inspections, 0); assert.equal(waits, 1);
      if (stage === 'epoch') epoch = 'replacement';
      if (stage === 'timeout') {
        assert.equal(await work, false); assert.equal(f.journal.current(f.ref.key)?.phase, 'unknown');
        gate.resolve(true); await tick(); assert.equal(f.journal.current(f.ref.key)?.phase, 'unknown');
      } else {
        gate.resolve(true); assert.equal(await work, stage !== 'epoch');
        assert.equal(f.journal.current(f.ref.key)?.phase, stage === 'settlement' ? 'completed' : stage === 'terminal' ? 'settling' : 'dispatching');
        assert.equal(inspections, stage === 'settlement' ? 1 : 0);
      }
    } finally { clearInterval(keepAlive); gate.resolve(false); f.close(); }
  });
}
