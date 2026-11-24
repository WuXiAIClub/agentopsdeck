import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { ClaudeOwnedRuntime } from '../claude/owned-runtime.js';
import { CopilotOwnedRuntime } from './owned-runtime.js';
import type { CopilotConfig } from './config.js';
import { DeckStore } from '../projection/deck-store.js';

const passed = () => ({ ready: Promise.resolve(true), finished: Promise.resolve(),
  inspectQuiescence: () => true, close() {} });

test('Copilot blocks previously queued work when its session model is no longer allowed', async () => {
  const f = fixture(); let starts = 0;
  f.store.copilotJournal.updateModel(f.key, 'retired-model', () => {});
  await f.enqueue();
  const owner = new CopilotOwnedRuntime(f.options, () => { starts++; throw new Error('must not start'); }, passed);
  try {
    assert.equal(await owner.initialize(), true);
    await owner.driver.wake(f.key);
    assert.equal(starts, 0);
    assert.equal(f.store.copilotJournal.current(f.key), undefined);
    const entry = f.store.turns.head('ghcp', f.key)!;
    assert.equal(entry.state, 'blocked');
    assert.equal(owner.commands.cancelQueued(f.key, entry.id,
      f.store.turns.version('ghcp', f.key, entry.id)!, { actorId: 'owner' }), true);
    owner.commands.updateModel(f.key, null, () => {}, model => assert.equal(model, 'fixture'));
    assert.equal(f.store.copilotJournal.session(f.key)?.model, undefined);
  } finally { await owner.close(); f.cleanup(); }
});
function fixture(runtimeOwner = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-copilot-owned-')));
  const homeDirectory = join(root, 'home'); mkdirSync(homeDirectory, { mode: 0o700 });
  const store = new ConnectorUserStore(join(root, 'connector.sqlite'), () => true, { runtimeOwner });
  const config: CopilotConfig = { homeDirectory, sdkDirectory: join(root, 'sdk'), workspace: join(root, 'workspace'),
    model: 'fixture', startupTimeoutMs: 1000, auth: { mode: 'github', credentialFile: join(root, 'absent-key') } };
  const key = `ghcp:${randomUUID()}`;
  store.copilotJournal.create({ key, nativeSessionId: randomUUID(), title: 'Copilot fixture', createdAt: 1 });
  const enqueue = () => store.turns.enqueueAsync('ghcp', { id: randomUUID(), sessionKey: key, createdAt: 2,
    payload: { actorId: 'owner', text: 'unsent', images: [] } });
  return { root, store, config, key, enqueue, options: { store, config, authorize: () => true },
    lock: join(homeDirectory, '.agentopsdeck-copilot-owner'), cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Copilot rejects non-owner and in-memory stores without claiming HOME or reading credentials', () => {
  const f = fixture(false), memory = new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true });
  try {
    assert.throws(() => new CopilotOwnedRuntime(f.options), /ownership/);
    assert.throws(() => new CopilotOwnedRuntime({ ...f.options, store: memory }), /ownership/);
    assert.equal(existsSync(f.lock), false); assert.equal(existsSync(f.config.auth.credentialFile), false);
  } finally { memory.close(); f.cleanup(); }
});

test('Claude and Copilot may share a Connector store but never HOME or duplicate runtime ownership', async () => {
  const f = fixture(), other = join(f.root, 'claude-home'); mkdirSync(other, { mode: 0o700 });
  const owner = new CopilotOwnedRuntime(f.options, undefined, passed);
  const claudeOptions = { store: f.store, authorize: () => true, config: { ...f.config,
    homeDirectory: other, apiKeyFile: join(f.root, 'absent-claude-key'), baseUrl: 'http://127.0.0.1:1' } };
  const claude = new ClaudeOwnedRuntime(claudeOptions, undefined, passed);
  try {
    assert.equal(await owner.initialize(), true); assert.equal(await claude.initialize(), true);
    assert.throws(() => new CopilotOwnedRuntime({ ...f.options, config: { ...f.config, homeDirectory: other } }));
    await claude.close();
    assert.throws(() => new ClaudeOwnedRuntime({ ...claudeOptions, config: { ...claudeOptions.config, homeDirectory: f.config.homeDirectory } }));
    await owner.close(); assert.equal(existsSync(f.lock), false);
    const restarted = new CopilotOwnedRuntime(f.options, undefined, passed);
    try { assert.equal(await restarted.initialize(), true); } finally { await restarted.close(); }
  } finally { await Promise.all([owner.close(), claude.close()]); f.cleanup(); }
});

test('Copilot failed startup leaves queued input unsent and does not retry or claim an unknown execution', async () => {
  const f = fixture(); let checks = 0, starts = 0;
  const owner = new CopilotOwnedRuntime(f.options, () => { starts++; throw new Error('must not start'); }, () => {
    checks++; return { ...passed(), ready: Promise.resolve(false) };
  });
  try {
    await f.enqueue(); await owner.driver.wake(f.key); assert.equal(starts, 0);
    assert.equal(await owner.initialize(), false); assert.equal(await owner.initialize(), false);
    await owner.driver.wake(f.key);
    assert.equal(checks, 1); assert.equal(starts, 0); assert.equal(owner.ready, false);
    assert.equal(f.store.copilotJournal.current(f.key), undefined);
    const entry = f.store.turns.head('ghcp', f.key)!;
    assert.equal(entry.state, 'queued');
    assert.equal(owner.commands.cancelQueued(f.key, entry.id, f.store.turns.version('ghcp', f.key, entry.id)!, { actorId: 'owner' }), true);
  } finally { await owner.close(); f.cleanup(); }
});

test('Copilot startup under maintenance remains local and paused history is readable', async () => {
  const f = fixture(), projection = new DeckStore(); let checks = 0;
  const owner = new CopilotOwnedRuntime({ ...f.options, projection }, undefined, () => { checks++; return passed(); });
  try {
    await f.enqueue(); const pause = owner.pauseQueueWorker(); await pause.drained;
    assert.equal(await owner.initialize(), false); assert.equal(checks, 0);
    await owner.refreshSession(f.key);
    assert.equal(owner.isSessionHistoryReady(f.key), true);
    assert.equal(projection.getMessages(f.key)[0]?.text, 'unsent');
    assert.equal(owner.inspectMaintenance().queuedInputs, 1);
    assert.equal(owner.inspectMaintenance().ownershipHeld, true);
    // Remove provably unsent fixture directly while paused; do not test by launching an installed CLI.
    f.store.turns.cancel('ghcp', f.key, f.store.turns.head('ghcp', f.key)!.id);
    assert.equal(pause.resume(), true); assert.equal(pause.resume(), false);
    assert.equal(await owner.initialize(), true); assert.equal(checks, 1);
  } finally { await owner.close(); f.cleanup(); }
});

test('Copilot close drains in-flight preflight and late readiness cannot reopen admission', async () => {
  const f = fixture(); let accept!: () => void, drain!: () => void, quiet = false, cancelled = false;
  const ready = new Promise<boolean>(resolve => { accept = () => resolve(true); });
  const finished = new Promise<void>(resolve => { drain = () => { quiet = true; resolve(); }; });
  const owner = new CopilotOwnedRuntime(f.options, undefined, () => ({ ready, finished,
    inspectQuiescence: () => quiet, close() { cancelled = true; } }));
  try {
    await f.enqueue(); const starting = owner.initialize(); await setImmediate();
    assert.equal(owner.inspectMaintenance().startupWorkers, 1);
    const closing = owner.close(); await setImmediate();
    assert.equal(cancelled, true); assert.equal(existsSync(f.lock), true);
    accept(); drain(); assert.equal(await starting, false); await closing;
    assert.equal(owner.ready, false); assert.equal(existsSync(f.lock), false);
    assert.equal(f.store.copilotJournal.current(f.key), undefined);
  } finally { accept(); drain(); await owner.close(); f.cleanup(); }
});

test('Copilot uncertain startup cleanup retains HOME marker and refuses takeover', async () => {
  const f = fixture();
  const owner = new CopilotOwnedRuntime(f.options, undefined, () => ({ ...passed(),
    ready: Promise.resolve(false), inspectQuiescence: () => false }));
  try {
    assert.equal(await owner.initialize(), false);
    await assert.rejects(owner.close(), /offline recovery/);
    assert.equal(existsSync(f.lock), true); assert.throws(() => new CopilotOwnedRuntime(f.options));
  } finally { await owner.close().catch(() => {}); f.cleanup(); }
});
