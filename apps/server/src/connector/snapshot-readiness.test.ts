import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { HubStore } from '../hub/hub-store.js';
import { registerHubRoutes } from '../routes/hub.js';
import { describeBatch } from '../codex/queued-batch.js';
import { createConnectorRuntime } from './runtime.js';

const originalHome = process.env.HOME;
async function fixture(t: test.TestContext, transport: 'local' | 'http' = 'local', openClaw = true, withCodex = !openClaw) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-snapshot-readiness-'));
  const home = join(dir, 'home'); mkdirSync(home);
  process.env.HOME = home;
  const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: withCodex ? 'true' : 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_OPENCLAW_GATEWAY_WS_URL: openClaw ? 'ws://unused.invalid' : '',
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(dir, 'connector.sqlite'), AOD_CONNECTOR_TOKENS_FILE: join(dir, 'tokens.json'),
    AOD_SESSION_TITLES_FILE: join(dir, 'titles.json'), AOD_QUEUE_FILE: join(dir, 'queue.json'),
    AOD_MIRROR_OUTBOX_FILE: join(dir, 'mirror.json'), AOD_ARTIFACT_INDEX_FILE: join(dir, 'artifacts.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(dir, 'updates.json') });
  const runtime = createConnectorRuntime(config, request => request.headers.get('x-synthetic-operator') === 'yes');
  let result: unknown = [], failed = false, reads = 0, connectionId: string | undefined = 'synthetic-old';
  runtime.gateway.connectionId = () => connectionId;
  runtime.gateway.requestWithConnection = async (method: string) => {
    assert.equal(method, 'sessions.list', 'only synthetic read-only RPC is permitted'); reads++;
    if (failed) throw new Error('synthetic native list unavailable');
    return { payload: result, connectionId } as never;
  };
  runtime.gateway.request = async <T>(method: string, params?: Record<string, unknown>) => (await runtime.gateway.requestWithConnection<T>(method, params)).payload;
  const server = transport === 'http' ? serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server?.address();
  const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
  const client = new ConnectorClient(origin, runtime.localToken, transport === 'local' ? request => runtime.app.fetch(request) : undefined);
  t.after(async () => {
    await runtime.close();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (process.env.HOME === home) {
      if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { config, runtime, client, clientFor: (token: string) => new ConnectorClient(origin, token, transport === 'local' ? request => runtime.app.fetch(request) : undefined),
    request: (path: string, token = runtime.localToken) => transport === 'local'
      ? runtime.app.request(path, { headers: { authorization: `Bearer ${token}` } })
      : fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } }),
    reads: () => reads, fail: (value: boolean) => { failed = value; }, set: (value: unknown) => { result = value; },
    connect: (value: string | undefined) => { connectionId = value; (runtime.gateway as any).options.onConnectionChange(value); } };
}

for (const transport of ['local', 'http'] as const) for (const managed of [false, true]) test(`${transport}: streaming history race stays readable (managed=${managed})`, async t => {
  const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
  codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
  f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Streaming', status: 'running',
    runtime: { turnId: 'turn', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
  if (managed) {
    f.runtime.connectorUsers.codexExecutions.begin(key, 'original', 'synthetic-connection');
    f.runtime.connectorUsers.codexExecutions.acknowledge(key, 'original', 'synthetic-connection', 'turn', () => {});
  } else codex.activeTurnIds.set(key, 'turn');
  codex.request = async (method: string) => {
    assert.equal(method, 'thread/read');
    codex.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'turn', itemId: 'new', delta: 'Live reply' });
    return { thread: { id: 'synthetic', turns: [
      { id: 'old', status: 'completed', items: [{ id: 'old-reply', type: 'agentMessage', text: 'Older reply' }] },
      { id: 'turn', status: 'inProgress', items: [] },
    ] } };
  };
  const response = await f.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/messages?limit=264`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.ok(body.sourceCursor);
  assert.ok(body.messages.some((message: any) => message.text === 'Older reply'));
  assert.ok(body.messages.some((message: any) => message.text === 'Live reply'));
});

for (const transport of ['local', 'http'] as const) test(`${transport}: batched history remains readable through streaming positional input collision`, async t => {
  const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
  codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
  const entries = ['first', 'second'].map((id, index) => ({ id, sessionKey: key, state: 'queued' as const,
    createdAt: index + 1, payload: { text: id, images: [] } }));
  const batch = describeBatch(entries)!;
  const executions = f.runtime.connectorUsers.codexExecutions;
  executions.begin(key, 'first', 'synthetic-connection', false, batch);
  executions.acknowledge(key, 'first', 'synthetic-connection', 'old', () => {});
  executions.observe(key, 'synthetic-connection', 'old', 'completed');
  executions.settleHistory(executions.get(key)!, 'current');
  executions.begin(key, 'current', 'synthetic-connection');
  executions.acknowledge(key, 'current', 'synthetic-connection', 'turn', () => {});
  f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Streaming', status: 'running',
    runtime: { turnId: 'turn', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
  f.runtime.store.addMessage({ id: `${key}:codex-input`, sessionKey: key, turnId: 'old', role: 'user',
    text: 'Stale positional input', createdAt: 1 });
  codex.request = async (method: string) => {
    assert.equal(method, 'thread/read', 'No dispatch, resume or replay');
    codex.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'turn', itemId: 'new', delta: 'Live reply' });
    return { thread: { id: 'synthetic', turns: [
      { id: 'old', status: 'completed', items: [{ id: 'input', type: 'userMessage',
        content: [{ type: 'text', text: entries.map(entry => entry.payload.text).join(batch.separator) }] }] },
      { id: 'turn', status: 'inProgress', items: [] },
    ] } };
  };
  const response = await f.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/messages?limit=200`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.ok(body.sourceCursor);
  assert.deepEqual(body.messages.filter((message: any) => message.role === 'user').map((message: any) => [message.id, message.text]),
    [['first', 'first'], ['second', 'second']]);
  assert.ok(body.messages.some((message: any) => message.text === 'Live reply'));
  assert.equal(executions.get(key)?.runId, 'turn');
  assert.equal(f.runtime.connectorUsers.turns.list('codex', key).length, 0);
});

for (const transport of ['local', 'http'] as const) for (const managed of [false, true]) {
  for (const activity of ['running', 'waiting']) test(`${transport}: ${managed ? 'managed' : 'external'} terminal reply remains readable on a ${activity} thread`, async t => {
    const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
    codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
    f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'running',
      runtime: { turnId: 'previous', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
    const turn = { id: 'previous', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Readable final reply' }] };
    codex.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read', 'no real native commands');
      return { thread: { id: 'synthetic', status: { type: 'active', activeFlags: activity === 'waiting' ? ['waitingOnApproval'] : [] }, turns: [turn] } };
    };
    if (managed) {
      f.runtime.connectorUsers.codexExecutions.begin(key, 'original', 'synthetic-connection');
      f.runtime.connectorUsers.codexExecutions.acknowledge(key, 'original', 'synthetic-connection', 'previous', () => {});
    }
    codex.handleNotification('turn/completed', { threadId: 'synthetic', turn });
    await codex.completingTurns.get(key);
    const state = await f.client.sessionExecution(key);
    assert.equal(state.runtime?.phase, 'completed');
    assert.equal(state.runtime?.threadActivity, activity);
    assert.equal(state.runtime?.sync, 'current');
    assert.equal(state.status, activity);
    const message = f.runtime.store.getMessages(key).find(message => message.text === 'Readable final reply')!;
    for (const suffix of ['', `/${encodeURIComponent(message.id)}`]) {
      const response = await f.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${suffix}`);
      assert.equal(response.status, 200, 'thread availability does not revoke history readiness');
      assert.match(await response.text(), /Readable final reply/);
    }
    codex.request = async (method: string) => { assert.equal(method, 'thread/read'); throw new Error('Synthetic read failure'); };
    await assert.rejects(codex.refreshSession(key), /Synthetic read failure/);
    const unavailable = await f.client.sessionExecution(key);
    assert.equal(unavailable.runtime?.phase, 'completed');
    assert.equal(unavailable.runtime?.threadActivity, 'unknown');
    assert.equal(unavailable.status, 'unknown');
    assert.ok(f.runtime.store.getMessages(key).some(message => message.text === 'Readable final reply'));
    assert.equal((await f.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/messages`)).status, 503);
  });
}

for (const transport of ['local', 'http'] as const) for (const failure of ['running', 'malformed', 'unavailable'] as const) {
  test(`${transport}: terminal enumeration ${failure} cannot certify warm history or trigger cleanup`, async t => {
    const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
    codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
    f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown' });
    let failed = false;
    const methods: string[] = [];
    codex.request = async (method: string, params: { threadId?: string }) => {
      methods.push(method);
      assert.equal(params.threadId, 'synthetic');
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/backgroundTerminals/list') {
        if (!failed) return { data: [] };
        if (failure === 'unavailable') throw new Error('Synthetic terminal enumeration unavailable');
        return { data: failure === 'running' ? [{ processId: 'private-process', itemId: 'unattributed' }] : [{}] };
      }
      assert.equal(method, 'thread/read', 'read-only history must not terminate, resume or dispatch');
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [
        { id: 'reply', type: 'agentMessage', text: 'Known final reply' },
      ] }] } };
    };
    await f.runtime.codex.refreshSession(key);
    const messages = f.runtime.store.getMessages(key);
    const page = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages`;
    const detail = `${page}/${encodeURIComponent(messages[0]!.id)}`;
    assert.equal((await f.request(page)).status, 200);
    failed = true;
    await assert.rejects(f.runtime.codex.refreshSession(key), /background terminals are still running|Invalid Codex background terminal identity|Synthetic terminal enumeration unavailable/);
    assert.equal(codex.isSessionHistoryReady(key), false);
    assert.deepEqual(f.runtime.store.getMessages(key), messages, 'failed proof preserves previously known messages');
    for (const path of [page, detail]) {
      const response = await f.request(path);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'Session history unavailable' });
    }
    failed = false;
    await f.runtime.codex.refreshSession(key);
    for (const path of [page, detail]) assert.equal((await f.request(path)).status, 200);
    assert.deepEqual(f.runtime.store.getMessages(key), messages);
    assert.ok(methods.includes('thread/backgroundTerminals/list'));
    assert.ok(methods.every(method => ['thread/read', 'thread/backgroundTerminals/list', 'thread/goal/get'].includes(method)),
      'history/terminal/goal reads must not terminate, resume or dispatch');
  });
}

for (const transport of ['local', 'http'] as const) for (const detail of [false, true]) {
  for (const invalid of ['anonymous', 'duplicate', 'prefix-collision', 'partial-older-turn']) test(`${transport}: ${invalid} history identity cannot publish ${detail ? 'detail' : 'page'} completeness`, async t => {
    const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
    codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
    f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown' });
    const thread: any = { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [
      { id: 'reply', type: 'agentMessage', text: 'Known final response' },
    ] }] };
    codex.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read'); return { thread };
    };
    await f.runtime.codex.refreshSession(key);
    const messages = f.runtime.store.getMessages(key), valid = structuredClone(thread);
    const route = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? `/${encodeURIComponent(messages[0]!.id)}` : ''}`;
    assert.equal((await f.request(route)).status, 200);
    if (invalid === 'anonymous') delete thread.turns[0].items[0].id;
    else if (invalid === 'partial-older-turn') thread.turns.unshift({ id: 'older', status: 'completed', itemsView: 'partial', items: [] });
    else if (invalid === 'prefix-collision') thread.turns[0].items.push(
      { id: 'tool-command-call', type: 'agentMessage', text: 'Colliding assistant' },
      { id: 'command', type: 'commandExecution', status: 'completed', command: 'synthetic' });
    else thread.turns[0].items.push({ id: 'reply', type: 'agentMessage', text: 'Unverified duplicate' });
    await assert.rejects(f.runtime.codex.refreshSession(key), /Invalid Codex thread history/);
    const rejected = await f.request(route);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await rejected.json(), { error: 'Session history unavailable' });
    assert.deepEqual(f.runtime.store.getMessages(key), messages);
    Object.assign(thread, valid);
    await f.runtime.codex.refreshSession(key);
    const recovered = await f.request(route);
    assert.equal(recovered.status, 200);
    assert.ok((await recovered.json() as any).sourceCursor);
    assert.deepEqual(f.runtime.store.getMessages(key), messages);
  });
}

for (const transport of ['local', 'http'] as const) for (const detail of [false, true]) {
  for (const entry of ['history', 'notification']) test(`${transport}: systemError ${entry} withholds warm ${detail ? 'detail' : 'history'} until valid recovery`, async t => {
    const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
    codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
    f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown' });
    const thread = { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [
      { id: 'reply', type: 'agentMessage', text: 'Known final response' },
    ] }] };
    codex.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read'); return { thread };
    };
    const notify = () => codex.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } });
    notify(); await codex.completingTurns.get(key);
    const messages = f.runtime.store.getMessages(key);
    const route = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? `/${encodeURIComponent(messages[0]!.id)}` : ''}`;
    assert.equal((await f.request(route)).status, 200);
    thread.status.type = 'systemError'; thread.turns[0]!.items[0]!.text = 'Unverified response';
    if (entry === 'notification') {
      codex.handleNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'systemError' } });
      assert.equal(f.runtime.codex.isSessionHistoryReady(key), false, 'notification invalidates warm history before another read');
    } else await assert.rejects(f.runtime.codex.refreshSession(key), /Codex thread unavailable/);
    const rejected = await f.request(route);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await rejected.json(), { error: 'Session history unavailable' }, 'no stale cursor, messages or native error');
    assert.deepEqual(f.runtime.store.getMessages(key), messages);
    assert.equal(f.runtime.store.getSession(key)?.runtime?.phase, 'completed');
    assert.equal(f.runtime.codex.isSessionHistoryReady(key), false);
    thread.status.type = 'idle'; thread.turns[0]!.items[0]!.text = 'Recovered final response';
    if (entry === 'history') await f.runtime.codex.refreshSession(key);
    else { notify(); await codex.completingTurns.get(key); }
    const recovered = await f.request(route);
    assert.equal(recovered.status, 200);
    assert.ok((await recovered.json() as any).sourceCursor);
    assert.equal(f.runtime.codex.isSessionHistoryReady(key), true);
    assert.equal(f.runtime.store.getSession(key)?.runtime?.sync, 'current');
    assert.ok(f.runtime.store.getMessages(key).some(message => message.text === 'Recovered final response'));
  });
}

for (const transport of ['local', 'http'] as const) for (const detail of [false, true]) {
  for (const invalid of ['missing-id', 'nonterminal-status']) test(`${transport}: malformed external ${invalid} does not disturb current ${detail ? 'detail' : 'history'}`, async t => {
    const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
    codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
    f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown' });
    let reads = 0;
    codex.request = async (method: string) => {
      assert.equal(method, 'thread/read'); reads++;
      return { thread: { id: 'synthetic', turns: [{ id: 'turn', status: 'inProgress', items: [
        { id: 'reply', type: 'agentMessage', text: 'Live response' },
      ] }] } };
    };
    await f.runtime.codex.refreshSession(key);
    const previous = f.runtime.store.getMessages(key)[0]!;
    const route = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? `/${encodeURIComponent(previous.id)}` : ''}`;
    const before = await f.request(route);
    assert.equal(before.status, 200);
    const { updatedAt: beforeReadAt, ...snapshot } = await before.json() as any;
    codex.handleNotification('turn/completed', { threadId: 'synthetic', turn: invalid === 'missing-id'
      ? { status: 'completed' } : { id: 'turn', status: 'inProgress' } });
    await codex.completingTurns.get(key);
    assert.equal(f.runtime.store.getSession(key)?.runtime?.phase, 'running');
    assert.equal(f.runtime.codex.isSessionHistoryReady(key), true);
    assert.equal(reads, 1, 'malformed completion cannot initiate final history reads');
    const after = await f.request(route);
    assert.equal(after.status, 200);
    const { updatedAt: afterReadAt, ...current } = await after.json() as any;
    assert.ok(afterReadAt >= beforeReadAt, 'response envelope timestamp describes the read, not a new projection');
    assert.deepEqual(current, snapshot, 'malformed notification creates no new projection or source cursor');
  });
}

for (const transport of ['local', 'http'] as const) for (const detail of [false, true]) {
  test(`${transport}: external failed notification invalidates warm ${detail ? 'detail' : 'history'} until final history recovers`, async t => {
    const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
    codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
    f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown' });
    let failed = false;
    const turn = { id: 'turn', status: 'inProgress', items: [{ id: 'reply', type: 'agentMessage', text: 'Known projection' }] };
    codex.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read');
      if (failed) throw new Error('Synthetic private history failure');
      return { thread: { id: 'synthetic', turns: [turn] } };
    };
    await f.runtime.codex.refreshSession(key);
    const previous = f.runtime.store.getMessages(key)[0]!;
    const route = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? `/${encodeURIComponent(previous.id)}` : ''}`;
    assert.equal((await f.request(route)).status, 200);
    const notify = () => codex.handleNotification('turn/completed', { threadId: 'synthetic', turn: {
      id: 'turn', status: 'failed', error: { message: 'Synthetic failure' },
    } });
    failed = true; notify();
    await codex.completingTurns.get(key);
    assert.equal(f.runtime.codex.isSessionHistoryReady(key), false);
    const events = f.runtime.store.getEventsSince().length;
    codex.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: 'completed' } });
    await codex.completingTurns.get(key);
    assert.equal(f.runtime.store.getSession(key)?.runtime?.phase, 'failed', 'conflicting retry cannot reinterpret native failure');
    assert.equal(f.runtime.store.getSession(key)?.runtime?.sync, 'error');
    assert.equal(f.runtime.store.getEventsSince().length, events, 'conflicting retry publishes no new cursor');
    const rejected = await f.request(route);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await rejected.json(), { error: 'Session history unavailable' }, 'no old messages, cursor or private error');
    assert.ok(f.runtime.store.getMessages(key).some(message => message.text === previous.text));
    failed = false; turn.status = 'failed'; turn.items[0]!.text = 'Final explanation'; notify();
    await codex.completingTurns.get(key);
    assert.equal(f.runtime.store.getSession(key)?.runtime?.phase, 'failed');
    assert.equal(f.runtime.store.getSession(key)?.runtime?.sync, 'current');
    const recovered = await f.request(route);
    assert.equal(recovered.status, 200);
    assert.ok((await recovered.json() as any).sourceCursor);
    assert.ok(f.runtime.store.getMessages(key).some(message => message.text === 'Final explanation'));
  });
}

for (const transport of ['local', 'http'] as const) for (const detail of [false, true]) {
  test(`${transport}: Codex ${detail ? 'detail' : 'history'} withholds contradictory external completion and recovers`, async t => {
    const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
    codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
    f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'idle', runtime: {
      turnId: 'turn', phase: 'completed', sync: 'current', connection: 'connected', lastEventAt: 1,
    } });
    codex.completedTurnIds.set(key, 'turn');
    f.runtime.store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Known projection', createdAt: 1 });
    const turn = { id: 'turn', status: 'failed', items: [] };
    codex.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read'); return { thread: { id: 'synthetic', turns: [turn] } };
    };
    const route = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? '/known' : ''}`;
    const response = await f.request(route);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Session history unavailable' });
    assert.equal(f.runtime.codex.isSessionHistoryReady(key), false);
    assert.equal(f.runtime.store.getSession(key)?.runtime?.phase, 'completed');
    assert.equal(f.runtime.store.getMessages(key)[0]?.text, 'Known projection');
    turn.status = 'completed';
    await f.runtime.codex.refreshSession(key);
    const recovered = await f.request(route);
    // The failure's state invalidation is a live projection. Ordinary hydration
    // must not erase its retained transcript; only final reconciliation replaces it.
    assert.equal(recovered.status, 200);
    assert.ok(f.runtime.store.getMessages(key).some(message => message.id === 'known' && message.text === 'Known projection'));
    assert.equal(f.runtime.codex.isSessionHistoryReady(key), true);
  });
}

for (const transport of ['local', 'http'] as const) for (const detail of [false, true]) {
  for (const invalid of ['missing-thread', 'wrong-id', 'missing-id', 'missing-turns', 'invalid-turns', 'null-turn', 'missing-items', 'invalid-items', 'null-item', 'array-item'] as const) {
    test(`${transport}: Codex ${detail ? 'detail' : 'history'} rejects ${invalid} without erasing known history`, async t => {
      const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
      codex.ensureStarted = async () => {}; codex.setConnection('synthetic-connection');
      f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown' });
      f.runtime.store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Known projection', createdAt: 1 });
      const thread: any = { id: 'synthetic', turns: [{ id: 'turn', status: 'completed', items: [] }] };
      if (invalid === 'wrong-id') thread.id = 'other-session';
      if (invalid === 'missing-id') delete thread.id;
      if (invalid === 'missing-turns') delete thread.turns;
      if (invalid === 'invalid-turns') thread.turns = {};
      if (invalid === 'null-turn') thread.turns = [null];
      if (invalid === 'missing-items') delete thread.turns[0].items;
      if (invalid === 'invalid-items') thread.turns[0].items = {};
      if (invalid === 'null-item') thread.turns[0].items = [null];
      if (invalid === 'array-item') thread.turns[0].items = [[]];
      let result: unknown = invalid === 'missing-thread' ? {} : { thread }, reads = 0;
      codex.request = async (method: string) => { assert.equal(method, 'thread/read'); reads++; return result; };
      const route = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? '/known' : ''}`;
      const response = await f.request(route);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'Session history unavailable' });
      assert.equal(f.runtime.store.getMessages(key)[0]?.text, 'Known projection');
      assert.equal(f.runtime.store.getSession(key)?.status, 'unknown');
      assert.equal(f.runtime.codex.isSessionHistoryReady(key), false);
      assert.equal(f.runtime.connectorUsers.codexExecutions.get(key), undefined);
      result = { thread: { id: 'synthetic', turns: [] } };
      await f.runtime.codex.refreshSession(key);
      const recovered = await f.request(route);
      assert.equal(recovered.status, detail ? 404 : 200, 'a valid empty snapshot is distinct from invalid history');
      assert.equal(reads, 2);
      assert.equal(f.runtime.codex.isSessionHistoryReady(key), true);
    });
  }
}

for (const transport of ['local', 'http'] as const) for (const detail of [false, true]) {
  for (const boundary of ['reply', 'artifact', 'live', 'finalizing', 'cache-commit', 'publication'] as const) {
    test(`${transport}: Codex ${detail ? 'detail' : 'history'} cannot certify a read invalidated at ${boundary}`, async t => {
      const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any, key = 'codex:synthetic';
      codex.ensureStarted = async () => {}; codex.setConnection('synthetic-old');
      f.runtime.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'unknown' });
      f.runtime.store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Known projection', createdAt: 1 });
      codex.touchProjection(key);
      const thread = { id: 'synthetic', turns: [{ id: 'turn', status: 'completed', items: [
        { id: 'message', type: 'agentMessage', text: 'Read projection' },
      ] }] };
      const replace = f.runtime.store.replaceMessages.bind(f.runtime.store), refresh = codex.refreshSession.bind(codex);
      let invalidate = true;
      codex.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read');
        if (invalidate && boundary === 'reply') codex.setConnection('synthetic-new');
        return { thread };
      };
      codex.options.projectAssistant = async (text: string) => {
        if (invalidate && boundary === 'artifact') codex.setConnection('synthetic-new');
        if (invalidate && boundary === 'live') codex.touchProjection(key);
        if (invalidate && boundary === 'finalizing') codex.completingTurns.set(key, Promise.resolve());
        return { text, media: [] };
      };
      f.runtime.store.replaceMessages = (...args) => {
        replace(...args);
        if (invalidate && boundary === 'cache-commit') queueMicrotask(() => codex.setConnection('synthetic-new'));
      };
      codex.refreshSession = async (...args: unknown[]) => {
        await refresh(...args);
        if (invalidate && boundary === 'publication') codex.setConnection('synthetic-new');
      };
      const route = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? '/known' : ''}`;
      const rejected = await f.request(route);
      assert.equal(rejected.status, 503);
      assert.deepEqual(await rejected.json(), { error: 'Session history unavailable' });
      assert.equal(rejected.headers.get('cache-control'), 'no-store');
      assert.equal(codex.threadRefreshResult.has(key), false, 'obsolete reads do not install success or failure cooldowns');
      assert.ok(f.runtime.store.getMessages(key).some(message => message.text === 'Known projection'), 'last-known messages survive');
      invalidate = false; codex.completingTurns.delete(key);
      await f.runtime.refreshMessages(key);
      assert.equal((await f.request(route)).status, 200, 'a validated subsequent read recovers');
    });
  }
}

for (const transport of ['local', 'http'] as const) for (const native of ['openclaw', 'codex']) {
  for (const detail of [false, true]) test(`${transport}/${native}: failed history cannot publish ${detail ? 'message detail' : 'a message page'} from an old success`, async t => {
    const f = await fixture(t, transport, native === 'openclaw', native === 'codex');
    const key = native === 'codex' ? 'codex:synthetic' : 'agent:main:synthetic';
    let failed = false;
    f.runtime.store.upsertSession({ sessionKey: key, agentId: native === 'codex' ? 'codex' : 'main', title: 'Synthetic', status: 'unknown' });
    if (native === 'codex') {
      const codex = f.runtime.codex as any;
      codex.ensureStarted = async () => {}; codex.setConnection('synthetic-codex');
      codex.request = async (method: string) => {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read');
        if (failed) throw new Error('synthetic private native detail');
        return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [
          { id: 'message', type: 'agentMessage', text: 'Known history' },
        ] }] } };
      };
    } else f.runtime.gateway.requestWithConnection = async <T>(method: string) => {
      assert.equal(method, 'chat.history');
      if (failed) throw new Error('synthetic private native detail');
      return { connectionId: f.runtime.gateway.connectionId()!, payload: { sessionKey: key, messages: [{ id: 'message', role: 'assistant', text: 'Known history', createdAt: 1 }] } as T };
    };
    await f.runtime.refreshMessages(key);
    const previous = f.runtime.store.getMessages(key);
    assert.equal(previous.length, 1);
    const route = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? `/${encodeURIComponent(previous[0]!.id)}` : ''}`;
    failed = true;
    await assert.rejects(f.runtime.refreshMessages(key), /synthetic private native detail/);
    const unavailable = await f.request(route);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await unavailable.json(), { error: 'Session history unavailable' }, 'no old messages, cursor or native error leakage');
    assert.deepEqual(f.runtime.store.getMessages(key), previous, 'failed fetch retains last-known local projection');
    failed = false;
    await f.runtime.refreshMessages(key);
    const recovered = await f.request(route);
    assert.equal(recovered.status, 200);
    assert.ok((await recovered.json() as any).sourceCursor);
  });
}

for (const transport of ['local', 'http'] as const) for (const detail of [false, true]) {
  test(`${transport}: revocation during a failed ${detail ? 'detail' : 'history'} read still returns denied`, async t => {
    const f = await fixture(t, transport), key = 'agent:main:synthetic';
    const headers = { 'x-synthetic-operator': 'yes', 'content-type': 'application/json' };
    const issued = await f.runtime.app.request('/api/connector/v1/tokens', { method: 'POST', headers,
      body: JSON.stringify({ label: 'Synthetic history reader', scopes: ['messages:read'] }) });
    assert.equal(issued.status, 201);
    const credential = await issued.json() as { token: string; record: { id: string } };
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.runtime.gateway.requestWithConnection = async () => { entered(); await held; throw new Error('synthetic history outage'); };
    const response = f.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? '/message' : ''}`, credential.token);
    await started;
    assert.equal((await f.runtime.app.request(`/api/connector/v1/tokens/${credential.record.id}`, { method: 'DELETE', headers })).status, 200);
    release();
    const denied = await response;
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'missing messages:read scope' });
  });
}

for (const transport of ['local', 'http'] as const) test(`${transport}: Codex endless pagination is unavailable and a later bounded snapshot can recover`, async t => {
  const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any;
  codex.ensureStarted = async () => {};
  codex.setConnection('synthetic-codex');
  let reads = 0;
  codex.request = async (method: string) => {
    assert.equal(method, 'thread/list');
    if (++reads > 101) throw new Error('synthetic test safety bound');
    return { data: [], nextCursor: `unique-${reads}` };
  };
  await assert.rejects(f.client.sessions(), { status: 503 });
  assert.equal(reads, 100);
  assert.equal(f.runtime.codex.isSessionListReady(), false);
  codex.request = async () => ({ data: [], nextCursor: null });
  assert.deepEqual((await f.client.sessions()).groups, []);
});

for (const transport of ['local', 'http'] as const) test(`${transport}: Codex list snapshot leaves history to the explicitly selected session`, async t => {
  const f = await fixture(t, transport, false, true), codex = f.runtime.codex as any;
  codex.ensureStarted = async () => {};
  codex.setConnection('synthetic-codex');
  const calls: string[] = [];
  codex.request = async (method: string, params: any) => {
    calls.push(method);
    if (method === 'thread/list') return { data: [{ id: 'selected', name: 'Selected' }, { id: 'unopened', name: 'Unopened' }], nextCursor: null };
    if (method === 'thread/goal/get') {
      assert.equal(params.threadId, 'selected', 'unopened sessions incur no Goal RPC');
      return { goal: null };
    }
    if (method === 'thread/backgroundTerminals/list') {
      assert.equal(params.threadId, 'selected', 'only the selected terminal transcript is checked');
      return { data: [] };
    }
    assert.equal(method, 'thread/read');
    assert.equal(params.threadId, 'selected', 'unopened sessions incur no history RPC');
    return { thread: { id: 'selected', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [
      { type: 'agentMessage', id: 'reply', text: 'Synthetic history' },
    ] }] } };
  };
  const snapshot = await f.client.sessions();
  assert.ok(snapshot.sourceCursor);
  assert.deepEqual(calls, ['thread/list']);
  assert.equal(f.runtime.store.getMessages('codex:selected').length, 0);
  const history = await f.client.messages('codex:selected');
  assert.equal(history.messages[0]?.text, 'Synthetic history');
  assert.deepEqual(calls, ['thread/list', 'thread/read', 'thread/backgroundTerminals/list', 'thread/goal/get']);
  await f.client.sessions();
  assert.deepEqual(calls, ['thread/list', 'thread/read', 'thread/backgroundTerminals/list', 'thread/goal/get'], 'list cache does not trigger any history or Goal work');
});

for (const transport of ['local', 'http'] as const) test(`${transport}: a failed cold snapshot is unavailable, not a fake idle session or a cached empty list`, async t => {
  const f = await fixture(t, transport);
  f.fail(true);
  await assert.rejects(f.client.sessions(), { status: 503 });
  assert.deepEqual(f.runtime.store.getSessionsState().groups, []);
  f.fail(false);
  const recovered = await f.client.sessions();
  assert.deepEqual(recovered.groups, [], 'a verified empty list is a valid snapshot');
  assert.ok(recovered.sourceCursor);
  assert.equal(f.reads(), 2, 'failure cannot populate the freshness cache');
});

for (const transport of ['local', 'http'] as const) for (const first of ['openclaw', 'codex'] as const) {
  for (const invalidation of ['connection', 'failed-refresh'] as const) test(`${transport}: ${first} completion is rechecked after waiting for the other runtime (${invalidation})`, async t => {
    const f = await fixture(t, transport, true, true), codex = f.runtime.codex as any;
    codex.ensureStarted = async () => {};
    codex.setConnection('synthetic-codex');
    const codexRead = async (method: string) => { assert.equal(method, 'thread/list'); return { data: [], nextCursor: null }; };
    codex.request = codexRead;
    const gatewayRead = f.runtime.gateway.requestWithConnection.bind(f.runtime.gateway);
    const fastRefresh = () => first === 'openclaw' ? f.runtime.refreshSessions() : f.runtime.codex.refreshSessions();
    await fastRefresh();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    if (first === 'openclaw') codex.request = async (method: string) => { entered(); await held; return codexRead(method); };
    else f.runtime.gateway.requestWithConnection = async <T>(method: string, params?: Record<string, unknown>) => { entered(); await held; return gatewayRead<T>(method, params); };
    const unavailable = assert.rejects(f.client.sessions(), { status: 503 });
    await started;
    if (invalidation === 'connection') {
      if (first === 'openclaw') f.connect('synthetic-new'); else codex.setConnection('synthetic-codex-new');
    } else {
      if (first === 'openclaw') f.fail(true);
      else codex.request = async () => { throw new Error('synthetic list failure'); };
      await assert.rejects(fastRefresh());
    }
    release(); await unavailable;
    f.fail(false); codex.request = codexRead;
    f.runtime.gateway.requestWithConnection = gatewayRead;
    assert.ok((await f.client.sessions()).sourceCursor, 'a new verified list recovers without replaying native execution');
  });
}

for (const transport of ['local', 'http'] as const) test(`${transport}: revoking snapshot authority during a native read withholds rows and cursor`, async t => {
  const f = await fixture(t, transport);
  const headers = { 'x-synthetic-operator': 'yes', 'content-type': 'application/json' };
  const response = await f.runtime.app.request('/api/connector/v1/tokens', { method: 'POST', headers,
    body: JSON.stringify({ label: 'Synthetic snapshot reader', scopes: ['sessions:read'] }) });
  assert.equal(response.status, 201);
  const credential = await response.json() as { token: string; record: { id: string } };
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.runtime.gateway.requestWithConnection = async () => {
    entered(); await held;
    return { payload: [], connectionId: f.runtime.gateway.connectionId() } as never;
  };
  const denied = assert.rejects(f.clientFor(credential.token).sessions(), { status: 403 });
  await started;
  assert.equal((await f.runtime.app.request(`/api/connector/v1/tokens/${credential.record.id}`, { method: 'DELETE', headers })).status, 200);
  release(); await denied;
  assert.ok((await f.client.sessions()).sourceCursor, 'revocation does not discard the authorized runtime cache');
});

test('failed forced refresh invalidates a previous success and concurrent readers await the current attempt', async t => {
  const f = await fixture(t);
  await f.runtime.refreshSessions();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.runtime.gateway.requestWithConnection = async () => { await held; throw new Error('synthetic list outage'); };
  const forced = assert.rejects(f.runtime.refreshSessions());
  const cached = assert.rejects(f.runtime.refreshSessions({ maxAgeMs: 60_000 }));
  release(); await Promise.all([forced, cached]);
  let retried = 0;
  f.runtime.gateway.requestWithConnection = async () => { retried++; return { payload: [], connectionId: f.runtime.gateway.connectionId() } as never; };
  await f.runtime.refreshSessions({ maxAgeMs: 60_000 });
  assert.equal(retried, 1, 'the failed attempt must invalidate the previous success');
});

for (const transport of ['local', 'http'] as const) {
  for (const replacement of ['synthetic-new', undefined]) test(`${transport}: Gateway ${replacement ?? 'disconnect'} invalidates a warm snapshot`, async t => {
    const f = await fixture(t, transport);
    await f.client.sessions();
    f.connect(replacement); f.fail(true);
    await assert.rejects(f.client.sessions(), { status: 503 });
    assert.equal(f.reads(), 2, 'connection change cannot reuse the previous success');
    f.connect('synthetic-recovered'); f.fail(false);
    assert.ok((await f.client.sessions()).sourceCursor);
    assert.equal(f.reads(), 3);
  });

  test(`${transport}: late Gateway list cannot project or certify a replacement connection`, async t => {
    const f = await fixture(t, transport);
    let release!: () => void, entered!: () => void, reads = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.runtime.gateway.requestWithConnection = async () => {
      const connectionId = f.runtime.gateway.connectionId(); reads++; entered(); await held;
      return { payload: [{ key: 'agent:main:synthetic-stale', title: 'Obsolete' }], connectionId } as never;
    };
    const unavailable = assert.rejects(f.client.sessions(), { status: 503 });
    await started;
    f.connect('synthetic-new');
    const concurrent = assert.rejects(f.runtime.refreshSessions({ maxAgeMs: 60_000 }));
    assert.equal(reads, 1, 'connection change must not start a parallel native list');
    release(); await Promise.all([unavailable, concurrent]);
    assert.equal(f.runtime.store.getSession('agent:main:synthetic-stale'), undefined);
    assert.ok((await f.client.sessions()).sourceCursor);
    assert.equal(reads, 2);
  });
}

test('Gateway replacement after synchronous projection cannot refill cleared freshness', async t => {
  const f = await fixture(t);
  const replace = f.runtime.store.replaceSessions.bind(f.runtime.store);
  f.runtime.store.replaceSessions = rows => {
    replace(rows);
    queueMicrotask(() => f.connect('synthetic-new'));
  };
  await assert.rejects(f.runtime.refreshSessions(), /connection changed/);
  f.runtime.store.replaceSessions = replace;
  await f.runtime.refreshSessions({ maxAgeMs: 60_000 });
  assert.equal(f.reads(), 2);
});

for (const invalid of [null, {}, { sessions: null }, { sessions: null, rows: [] }, { rows: [null] }, [false], [[]], [{}], [{ key: 123 }]]) test(`malformed Gateway list ${JSON.stringify(invalid)} never certifies a snapshot`, async t => {
  const f = await fixture(t); f.set(invalid);
  await assert.rejects(f.client.sessions(), { status: 503 });
  f.set({ sessions: [] });
  assert.deepEqual((await f.client.sessions()).groups, []);
  assert.equal(f.reads(), 2);
});

test('intentionally absent OpenClaw does not block a Codex-only snapshot or call the Gateway', async t => {
  const f = await fixture(t, 'local', false);
  let codexReads = 0;
  (f.runtime.codex as any).ensureStarted = async () => {};
  (f.runtime.codex as any).request = async (method: string) => {
    assert.equal(method, 'thread/list', 'only synthetic read-only Codex RPC is permitted');
    codexReads++; return { data: [], nextCursor: null };
  };
  assert.equal(f.runtime.codex.enabled, true);
  assert.ok((await f.client.sessions()).sourceCursor);
  assert.equal(codexReads, 1);
  assert.equal(f.reads(), 0);
});

for (const transport of ['local', 'http'] as const) test(`${transport}: an old Codex connection cannot certify a new Connector snapshot`, async t => {
  const f = await fixture(t, transport, false), codex = f.runtime.codex as any;
  codex.ensureStarted = async () => {};
  codex.setConnection('old');
  let release!: () => void, entered!: () => void, reads = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  codex.request = async (method: string) => {
    assert.equal(method, 'thread/list'); reads++; entered(); await held;
    return { data: [], nextCursor: null };
  };
  const unavailable = assert.rejects(f.client.sessions(), { status: 503 });
  await started;
  codex.setConnection('new'); release();
  await unavailable;
  assert.ok((await f.client.sessions()).sourceCursor);
  assert.equal(reads, 2, 'replacement is read before its snapshot is marked ready');
  assert.equal(f.reads(), 0);
});

test('Codex list failure is not swallowed by the combined Connector snapshot', async t => {
  const f = await fixture(t);
  f.runtime.codex.refreshSessions = async () => { throw new Error('synthetic Codex list outage'); };
  await assert.rejects(f.client.sessions(), { status: 503 });
  f.runtime.codex.refreshSessions = async () => {};
  assert.ok((await f.client.sessions()).sourceCursor);
});

test('unavailable snapshot returns only a sanitized error, without a cursor or cached running sessions', async t => {
  const f = await fixture(t);
  f.runtime.store.upsertSession({ sessionKey: 'codex:synthetic', agentId: 'codex', source: 'codex', title: 'Cached', status: 'running' });
  f.fail(true);
  const response = await f.runtime.app.request('/api/connector/v1/sessions/state', {
    headers: { authorization: `Bearer ${f.runtime.localToken}` },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Session snapshot unavailable' });
  assert.equal(f.runtime.store.getSession('codex:synthetic')?.status, 'running', 'read failure does not fabricate idle or erase projection');
});

for (const transport of ['local', 'http'] as const) test(`${transport}: Hub isolates an unready Connector and accepts its later verified empty snapshot`, async t => {
  const bad = await fixture(t, transport), good = await fixture(t, transport);
  const hubStore = new HubStore(':memory:', 'synthetic-vault'), app = new Hono();
  const routes = registerHubRoutes(app, { config: { ...bad.config, serverRole: 'hub' }, hubStore, normalizeError: () => 'unavailable',
    connectorClient: id => id === 'bad' ? bad.client : good.client });
  t.after(async () => { await routes?.close(); hubStore.close(); });
  for (const id of ['bad', 'good']) hubStore.upsertConnection({ id, kind: 'remote', label: id, connectorUrl: 'http://unused.invalid', status: 'enabled', capabilities: ['sessions'] });
  bad.fail(true);
  const first = await (await app.request('/api/hub/v1/sessions/state')).json() as any;
  assert.deepEqual(Object.fromEntries(first.sourceStates.map((source: any) => [source.connectionId, source.state])), { bad: 'unavailable', good: 'ready' });
  assert.deepEqual(first.sources.map((source: any) => source.connectionId), ['good']);
  assert.deepEqual(first.groups, []);
  bad.fail(false);
  const recovered = await (await app.request('/api/hub/v1/sessions/state')).json() as any;
  assert.ok(recovered.sourceStates.every((source: any) => source.state === 'ready'));
  assert.equal(recovered.sources.length, 2);
  assert.equal(bad.reads(), 2);
});
