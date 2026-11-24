import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import asyncFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer, findOpaqueSecrets, type CodexAppServerOptions } from './app-server.js';
import type { CodexExecution } from './executions.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const terminalFact = (): CodexExecution => ({ sessionKey: 'codex:synthetic', commandId: 'owned', connectionId: 'synthetic-connection',
  runId: 'original-run', phase: 'completed', sync: 'current', revision: 3, startedAt: 1, updatedAt: 2, completedAt: 2 });

test('owned credential preparation requires worker observation and cannot silently use synchronous SQL', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.codex.prepareOwnedCredentials(f.sessionKey, input, 'owned'), /unavailable/);
    assert.equal(existsSync(join(f.directory, '.agentopsdeck-codex-secrets')), false);
    assert.equal(f.starts(), 0);
  } finally { await f.close(); }
});

for (const outcome of ['not_started', 'admitted', 'unknown'] as const) {
  test(`owned credential handoff ${outcome} retains original resource outcome through close and repeated finish`, async () => {
    const f = fixture({ async get() { return undefined; } });
    try {
      f.database.codexExecutions.get = () => { throw new Error('sync resource SQL forbidden'); };
      const prepared = await f.codex.prepareOwnedCredentials(f.sessionKey, input, 'owned');
      const file = prepared.text.match(/stored at ([^\]]+)/)?.[1]!;
      assert.ok(file); assert.equal(existsSync(file), true);
      assert.equal(prepared.text.includes('AbCd0123+/'.repeat(31)), false);
      prepared.dispatching();
      assert.throws(() => prepared.dispatching(), /invalidated/);
      await prepared.finish(outcome);
      await prepared.finish('not_started');
      assert.equal(existsSync(file), outcome !== 'not_started');
      await f.codex.close();
      assert.equal(existsSync(file), outcome !== 'not_started');
      assert.equal(f.starts(), 0);
    } finally { await f.close(); }
  });
}

test('owned finish preserves its original rejection without an unobserved rejecting branch', async () => {
  const f = fixture({ async get() { return undefined; } });
  const cleanup = f.runtime.cleanupSecretFiles;
  try {
    const prepared = await f.codex.prepareOwnedCredentials(f.sessionKey, input, 'owned');
    let attempts = 0;
    f.runtime.cleanupSecretFiles = async () => { attempts++; throw new Error('synthetic physical finish failure'); };
    await assert.rejects(prepared.finish('not_started'), /physical finish failure/);
    await assert.rejects(prepared.finish('unknown'), /physical finish failure/);
    await tick();
    assert.equal(attempts, 1);
    assert.throws(() => prepared.dispatching(), /invalidated/);
  } finally { f.runtime.cleanupSecretFiles = cleanup; await f.close(); }
});

for (const stage of ['observation', 'removal'] as const) {
  test(`throwing credential ${stage} diagnostic sink cannot change retention or physical close`, async t => {
    const f = fixture({ async get() {
      if (stage === 'observation') throw new Error('synthetic observation failure');
      return terminalFact();
    } });
    let restoreRemoval: (() => void) | undefined;
    const warning = t.mock.method(console, 'warn', () => { throw new Error('synthetic diagnostic failure'); });
    try {
      const prepared = await f.codex.prepareOwnedCredentials(f.sessionKey, input, 'owned');
      const file = prepared.text.match(/stored at ([^\]]+)/)?.[1]!;
      prepared.dispatching(); await prepared.finish('unknown');
      if (stage === 'removal') {
        const removal = t.mock.method(asyncFs, 'rm', async () => { throw new Error('synthetic removal failure'); });
        restoreRemoval = () => removal.mock.restore();
        syncBuiltinESMExports();
      }
      await f.runtime.cleanupSecretFiles(f.sessionKey);
      assert.equal(existsSync(file), true);
      await f.codex.close();
      assert.equal(existsSync(file), true);
    } finally {
      restoreRemoval?.(); warning.mock.restore(); syncBuiltinESMExports(); await f.close();
    }
  });
}

for (const change of ['session', 'command', 'connection', 'no-run', 'unknown', 'running', 'missing', 'malformed', 'throw', 'terminal'] as const) {
  test(`worker credential cleanup ${change} never consults main-thread SQL or deletes on foreign evidence`, async t => {
    let fact: CodexExecution | undefined = terminalFact(), fail = false;
    const f = fixture({ async get() { if (fail) throw new Error('PRIVATE-CREDENTIAL-READ'); return fact; } });
    const warnings: string[] = []; t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
    try {
      f.database.codexExecutions.get = () => { throw new Error('sync resource SQL forbidden'); };
      const prepared = await f.codex.prepareOwnedCredentials(f.sessionKey, input, 'owned');
      const file = prepared.text.match(/stored at ([^\]]+)/)?.[1]!;
      prepared.dispatching(); await prepared.finish('admitted');
      if (change === 'session') fact.sessionKey = 'codex:foreign';
      if (change === 'command') fact.commandId = 'foreign';
      if (change === 'connection') fact.connectionId = 'replacement';
      if (change === 'no-run') delete fact.runId;
      if (change === 'unknown') fact.phase = 'unknown';
      if (change === 'running') fact.phase = 'running';
      if (change === 'missing') fact = undefined;
      if (change === 'malformed') fact!.revision = NaN;
      if (change === 'throw') fail = true;
      await f.runtime.cleanupSecretFiles(f.sessionKey);
      assert.equal(existsSync(file), change !== 'terminal');
      assert.equal(warnings.join('').includes('PRIVATE-CREDENTIAL-READ'), false);
      assert.equal(warnings.join('').includes(file), false);
    } finally { await f.close(); }
  });
}

test('close and duplicate cleanup wait for the original worker observation, not a modified public Promise', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ async get() { entered.resolve(); await gate.promise; return terminalFact(); } });
  try {
    f.database.codexExecutions.get = () => { throw new Error('sync resource SQL forbidden'); };
    const prepared = await f.codex.prepareOwnedCredentials(f.sessionKey, input, 'owned');
    const file = prepared.text.match(/stored at ([^\]]+)/)?.[1]!;
    prepared.dispatching(); await prepared.finish('admitted');
    const cleanup = f.runtime.cleanupSecretFiles(f.sessionKey) as Promise<void>; await entered.promise;
    Object.defineProperty(cleanup, 'then', { value: (done: () => unknown) => Promise.resolve(done()) });
    let closed = false; const closing = f.codex.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(existsSync(file), true);
    gate.resolve(); await closing; assert.equal(existsSync(file), false);
  } finally { gate.resolve(); await f.close(); }
});

test('worker observation finishing late cannot delete a replacement resource owner', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ async get() { entered.resolve(); await gate.promise; return terminalFact(); } });
  try {
    const prepared = await f.codex.prepareOwnedCredentials(f.sessionKey, input, 'owned');
    const file = prepared.text.match(/stored at ([^\]]+)/)?.[1]!;
    prepared.dispatching(); await prepared.finish('unknown');
    const cleanup = f.runtime.cleanupSecretFiles(f.sessionKey); await entered.promise;
    const successor = { commandId: 'successor', connectionId: 'replacement', dispatched: true, directory: join(f.directory, 'successor') };
    fs.mkdirSync(successor.directory); f.runtime.activeSecretFiles.set(f.sessionKey, successor);
    gate.resolve(); await cleanup;
    assert.equal(existsSync(file), true); assert.equal(existsSync(successor.directory), true);
    assert.equal(f.runtime.activeSecretFiles.get(f.sessionKey), successor);
  } finally { gate.resolve(); await f.close(); }
});

test('owned preparation registers before file work, and close drains it despite public Promise tampering', async t => {
  const f = fixture({ async get() { return undefined; } }), gate = deferred(), entered = deferred();
  const write = asyncFs.writeFile;
  const mock = t.mock.method(asyncFs, 'writeFile', async (...args: Parameters<typeof write>) => {
    entered.resolve(); await gate.promise; return write(...args);
  });
  syncBuiltinESMExports();
  try {
    const work = f.codex.prepareOwnedCredentials(f.sessionKey, input, 'owned');
    const rejected = assert.rejects(work, /temporary credential directory/); await entered.promise;
    Object.defineProperty(work, 'then', { value: (done: () => unknown) => Promise.resolve(done()) });
    await assert.rejects(f.codex.prepareOwnedCredentials(f.sessionKey, input, 'duplicate'), /unavailable/);
    let closed = false; const closing = f.codex.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    gate.resolve(); await rejected; await closing;
    assert.deepEqual(readdirSync(join(f.directory, '.agentopsdeck-codex-secrets')), []);
    assert.equal(f.starts(), 0);
  } finally { gate.resolve(); mock.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

// Synthetic opaque input only; no host configuration, native process or token.
const input = `Synthetic value: ${'AbCd0123+/'.repeat(31)}==`;
function fixture(credentialExecutionReader?: CodexAppServerOptions['credentialExecutionReader']) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-secret-lifecycle-'));
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const sessionKey = 'codex:synthetic';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic resource lifecycle', status: 'idle' });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions,
    authorizeTurn: () => true, ...(credentialExecutionReader ? { credentialExecutionReader } : {}) });
  const runtime = codex as any;
  runtime.connectionId = 'synthetic-connection';
  runtime.ensureStarted = async () => {};
  runtime.ensureThreadLoaded = async () => {};
  // Direct dispatch tests begin after the worker's validated predecessor read.
  runtime.threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  runtime.reconcileCompletedTurn = () => {};
  let file = '', starts = 0;
  runtime.request = async (method: string, params: any) => {
    assert.equal(method, 'turn/start'); starts++;
    file = params.input[0].text.match(/stored at ([^\]]+)/)?.[1] ?? '';
    assert.ok(file); assert.equal(existsSync(file), true);
    return { turn: { id: 'native' } };
  };
  return { directory, database, store, sessionKey, codex, runtime, file: () => file, starts: () => starts,
    complete: (id = 'native', status = 'completed') => runtime.handleNotification('turn/completed', {
      threadId: 'synthetic', turn: { id, status, ...(status === 'failed' ? { error: { message: 'synthetic failure' } } : {}) },
    }),
    close: async () => { await codex.close(); database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const failure of ['rpc-error', 'missing-ack', 'close-during-start', 'running-close', 'foreign-early-terminal']) {
  test(`Codex keeps staged resources when execution may still use them: ${failure}`, async () => {
    const f = fixture();
    const request = f.runtime.request;
    f.runtime.request = async (method: string, params: unknown) => {
      const result = await request(method, params);
      if (failure === 'rpc-error') throw new Error('synthetic lost ACK');
      if (failure === 'missing-ack') return {};
      if (failure === 'close-during-start') void f.codex.close();
      if (failure === 'foreign-early-terminal') f.complete('foreign');
      return result;
    };
    try {
      const accepted = await f.codex.send(f.sessionKey, input);
      await f.runtime.drainQueuedTurn(f.sessionKey);
      if (failure === 'running-close' || failure === 'close-during-start') await f.codex.close();
      assert.equal(existsSync(f.file()), true, 'uncertain dispatch or shutdown is not proof that the resource is unused');
      assert.equal(f.starts(), 1);
      if (failure === 'rpc-error' || failure === 'missing-ack' || failure === 'close-during-start') {
        assert.equal(f.database.turns.head('codex', f.sessionKey)?.id, accepted.idempotencyKey);
        assert.equal(f.database.turns.head('codex', f.sessionKey)?.state, 'outcome_unknown');
      }
      await f.codex.close();
      assert.equal(existsSync(f.file()), true, 'closing the adapter must not delete resources from an unresolved run');
    } finally { await f.close(); }
  });
}

for (const status of ['completed', 'failed', 'interrupted']) {
  test(`Codex early ${status} evidence cannot reclaim files before the matching native ACK`, async () => {
    const f = fixture();
    const request = f.runtime.request;
    f.runtime.request = async (method: string, params: unknown) => {
      const result = await request(method, params);
      f.complete('native', status);
      assert.equal(existsSync(f.file()), true, 'early terminal evidence has not yet bound this command');
      return result;
    };
    try {
      await f.codex.send(f.sessionKey, input);
      await f.runtime.drainQueuedTurn(f.sessionKey);
      assert.equal(f.database.codexExecutions.get(f.sessionKey)?.phase, status);
      assert.equal(existsSync(f.file()), false, 'matching ACK and terminal evidence permit reclamation');
    } finally { await f.close(); }
  });
}

test('Codex a delayed predecessor terminal cannot reclaim a successor resource staged before native dispatch', async () => {
  const f = fixture();
  try {
    await f.codex.send(f.sessionKey, input);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    f.complete();
    await f.runtime.cleanupSecretFiles(f.sessionKey);
    const previous = f.database.codexExecutions.get(f.sessionKey)!;
    f.database.codexExecutions.settleHistory(previous, 'current');
    const prompt = await f.runtime.bridgeOpaqueSecrets(f.sessionKey, input, 'successor');
    const nextFile = prompt.match(/stored at ([^\]]+)/)?.[1];
    assert.ok(nextFile);
    // A repeated terminal is allowed through the legacy projection retry path.
    f.runtime.completedTurnIds.clear();
    f.complete();
    assert.equal(existsSync(nextFile), true, 'terminal proof belongs to the predecessor, not this new preparation');
  } finally { await f.close(); }
});

test('Codex releases files when preparation fails before any native dispatch attempt', async () => {
  const f = fixture();
  try {
    f.runtime.startTurn = async () => { throw new Error('synthetic preparation failure'); };
    await f.codex.send(f.sessionKey, input);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(f.starts(), 0);
    assert.deepEqual(readdirSync(join(f.directory, '.agentopsdeck-codex-secrets')), []);
  } finally { await f.close(); }
});

for (const status of ['completed', 'failed', 'interrupted']) {
  for (const recovered of [false, true]) {
    test(`Codex reclaims matching ${status} resources via ${recovered ? 'history recovery' : 'live notification'}`, async () => {
      const f = fixture();
      try {
        await f.codex.send(f.sessionKey, input);
        await f.runtime.drainQueuedTurn(f.sessionKey);
        assert.equal(existsSync(f.file()), true);
        if (recovered) {
          f.runtime.request = async (method: string) => {
            if (method === 'thread/backgroundTerminals/list') return { data: [] };
            assert.equal(method, 'thread/read');
            return { thread: { id: 'synthetic', turns: [{ id: 'native', status, items: [] }] } };
          };
          await f.codex.refreshSession(f.sessionKey);
        } else f.complete('native', status);
        await f.runtime.cleanupSecretFiles(f.sessionKey);
        assert.equal(f.database.codexExecutions.get(f.sessionKey)?.phase, status);
        assert.equal(existsSync(f.file()), false);
        assert.equal(f.runtime.activeSecretFiles.size, 0);
        assert.equal(f.starts(), 1);
      } finally { await f.close(); }
    });
  }
}

test('Codex unavailable execution evidence cannot reclaim dispatched resources', async () => {
  const f = fixture();
  try {
    await f.codex.send(f.sessionKey, input);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    f.database.codexExecutions.observe(f.sessionKey, 'synthetic-connection', 'native', 'completed');
    f.runtime.executionUnavailable = true;
    await f.runtime.cleanupSecretFiles(f.sessionKey);
    await f.codex.close();
    assert.equal(existsSync(f.file()), true);
  } finally { await f.close(); }
});

test('Codex refuses to overwrite unresolved resource ownership', async () => {
  const f = fixture();
  try {
    await f.codex.send(f.sessionKey, input);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    const original = f.runtime.activeSecretFiles.get(f.sessionKey);
    await assert.rejects(f.runtime.bridgeOpaqueSecrets(f.sessionKey, input, 'successor'), /unresolved/);
    assert.equal(f.runtime.activeSecretFiles.get(f.sessionKey), original);
    assert.equal(existsSync(f.file()), true);
    assert.equal(readdirSync(join(f.directory, '.agentopsdeck-codex-secrets')).length, 1);
  } finally { await f.close(); }
});

test('Codex async cleanup yields, deduplicates and keeps successor ownership blocked until deletion', async t => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const remove = asyncFs.rm;
  let calls = 0;
  try {
    await f.codex.send(f.sessionKey, input);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    f.database.codexExecutions.observe(f.sessionKey, 'synthetic-connection', 'native', 'completed');
    const mock = t.mock.method(asyncFs, 'rm', async (...args: Parameters<typeof remove>) => {
      calls++; entered(); await gate; return remove(...args);
    });
    syncBuiltinESMExports();
    try {
      const cleanup = f.runtime.cleanupSecretFiles(f.sessionKey);
      await started;
      const duplicate = f.runtime.cleanupSecretFiles(f.sessionKey);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.equal(existsSync(f.file()), true);
      await assert.rejects(f.runtime.bridgeOpaqueSecrets(f.sessionKey, input, 'successor'), /unresolved/);
      let closed = false;
      const closing = f.codex.close().then(() => { closed = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(closed, false, 'shutdown waits for in-flight cleanup');
      release(); await Promise.all([cleanup, duplicate, closing]);
      assert.equal(calls, 1);
      assert.equal(existsSync(f.file()), false);
      assert.equal(f.runtime.activeSecretFiles.size, 0);
      assert.equal(f.runtime.cleaningSecretFiles.size, 0);
    } finally { release(); mock.mock.restore(); syncBuiltinESMExports(); }
  } finally { await f.close(); }
});

test('Codex cleanup failure retains exact ownership and permits a later cleanup retry', async t => {
  const f = fixture();
  try {
    await f.codex.send(f.sessionKey, input);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    f.database.codexExecutions.observe(f.sessionKey, 'synthetic-connection', 'native', 'completed');
    const resources = f.runtime.activeSecretFiles.get(f.sessionKey);
    const mock = t.mock.method(asyncFs, 'rm', async () => { throw new Error('synthetic private path failure'); });
    syncBuiltinESMExports();
    try {
      await f.runtime.cleanupSecretFiles(f.sessionKey);
      assert.equal(f.runtime.activeSecretFiles.get(f.sessionKey), resources);
      assert.equal(f.runtime.cleaningSecretFiles.size, 0);
      await assert.rejects(f.runtime.bridgeOpaqueSecrets(f.sessionKey, input, 'successor'), /unresolved/);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    await f.runtime.cleanupSecretFiles(f.sessionKey);
    assert.equal(existsSync(f.file()), false);
    assert.equal(f.runtime.activeSecretFiles.size, 0);
  } finally { await f.close(); }
});

test('Codex partial preparation failure removes only its newly allocated directory', async (t) => {
  const f = fixture();
  const unrelated = join(f.directory, '.agentopsdeck-codex-secrets', 'unresolved-predecessor');
  fs.mkdirSync(unrelated, { recursive: true, mode: 0o700 });
  const write = asyncFs.writeFile;
  let writes = 0;
  const mocked = t.mock.method(asyncFs, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (String(args[0]).includes('.agentopsdeck-codex-secrets')) {
      if (++writes === 2) throw new Error('synthetic disk failure');
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    await f.codex.send(f.sessionKey, `${input}\nSecond synthetic value: ${'EfGh4567+/'.repeat(31)}==`);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(writes, 2);
    assert.equal(f.starts(), 0);
    assert.deepEqual(readdirSync(join(f.directory, '.agentopsdeck-codex-secrets')), ['unresolved-predecessor']);
    assert.equal(f.runtime.activeSecretFiles.size, 0);
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports();
    await f.close();
  }
});

for (const invalidation of ['closed', 'connection', 'executionUnavailable']) {
  test(`Codex async credential preparation yields and cleans only its own files on ${invalidation}`, async t => {
    const f = fixture();
    const predecessor = join(f.directory, '.agentopsdeck-codex-secrets', 'unrelated');
    fs.mkdirSync(predecessor, { recursive: true, mode: 0o700 });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const write = asyncFs.writeFile;
    const mock = t.mock.method(asyncFs, 'writeFile', async (...args: Parameters<typeof write>) => {
      entered(); await gate; return write(...args);
    });
    syncBuiltinESMExports();
    try {
      const pending = f.runtime.bridgeOpaqueSecrets(f.sessionKey, input, 'preparation');
      const rejected = assert.rejects(pending, /temporary credential directory/);
      await started;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.runtime.activeSecretFiles.size, 0, 'not dispatched or published while preparation is pending');
      await assert.rejects(f.runtime.bridgeOpaqueSecrets(f.sessionKey, input, 'duplicate'), /unresolved/);
      let close: Promise<void> | undefined;
      if (invalidation === 'closed') close = f.codex.close();
      else if (invalidation === 'connection') f.runtime.connectionId = 'replacement';
      else f.runtime.executionUnavailable = true;
      release(); await rejected; await close;
      assert.equal(f.starts(), 0);
      assert.equal(f.runtime.preparingSecretFiles.size, 0);
      assert.deepEqual(readdirSync(join(f.directory, '.agentopsdeck-codex-secrets')), ['unrelated']);
    } finally { release(); mock.mock.restore(); syncBuiltinESMExports(); await f.close(); }
  });
}

for (const invalidation of ['closed', 'connection', 'authorization']) {
test(`Codex never dispatches after async preparation invalidates ${invalidation}`, async () => {
  const f = fixture();
  const bridge = f.runtime.bridgeOpaqueSecrets.bind(f.runtime);
  f.runtime.bridgeOpaqueSecrets = async (...args: unknown[]) => {
    const result = await bridge(...args);
    if (invalidation === 'closed') f.runtime.closed = true;
    else if (invalidation === 'connection') f.runtime.connectionId = 'replacement';
    else f.runtime.authorized = () => false;
    return result;
  };
  try {
    await f.codex.send(f.sessionKey, input);
    await f.runtime.drainQueuedTurn(f.sessionKey);
    assert.equal(f.starts(), 0);
    assert.deepEqual(readdirSync(join(f.directory, '.agentopsdeck-codex-secrets')), []);
  } finally { await f.close(); }
});
}

test('explicit [[AOD_SECRET:...]] envelope is detected and materialized without writing wrapper markers into secret file', async () => {
  const candidates = findOpaqueSecrets('Use Credential OPENAI_API_KEY: [[AOD_SECRET:sk-live-secret-99887766]]');
  assert.deepEqual(candidates, ['[[AOD_SECRET:sk-live-secret-99887766]]']);
  const f = fixture({ async get() { return undefined; } });
  try {
    const prepared = await f.codex.prepareOwnedCredentials(f.sessionKey, 'Use Credential OPENAI_API_KEY: [[AOD_SECRET:sk-live-secret-99887766]]', 'owned-env');
    const file = prepared.text.match(/stored at ([^\]]+)/)?.[1]!;
    assert.ok(file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'sk-live-secret-99887766');
    assert.equal(prepared.text.includes('sk-live-secret-99887766'), false);
    await prepared.finish('not_started');
  } finally { await f.close(); }
});
