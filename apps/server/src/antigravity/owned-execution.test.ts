import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PrivateAgentHomeLease } from '../connector/private-agent-home-lease.js';
import type { AntigravitySessionUpdate } from './acp-client.js';
import { AntigravityOwnedExecution, type AntigravityExecutionResult, type AntigravityExecutionWorker,
  type AntigravityOwnedExecutionOptions } from './owned-execution.js';

const supported = { skip: process.platform !== 'linux' };
const nativeSessionId = 'synthetic-provider-session';
const identity = { key: 'antigravity:synthetic-session', executionId: 'synthetic-execution', ownerEpoch: 'synthetic-epoch' };
const update: AntigravitySessionUpdate = { sessionId: nativeSessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic output' } } };

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'aod-antigravity-execution-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), storeFile = join(root, 'connector.sqlite'), nodeId = `node_${randomUUID()}`;
  mkdirSync(home, { mode: 0o700 }); writeFileSync(storeFile, '', { mode: 0o600 });
  const lease = PrivateAgentHomeLease.acquire('antigravity', home, storeFile, nodeId);
  const events: string[] = [], results: AntigravityExecutionResult[] = [];
  let binding = false, owned = true;
  let hooks: Parameters<AntigravityOwnedExecutionOptions['createWorker']>[0];
  const worker: AntigravityExecutionWorker = {
    initialize: async () => { events.push('initialize'); return { protocolVersion: 1, agentCapabilities: {} }; },
    newSession: async () => { events.push('new'); return nativeSessionId; },
    resumeOwnedSession: async (sessionId, assertion) => { assertion(sessionId); events.push('resume'); },
    prompt: async (_text, persist) => {
      events.push('prompt'); await persist(nativeSessionId); hooks.assertOwnership();
      events.push('transmit'); hooks.update(update); return { stopReason: 'end_turn' };
    },
    cancel: () => { events.push('cancel'); },
    stopAndDrain: async () => { events.push('drain'); return { cleaned: true, quiescent: true }; },
  };
  const options: AntigravityOwnedExecutionOptions = {
    identity: { ...identity }, homeLease: lease,
    assertOwnership: () => { if (!owned) throw Error('synthetic ownership lost'); },
    journal: {
      assertBinding: (actual, sessionId) => {
        assert.deepEqual(actual, identity); assert.equal(sessionId, nativeSessionId);
        if (!binding) throw Error('synthetic foreign binding');
      },
      bindAndPersistIntent: async (actual, sessionId) => {
        assert.deepEqual(actual, identity); assert.equal(sessionId, nativeSessionId);
        events.push('persist'); binding = true;
      },
      settle: async (actual, result) => { assert.deepEqual(actual, identity); events.push('settle'); results.push(result); },
    },
    createWorker: input => { hooks = input; events.push('create'); return worker; },
    update: (actual, value) => { assert.deepEqual(actual, identity); assert.deepEqual(value, update); events.push('update'); },
  };
  return { options, worker, events, results, hooks: () => hooks, bind: () => { binding = true; },
    loseOwnership: () => { owned = false; },
    locked: () => existsSync(join(home, '.agentopsdeck-antigravity-owner')) };
}

test('Owned Antigravity execution binds before transmission and drains before durable settlement and HOME release', supported, async context => {
  const original = fixture(context), execution = new AntigravityOwnedExecution(original.options);
  original.options.identity = { key: 'antigravity:foreign', executionId: 'foreign', ownerEpoch: 'foreign' };
  assert.deepEqual(await execution.run('synthetic prompt'), { outcome: 'completed', nativeSessionId });
  assert.deepEqual(original.events, ['create', 'initialize', 'new', 'prompt', 'persist', 'transmit', 'update', 'drain', 'settle']);
  assert.equal(original.locked(), false);
  await assert.rejects(execution.run('must not replay'));
  assert.throws(() => original.hooks().update(update));
  execution.cancel();
  assert.ok(!original.events.includes('cancel'));
});

test('Owned Antigravity resume rejects foreign identities before allocating a worker', supported, async context => {
  const original = fixture(context);
  original.options.resumeSessionId = nativeSessionId;
  assert.throws(() => new AntigravityOwnedExecution(original.options));
  assert.equal(original.events.length, 0);
  original.bind();
  assert.deepEqual(await new AntigravityOwnedExecution(original.options).run('synthetic resume'), { outcome: 'completed', nativeSessionId });
  assert.ok(original.events.includes('resume'));
  assert.ok(!original.events.includes('new'));
});

test('Failed durable intent never transmits and settles only unknown after cleanup', supported, async context => {
  const original = fixture(context);
  original.options.journal.bindAndPersistIntent = async () => { throw Error('synthetic database response lost'); };
  assert.deepEqual(await new AntigravityOwnedExecution(original.options).run('synthetic prompt'), { outcome: 'unknown', nativeSessionId });
  assert.ok(!original.events.includes('transmit'));
  assert.deepEqual(original.events.slice(-2), ['drain', 'settle']);
});

test('Unacknowledged binding cannot become a successful prompt', supported, async context => {
  const original = fixture(context);
  original.options.journal.bindAndPersistIntent = async () => {};
  assert.equal((await new AntigravityOwnedExecution(original.options).run('synthetic prompt')).outcome, 'unknown');
  assert.ok(!original.events.includes('transmit'));
});

test('Lost ownership drains but refuses settlement and retains the HOME marker', supported, async context => {
  const original = fixture(context);
  original.options.journal.bindAndPersistIntent = async () => { original.bind(); original.loseOwnership(); };
  await assert.rejects(new AntigravityOwnedExecution(original.options).run('synthetic prompt'), /offline recovery/);
  assert.ok(original.events.includes('drain'));
  assert.ok(!original.events.includes('transmit'));
  assert.deepEqual(original.results, []);
  assert.equal(original.locked(), true);
});

test('Unproven process-tree cleanup cannot settle or release HOME', supported, async context => {
  const original = fixture(context);
  original.worker.stopAndDrain = async () => ({ cleaned: false, quiescent: true });
  await assert.rejects(new AntigravityOwnedExecution(original.options).run('synthetic prompt'), /offline recovery/);
  assert.deepEqual(original.results, []);
  assert.equal(original.locked(), true);
});

test('Forced cleanup downgrades a provider end_turn to unknown', supported, async context => {
  const original = fixture(context);
  original.worker.stopAndDrain = async () => ({ cleaned: true, quiescent: false });
  assert.equal((await new AntigravityOwnedExecution(original.options).run('synthetic prompt')).outcome, 'unknown');
  assert.equal(original.locked(), false);
});

test('Settlement failure retains HOME and hides underlying diagnostics', supported, async context => {
  const original = fixture(context);
  original.options.journal.settle = async () => { throw Error('synthetic private diagnostic'); };
  await assert.rejects(new AntigravityOwnedExecution(original.options).run('synthetic prompt'), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('private diagnostic')); return true;
  });
  assert.ok(original.events.includes('drain'));
  assert.equal(original.locked(), true);
});

test('Worker allocation failure is not treated as proof of process cleanup', supported, async context => {
  const original = fixture(context);
  original.options.createWorker = () => { throw Error('synthetic startup failure'); };
  await assert.rejects(new AntigravityOwnedExecution(original.options).run('synthetic prompt'), /offline recovery/);
  assert.deepEqual(original.results, []);
  assert.equal(original.locked(), true);
});

test('Cancellation during persistence never transmits or manufactures provider stop proof', supported, async context => {
  const original = fixture(context), execution = new AntigravityOwnedExecution(original.options);
  original.options.journal.bindAndPersistIntent = async () => { original.bind(); execution.cancel(); };
  assert.equal((await execution.run('synthetic prompt')).outcome, 'unknown');
  assert.ok(original.events.includes('cancel'));
  assert.ok(!original.events.includes('transmit'));
});

test('Only requested and proven cancellation can settle cancelled', supported, async context => {
  for (const requested of [false, true]) {
    const original = fixture(context), execution = new AntigravityOwnedExecution(original.options);
    original.worker.prompt = async (_text, persist) => {
      await persist(nativeSessionId);
      if (requested) execution.cancel();
      return { stopReason: 'cancelled' };
    };
    assert.equal((await execution.run('synthetic prompt')).outcome, requested ? 'cancelled' : 'unknown');
  }
});

test('Foreign-session updates abort the turn rather than entering its transcript', supported, async context => {
  const original = fixture(context);
  original.worker.prompt = async (_text, persist) => {
    await persist(nativeSessionId); original.hooks().update({ ...update, sessionId: 'synthetic-foreign' });
    return { stopReason: 'end_turn' };
  };
  assert.equal((await new AntigravityOwnedExecution(original.options).run('synthetic prompt')).outcome, 'unknown');
  assert.ok(!original.events.includes('update'));
});

test('Async authority assertions fail closed without unhandled rejections', supported, async context => {
  const original = fixture(context);
  original.options.assertOwnership = async () => { throw Error('synthetic async assertion'); };
  assert.throws(() => new AntigravityOwnedExecution(original.options), /offline recovery/);
  assert.deepEqual(original.events, []);
});

test('Constructor authority failures do not expose journal or owner diagnostics', supported, async context => {
  for (const boundary of ['owner', 'binding']) {
    const original = fixture(context);
    if (boundary === 'owner') original.options.assertOwnership = () => { throw Error('synthetic private owner diagnostic'); };
    else {
      original.options.resumeSessionId = nativeSessionId;
      original.options.journal.assertBinding = () => { throw Error('synthetic private binding diagnostic'); };
    }
    assert.throws(() => new AntigravityOwnedExecution(original.options), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /offline recovery/);
      assert.ok(!error.message.includes('private'));
      return true;
    });
    assert.equal(original.events.length, 0);
  }
});

test('Invalid scope, empty prompts and concurrent execution cannot allocate extra workers', supported, async context => {
  const original = fixture(context);
  assert.throws(() => new AntigravityOwnedExecution({ ...original.options, identity: { ...identity, key: 'codex:foreign' } }));
  const execution = new AntigravityOwnedExecution(original.options);
  await assert.rejects(execution.run(' '));
  const pending = execution.run('synthetic prompt');
  await assert.rejects(execution.run('concurrent prompt'));
  await pending;
  assert.equal(original.events.filter(event => event === 'create').length, 1);
});

test('Cancellation while initializing does not call prompt-only cancellation or start a session', supported, async context => {
  const original = fixture(context), execution = new AntigravityOwnedExecution(original.options);
  original.worker.initialize = async () => {
    execution.cancel(); return { protocolVersion: 1, agentCapabilities: {} };
  };
  assert.equal((await execution.run('synthetic prompt')).outcome, 'unknown');
  assert.ok(!original.events.includes('cancel'));
  assert.ok(!original.events.includes('new'));
  assert.ok(!original.events.includes('prompt'));
  assert.equal(original.locked(), false);
});

test('Resume binding is rechecked after asynchronous initialization before native resume', supported, async context => {
  const original = fixture(context);
  original.options.resumeSessionId = nativeSessionId; original.bind();
  const execution = new AntigravityOwnedExecution(original.options);
  original.worker.initialize = async () => {
    original.options.journal.assertBinding = () => { throw Error('synthetic reassigned session'); };
    return { protocolVersion: 1, agentCapabilities: {} };
  };
  assert.equal((await execution.run('synthetic prompt')).outcome, 'unknown');
  assert.ok(!original.events.includes('resume'));
  assert.ok(!original.events.includes('prompt'));
});
