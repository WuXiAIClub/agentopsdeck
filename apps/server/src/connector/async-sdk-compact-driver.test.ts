import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncSdkCompactDriver } from './async-sdk-compact-driver.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import type { SdkAgentId, SdkCompactRef, SdkCompactResult } from './sdk-execution-journal.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const authorization = 'Bearer isolated-compact-lifecycle';
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) { assert.ok(Date.now() < deadline); await delay(2); }
}
function fixture(runtime: SdkAgentId, options: { badProof?: boolean; closeThrows?: boolean; deadlineMs?: number; closeFinishes?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-compact-lifecycle-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), 'isolated-compact-lifecycle');
  const actorId = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', token => tokens.hasScope(token, 'messages:send'), { runtimeOwner: true });
  const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal, key = `${runtime}:session`;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  store.turns.enqueue(runtime, { id: 'first', sessionKey: key, createdAt: 0, payload: { actorId, text: 'first', images: [] } });
  const first = { key, id: 'first-run', epoch: 'old' };
  journal.begin(first, ['first'], store.turns); journal.observeTerminal(first, 'completed', store.turns); journal.confirmSettled(first);
  const owner = { command: createConnectorOwnerCommands(store, tokens) };
  const calls: { ref: SdkCompactRef; result: ReturnType<typeof gate<SdkCompactRef & SdkCompactResult>>;
    finished: ReturnType<typeof gate<void>>; quiet: boolean; closes: number; interrupts: number }[] = [];
  let faults = 0, drains = 0, occupied = false;
  const driver = new AsyncSdkCompactDriver({ owner, runtime, epoch: 'epoch', deadlineMs: options.deadlineMs ?? 1_000,
    ready: () => true, occupied: () => occupied, drained: () => { drains++; }, faulted: () => { faults++; },
    diagnostics: new PerformanceDiagnostics(() => {}), models: { model: 'default' },
    start(execution) {
      const call = { ref: execution, result: gate<SdkCompactRef & SdkCompactResult>(), finished: gate(), quiet: false, closes: 0, interrupts: 0 };
      calls.push(call);
      return { result: call.result.promise, finished: call.finished.promise,
        inspectQuiescence: async () => call.quiet && !options.badProof,
        inspectSettlement: async () => ({ ...execution, completionEventId: 'boundary', historyPersisted: true, nativeQuiescent: true }),
        interrupt: async () => { call.interrupts++; },
        close: () => {
          call.closes++;
          if (options.closeFinishes) { call.quiet = true; call.finished.resolve(); }
          if (options.closeThrows) throw Error('private native detail');
        } };
    } });
  function result(index = 0) {
    const call = calls[index]!;
    call.result.resolve({ ...call.ref, nativeRequestId: call.ref.id, completionEventId: 'boundary', outcome: 'completed' });
  }
  function finish(index = 0) { calls[index]!.quiet = true; calls[index]!.finished.resolve(); }
  return { driver, journal, key, calls, result, finish, tokens, actorId,
    faults: () => faults, drains: () => drains, occupied: (value: boolean) => { occupied = value; },
    async dispose() {
      for (let i = 0; i < calls.length; i++) { result(i); finish(i); }
      await driver.close().catch(() => {}); store.close(); rmSync(directory, { recursive: true, force: true });
    } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: early compact result cannot settle or release physical occupancy; duplicate never replays`, async () => {
    const f = fixture(runtime);
    try {
      const task = f.driver.compact(f.key, 'command', authorization);
      await until(() => f.calls.length === 1); f.result(); await delay(5);
      assert.equal(f.driver.has(f.key), true); assert.equal(f.journal.current(f.key)?.phase, 'dispatching');
      f.finish(); assert.equal(await task, 'accepted');
      assert.equal(f.journal.current(f.key)?.phase, 'completed'); assert.equal(f.driver.has(f.key), false);
      assert.equal(await f.driver.compact(f.key, 'command', authorization), 'accepted');
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.closes, 1); assert.equal(f.faults(), 0);
    } finally { await f.dispose(); }
  });
  test(`${runtime}: maintenance pause blocks new admission but preserves authorized original stop and settlement`, async () => {
    const f = fixture(runtime);
    try {
      const task = f.driver.compact(f.key, 'command', authorization);
      await until(() => f.calls.length === 1); f.driver.pause();
      assert.equal(await f.driver.compact(f.key, 'other', authorization), 'not_started');
      assert.equal(await f.driver.interrupt(f.key, 'stale', authorization), 'not_started');
      assert.equal(await f.driver.interrupt(f.key, f.calls[0]!.ref.id, authorization), 'accepted');
      assert.equal(f.calls[0]!.interrupts, 1);
      f.result(); f.finish(); assert.equal(await task, 'accepted');
      assert.equal(f.journal.current(f.key)?.phase, 'completed'); assert.equal(f.faults(), 0);
    } finally { await f.dispose(); }
  });
  test(`${runtime}: revoked original authority cannot stop native compact`, async () => {
    const f = fixture(runtime);
    try {
      const task = f.driver.compact(f.key, 'command', authorization);
      await until(() => f.calls.length === 1); f.tokens.revoke(f.actorId);
      assert.equal(await f.driver.interrupt(f.key, f.calls[0]!.ref.id, authorization), 'blocked');
      assert.equal(f.calls[0]!.interrupts, 0); f.result(); f.finish(); assert.equal(await task, 'accepted');
    } finally { await f.dispose(); }
  });
  test(`${runtime}: timeout retains original result and physical finish, marks unknown and never replays`, async () => {
    const f = fixture(runtime, { deadlineMs: 25 });
    try {
      const task = f.driver.compact(f.key, 'command', authorization); let returned = false;
      void task.then(() => { returned = true; });
      await until(() => f.calls.length === 1); await until(() => f.calls[0]!.closes === 1);
      assert.equal(returned, false); assert.equal(f.driver.has(f.key), true);
      assert.equal(f.journal.current(f.key)?.phase, 'unknown'); f.result(); f.finish();
      assert.equal(await task, 'unknown');
      assert.equal(await f.driver.compact(f.key, 'command', authorization), 'not_started'); assert.equal(f.calls.length, 1);
    } finally { await f.dispose(); }
  });
  test(`${runtime}: close freezes admission immediately and waits original promises even after physical exit`, async () => {
    const f = fixture(runtime, { closeFinishes: true });
    try {
      const task = f.driver.compact(f.key, 'command', authorization);
      await until(() => f.calls.length === 1);
      const closing = f.driver.close(); let closed = false; void closing.then(() => { closed = true; });
      assert.equal(await f.driver.compact(f.key, 'other', authorization), 'not_started');
      await delay(5); assert.equal(closed, false); f.result();
      assert.equal(await task, 'unknown'); await closing; assert.equal(f.calls[0]!.closes, 1);
    } finally { await f.dispose(); }
  });
  test(`${runtime}: corrupted physical proof permanently fences resume and close reports failure`, async () => {
    const f = fixture(runtime, { badProof: true });
    try {
      const task = f.driver.compact(f.key, 'command', authorization);
      await until(() => f.calls.length === 1); f.result(); f.finish();
      assert.equal(await task, 'unknown'); assert.ok(f.faults() > 0); f.driver.resume();
      assert.equal(await f.driver.compact(f.key, 'other', authorization), 'not_started');
      await assert.rejects(f.driver.close(), /cleanup could not be confirmed/);
    } finally { await f.dispose(); }
  });
}
