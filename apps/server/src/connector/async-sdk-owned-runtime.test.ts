import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { SdkPreflight } from './sdk-owned-runtime.js';
import { createAsyncClaudeOwnedRuntime, createAsyncClaudeConnectorRuntime } from '../claude/async-owned-runtime.js';
import { createAsyncCopilotOwnedRuntime, createAsyncCopilotConnectorRuntime } from '../copilot/async-owned-runtime.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { projectCopilotMessage } from '../copilot/message-projection.js';

const token = 'isolated-owned-lifecycle-test', authorization = `Bearer ${token}`;
const silence = new PerformanceDiagnostics(() => {});
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5_000;
  while (!await predicate()) { if (Date.now() > end) assert.fail('Original lifecycle did not reach expected boundary'); await tick(); }
}
const passed = (): SdkPreflight => ({ ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close() {} });
function physical() {
  const finished = gate(); let quiet = false, closes = 0;
  const worker: SdkPreflight = { ready: Promise.resolve(true), finished: finished.promise,
    inspectQuiescence: () => quiet, close() { closes++; quiet = true; finished.release(); } };
  return { worker, finish() { quiet = true; finished.release(); }, closes: () => closes };
}
async function fixture(runtime: SdkAgentId, materialized = false) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-async-owned-')), file = join(root, 'connector.sqlite');
  const homeDirectory = join(root, 'home'); mkdirSync(homeDirectory, { mode: 0o700 });
  const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  const key = `${runtime}:${randomUUID()}`, journal = runtime === 'ghcp' ? seed.copilotJournal : seed.claudeJournal;
  const nativeSessionId = randomUUID();
  journal.create({ key, nativeSessionId, title: 'Original', createdAt: 1 });
  if (materialized) {
    await seed.turns.enqueueAsync(runtime, { id: 'original-input', sessionKey: key, createdAt: 1, payload: { text: 'Original', actorId: 'fixture' } });
    const ref = { key, id: randomUUID(), epoch: randomUUID() };
    journal.begin(ref, ['original-input'], seed.turns);
    if (runtime === 'ghcp') seed.copilotTranscript.append(ref, projectCopilotMessage({ id: randomUUID(), type: 'user.message',
      timestamp: new Date(1).toISOString(), data: { messageId: randomUUID(), content: 'Original' } })!, 'Original');
    else seed.claudeTranscript.append(ref, projectClaudeMessage({ type: 'user', uuid: randomUUID(), session_id: nativeSessionId,
      parent_tool_use_id: null, message: { role: 'user', content: 'Original' } }, nativeSessionId));
    journal.observeTerminal(ref, 'completed', seed.turns); journal.confirmSettled(ref);
  }
  seed.close();
  const owner = new AsyncConnectorOwner({ file, tokenFile: join(root, 'tokens.json'), bootstrapToken: token,
    sdkModels: { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } } }, silence);
  await owner.open();
  const deck = new DeckStore();
  const config = { homeDirectory, workspace: root, sdkDirectory: root, startupTimeoutMs: 1_000,
    apiKeyFile: join(root, 'absent-key'), model: 'default', baseUrl: 'http://127.0.0.1:1',
    auth: { mode: 'github' as const, credentialFile: join(root, 'absent-key') } };
  const marker = join(homeDirectory, runtime === 'ghcp' ? '.agentopsdeck-copilot-owner' : '.agentopsdeck-claude-owner');
  type Port = Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'>;
  async function build(options: { check?: () => SdkPreflight; deleteNative?: () => SdkPreflight; port?: Port } = {}) {
    const input = { owner: options.port ?? owner, config, projection: deck, diagnostics: silence };
    const ports = { start: () => assert.fail('No inference or replay in lifecycle fixture'), check: options.check ?? passed, deleteNative: options.deleteNative ?? passed };
    return runtime === 'ghcp' ? createAsyncCopilotOwnedRuntime(input, ports) : createAsyncClaudeOwnedRuntime(input, ports);
  }
  function deferred(check: () => SdkPreflight) {
    const input = { owner, config, projection: deck, diagnostics: silence };
    const ports = { start: () => assert.fail('No inference in deferred lifecycle fixture'), check, deleteNative: passed };
    return runtime === 'ghcp' ? createAsyncCopilotConnectorRuntime(input, ports) : createAsyncClaudeConnectorRuntime(input, ports);
  }
  return { owner, root, file, config, key, deck, marker, build, deferred,
    async close() { await owner.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: complete projection refresh includes history and repeated refresh emits no duplicate events`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime, true); let original;
    try {
      original = await f.build(); assert.equal(await original.initialize(), true);
      // Simulate a stale local projection without changing durable native facts.
      f.deck.replaceMessages(f.key, [], { authoritative: true });
      assert.equal(f.deck.getMessages(f.key).length, 0);
      await original.refreshProjection();
      assert.ok(f.deck.getMessages(f.key).some(row => row.text === 'Original'));
      const head = f.deck.latestEventId();
      await original.refreshProjection(); assert.equal(f.deck.latestEventId(), head);
      assert.equal(original.isSessionHistoryReady(f.key), true);
    } finally { await original?.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: overlapping projection refresh requests require a fresh successor directory scan`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime), held = gate(), entered = gate(); let original; let block = false, pages = 0;
    const port: Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'> = {
      get runtimeOwnerFile() { return f.owner.runtimeOwnerFile; },
      command: (async (kind, input) => {
        const value = await f.owner.command(kind, input);
        if (block && kind === 'sdkSessionPage' && ++pages === 1) { entered.release(); await held.promise; }
        return value;
      }) as AsyncConnectorOwner['command'],
    };
    try {
      original = await f.build({ port }); assert.equal(await original.initialize(), true);
      block = true; const first = original.refreshProjection(); await entered.promise;
      const created = await f.owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'barrier-new-session', payloadJson: '{"title":"New committed session"}' });
      assert.ok('receipt' in created && created.key);
      const next = original.refreshProjection(); assert.equal(first, next);
      held.release(); await next;
      assert.equal(pages, 2); assert.equal(f.deck.getSession(created.key!)?.title, 'New committed session');
      assert.equal(original.isSessionHistoryReady(created.key!), true);
    } finally { held.release(); await original?.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: vanished directory entries are rechecked against original deletion facts`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime); let original; let hide = false;
    const port: Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'> = {
      get runtimeOwnerFile() { return f.owner.runtimeOwnerFile; },
      command: (async (kind, input) => {
        const value = await f.owner.command(kind, input);
        return hide && kind === 'sdkSessionPage' ? [] : value;
      }) as AsyncConnectorOwner['command'],
    };
    try {
      original = await f.build({ port }); assert.equal(await original.initialize(), true);
      assert.ok(f.deck.getSession(f.key));
      const claim = await f.owner.command('sdkDeletionClaim', { runtime, key: f.key, authorization, commandKey: 'barrier-delete' });
      assert.ok('intent' in claim && claim.intent); assert.equal(claim.nativeRequired, false);
      const ref = { runtime, key: f.key, intent: claim.intent, receiptId: claim.receipt.id };
      assert.equal(await f.owner.command('sdkDeletionReady', { ...ref, authorization }), true);
      assert.notEqual(await f.owner.command('sdkDeletionSettle', { ...ref, accepted: true, nativeQuiescent: true }), false);
      assert.ok(f.deck.getSession(f.key), 'notification has deliberately not refreshed memory');
      hide = true; await original.refreshProjection();
      assert.equal(f.deck.getSession(f.key), undefined); assert.equal(original.isSessionHistoryReady(f.key), false);
    } finally { await original?.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: close drains a full projection refresh without publishing its delayed read`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime), held = gate(), entered = gate(); let original; let block = false, closed = false;
    const port: Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'> = {
      get runtimeOwnerFile() { return f.owner.runtimeOwnerFile; },
      command: (async (kind, input) => {
        const value = await f.owner.command(kind, input);
        if (block && kind === 'sdkLifecycleRead') { entered.release(); await held.promise; }
        return value;
      }) as AsyncConnectorOwner['command'],
    };
    try {
      original = await f.build({ port }); assert.equal(await original.initialize(), true);
      block = true; const refresh = original.refreshProjection(), rejected = assert.rejects(refresh);
      await entered.promise; const close = original.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      held.release(); await rejected; await close;
      await assert.rejects(original.refreshProjection());
    } finally { held.release(); await original?.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: deferred vendor factory acquires HOME in maintenance without starting native`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime); let checks = 0;
    const original = f.deferred(() => { checks++; return passed(); });
    try {
      assert.equal(existsSync(f.marker), false);
      const pause = original.pauseQueueWorker(); original.activate(); await pause.drained;
      assert.equal(checks, 0); assert.equal(existsSync(f.marker), true);
      assert.equal((await original.inspectMaintenance()).ownershipHeld, true);
      assert.equal(pause.resume(), true); await until(() => original.ready);
      assert.equal(checks, 1); await original.close(); assert.equal(existsSync(f.marker), false);
    } finally { await original.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: maintenance during physical preflight resumes original startup without retry`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime), preflight = physical(); let checks = 0;
    const original = f.deferred(() => { checks++; return preflight.worker; });
    try {
      original.activate(); await until(() => checks === 1);
      const pause = original.pauseQueueWorker(); let drained = false; void pause.drained.then(() => { drained = true; });
      await tick(); assert.equal(drained, false); preflight.finish(); await pause.drained;
      assert.equal(original.status, 'maintenance'); assert.equal(original.ready, false);
      assert.equal(pause.resume(), true); await until(() => original.ready);
      assert.equal(checks, 1); await original.close(); assert.equal(existsSync(f.marker), false);
    } finally { preflight.finish(); await original.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: deferred close during preflight drains original worker and releases HOME`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime), preflight = physical(); let checks = 0;
    const original = f.deferred(() => { checks++; return preflight.worker; });
    try {
      original.activate(); await until(() => checks === 1); await original.close();
      assert.ok(preflight.closes() >= 1); assert.equal(original.status, 'closed'); assert.equal(existsSync(f.marker), false);
    } finally { preflight.finish(); await original.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: sole-worker lifecycle owns HOME, startup physical barrier, history and clean reopen`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime), preflight = physical(); let original;
    try {
      original = await f.build({ check: () => preflight.worker });
      assert.equal(existsSync(f.marker), true); assert.equal(original.ready, false);
      const startup = original.initialize(); await until(() => f.deck.getSession(f.key) !== undefined);
      await tick(); assert.equal(original.ready, false, 'early ready is not physical exit');
      preflight.finish(); assert.equal(await startup, true); assert.equal(original.status, 'ready');
      await original.refreshSession(f.key); assert.equal(original.isSessionHistoryReady(f.key), true);
      const pause = original.pauseQueueWorker(); await pause.drained;
      assert.equal(original.ready, false); assert.equal(original.status, 'maintenance');
      assert.equal(pause.resume(), true); assert.equal(pause.resume(), false);
      await assert.rejects(f.build(), /ownership/);
      await original.close(); assert.equal(existsSync(f.marker), false);
      const reopened = await f.build(); try { assert.equal(await reopened.initialize(), true); } finally { await reopened.close(); }
    } finally { preflight.finish(); await original?.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: original native deletion waits physical exit and success survives revocation`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime, true), deletion = physical(); let original; let calls = 0;
    try {
      original = await f.build({ deleteNative: () => { calls++; return deletion.worker; } });
      assert.equal(await original.initialize(), true);
      const pending = original.remove(f.key, 'original-delete', authorization);
      await until(() => calls === 1);
      const principal = await f.owner.command('tokenAuthenticate', { authorization }); assert.ok(principal);
      await f.owner.command('tokenRevoke', { tokenId: principal.tokenId });
      assert.equal((await f.owner.command('sdkSnapshotRead', { runtime, key: f.key })).deletion?.phase, 'pending');
      deletion.finish();
      const result = await pending; assert.ok('receipt' in result); assert.equal(result.receipt.state, 'accepted');
      assert.equal(calls, 1); assert.equal(f.deck.getSession(f.key), undefined);
      assert.equal((await f.owner.command('sdkSnapshotRead', { runtime, key: f.key })).deletion?.phase, 'deleted');
      assert.equal(deletion.closes(), 1);
      await original.close();
    } finally { deletion.finish(); await original?.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: local deletion duplicate is observation only, pause denies new effect`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime); let original;
    try {
      original = await f.build(); assert.equal(await original.initialize(), true);
      const pause = original.pauseQueueWorker(); await pause.drained;
      await assert.rejects(original.remove(f.key, 'paused-delete', authorization)); pause.resume();
      const result = await original.remove(f.key, 'local-delete', authorization);
      assert.ok('receipt' in result); assert.equal(result.receipt.state, 'accepted');
      const duplicate = await original.remove(f.key, 'local-delete', authorization);
      assert.ok('receipt' in duplicate && !duplicate.admitted); assert.deepEqual(duplicate.receipt, result.receipt);
      await original.close();
      const reopened = await f.build(); try { await reopened.initialize(); assert.equal(f.deck.getSession(f.key), undefined); } finally { await reopened.close(); }
    } finally { await original?.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: streaming refreshes merge, discard stale snapshot and never publish after close`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime), held = gate(), entered = gate(); let original; let block = false, reads = 0;
    const port: Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'> = {
      get runtimeOwnerFile() { return f.owner.runtimeOwnerFile; },
      command: (async (kind, input) => {
        const value = await f.owner.command(kind, input);
        if (block && kind === 'sdkLifecycleRead') { reads++; if (reads === 1) { entered.release(); await held.promise; } }
        return value;
      }) as AsyncConnectorOwner['command'],
    };
    try {
      original = await f.build({ port }); assert.equal(await original.initialize(), true);
      block = true; const first = original.refreshSession(f.key); await entered.promise;
      const refreshes = Array.from({ length: 1_000 }, () => original!.refreshSession(f.key));
      assert.ok(refreshes.every(p => p === first), 'one original promise per session, not an unbounded chain');
      held.release(); await Promise.all(refreshes);
      assert.equal(reads, 2); assert.equal(original.isSessionHistoryReady(f.key), true);
      block = false; await original.close(); await assert.rejects(original.refreshSession(f.key));
      assert.equal(original.isSessionHistoryReady(f.key), false);
    } finally { held.release(); await original?.close().catch(() => {}); await f.close(); }
  });

  test(`${runtime}: failed physical proof retains HOME, no constructor takeover`, { timeout: 15_000 }, async () => {
    const f = await fixture(runtime); let original;
    try {
      original = await f.build({ check: () => ({ ...passed(), inspectQuiescence: () => false }) });
      assert.equal(await original.initialize(), false); assert.equal(original.status, 'failed');
      await assert.rejects(original.close(), /ownership/); assert.equal(existsSync(f.marker), true);
      await assert.rejects(f.build(), /ownership/);
    } finally { await original?.close().catch(() => {}); await f.close(); }
  });
}

test('trusted owner file is unavailable before ready, after failure and after close; swapped history retires owner', async () => {
  class Fake extends EventEmitter {
    messages: { id: number; kind: string }[] = [];
    postMessage(value: { id: number; kind: string }) { this.messages.push(value); }
    terminate() { queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
  }
  const fake = new Fake(), file = join(tmpdir(), `agentopsdeck-trusted-${randomUUID()}.sqlite`);
  const owner = new AsyncConnectorOwner({ file }, silence, () => fake as unknown as Worker);
  assert.equal(owner.runtimeOwnerFile, undefined);
  fake.emit('message', { kind: 'ready' }); await owner.open(); assert.equal(owner.runtimeOwnerFile, file);
  const pending = owner.command('sdkLifecycleRead', { runtime: 'ghcp', key: 'ghcp:original', history: false });
  await tick(); const request = fake.messages.at(-1)!;
  fake.emit('message', { ...request, ok: true, body: JSON.stringify({ runtime: 'ghcp', key: 'ghcp:swapped',
    snapshot: { session: null, execution: null, deletion: null, canStart: false, unresolved: false }, page: null }) });
  await assert.rejects(pending); assert.equal(owner.runtimeOwnerFile, undefined); await owner.close().catch(() => {});
});
