import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createAsyncFileSessions } from './async-file-sessions.js';
import { ConnectorOwnerUnavailable, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'original-file-session-'));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), bootstrapToken: 'isolated-files' };
  const codex = `codex:${randomUUID()}`, claude = 'claude-code:public-key', copilot = 'ghcp:public-key';
  const ids = { claude: randomUUID(), copilot: randomUUID() };
  // Original DB seeded BEFORE worker ownership, never a second live writer.
  const store = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  try {
    store.codexExecutions.enrollBoardTools(codex.slice(6));
    store.claudeJournal.create({ key: claude, nativeSessionId: ids.claude, title: 'Original', createdAt: 1 });
    store.copilotJournal.create({ key: copilot, nativeSessionId: ids.copilot, title: 'Original', createdAt: 1 });
  } finally { store.close(); }
  const owner = new AsyncConnectorOwner(config, new PerformanceDiagnostics(() => {}));
  await owner.open();
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }); });
  const local = { enabled: true, tools: true, listReady: true, claudeReady: true, copilotReady: true, refreshes: 0 };
  const hooks: { refresh?: () => Promise<void> } = {};
  const native = {
    codex: { get enabled() { return local.enabled; }, boardToolsAvailable: () => local.tools,
      isSessionListReady: () => local.listReady,
      refreshSessions: async () => { local.refreshes++; await hooks.refresh?.(); local.listReady = true; } },
    sdk: { claude: { get ready() { return local.claudeReady; } }, copilot: { get ready() { return local.copilotReady; } } },
  };
  const deck = new Set([codex]);
  const sessions = createAsyncFileSessions(owner, native, { getSession: key => deck.has(key) });
  return { owner, codex, claude, copilot, ids, local, hooks, deck, sessions, config, native };
}

test('file session protocol is fixed, narrow and rejects fabricated observation fields', () => {
  assert.ok(validConnectorOwnerInput('fileSessionObserve', { sessionKey: 'ghcp:original' }));
  for (const extra of ['sql', 'authority', 'actor', 'nativeSessionId', 'ready']) {
    assert.equal(validConnectorOwnerInput('fileSessionObserve', { sessionKey: 'ghcp:original', [extra]: true }), false);
  }
  for (const row of [undefined, {}, { runtime: 'codex', deleted: false },
    { runtime: 'ghcp', deleted: false, sessionId: '' }, { runtime: 'hermes', deleted: false, sessionId: 'other' },
    { runtime: 'codex', deleted: false, boardTools: true, ready: true }]) {
    assert.equal(validConnectorOwnerOutput('fileSessionObserve', row), false);
  }
});

test('real sole-worker enrollment and native SDK IDs, not public keys, drive both resolvers', async t => {
  const f = await fixture(t), head = await f.owner.command('eventProjectionHead', {});
  assert.deepEqual(await f.sessions.boardBindingSession(f.codex), { runtime: 'codex', sessionId: f.codex.slice(6), ready: true });
  assert.deepEqual(await f.sessions.boardBindingSession(f.claude), { runtime: 'claude-code', sessionId: f.ids.claude, ready: true });
  assert.deepEqual(await f.sessions.boardBindingSession(f.copilot), { runtime: 'ghcp', sessionId: f.ids.copilot, ready: true });
  for (const key of [f.claude, f.copilot, f.codex]) assert.deepEqual(await f.sessions.workspaceSession(key), { exists: true, ready: true });
  assert.deepEqual(await f.owner.command('eventProjectionHead', {}), head, 'pure observations must not invalidate discovery');
  f.local.claudeReady = false; f.local.copilotReady = false; f.local.tools = false;
  assert.equal(await f.sessions.boardBindingSession(f.codex), undefined);
  assert.deepEqual(await f.sessions.boardBindingSession(f.claude), { runtime: 'claude-code', sessionId: f.ids.claude, ready: false });
  assert.deepEqual(await f.sessions.workspaceSession(f.copilot), { exists: true, ready: false });
});

test('Deck entries, configured tools and unsupported runtimes cannot invent original enrollment or SDK sessions', async t => {
  const f = await fixture(t);
  for (const key of [`codex:${randomUUID()}`, 'claude-code:display-only', 'ghcp:display-only', 'hermes:original', 'codex:']) {
    f.deck.add(key);
    assert.equal(await f.sessions.boardBindingSession(key), undefined);
    if (!key.startsWith('codex:') || key === 'codex:') assert.deepEqual(await f.sessions.workspaceSession(key),
      { exists: false, ready: key.startsWith('claude-code:') || key.startsWith('ghcp:') });
  }
  f.deck.delete(f.codex);
  assert.deepEqual(await f.sessions.workspaceSession(f.codex), { exists: false, ready: true });
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: original deletion receipt blocks both file consumers and survives worker reopen`, async t => {
  const f = await fixture(t), key = runtime === 'claude-code' ? f.claude : f.copilot;
  const result = await f.owner.command('sdkDeletionClaim', { runtime, key, commandKey: 'original-deletion', authorization: 'Bearer isolated-files' });
  assert.ok('receipt' in result && result.receipt.state === 'outcome_unknown');
  assert.equal(await f.sessions.boardBindingSession(key), undefined);
  assert.deepEqual(await f.sessions.workspaceSession(key), { exists: false, ready: false });
  await f.owner.close();
  const reopened = new AsyncConnectorOwner(f.config, new PerformanceDiagnostics(() => {}));
  try {
    const sessions = createAsyncFileSessions(reopened, f.native, { getSession: () => true });
    assert.equal(await sessions.boardBindingSession(key), undefined);
    assert.deepEqual(await sessions.workspaceSession(key), { exists: false, ready: false });
  } finally { await reopened.close(); }
});

test('Codex original list refresh is joined and deletion is rechecked after native await', async t => {
  const f = await fixture(t); f.local.listReady = false;
  f.hooks.refresh = async () => {
    const result = await f.owner.command('codexDeletionClaim', { key: f.codex, commandKey: 'during-refresh', authorization: 'Bearer isolated-files' });
    assert.ok('receipt' in result && result.receipt.state === 'outcome_unknown');
  };
  assert.deepEqual(await f.sessions.workspaceSession(f.codex), { exists: false, ready: false });
  assert.equal(f.local.refreshes, 1);
  assert.equal(await f.sessions.boardBindingSession(f.codex), undefined);
});

test('Codex native list readiness is checked after refresh and failure is never hidden', async t => {
  const f = await fixture(t); f.local.listReady = false;
  assert.deepEqual(await f.sessions.workspaceSession(f.codex), { exists: true, ready: true });
  assert.equal(f.local.refreshes, 1);
  f.local.listReady = false; f.hooks.refresh = async () => { throw new ConnectorOwnerUnavailable(); };
  await assert.rejects(f.sessions.workspaceSession(f.codex));
  f.local.enabled = false;
  assert.deepEqual(await f.sessions.workspaceSession(f.codex), { exists: true, ready: false });
  assert.equal(f.local.refreshes, 2, 'disabled native must not attempt a refresh');
});
