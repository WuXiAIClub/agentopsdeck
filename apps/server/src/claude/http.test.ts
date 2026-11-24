import assert from 'node:assert/strict';
import { projectClaudeToolDetails } from './tool-details.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { loadConfig } from '../config.js';
import { DeckStore } from '../projection/deck-store.js';
import { registerConnectorRoutes } from '../routes/connector.js';
import { ClaudeConnectorRuntime } from './connector-runtime.js';
import { ClaudeOwnedRuntime } from './owned-runtime.js';
import { CLAUDE_CLI_VERSION } from './dispatch-adapter.js';
import { projectClaudeMessage } from './message-projection.js';
import { mediaResourceId } from '../messages/media-resource.js';

// Real receipt, authorization, journal, queue, projection and runtime layers;
// only the native worker/provider is synthetic. No live HOME or key is read.
async function fixture(activate = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-claude-http-')));
  const homeDirectory = join(root, 'private'); mkdirSync(homeDirectory, { mode: 0o700 });
  const config = loadConfig({ AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json') });
  config.claude = { homeDirectory, workspace: join(root, 'workspace'), sdkDirectory: join(root, 'sdk'),
    apiKeyFile: join(root, 'absent-key'), model: 'fixture', baseUrl: 'http://127.0.0.1:1', startupTimeoutMs: 1000 };
  const users = new ConnectorUserStore(config.connector.usersDatabaseFile, () => true, { runtimeOwner: true });
  const tokens = new ConnectorTokenStore(config.connector.tokenFile);
  const deck = new DeckStore({ sessionTitlesFile: config.sessionTitlesFile });
  const calls: { finish: () => void; text: string; partial: (text: string) => void; tools: () => void }[] = [];
  let owned: ClaudeOwnedRuntime | undefined;
  const claude = new ClaudeConnectorRuntime({ store: users, config: config.claude, projection: deck,
    authorize: (_key, actor) => tokens.hasScope(actor.actorId, 'messages:send'),
  }, options => owned = new ClaudeOwnedRuntime(options, ({ execution, text }, project, stream) => {
    let release!: () => void, done!: () => void, quiet = false, stopped = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finished = new Promise<void>(resolve => { done = resolve; });
    const session_id = execution.nativeSessionId;
    const identities: { type: string; uuid: string; session_id: string; parent_tool_use_id: null }[] = [];
    calls.push({ finish: release, text, tools: () => {
      for (const [type, uuid, block] of [
        ['assistant', 'call', { type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'LAZY_INPUT' } }],
        ['user', 'result', { type: 'tool_result', tool_use_id: 'tool', content: 'x'.repeat(4000) + 'LAZY_RESULT' }],
      ] as const) {
        const event = { type, uuid, session_id, parent_tool_use_id: null, message: { role: type, content: [block] } };
        project(projectClaudeMessage(event, session_id), undefined, projectClaudeToolDetails(event, session_id));
      }
    }, partial: text => stream({ messageId: 'provider', parentToolUseId: null,
      blocks: [{ blockIndex: 0, text, truncated: false }] }) });
    return { finished, async *[Symbol.asyncIterator]() {
      try {
        yield { type: 'system', subtype: 'init', session_id, claude_code_version: CLAUDE_CLI_VERSION };
        const user = { type: 'user', uuid: execution.id, session_id, parent_tool_use_id: null,
          message: { role: 'user', content: text } };
        project(projectClaudeMessage(user, session_id)); identities.push(user); yield user;
        await gate;
        if (!stopped) {
          const assistant = { type: 'assistant', uuid: `${execution.id}-reply`, session_id, parent_tool_use_id: null,
            user_message_uuid: execution.id, message: { role: 'assistant', content: 'Fixture reply' } };
          project(projectClaudeMessage(assistant, session_id), { messageId: 'provider', blockIndexes: [0] });
          identities.push(assistant); yield assistant;
        }
        yield { type: 'result', uuid: `${execution.id}-result`, session_id, user_message_uuid: execution.id,
          subtype: stopped ? 'error_during_execution' : 'success', is_error: stopped };
      } finally { quiet = true; done(); }
    }, interrupt: async () => { stopped = true; release(); }, historyIdentities: async () => identities,
    inspectQuiescence: async () => quiet, close: () => { stopped = true; release(); } };
  }, () => ({ ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close: () => {} })));
  const app = new Hono();
  const routes = registerConnectorRoutes(app, { config, tokens, connectorUsers: users, store: deck, claude,
    gateway: { request: () => assert.fail('Claude must never fall through to OpenClaw') } as any,
    sessionSnapshotReady: () => true, historySnapshotReady: key => claude.isSessionHistoryReady(key),
    refreshSessions: async () => claude.refreshDirectory(), refreshMessages: key => claude.refreshSession(key),
    fallbackAgents: () => [], isAuthorizedRequest: () => true, normalizeError: () => 'Unavailable' });
  if (activate) { claude.activate(); assert.equal(await owned!.initialize(), true); }
  const token = tokens.createTransient(['sessions:create', 'sessions:read', 'messages:read', 'messages:send', 'queue:manage']);
  const headers = { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' };
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) =>
    app.request(`/api/connector/v1${path}`, { method, headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, app, users, tokens, token, claude, calls, request, deck,
    close: async () => { routes.close(); await claude.close(); users.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Claude explicit file rebuild is scoped, cancellable and never starts native work', async () => {
  const f = await fixture();
  try {
    const key = (await (await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'file-create' })).json()).key;
    const path = `/sessions/${encodeURIComponent(key)}/files`;
    assert.equal((await (await f.request(path)).json()).rebuildAvailable, true);
    const other = f.tokens.createTransient(['messages:read']);
    const denied = f.tokens.createTransient(['sessions:read']);
    assert.equal((await f.request(`${path}/rebuild`, 'POST', undefined, { authorization: `Bearer ${denied.token}` })).status, 403);
    const start = await f.request(`${path}/rebuild`, 'POST');
    assert.equal(start.status, 200);
    const job = await start.json();
    assert.equal(job.scanned, 0);
    const recovered = await f.request(`${path}/rebuild`, 'POST');
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), job, 'same actor recovers the exact job without restarting its scan');
    assert.equal((await f.request(`${path}/rebuild`, 'POST', undefined, { authorization: `Bearer ${other.token}` })).status, 409,
      'another actor cannot take over the active rebuild');
    assert.equal((await f.request(`${path}/rebuild/${job.id}`, 'DELETE', undefined, { authorization: `Bearer ${other.token}` })).status, 404);
    assert.equal((await f.request(`${path}/rebuild/${job.id}`, 'POST', { step: -1 })).status, 400);
    assert.equal((await f.request(`${path}/rebuild/${job.id}`, 'POST', { step: 0, tooLarge: 'x'.repeat(1024) })).status, 413);
    assert.equal((await (await f.request(`${path}/rebuild/${job.id}`, 'DELETE')).json()).state, 'cancelled');
    const next = await (await f.request(`${path}/rebuild`, 'POST')).json();
    assert.equal((await (await f.request(`${path}/rebuild/${next.id}`, 'POST', { step: 0 })).json()).state, 'completed');
    assert.equal((await (await f.request(path)).json()).coverage, 'partial');
    assert.equal(f.calls.length, 0);
    f.token.dispose();
    assert.equal((await f.request(`${path}/rebuild/${next.id}`, 'POST', { step: 0 })).status, 401);
  } finally { await f.close(); }
});

test('file rebuild rechecks authority after reading a delayed step body', async () => {
  const f = await fixture();
  try {
    const key = (await (await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'file-revoke-create' })).json()).key;
    const path = `/sessions/${encodeURIComponent(key)}/files/rebuild`;
    const job = await (await f.request(path, 'POST')).json();
    const original = f.users.fileIndex.page(key);
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      f.token.dispose();
      controller.enqueue(new TextEncoder().encode('{"step":0}')); controller.close();
    } }, { highWaterMark: 0 });
    const response = await f.app.fetch(new Request(`http://connector/api/connector/v1${path}/${job.id}`, {
      method: 'POST', headers: { authorization: `Bearer ${f.token.token}`, 'content-type': 'application/json' }, body, duplex: 'half',
    } as RequestInit));
    assert.equal(response.status, 403);
    assert.deepEqual(f.users.fileIndex.page(key), original);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('Claude SDK media passes the reserved runtime gate but requires media scope and exact membership', async () => {
  const f = await fixture();
  try {
    const key = (await (await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'media-create' })).json()).key;
    const file = { name: 'fixture.txt', mimeType: 'text/plain', data: Buffer.from('safe fixture').toString('base64') };
    const path = `/sessions/${encodeURIComponent(key)}`;
    const sent = await f.request(`${path}/messages`, 'POST', { message: 'attachment', idempotencyKey: 'media-send',
      media: [{ name: file.name, mimeType: file.mimeType, type: 'file', dataUrl: `data:${file.mimeType};base64,${file.data}` }] });
    assert.equal(sent.status, 200);
    const admission = (await sent.json()).idempotencyKey;
    const item = f.users.sdkAttachments.media(key, admission)[0]!;
    const url = `${path}/messages/${encodeURIComponent(admission)}/media/${mediaResourceId(item.url)}`;
    assert.equal((await f.request(url)).status, 403);
    const token = f.tokens.createTransient(['messages:read', 'media:read']);
    const headers = { authorization: `Bearer ${token.token}` };
    const response = await f.request(url, 'GET', undefined, headers);
    assert.equal(response.status, 200); assert.equal(await response.text(), 'safe fixture');
    assert.equal((await f.request(url.replace(`/${encodeURIComponent(admission)}/media/`, '/foreign/media/'), 'GET', undefined, headers)).status, 404);
    assert.equal((await f.request(`${url}/approval`, 'POST', {}, headers)).status, 409);
    assert.equal((await f.request(`${path}/messages`, 'POST', { message: '/stop', idempotencyKey: 'stop-media',
      media: [{ name: file.name, type: 'file', dataUrl: `data:${file.mimeType};base64,${file.data}` }] })).status, 400);
  } finally { await f.close(); }
});

test('Claude public create/send/history use durable idempotency without invoking another runtime', async () => {
  const f = await fixture();
  try {
    const create = () => f.request('/agents/claude-code/sessions', 'POST', { title: 'HTTP fixture' }, { 'idempotency-key': 'create' });
    const response = await create(); assert.equal(response.status, 201);
    const body = await response.json(), key = body.key as string;
    assert.match(key, /^claude-code:/); assert.equal(f.calls.length, 0);
    assert.equal((await (await create()).json()).key, key);
    assert.equal(f.users.claudeJournal.sessionKeys().length, 1);
    const path = `/sessions/${encodeURIComponent(key)}`;
    const send = () => f.request(`${path}/messages`, 'POST', { message: 'hello', idempotencyKey: 'send' });
    const sent = await send(); assert.equal(sent.status, 200); assert.equal((await sent.json()).command.state, 'accepted');
    await setImmediate(); assert.equal(f.calls.length, 1);
    assert.equal((await send()).status, 200); assert.equal(f.calls.length, 1);
    f.calls[0]!.finish(); await setImmediate();
    const history = await f.request(`${path}/messages?limit=1`); assert.equal(history.status, 200);
    const page = await history.json(); assert.equal(page.totalCount, 2); assert.equal(page.hiddenCount, 1);
    assert.equal(page.messages[0].text, 'Fixture reply');
    const older = await f.request(`${path}/messages?before=${encodeURIComponent(page.messages[0].id)}`);
    assert.equal(older.status, 200); assert.equal((await older.json()).messages[0].text, 'hello');
    assert.equal((await f.request(`${path}/messages?before=invalid`)).status, 409);
    assert.equal(f.calls.length, 1, 'history never starts or resumes native');
    assert.equal((await f.request(`${path}/settings`, 'PATCH', {})).status, 409);
    // Mock turns have no native SDK files; deletion cannot claim success.
    const deletion = () => f.request(path, 'DELETE', {}, { 'idempotency-key': 'delete-unknown' });
    const deleted = await deletion();
    assert.equal(deleted.status, 202);
    assert.equal((await deleted.json()).command.state, 'outcome_unknown');
    assert.equal(f.users.claudeJournal.deletion(key)?.phase, 'unknown');
    assert.equal((await (await deletion()).json()).command.state, 'outcome_unknown');
    assert.equal((await (await f.request(`${path}/deletion-commands/delete-unknown`)).json()).command.state, 'outcome_unknown');
    f.token.dispose(); assert.equal((await f.request(`${path}/messages`)).status, 401);
  } finally { await f.close(); }
});

test('Claude paused sends reject definitively while accepted duplicate receipts remain accepted', async () => {
  const f = await fixture();
  try {
    const created = await (await f.request('/agents/claude-code/sessions', 'POST', { title: 'Pause' }, { 'idempotency-key': 'create-pause' })).json();
    const path = `/sessions/${encodeURIComponent(created.key)}/messages`;
    const send = (id: string) => f.request(path, 'POST', { message: 'hello', idempotencyKey: id });
    assert.equal((await send('accepted-before-pause')).status, 200);
    await setImmediate(); f.calls[0]!.finish(); await setImmediate();
    const pause = f.claude.pauseQueueWorker(); await pause.drained;
    assert.equal((await (await send('accepted-before-pause')).json()).command.state, 'accepted');
    const rejected = await send('paused-input'); assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).command.state, 'rejected');
    assert.equal(pause.resume(), true);
    assert.equal((await send('paused-input')).status, 409, 'rejected identity cannot silently become a new send');
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('Claude HTTP tool details stay lazy and require current owner authorization', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'tools-create' });
    const key = (await created.json()).key as string, path = `/sessions/${encodeURIComponent(key)}`;
    await f.request(`${path}/messages`, 'POST', { message: 'hello', idempotencyKey: 'tools-send' });
    await setImmediate(); f.calls[0]!.tools();
    const response = await f.request(`${path}/messages`); assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(JSON.stringify(page).includes('LAZY_INPUT'), false);
    assert.equal(JSON.stringify(page).includes('LAZY_RESULT'), false);
    const result = page.messages.find((row: { toolPhase?: string }) => row.toolPhase === 'result');
    assert.ok(result?.toolDetailAvailable);
    const detailPath = `${path}/messages/${encodeURIComponent(result.id)}`;
    const detail = await f.request(detailPath); assert.equal(detail.status, 200);
    const body = JSON.stringify(await detail.json());
    assert.match(body, /LAZY_INPUT/); assert.match(body, /LAZY_RESULT/);
    assert.equal((await f.request(`${path}/messages/invalid`)).status, 404);
    f.token.dispose(); assert.equal((await f.request(detailPath)).status, 401);
  } finally { await f.close(); }
});

test('Claude authenticated HTTP history and DeckStore stream share stable IDs, queue order and revoked access', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'stream-create' });
    const key = (await created.json()).key as string, path = `/sessions/${encodeURIComponent(key)}`;
    await f.request(`${path}/messages`, 'POST', { message: 'hello', idempotencyKey: 'stream-send' });
    await setImmediate();
    f.calls[0]!.partial('Fixture');
    const live = await (await f.request(`${path}/messages?limit=1`)).json();
    const id = live.messages[0].id as string;
    assert.equal(live.messages[0].text, 'Fixture'); assert.match(id, /^claude-live:/);
    assert.ok(f.deck.getMessages(key).some(message => message.id === id && message.text === 'Fixture'));
    const older = await (await f.request(`${path}/messages?before=${encodeURIComponent(id)}`)).json();
    assert.equal(older.messages[0].text, 'hello');
    assert.equal((await f.request(`${path}/messages`, 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'synthetic' })).status, 403);
    f.calls[0]!.partial('Fixture reply');
    f.calls[0]!.finish(); await setImmediate();
    const final = await (await f.request(`${path}/messages`)).json();
    assert.equal(final.totalCount, 2);
    assert.equal(final.messages[1].id, id); assert.equal(final.messages[1].text, 'Fixture reply');
    const single = await f.request(`${path}/messages/${encodeURIComponent(id)}`);
    assert.equal(single.status, 200);
    assert.equal(f.users.claudeTranscript.liveMessages(key).length, 0);
    f.token.dispose(); assert.equal((await f.request(`${path}/messages`)).status, 401);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('Claude public routes reject unready admission and delegated reads/creation before claiming receipts', async () => {
  const f = await fixture(false);
  try {
    const response = await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'not-ready' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Agent is not ready', code: 'agent_not_ready', runtime: 'claude-code', readiness: 'starting' });
    assert.equal((await (await f.request('/health')).json()).claude.status, 'starting');
    const capabilities = await (await f.request('/capabilities')).json();
    assert.equal(capabilities.runtimes['claude-code'].status, 'starting');
    assert.equal(capabilities.runtimes['claude-code'].features.compact, true);
    assert.equal(capabilities.runtimes.hermes.features.compact, false);
    assert.equal(capabilities.runtimes.ghcp.status, 'disabled');
    assert.equal(f.users.claudeJournal.sessionKeys().length, 0);
    const headers = { 'x-agentopsdeck-execution-grant': 'synthetic' };
    assert.equal((await f.request('/agents/claude-code/sessions', 'POST', {}, headers)).status, 403);
    assert.equal((await f.request('/sessions/claude-code%3Asynthetic/messages', 'GET', undefined, headers)).status, 403);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('Claude readiness reflects maintenance without losing history or replaying a command', async () => {
  const f = await fixture();
  try {
    assert.equal((await (await f.request('/health')).json()).claude.status, 'ready');
    const pause = f.claude.pauseQueueWorker(); await pause.drained;
    assert.equal((await (await f.request('/capabilities')).json()).runtimes['claude-code'].status, 'maintenance');
    const denied = await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'maintenance' });
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).readiness, 'maintenance');
    assert.equal(f.users.claudeJournal.sessionKeys().length, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(pause.resume(), true);
    assert.equal((await (await f.request('/health')).json()).claude.status, 'ready');
  } finally { await f.close(); }
});

test('Claude compact variants reject durably before native admission', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'create' });
    const key = (await created.json()).key as string;
    for (const [index, message] of ['/compact', ' /compact focus ', '/compact\nkeep context'].entries()) {
      const send = () => f.request(`/sessions/${encodeURIComponent(key)}/messages`, 'POST', { message, idempotencyKey: `compact-${index}` });
      for (let repeat = 0; repeat < 2; repeat++) {
        const response = await send(); assert.equal(response.status, 409);
        assert.equal((await response.json()).command.state, 'rejected');
      }
    }
    await setImmediate(); assert.equal(f.calls.length, 0);
    assert.equal(f.users.turns.maintenanceCount(), 0);
  } finally { await f.close(); }
});

test('Claude public queue supports versioned edit/cancel and exact-run stop', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'create' });
    const key = (await created.json()).key as string, path = `/sessions/${encodeURIComponent(key)}`;
    await f.request(`${path}/messages`, 'POST', { message: 'first', idempotencyKey: 'first' });
    await setImmediate();
    const queued = await f.request(`${path}/messages`, 'POST', { message: 'second', idempotencyKey: 'second' });
    const second = await queued.json(); assert.equal(second.queueDisposition, 'waiting');
    const id = second.idempotencyKey as string;
    const refreshed = await (await f.request(`${path}/messages`)).json();
    assert.equal(refreshed.messages.at(-1).id, id);
    assert.equal(refreshed.messages.at(-1).status, 'queued');
    const version = f.users.turns.version('claude-code', key, id)!;
    for (const headers of [{ 'if-match': `"${version}"` },
      { 'if-match': `"${version}"`, 'idempotency-key': 'compact-edit' }]) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const rejected = await f.request(`${path}/queue/${id}`, 'PATCH', { message: '/compact focus' }, headers);
        assert.equal(rejected.status, 409);
        if ('idempotency-key' in headers) assert.equal((await rejected.json()).command.state, 'rejected');
        assert.equal(f.users.turns.version('claude-code', key, id), version);
      }
    }
    assert.equal((await (await f.request(`${path}/messages`)).json()).messages.at(-1).text, 'second');
    const edit = await f.request(`${path}/queue/${id}`, 'PATCH', { message: 'edited' },
      { 'if-match': `"${version}"`, 'idempotency-key': 'edit' });
    assert.equal(edit.status, 200);
    assert.equal((await (await f.request(`${path}/messages`)).json()).messages.at(-1).text, 'edited');
    const cancelHeaders = { 'if-match': `"${f.users.turns.version('claude-code', key, id)}"`, 'idempotency-key': 'cancel' };
    assert.equal((await f.request(`${path}/queue/${id}`, 'DELETE', undefined, cancelHeaders)).status, 200);
    assert.equal((await f.request(`${path}/queue/${id}`, 'DELETE', undefined, cancelHeaders)).status, 200);
    assert.equal((await (await f.request(`${path}/messages`)).json()).messages.some((row: { id: string }) => row.id === id), false);
    assert.equal((await f.request(`${path}/messages`, 'POST', { message: '/stop', expectedRunId: 'stale', idempotencyKey: 'stale-stop' })).status, 409);
    const expectedRunId = f.users.claudeJournal.current(key)!.id;
    assert.equal((await f.request(`${path}/messages`, 'POST', { message: '/stop', expectedRunId, idempotencyKey: 'stop' })).status, 200);
    await setImmediate(); assert.equal(f.calls.length, 1);
    assert.equal(f.users.turns.maintenanceCount(), 0);
  } finally { await f.close(); }
});

test('Claude HTTP waiting inputs batch into one successor run and retain exact IDs across refresh', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/agents/claude-code/sessions', 'POST', {}, { 'idempotency-key': 'create' });
    const key = (await created.json()).key as string, path = `/sessions/${encodeURIComponent(key)}`;
    const send = (message: string) => f.request(`${path}/messages`, 'POST', { message, idempotencyKey: message });
    await send('first'); await setImmediate();
    const ids: string[] = [];
    for (const text of ['second', 'third']) {
      const reply = await (await send(text)).json();
      ids.push(reply.idempotencyKey); assert.equal(reply.queueDisposition, 'waiting');
    }
    assert.equal(f.calls.length, 1);
    const queued = await (await f.request(`${path}/messages?limit=2`)).json();
    assert.deepEqual(queued.messages.map((m: { id: string }) => m.id), ids);
    f.calls[0]!.finish();
    for (let i = 0; i < 20 && f.calls.length < 2; i++) await setImmediate();
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[1]!.text, /^second\n\n\[Queued message boundary [a-f0-9-]+\]\n\nthird$/);
    f.calls[1]!.finish(); await setImmediate();
    const final = await (await f.request(`${path}/messages`)).json();
    assert.equal(final.totalCount, 5);
    assert.deepEqual(final.messages.filter((m: { role: string }) => m.role === 'user').map((m: { text: string }) => m.text), ['first', 'second', 'third']);
    for (const id of ids) {
      const rows = final.messages.filter((m: { id: string }) => m.id === id);
      assert.equal(rows.length, 1); assert.equal(rows[0].status, 'sent');
    }
    assert.equal(f.calls.length, 2, 'three inputs execute in two native turns');
  } finally { await f.close(); }
});
