import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TurnQueue } from '../commands/turn-queue.js';
import { PrivateAgentHomeLease } from '../connector/private-agent-home-lease.js';
import type { AntigravitySessionUpdate } from './acp-client.js';
import type { AntigravityConfig } from './config.js';
import { AntigravityProcessWorker } from './execution-worker.js';
import { AntigravityJournal } from './journal.js';
import { AntigravityOwnedExecution } from './owned-execution.js';

const supported = { skip: process.platform !== 'linux' };

function setupFixture(context: TestContext, mode = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'aod-antigravity-worker-'));
  const homeDirectory = join(root, 'home');
  const workspace = join(root, mode);
  const binDirectory = join(root, 'bin');
  const command = join(binDirectory, 'agy');
  const storeFile = join(root, 'connector.sqlite');
  for (const directory of [homeDirectory, workspace, binDirectory]) mkdirSync(directory, { mode: 0o700 });
  for (const name of ['config', 'cache', 'data', 'tmp']) mkdirSync(join(homeDirectory, name), { mode: 0o700 });
  copyFileSync(fileURLToPath(new URL('./acp-fixture.mjs', import.meta.url)), command);
  chmodSync(command, 0o700);
  writeFileSync(storeFile, '', { mode: 0o600 });
  chmodSync(storeFile, 0o600);
  const config: AntigravityConfig = { command, homeDirectory, workspace, startupTimeoutMs: 1_000 };
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, config, homeDirectory, storeFile };
}

test('AntigravityProcessWorker drains cleanly and quiescently on natural EOF exit', supported, async context => {
  const { config } = setupFixture(context);
  const updates: AntigravitySessionUpdate[] = [];
  const worker = new AntigravityProcessWorker({
    config,
    assertOwnership: () => {},
    update: update => { updates.push(update); },
    drainGraceMs: 500,
    drainKillMs: 500,
  });
  context.after(async () => { await worker.stopAndDrain(); });
  assert.equal((await worker.initialize()).protocolVersion, 1);
  const sessionId = await worker.newSession();
  assert.equal(sessionId, 'synthetic-native-session');
  const promptResult = await worker.prompt('synthetic prompt', async () => {});
  assert.deepEqual(promptResult, { stopReason: 'end_turn' });
  assert.equal(updates.length, 1);
  const evidence = await worker.stopAndDrain();
  assert.deepEqual(evidence, { cleaned: true, quiescent: true });
  assert.deepEqual(await worker.stopAndDrain(), { cleaned: true, quiescent: true });
  await assert.rejects(worker.initialize());
});

test('AntigravityProcessWorker forces process-group cleanup and reports non-quiescent when child hangs or leaves descendants', supported, async context => {
  for (const promptText of ['hang-after-response', 'lingering-descendant']) {
    const { config } = setupFixture(context);
    const worker = new AntigravityProcessWorker({
      config,
      assertOwnership: () => {},
      update: () => {},
      drainGraceMs: 120,
      drainKillMs: 500,
    });
    context.after(async () => { await worker.stopAndDrain(); });
    await worker.initialize();
    await worker.newSession();
    const promptResult = await worker.prompt(promptText, async () => {});
    assert.deepEqual(promptResult, { stopReason: 'end_turn' });
    const evidence = await worker.stopAndDrain();
    assert.deepEqual(evidence, { cleaned: true, quiescent: false });
  }
});

test('End-to-end AntigravityOwnedExecution with AntigravityJournal and AntigravityProcessWorker binds, settles, and resumes', supported, async context => {
  const { config, homeDirectory, storeFile } = setupFixture(context);
  const database = new DatabaseSync(storeFile);
  context.after(() => database.close());
  const turns = new TurnQueue(database);
  const journal = new AntigravityJournal(database);
  const sessionKey = 'antigravity:synthetic-session';
  const ownerEpoch = `epoch_${randomUUID()}`;
  const nodeId = `node_${randomUUID()}`;
  journal.create({ key: sessionKey, title: 'Synthetic Session', createdAt: 1_000 });

  turns.enqueue('antigravity', {
    id: 'command-1',
    sessionKey,
    createdAt: 1_000,
    payload: { text: 'first turn', actorId: 'owner' },
  });
  const firstIdentity = { key: sessionKey, executionId: 'exec-1', ownerEpoch };
  journal.begin(firstIdentity, ['command-1'], turns);

  const firstLease = PrivateAgentHomeLease.acquire('antigravity', homeDirectory, storeFile, nodeId);
  const updates: AntigravitySessionUpdate[] = [];
  const firstExecution = new AntigravityOwnedExecution({
    identity: firstIdentity,
    homeLease: firstLease,
    assertOwnership: () => {},
    journal: {
      assertBinding: (actual, nativeId) => journal.assertBinding(actual, nativeId),
      bindAndPersistIntent: async (actual, nativeId) => journal.bindAndPersistIntentSync(actual, nativeId, turns),
      settle: async (actual, result) => journal.settleSync(actual, result, turns),
    },
    createWorker: hooks => new AntigravityProcessWorker({
      config,
      assertOwnership: hooks.assertOwnership,
      update: hooks.update,
      drainGraceMs: 500,
      drainKillMs: 500,
    }),
    update: (_actual, update) => { updates.push(update); },
  });
  const firstResult = await firstExecution.run('first turn');
  assert.deepEqual(firstResult, { outcome: 'completed', nativeSessionId: 'synthetic-native-session' });
  assert.equal(existsSync(join(homeDirectory, '.agentopsdeck-antigravity-owner')), false);
  assert.equal(journal.session(sessionKey)?.nativeSessionId, 'synthetic-native-session');
  assert.equal(journal.session(sessionKey)?.nativeState, 'ready');
  assert.equal(updates.length, 1);

  turns.enqueue('antigravity', {
    id: 'command-2',
    sessionKey,
    createdAt: 2_000,
    payload: { text: 'second turn', actorId: 'owner' },
  });
  const secondIdentity = { key: sessionKey, executionId: 'exec-2', ownerEpoch };
  journal.begin(secondIdentity, ['command-2'], turns);

  const secondLease = PrivateAgentHomeLease.acquire('antigravity', homeDirectory, storeFile, nodeId);
  const secondExecution = new AntigravityOwnedExecution({
    identity: secondIdentity,
    resumeSessionId: 'synthetic-native-session',
    homeLease: secondLease,
    assertOwnership: () => {},
    journal: {
      assertBinding: (actual, nativeId) => journal.assertBinding(actual, nativeId),
      bindAndPersistIntent: async (actual, nativeId) => journal.bindAndPersistIntentSync(actual, nativeId, turns),
      settle: async (actual, result) => journal.settleSync(actual, result, turns),
    },
    createWorker: hooks => new AntigravityProcessWorker({
      config,
      assertOwnership: hooks.assertOwnership,
      update: hooks.update,
      drainGraceMs: 500,
      drainKillMs: 500,
    }),
    update: (_actual, update) => { updates.push(update); },
  });
  const secondResult = await secondExecution.run('second turn');
  assert.deepEqual(secondResult, { outcome: 'completed', nativeSessionId: 'synthetic-native-session' });
  assert.equal(existsSync(join(homeDirectory, '.agentopsdeck-antigravity-owner')), false);
  assert.equal(journal.session(sessionKey)?.nativeState, 'ready');
  assert.equal(journal.pendingCount(), 0);
  assert.equal(updates.length, 2);
});
