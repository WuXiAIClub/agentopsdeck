import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { loadConfig } from '../config.js';
import { registerConnectorRoutes } from '../routes/connector.js';

function rollout(model = 'old-model', output = 'old-output') {
  return [
    { type: 'turn_context', payload: { turn_id: 'turn', type: 'turn_context', model } },
    { type: 'response_item', timestamp: '2026-09-16T00:00:00Z', payload: { type: 'function_call', call_id: 'call', name: 'synthetic', arguments: '{}' } },
    { type: 'response_item', timestamp: '2026-09-16T00:00:01Z', payload: { type: 'function_call_output', call_id: 'call', output } },
  ].map(entry => JSON.stringify(entry)).join('\n');
}

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-rollout-read-')), file = join(dir, 'rollout.jsonl');
  writeFileSync(file, rollout());
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any, key = 'codex:synthetic';
  runtime.ensureStarted = async () => {}; runtime.setConnection('synthetic-connection');
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown' });
  store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Known projection', createdAt: 1 });
  const thread = { id: 'synthetic', path: file, turns: [{ id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Native reply' }] }] };
  runtime.request = async (method: string) => { if (method === 'thread/backgroundTerminals/list') return { data: [] }; assert.equal(method, 'thread/read'); return { thread }; };
  t.after(async () => {
    await codex.close(); users.close(); t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  });
  return { codex, runtime, store, users, key, file, dir, thread };
}

test('large running history stays readable through Connector HTTP under continuous appends; queue and terminal checks remain fenced', async t => {
  const f = fixture(t);
  // Opt-in stress size; ordinary regression runs remain small. This only
  // creates synthetic tool output in this test's disposable directory.
  const toolMiB = Number(process.env.AOD_TEST_ROLLOUT_MIB ?? 12);
  assert.ok(Number.isSafeInteger(toolMiB) && toolMiB >= 12 && toolMiB <= 1024);
  const pageLimit = toolMiB >= 110 ? 200 : 10;
  f.thread.turns[0]!.status = 'inProgress';
  const start = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }) + '\n';
  writeFileSync(f.file, start + rollout() + '\n');
  // Retain genuine large tool output: API pages remain summaries, but the
  // separately authorized detail endpoint must not lose content.
  for (let index = 0; index < toolMiB; index++) appendFileSync(f.file, [
    { type: 'response_item', payload: { type: 'function_call', call_id: `large-${index}`, name: 'synthetic', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: `large-${index}`, output: 'x'.repeat(1024 * 1024) } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  f.users.codexExecutions.begin(f.key, 'active', 'synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key, 'active', 'synthetic-connection', 'turn', () => {});
  f.users.turns.enqueue('codex', { id: 'waiting', sessionKey: f.key, createdAt: 1, payload: { text: 'Never dispatch in history test', images: [] } });

  let reads = 0, nativeReads = 0;
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read', 'history must never resume, interrupt or dispatch work');
    nativeReads++;
    return { thread: f.thread };
  };
  const original = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (args[0] !== f.file) return handle;
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (...parameters: Parameters<typeof read>) => {
      const result = await read(...parameters);
      reads++;
      appendFileSync(f.file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
        info: { last_token_usage: { total_tokens: reads }, model_context_window: 200000 } } }) + '\n');
      return result;
    });
    return handle;
  });
  syncBuiltinESMExports();
  const config = loadConfig({ AOD_CONNECTOR_TOKENS_FILE: join(f.dir, 'tokens.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(f.dir, 'unused.sqlite'), AOD_SESSION_TITLES_FILE: join(f.dir, 'titles.json') });
  const tokens = new ConnectorTokenStore(config.connector.tokenFile);
  const token = tokens.createTransient(['messages:read']);
  const app = new Hono();
  const routes = registerConnectorRoutes(app, { config, tokens, connectorUsers: f.users, store: f.store, codex: f.codex,
    gateway: { request: async () => assert.fail('No OpenClaw dispatch') } as any,
    sessionSnapshotReady: () => true, historySnapshotReady: key => f.codex.isSessionHistoryReady(key),
    refreshSessions: async () => {}, refreshMessages: key => f.codex.refreshSession(key),
    fallbackAgents: () => [], isAuthorizedRequest: () => true, normalizeError: () => 'failure' });
  t.after(() => { routes.close(); token.dispose(); });
  const client = new ConnectorClient('http://synthetic', token.token, request => app.fetch(request));
  const path = `/sessions/${encodeURIComponent(f.key)}/messages`;
  const started = performance.now();
  const first: any = await client.json(`${path}?limit=${pageLimit}`);
  const coldMs = performance.now() - started;
  assert.equal(first.messages.length, pageLimit);
  assert.ok(JSON.stringify(first).length < pageLimit * 2_000, 'large tool bodies are not shipped in the history page');
  assert.ok(JSON.stringify(f.store.getMessages(f.key)).length < toolMiB * 4_200, 'projection itself no longer retains large tool bodies');
  const older: any = await client.json(`${path}?limit=10&before=${encodeURIComponent(first.messages[0].id)}`);
  assert.equal(older.messages.length, 10);
  assert.equal(nativeReads, 1, 'older pages reuse the verified projection without a second native read');
  const beforeDetailReads = reads;
  const details: any = await client.json(`${path}/${encodeURIComponent(`${f.key}:codex-tool-large-0-result`)}`);
  assert.ok(details.message.text.includes('x'.repeat(1024 * 1024)), 'lazy details stay lossless');
  assert.equal(reads - beforeDetailReads, 2, 'detail reads only its own record, not the complete rollout');
  assert.ok(JSON.stringify(f.store.getMessages(f.key)).length < toolMiB * 4_200, 'detail does not rehydrate the full body into projection');
  for (let index = 0; index < 3; index++) {
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => client.json(`${path}?limit=10`)));
    assert.equal(concurrent.length, 4);
  }
  assert.equal(nativeReads, 4, 'same-session concurrent refreshes coalesce');
  assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'running');
  assert.equal(f.users.turns.list('codex', f.key).length, 1);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  const known = f.store.getMessages(f.key);
  f.thread.turns[0]!.status = 'completed';
  const terminal = await app.request(`/api/connector/v1${path}`, { headers: { authorization: `Bearer ${token.token}` } });
  assert.equal(terminal.status, 503, 'live prefixes never certify a terminal read racing with writes');
  assert.deepEqual(f.store.getMessages(f.key), known);
  assert.equal(f.users.codexExecutions.get(f.key)?.phase, 'running');
  assert.equal(f.users.turns.list('codex', f.key).length, 1);
  t.diagnostic(JSON.stringify({ toolMiB, pageLimit, coldMs: Math.round(coldMs), nativeReads,
    pageBytes: Buffer.byteLength(JSON.stringify(first)), projectionBytes: Buffer.byteLength(JSON.stringify(known)),
    peakRssKiB: process.resourceUsage().maxRSS }));
});

for (const change of ['revoke', 'projection', 'rewrite', 'forbidden'] as const) {
  test(`indexed HTTP detail fences ${change} during on-demand read`, async t => {
    const f = fixture(t);
    writeFileSync(f.file, rollout('model', 'private-output-'.repeat(5000)) + '\n');
    await f.codex.refreshSession(f.key);
    const config = loadConfig({ AOD_CONNECTOR_TOKENS_FILE: join(f.dir, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(f.dir, 'unused.sqlite'), AOD_SESSION_TITLES_FILE: join(f.dir, 'titles.json') });
    const tokens = new ConnectorTokenStore(config.connector.tokenFile);
    const token = tokens.createTransient(['messages:read']);
    const app = new Hono();
    const routes = registerConnectorRoutes(app, { config, tokens, connectorUsers: f.users, store: f.store, codex: f.codex,
      gateway: { request: async () => assert.fail('No dispatch') } as any,
      sessionSnapshotReady: () => true, historySnapshotReady: key => f.codex.isSessionHistoryReady(key),
      refreshSessions: async () => {}, refreshMessages: async () => assert.fail('cached detail must not refresh native history'),
      fallbackAgents: () => [], isAuthorizedRequest: () => true, normalizeError: () => 'failure' });
    t.after(() => { routes.close(); token.dispose(); });
    let reads = 0;
    const original = fsPromises.open;
    t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (args[0] !== f.file) return handle;
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...parameters: Parameters<typeof read>) => {
        reads++;
        if (change === 'revoke') token.dispose();
        if (change === 'projection') f.store.replaceMessages(f.key, [], { authoritative: true });
        if (change === 'rewrite') writeFileSync(f.file, rollout('model', 'another-output-'.repeat(5000)) + '\n');
        return read(...parameters);
      });
      return handle;
    });
    syncBuiltinESMExports();
    if (change === 'forbidden') token.dispose();
    const response = await app.request(`/api/connector/v1/sessions/${encodeURIComponent(f.key)}/messages/${encodeURIComponent(`${f.key}:codex-tool-call-result`)}`,
      { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(response.status, change === 'revoke' || change === 'forbidden' ? 403 : 409);
    assert.ok(!(await response.text()).includes('private-output'));
    assert.equal(reads, change === 'forbidden' ? 0 : 1);
  });
}

test('image-view tool history retains metadata and text without persisting embedded image bytes', async t => {
  const f = fixture(t);
  const image = { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(2_000_000)}` };
  writeFileSync(f.file, [
    { type: 'response_item', payload: { type: 'function_call', call_id: 'image', name: 'view_images', arguments: '{"path":"/tmp/a.png"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'image', output: [image, { type: 'text', text: 'Opened image' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  await f.codex.refreshSession(f.key);
  const tools = f.store.getMessages(f.key).filter(row => row.role === 'tool');
  assert.equal(tools.length, 2);
  assert.ok(JSON.stringify(tools).length < 3000);
  assert.ok(tools.every(row => row.toolName === 'view_images' && row.toolCallId === 'image'));
  assert.match(tools[0]!.text, /\/tmp\/a.png/);
  assert.match(tools[1]!.text, /Opened image/);
  assert.match(tools[1]!.text, /Image payload omitted/);
});

for (const final of [false, true]) test(`${final ? 'terminal' : 'ordinary'} history opens the rollout only once`, async t => {
  const f = fixture(t);
  let reads = 0;
  for (const method of ['open', 'readFile'] as const) {
    const original = fsPromises[method];
    t.mock.method(fsPromises, method, (...args: any[]) => {
      if (args[0] === f.file) reads++;
      return (original as any)(...args);
    });
  }
  syncBuiltinESMExports();
  if (final) {
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100);
    await f.runtime.completingTurns.get(f.key);
  } else await f.codex.refreshSession(f.key);
  assert.equal(reads, 1);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.ok(f.store.getMessages(f.key).some(message => message.toolPhase === 'result' && message.text.includes('old-output')));
  if (!final) assert.equal(f.store.getSession(f.key)?.model, 'old-model');
});

for (const final of [false, true]) test(`${final ? 'terminal' : 'ordinary'} history rejects a native/rollout message-key collision`, async t => {
  const f = fixture(t), item = f.thread.turns[0]!.items[0]!;
  item.id = 'tool-call-call';
  const before = f.store.getMessages(f.key);
  if (final) {
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100);
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  } else await assert.rejects(f.codex.refreshSession(f.key), /Invalid Codex thread history message identity/);
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  assert.deepEqual(f.store.getMessages(f.key), before);
  assert.equal(f.store.getSession(f.key)?.model, undefined);
  item.id = 'reply';
  if (final) {
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100);
    await f.runtime.completingTurns.get(f.key);
  } else await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.store.getMessages(f.key).length, 3);
});

test('model and tools use the same captured rollout when the file changes during assistant projection', async t => {
  const f = fixture(t);
  f.runtime.options.projectAssistant = async (text: string) => {
    writeFileSync(f.file, rollout('new-model', 'new-output'));
    return { text, media: [] };
  };
  await f.codex.refreshSession(f.key);
  assert.equal(f.store.getSession(f.key)?.model, 'old-model');
  const tools = f.store.getMessages(f.key).filter(message => message.toolPhase === 'result');
  assert.ok(tools.some(message => message.text.includes('old-output')));
  assert.ok(tools.every(message => !message.text.includes('new-output')));
});

for (const invalid of ['missing', 'directory', 'oversized'] as const) test(`ordinary history rejects a ${invalid} rollout without clearing history or certifying success`, async t => {
  const f = fixture(t);
  if (invalid === 'missing') f.thread.path = join(f.dir, 'missing.jsonl');
  if (invalid === 'directory') f.thread.path = f.dir;
  if (invalid === 'oversized') truncateSync(f.file, 64 * 1024 * 1024 + 1);
  await assert.rejects(f.codex.refreshSession(f.key), /rollout/i);
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
  assert.equal(f.store.getSession(f.key)?.model, undefined);
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  f.thread.path = f.file; writeFileSync(f.file, rollout());
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
});

test('terminal history with an unreadable rollout keeps sync error and old messages', async t => {
  const f = fixture(t);
  f.thread.path = join(f.dir, 'missing.jsonl');
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100);
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
});

for (const change of ['none', 'grow', 'truncate', 'rewrite', 'read-error'] as const) {
  test(`rollout handle is closed and read stays bounded when file change is ${change}`, async t => {
    const f = fixture(t);
    // Exercise multiple reads without allocating a maximum-size file.
    const contents = `${rollout()}\n${' '.repeat(2 * 1024 * 1024)}`;
    writeFileSync(f.file, contents);
    const open = fsPromises.open;
    let opened = 0, closed = 0, requested = 0;
    t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[0] !== f.file) return handle;
      opened++;
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { closed++; return close(); });
      t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        assert.ok(length <= 1024 * 1024);
        assert.ok(position + length <= Buffer.byteLength(contents));
        requested += length;
        if (position === 0) {
          if (change === 'grow') appendFileSync(f.file, 'growth');
          if (change === 'truncate') truncateSync(f.file, 0);
          if (change === 'rewrite') {
            writeFileSync(f.file, contents.replace('old-model', 'new-model'));
            utimesSync(f.file, new Date(0), new Date(0));
          }
          if (change === 'read-error') throw new Error('Synthetic read failure');
        }
        return read(buffer, offset, length, position);
      });
      return handle;
    });
    syncBuiltinESMExports();
    if (change === 'none') {
      await f.codex.refreshSession(f.key);
      assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    } else {
      await assert.rejects(f.codex.refreshSession(f.key), /rollout/i);
      assert.equal(f.codex.isSessionHistoryReady(f.key), false);
      assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
    }
    assert.equal(opened, 1);
    assert.equal(closed, 1);
    assert.ok(requested <= Buffer.byteLength(contents));
  });
}

test('absent rollout path retains native history without attempting filesystem enrichment', async t => {
  const f = fixture(t);
  f.thread.path = '';
  t.mock.method(fsPromises, 'open', async () => { throw new Error('Must not open a file'); });
  syncBuiltinESMExports();
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Native reply'));
});
