import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { CLAUDE_CLI_VERSION } from './dispatch-adapter.js';
import { ClaudeOwnedRuntime } from './owned-runtime.js';
import { ConnectorAgentRuntimes } from '../connector/agent-runtimes.js';
import { DeckStore } from '../projection/deck-store.js';

const passedPreflight = () => ({ ready: Promise.resolve(true), finished: Promise.resolve(),
  inspectQuiescence: () => true, close: () => {} });

test('Claude blocks previously queued work when its session model is no longer allowed', async () => {
  const f = fixture(); let starts = 0;
  f.store.claudeJournal.updateModel(f.key, 'retired-model', () => {});
  await f.enqueue();
  const owner = new ClaudeOwnedRuntime(f.options, () => { starts++; throw new Error('must not start'); }, passedPreflight);
  try {
    assert.equal(await owner.initialize(), true);
    await owner.driver.wake(f.key);
    assert.equal(starts, 0);
    assert.equal(f.store.claudeJournal.current(f.key), undefined);
    const entry = f.store.turns.head('claude-code', f.key)!;
    assert.equal(entry.state, 'blocked');
    assert.equal(owner.commands.cancelQueued(f.key, entry.id,
      f.store.turns.version('claude-code', f.key, entry.id)!, { actorId: 'owner' }), true);
    owner.commands.updateModel(f.key, null, () => {}, model => assert.equal(model, 'fixture'));
    assert.equal(f.store.claudeJournal.session(f.key)?.model, undefined);
  } finally { await owner.close(); f.store.close(); f.cleanup(); }
});

function fixture(runtimeOwner = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-claude-owner-')));
  const file = join(root, 'connector.sqlite'), homeDirectory = join(root, 'home');
  mkdirSync(homeDirectory, { mode: 0o700 });
  const store = new ConnectorUserStore(file, () => true, { runtimeOwner });
  const config = { homeDirectory, sdkDirectory: join(root, 'unused-sdk'), workspace: join(root, 'workspace'),
    apiKeyFile: join(root, 'absent-key'), model: 'fixture', baseUrl: 'http://127.0.0.1:1', startupTimeoutMs: 1000 };
  const key = `claude-code:${randomUUID()}`;
  store.claudeJournal.create({ key, nativeSessionId: randomUUID(), title: 'Owned fixture', createdAt: 0 });
  const enqueue = () => store.turns.enqueueAsync('claude-code', { id: randomUUID(), sessionKey: key,
    createdAt: 0, payload: { text: 'Fixture', actorId: 'owner', images: [] } });
  return { root, file, store, config, key, enqueue, lock: join(homeDirectory, '.agentopsdeck-claude-owner'),
    options: { store, config, authorize: () => true }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('Claude owned runtime rejects non-owner/memory/closed stores before launching or claiming HOME', () => {
  const f = fixture(false); const memory = new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true });
  try {
    assert.throws(() => new ClaudeOwnedRuntime(f.options), /exclusive Connector/);
    assert.throws(() => new ClaudeOwnedRuntime({ ...f.options, store: memory }), /ownership/);
    f.store.stopTurnStarts(); assert.throws(() => new ClaudeOwnedRuntime(f.options));
    assert.equal(existsSync(f.lock), false); assert.equal(existsSync(f.config.apiKeyFile), false);
  } finally { memory.close(); f.store.close(); f.cleanup(); }
});

test('Claude owned runtime prevents duplicate store owners even with distinct HOME; clean restart retains identity', async () => {
  const f = fixture();
  try {
    const first = new ClaudeOwnedRuntime(f.options);
    const other = join(f.root, 'other-home'); mkdirSync(other, { mode: 0o700 });
    assert.throws(() => new ClaudeOwnedRuntime({ ...f.options, config: { ...f.config, homeDirectory: other } }));
    assert.throws(() => new ConnectorUserStore(f.file, () => true, { runtimeOwner: true }), /locked/);
    const observation = first.inspectMaintenance();
    assert.equal(observation.nativeWorkers, 0); assert.equal(observation.unresolvedExecutions, 0);
    assert.equal(observation.queuedInputs, 0); assert.equal(observation.ownershipHeld, true);
    const closing = first.close(); assert.equal(first.close(), closing); await closing;
    assert.equal(existsSync(f.lock), false);
    const second = new ClaudeOwnedRuntime(f.options); await second.close();
  } finally { f.store.close(); f.cleanup(); }
});

test('Claude owned runtime holds HOME through native close and reports pending workers to maintenance', async () => {
  const f = fixture(); let complete!: () => void, started = 0;
  const finished = new Promise<void>(resolve => { complete = resolve; });
  let closing = false, quiet = false;
  const owner = new ClaudeOwnedRuntime(f.options, request => {
    started++;
    return { finished,
      async *[Symbol.asyncIterator]() {
        const session_id = request.execution.nativeSessionId;
        yield { type: 'system', subtype: 'init', session_id, claude_code_version: CLAUDE_CLI_VERSION };
        yield { type: 'user', uuid: request.execution.id, session_id, parent_tool_use_id: null };
        await finished;
      },
      interrupt: async () => {}, historyIdentities: async () => [], inspectQuiescence: async () => quiet,
      close: () => { closing = true; },
    };
  }, passedPreflight);
  try {
    await f.enqueue(); await owner.driver.wake(f.key);
    assert.equal(started, 0, 'Existing queue must wait for startup');
    assert.equal(await owner.initialize(), true);
    await setImmediate(); assert.equal(started, 1, 'Successful startup wakes the existing queue without browser polling');
    assert.equal(owner.inspectMaintenance().nativeWorkers, 1);
    assert.equal(owner.inspectMaintenance().unresolvedExecutions, 1);
    const closed = owner.close(); await setImmediate();
    assert.equal(closing, true); assert.equal(existsSync(f.lock), true);
    assert.throws(() => new ClaudeOwnedRuntime(f.options));
    quiet = true; complete(); await closed;
    assert.equal(existsSync(f.lock), false);
    assert.equal(f.store.claudeJournal.current(f.key)?.phase, 'unknown', 'shutdown cannot fabricate native completion');
  } finally { quiet = true; complete(); await owner.close(); f.store.close(); f.cleanup(); }
});

test('Claude owned runtime detects lost HOME ownership before a native send', async () => {
  const f = fixture(); let started = 0;
  const owner = new ClaudeOwnedRuntime(f.options, () => { started++; throw new Error('must not start'); }, passedPreflight);
  try {
    assert.equal(await owner.initialize(), true);
    renameSync(f.lock, join(f.config.homeDirectory, 'old-owner'));
    writeFileSync(f.lock, 'replacement', { mode: 0o600 });
    assert.equal(owner.status, 'failed');
    await f.enqueue(); await owner.driver.wake(f.key);
    assert.equal(started, 0); assert.equal(owner.inspectMaintenance().ownershipHeld, false);
    assert.equal(f.store.claudeJournal.current(f.key), undefined, 'Lost ownership rejects before journal admission');
    assert.equal(f.store.turns.head('claude-code', f.key)?.state, 'queued');
    await assert.rejects(owner.close(), /offline recovery/);
    assert.equal(existsSync(f.lock), true); assert.throws(() => new ClaudeOwnedRuntime(f.options));
  } finally { await owner.close().catch(() => {}); f.store.close(); f.cleanup(); }
});

test('Claude owned runtime never releases HOME after unconfirmed native cleanup', async () => {
  const f = fixture();
  const owner = new ClaudeOwnedRuntime(f.options, () => ({ finished: Promise.resolve(),
    async *[Symbol.asyncIterator]() { throw new Error('fixture disconnect'); },
    interrupt: async () => {}, historyIdentities: async () => [], inspectQuiescence: async () => false, close: () => {},
  }), passedPreflight);
  try {
    assert.equal(await owner.initialize(), true);
    await f.enqueue(); await owner.driver.wake(f.key); await setImmediate();
    assert.equal(owner.inspectMaintenance().cleanupUnconfirmed, true);
    assert.equal(owner.status, 'failed');
    await assert.rejects(owner.close(), /offline recovery/);
    assert.equal(existsSync(f.lock), true); assert.throws(() => new ClaudeOwnedRuntime(f.options));
  } finally { await owner.close().catch(() => {}); f.store.close(); f.cleanup(); }
});

test('Claude startup is once-only and fences queued input without manufacturing an unknown receipt', async () => {
  const f = fixture(); let checks = 0, starts = 0, finish!: (value: boolean) => void;
  const ready = new Promise<boolean>(resolve => { finish = resolve; });
  const owner = new ClaudeOwnedRuntime(f.options, () => { starts++; throw new Error('must not start'); }, () => {
    checks++;
    return { ready, finished: ready.then(() => {}), inspectQuiescence: () => checks > 0,
      close: () => finish(false) };
  });
  try {
    await f.enqueue(); await owner.driver.wake(f.key);
    assert.equal(owner.ready, false); assert.equal(checks, 0); assert.equal(starts, 0);
    assert.equal(owner.status, 'starting');
    assert.equal(f.store.claudeJournal.current(f.key), undefined);
    const initializing = owner.initialize(); assert.equal(owner.initialize(), initializing);
    await setImmediate(); await owner.driver.wake(f.key);
    assert.equal(checks, 1); assert.equal(starts, 0);
    finish(false); assert.equal(await initializing, false);
    assert.equal(await owner.initialize(), false); assert.equal(checks, 1);
    await owner.driver.wake(f.key);
    assert.equal(f.store.claudeJournal.current(f.key), undefined);
    assert.equal(f.store.turns.head('claude-code', f.key)?.state, 'queued');
    assert.equal(owner.inspectMaintenance().startupState, 'failed');
    assert.equal(owner.status, 'failed');
  } finally { finish(false); await owner.close(); f.store.close(); f.cleanup(); }
});

test('Claude close during startup waits for cleanup and late success cannot reopen admission', async () => {
  const f = fixture(); let accept!: () => void, drain!: () => void, quiet = false, cancelled = false;
  const ready = new Promise<boolean>(resolve => { accept = () => resolve(true); });
  const finished = new Promise<void>(resolve => { drain = () => { quiet = true; resolve(); }; });
  const owner = new ClaudeOwnedRuntime(f.options, () => { throw new Error('must not start'); }, () => ({
    ready, finished, inspectQuiescence: () => quiet, close: () => { cancelled = true; },
  }));
  try {
    await f.enqueue(); const initializing = owner.initialize(); await setImmediate();
    assert.equal(owner.inspectMaintenance().startupWorkers, 1);
    const closing = owner.close(); await setImmediate();
    assert.equal(cancelled, true); assert.equal(existsSync(f.lock), true);
    accept(); drain(); assert.equal(await initializing, false); await closing;
    assert.equal(owner.ready, false); assert.equal(existsSync(f.lock), false);
    assert.equal(f.store.claudeJournal.current(f.key), undefined);
  } finally { accept(); drain(); await owner.close(); f.store.close(); f.cleanup(); }
});

test('Claude startup with unproven cleanup retains HOME ownership on close', async () => {
  const f = fixture();
  const owner = new ClaudeOwnedRuntime(f.options, undefined, () => ({
    ready: Promise.resolve(false), finished: Promise.resolve(), inspectQuiescence: () => false, close: () => {},
  }));
  try {
    assert.equal(await owner.initialize(), false);
    assert.equal(owner.inspectMaintenance().startupWorkers, 1);
    await assert.rejects(owner.close(), /offline recovery/);
    assert.equal(existsSync(f.lock), true);
  } finally { await owner.close().catch(() => {}); f.store.close(); f.cleanup(); }
});

test('Claude close before startup microtask never launches a preflight', async () => {
  const f = fixture(); let checks = 0;
  const owner = new ClaudeOwnedRuntime(f.options, undefined, () => { checks++; return passedPreflight(); });
  try {
    const starting = owner.initialize(), closing = owner.close();
    assert.equal(await starting, false); await closing;
    assert.equal(checks, 0); assert.equal(owner.ready, false); assert.equal(existsSync(f.lock), false);
  } finally { await owner.close(); f.store.close(); f.cleanup(); }
});

test('Claude startup success cannot reopen admission after HOME ownership is lost', async () => {
  const f = fixture(); let accept!: () => void, started = 0;
  const ready = new Promise<boolean>(resolve => { accept = () => resolve(true); });
  const owner = new ClaudeOwnedRuntime(f.options, () => { started++; throw new Error('must not start'); }, () => ({
    ready, finished: ready.then(() => {}), inspectQuiescence: () => true, close: () => {},
  }));
  try {
    await f.enqueue(); const starting = owner.initialize(); await setImmediate();
    renameSync(f.lock, join(f.config.homeDirectory, 'old-owner'));
    writeFileSync(f.lock, 'replacement', { mode: 0o600 });
    accept(); assert.equal(await starting, false); await owner.driver.wake(f.key);
    assert.equal(owner.ready, false); assert.equal(started, 0);
    assert.equal(f.store.claudeJournal.current(f.key), undefined);
    assert.equal(f.store.turns.head('claude-code', f.key)?.state, 'queued');
    await assert.rejects(owner.close(), /offline recovery/);
    assert.equal(existsSync(f.lock), true);
  } finally { accept(); await owner.close().catch(() => {}); f.store.close(); f.cleanup(); }
});

test('Claude owner close synchronously fences an already scheduled queue wake', async () => {
  const f = fixture(); let started = 0;
  const owner = new ClaudeOwnedRuntime(f.options, () => { started++; throw new Error('must not start'); });
  try {
    await f.enqueue(); const waking = owner.driver.wake(f.key);
    const closed = owner.close();
    assert.equal(owner.driver.inspect().closed, true);
    await Promise.all([waking, closed]);
    assert.equal(started, 0); assert.equal(f.store.claudeJournal.current(f.key), undefined);
    assert.equal(f.store.turns.head('claude-code', f.key)?.state, 'queued');
  } finally { await owner.close(); f.store.close(); f.cleanup(); }
});

test('Claude lifecycle directory restoration never reads histories or starts native work', async () => {
  const f = fixture(), deck = new DeckStore(); let reads = 0, checks = 0;
  const page = f.store.claudeTranscript.page.bind(f.store.claudeTranscript);
  f.store.claudeTranscript.page = (...args) => { reads++; return page(...args); };
  for (let i = 0; i < 201; i++) f.store.claudeJournal.create({ key: `claude-code:directory-${i}`,
    nativeSessionId: randomUUID(), title: 'Restored', createdAt: 0 });
  const owner = new ClaudeOwnedRuntime({ ...f.options, projection: deck }, () => { throw new Error('must not start'); },
    () => { checks++; return passedPreflight(); });
  try {
    owner.refreshDirectory();
    assert.equal(deck.getSession('claude-code:directory-200')?.status, 'unknown');
    assert.equal(checks, 0); assert.equal(reads, 0); assert.equal(owner.isSessionHistoryReady(f.key), false);
    assert.equal(await owner.initialize(), true);
    assert.equal(deck.getSession(f.key)?.status, 'idle');
    assert.equal(checks, 1); assert.equal(reads, 0);
  } finally { await owner.close(); f.store.close(); f.cleanup(); }
});

test('Claude registry history is local, works before startup and cannot dispatch the queue', async () => {
  const f = fixture(), deck = new DeckStore(); let checks = 0;
  const owner = new ClaudeOwnedRuntime({ ...f.options, projection: deck }, () => { throw new Error('must not start'); },
    () => { checks++; return passedPreflight(); });
  const registry = new ConnectorAgentRuntimes([owner]);
  try {
    await f.enqueue(); assert.equal(registry.historyReady(f.key), false);
    await registry.forSession(f.key)!.refreshSession(f.key, { fresh: true });
    assert.equal(registry.historyReady(f.key), true); assert.equal(checks, 0);
    assert.equal(f.store.claudeJournal.current(f.key), undefined);
    assert.equal(f.store.turns.head('claude-code', f.key)?.state, 'queued');
    await assert.rejects(owner.refreshSession('ghcp:other'));
    await assert.rejects(owner.refreshSession('claude-code:absent'));
    assert.throws(() => registry.forSession('ghcp:other'), /disabled/);
    await registry.close(); assert.equal(registry.historyReady(f.key), false);
    await assert.rejects(owner.refreshSession(f.key));
  } finally { await registry.close(); f.store.close(); f.cleanup(); }
});

test('Claude history readiness is invalidated when a later projection fails', async () => {
  const f = fixture(), deck = new DeckStore();
  const owner = new ClaudeOwnedRuntime({ ...f.options, projection: deck });
  try {
    await owner.refreshSession(f.key); assert.equal(owner.isSessionHistoryReady(f.key), true);
    f.store.claudeTranscript.pageBlocks = () => { throw new Error('fixture unavailable'); };
    await assert.rejects(owner.refreshSession(f.key));
    assert.equal(owner.isSessionHistoryReady(f.key), false);
  } finally { await owner.close(); f.store.close(); f.cleanup(); }
});

test('Claude registry maintenance drain waits for startup; late readiness cannot bypass queue pause', async () => {
  const f = fixture(); let finish!: () => void, quiet = false, starts = 0;
  const ready = new Promise<boolean>(resolve => { finish = () => { quiet = true; resolve(true); }; });
  const owner = new ClaudeOwnedRuntime(f.options, () => { starts++; throw new Error('must not start'); }, () => ({
    ready, finished: ready.then(() => {}), inspectQuiescence: () => quiet, close: () => finish(),
  }));
  const registry = new ConnectorAgentRuntimes([owner]);
  try {
    await f.enqueue(); const starting = owner.initialize(); await setImmediate();
    const pause = registry.pauseQueueWorkers(); let drained = false;
    void pause.drained.then(() => { drained = true; }); await setImmediate();
    assert.equal(drained, false); assert.equal(pause.resume(), false);
    finish(); assert.equal(await starting, true); await pause.drained;
    await owner.driver.wake(f.key);
    assert.equal(starts, 0); assert.equal(owner.inspectMaintenance().startupWorkers, 0);
    assert.equal(owner.inspectMaintenance().queuedInputs, 1);
    assert.equal(f.store.claudeJournal.current(f.key), undefined);
    await registry.close(); assert.equal(pause.resume(), false);
  } finally { finish(); await registry.close(); f.store.close(); f.cleanup(); }
});

test('Claude paused lifecycle refuses new startup and resumes only its current lease', async () => {
  const f = fixture(); let checks = 0;
  const owner = new ClaudeOwnedRuntime(f.options, undefined, () => { checks++; return passedPreflight(); });
  try {
    const pause = owner.pauseQueueWorker(); assert.equal(owner.pauseQueueWorker(), pause);
    assert.equal(owner.status, 'maintenance');
    assert.equal(await owner.initialize(), false); assert.equal(checks, 0);
    await pause.drained; assert.equal(pause.resume(), true); assert.equal(pause.resume(), false);
    assert.equal(await owner.initialize(), true); assert.equal(checks, 1);
    assert.equal(owner.status, 'ready');
  } finally { await owner.close(); f.store.close(); f.cleanup(); }
});

test('Claude unconfirmed startup cleanup blocks registry maintenance drain', async () => {
  const f = fixture();
  const owner = new ClaudeOwnedRuntime(f.options, undefined, () => ({
    ready: Promise.resolve(false), finished: Promise.resolve(), inspectQuiescence: () => false, close: () => {},
  }));
  const registry = new ConnectorAgentRuntimes([owner]);
  try {
    assert.equal(await owner.initialize(), false);
    const pause = registry.pauseQueueWorkers();
    await assert.rejects(pause.drained, /runtime drain failed/); assert.equal(pause.resume(), false);
    await assert.rejects(registry.close(), /failed to close/); assert.equal(existsSync(f.lock), true);
  } finally { await registry.close().catch(() => {}); f.store.close(); f.cleanup(); }
});
