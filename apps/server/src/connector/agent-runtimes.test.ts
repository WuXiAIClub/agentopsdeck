import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorAgentRuntimes, connectorAgentId, type ConnectorAgentLifecycle } from './agent-runtimes.js';

function agent(id: ConnectorAgentLifecycle['id'], calls: string[] = []): ConnectorAgentLifecycle {
  return { id, refreshSession: async key => { calls.push(key); }, isSessionHistoryReady: () => true,
    pauseQueueWorker: () => { calls.push(`pause:${id}`); return { drained: Promise.resolve(), resume: () => { calls.push(`resume:${id}`); return true; } }; },
    close: async () => { calls.push(`close:${id}`); } };
}

test('routes exact runtime prefixes, never aliases or substrings', async () => {
  const calls: string[] = [], runtimes = new ConnectorAgentRuntimes([agent('codex', calls), agent('hermes', calls)]);
  for (const id of ['codex', 'hermes'] as const) {
    assert.equal(connectorAgentId(`${id}:same-native-id`), id);
    await runtimes.forSession(`${id}:same-native-id`)!.refreshSession(`${id}:same-native-id`, {});
    assert.equal(runtimes.historyReady(`${id}:same-native-id`), true);
  }
  assert.deepEqual(calls, ['codex:same-native-id', 'hermes:same-native-id']);
  for (const key of ['agent:main:codex:x', 'codexish:x', 'codex', 'codexX', 'hub:hermes:x']) {
    assert.equal(connectorAgentId(key), undefined);
    assert.equal(runtimes.forSession(key), undefined);
    assert.equal(runtimes.historyReady(key), undefined);
  }
});

test('disabled and reserved new runtimes cannot fall back to OpenClaw', () => {
  const runtimes = new ConnectorAgentRuntimes([agent('codex')]);
  for (const id of ['hermes', 'claude-code', 'ghcp']) {
    assert.throws(() => runtimes.forSession(`${id}:example`), /disabled/);
    assert.equal(runtimes.historyReady(`${id}:example`), false);
  }
  assert.throws(() => new ConnectorAgentRuntimes([agent('codex'), agent('codex')]), /Duplicate/);
});

test('maintenance waits for every runtime and consumes resume lease only once', async () => {
  const calls: string[] = [], slow = agent('hermes', calls);
  let release!: () => void;
  slow.pauseQueueWorker = () => ({ drained: new Promise(resolve => { release = resolve; }), resume: () => true });
  const runtimes = new ConnectorAgentRuntimes([agent('codex', calls), slow]);
  const pause = runtimes.pauseQueueWorkers();
  assert.equal(pause.resume(), false);
  await Promise.resolve();
  assert.deepEqual(calls, ['pause:codex']);
  release(); await pause.drained;
  assert.equal(pause.resume(), true);
  assert.equal(pause.resume(), false);
});

test('a refused resume re-pauses all runtimes', async () => {
  const calls: string[] = [], refusing = agent('hermes', calls);
  refusing.pauseQueueWorker = () => { calls.push('pause:hermes'); return { drained: Promise.resolve(), resume: () => false }; };
  const runtimes = new ConnectorAgentRuntimes([agent('codex', calls), refusing]);
  const pause = runtimes.pauseQueueWorkers(); await pause.drained;
  assert.equal(pause.resume(), false);
  assert.deepEqual(calls, ['pause:codex', 'pause:hermes', 'resume:codex', 'pause:codex', 'pause:hermes']);
});

test('shutdown attempts and drains all runtimes even after one fails; no raw native error', async () => {
  const calls: string[] = [], broken = agent('codex'), slow = agent('hermes', calls);
  let release!: () => void;
  broken.close = async () => { throw new Error('PRIVATE_NATIVE_TEXT'); };
  slow.close = () => new Promise(resolve => { release = resolve; });
  const runtimes = new ConnectorAgentRuntimes([broken, slow]);
  const paused = runtimes.pauseQueueWorkers(); await paused.drained;
  const close = runtimes.close();
  assert.equal(runtimes.close(), close);
  assert.equal(paused.resume(), false);
  assert.equal(runtimes.historyReady('codex:x'), false);
  assert.throws(() => runtimes.forSession('codex:x'), /closing/);
  await Promise.resolve(); release();
  await assert.rejects(close, error => error instanceof Error && !error.message.includes('PRIVATE_NATIVE_TEXT'));
});

test('a thrown resume re-pauses every runtime and never exposes native diagnostics', async () => {
  const calls: string[] = [], broken = agent('hermes', calls);
  broken.pauseQueueWorker = () => { calls.push('pause:hermes'); return { drained: Promise.resolve(), resume: () => { throw new Error('PRIVATE'); } }; };
  const runtimes = new ConnectorAgentRuntimes([agent('codex', calls), broken]);
  const pause = runtimes.pauseQueueWorkers(); await pause.drained;
  assert.equal(pause.resume(), false);
  assert.equal(pause.resume(), false);
  assert.deepEqual(calls, ['pause:codex', 'pause:hermes', 'resume:codex', 'pause:codex', 'pause:hermes']);
});

test('pause attempts all runtimes even if one throws; a failed drain never resumes', async () => {
  const calls: string[] = [], broken = agent('codex');
  broken.pauseQueueWorker = () => { throw new Error('PRIVATE'); };
  const runtimes = new ConnectorAgentRuntimes([broken, agent('hermes', calls)]);
  assert.throws(() => runtimes.pauseQueueWorkers(), /execution fence must remain closed/);
  assert.deepEqual(calls, ['pause:hermes']);

  broken.pauseQueueWorker = () => ({ drained: Promise.reject(new Error('PRIVATE')), resume: () => { throw new Error('must not resume'); } });
  const lease = runtimes.pauseQueueWorkers();
  await assert.rejects(lease.drained, /Connector runtime drain failed/);
  assert.equal(lease.resume(), false);
});

test('a re-pause failure still attempts later runtimes and keeps the lease unusable', async () => {
  const calls: string[] = [], broken = agent('codex');
  let pauses = 0;
  broken.pauseQueueWorker = () => {
    if (++pauses > 1) throw new Error('PRIVATE');
    return { drained: Promise.resolve(), resume: () => false };
  };
  const runtimes = new ConnectorAgentRuntimes([broken, agent('hermes', calls)]);
  const lease = runtimes.pauseQueueWorkers(); await lease.drained;
  assert.throws(() => lease.resume(), /execution fence must remain closed/);
  assert.equal(lease.resume(), false);
  assert.deepEqual(calls, ['pause:hermes', 'pause:hermes']);
});
