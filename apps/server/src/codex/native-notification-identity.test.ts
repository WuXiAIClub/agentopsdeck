import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from './app-server.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';

for (const aliases of [
  { turnId: 'different' },
  { thread: { id: 'different' } },
  { threadId: 'different', thread: { id: 'synthetic' } },
  { turn: { id: 'owned', status: 'completed', threadId: 'different' } },
  { item: { threadId: 'different' } },
  { turnId: null },
]) test('contradictory native lifecycle cannot settle execution or automation completion', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-native-identity-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  const key = 'codex:synthetic';
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  t.after(async () => { await codex.close(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  const runtime = codex as any;
  runtime.setConnection('connection');
  let completions = 0, interactions = 0;
  runtime.interactions = { notification: () => { interactions++; }, reset: () => {} };
  runtime.automationCompletions.live = () => { completions++; };
  users.codexExecutions.begin(key, 'command', 'connection');
  users.codexExecutions.acknowledge(key, 'command', 'connection', 'owned', () => {});
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'running',
    runtime: { turnId: 'owned', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
  const fact = users.codexExecutions.get(key), session = store.getSession(key);
  const epoch = runtime.nativeUnscopedActivityEpoch;
  runtime.receive(JSON.stringify({ method: 'turn/completed', params: {
    threadId: 'synthetic', turn: { id: 'owned', status: 'completed' }, ...aliases,
  } }));
  assert.deepEqual(users.codexExecutions.get(key), fact);
  assert.deepEqual(store.getSession(key), session);
  assert.equal(store.getMessages(key).length, 0);
  assert.equal(completions, 0);
  assert.equal(interactions, 0, 'conflicting identities cannot end a live interaction owner');
  assert.equal(users.codexExecutions.canStart(key), false);
  if ('thread' in aliases || 'item' in aliases || 'turn' in aliases) {
    assert.equal(runtime.nativeUnscopedActivityEpoch, epoch + 1, 'Ambiguous scope invalidates all in-flight reads');
  }
});

test('benign global account and mcp notifications do not invalidate nativeUnscopedActivityEpoch unless identity conflicts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-native-identity-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  t.after(async () => { await codex.close(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  const runtime = codex as any;
  runtime.setConnection('connection');
  const epoch = runtime.nativeUnscopedActivityEpoch;
  runtime.receive(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex' } } }));
  runtime.receive(JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } }));
  runtime.receive(JSON.stringify({ method: 'mcpServer/startupStatus/updated', params: { name: 'agentopsdeck-board', status: 'ready' } }));
  assert.equal(runtime.nativeUnscopedActivityEpoch, epoch, 'Benign unscoped account/mcp notices must not invalidate display/history proofs');
  runtime.receive(JSON.stringify({ method: 'account/rateLimits/updated', params: { threadId: 'a', thread: { id: 'b' } } }));
  assert.equal(runtime.nativeUnscopedActivityEpoch, epoch + 1, 'Conflicting thread aliases still invalidate the unscoped epoch');
});
