import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CopilotHistoryIdentity } from './dispatch-adapter.js';
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
import { CopilotConnectorRuntime } from './connector-runtime.js';
import { CopilotOwnedRuntime } from './owned-runtime.js';
import { COPILOT_CLI_VERSION } from './dispatch-adapter.js';
import { projectCopilotMessage } from './message-projection.js';
import { projectCopilotToolDetail } from './tool-details.js';

// Real receipt, authorization, journal, queue, projection and runtime layers;
// only the native worker/provider is synthetic. No live HOME or key is read.
async function fixture(activate = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-copilot-http-')));
  const homeDirectory = join(root, 'private'); mkdirSync(homeDirectory, { mode: 0o700 });
  const config = loadConfig({ AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json') });
  config.copilot = { homeDirectory, workspace: join(root, 'workspace'), sdkDirectory: join(root, 'sdk'),
    auth: { mode: 'github', credentialFile: join(root, 'absent-key') }, model: 'fixture', startupTimeoutMs: 1000 };
  const users = new ConnectorUserStore(config.connector.usersDatabaseFile, () => true, { runtimeOwner: true });
  const tokens = new ConnectorTokenStore(config.connector.tokenFile);
  const deck = new DeckStore({ sessionTitlesFile: config.sessionTitlesFile });
  const calls: { finish: () => void; text: string; partial: (text: string) => void; tool: () => void }[] = [];
  let owned: CopilotOwnedRuntime | undefined;
  const copilot = new CopilotConnectorRuntime({ store: users, config: config.copilot, projection: deck,
    authorize: (_key, actor) => tokens.hasScope(actor.actorId, 'messages:send'),
  }, options => owned = new CopilotOwnedRuntime(options, ({ execution, text }, projection) => {
    let release!: () => void, done!: () => void, quiet = false, stopped = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finished = new Promise<void>(resolve => { done = resolve; });
    const sessionId = execution.nativeSessionId, inputId = randomUUID(), replyId = randomUUID();
    const identities: CopilotHistoryIdentity[] = [];
    const event = <T extends string>(type: T, data: object) => ({ id: randomUUID(), type, timestamp: new Date().toISOString(), data });
    calls.push({ finish: release, text, partial: text => projection.stream?.({ messageId: replyId, text, truncated: false }),
      tool: () => {
        const source = event('tool.execution_complete', { toolCallId: 'call', success: true, result: { content: 'LAZY_TOOL_BODY' } });
        const row = projectCopilotMessage(source)!;
        projection.project?.(row, projectCopilotToolDetail(source, row));
      } });
    return { finished, verified: Promise.resolve({ sessionId, version: COPILOT_CLI_VERSION, protocolVersion: 3 }),
      admitted: Promise.resolve({ messageId: inputId }), async *[Symbol.asyncIterator]() {
        try {
          const input = event('user.message', { messageId: inputId, content: text });
          projection.project?.(projectCopilotMessage(input)!);
          identities.push({ id: input.id, type: input.type, messageId: inputId }); yield input;
          await gate;
          if (!stopped) {
            const output = event('assistant.message', { messageId: replyId, originatingMessageId: inputId, content: 'Fixture reply' });
            projection.project?.(projectCopilotMessage(output)!);
            identities.push({ id: output.id, type: output.type, messageId: replyId, originatingMessageId: inputId }); yield output;
          }
          yield event('session.idle', { aborted: stopped });
        } finally { quiet = true; done(); }
      }, interrupt: async () => { stopped = true; release(); }, historyIdentities: async () => ({ sessionId, entries: identities }),
      inspectQuiescence: async () => quiet, close: () => { stopped = true; release(); } };
  }, () => ({ ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close: () => {} })));
  const app = new Hono();
  const routes = registerConnectorRoutes(app, { config, tokens, connectorUsers: users, store: deck, copilot,
    gateway: { request: () => assert.fail('Copilot must never fall through to OpenClaw') } as any,
    sessionSnapshotReady: () => true, historySnapshotReady: key => copilot.isSessionHistoryReady(key),
    refreshSessions: async () => copilot.refreshDirectory(), refreshMessages: key => copilot.refreshSession(key),
    fallbackAgents: () => [], isAuthorizedRequest: () => true, normalizeError: () => 'Unavailable' });
  if (activate) { copilot.activate(); assert.equal(await owned!.initialize(), true); }
  const token = tokens.createTransient(['sessions:create', 'sessions:read', 'messages:read', 'messages:send', 'queue:manage', 'models:read']);
  const headers = { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' };
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) =>
    app.request(`/api/connector/v1${path}`, { method, headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, app, users, tokens, token, copilot, calls, request, deck,
    close: async () => { routes.close(); await copilot.close(); users.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Copilot file rebuild uses durable summaries without native worker calls', async () => {
  const f = await fixture();
  try {
    const key = (await (await f.request('/agents/ghcp/sessions', 'POST', {}, { 'idempotency-key': 'file-create' })).json()).key;
    const path = `/sessions/${encodeURIComponent(key)}/files`;
    assert.equal((await (await f.request(path)).json()).rebuildAvailable, true);
    const job = await (await f.request(`${path}/rebuild`, 'POST')).json();
    assert.equal(job.state, 'scanning');
    const result = await f.request(`${path}/rebuild/${job.id}`, 'POST', { step: job.step });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).state, 'completed');
    assert.equal((await (await f.request(path)).json()).coverage, 'partial');
    assert.equal(f.calls.length, 0);
    assert.equal((await f.request('/sessions/codex%3Aunsupported/files/rebuild', 'POST')).status, 404);
  } finally { await f.close(); }
});

test('Copilot compact variants reject durably before native admission', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/agents/ghcp/sessions', 'POST', {}, { 'idempotency-key': 'create' });
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

test('Copilot public create/send/history use durable idempotency without invoking another runtime', async () => {
  const f = await fixture();
  try {
    const create = () => f.request('/agents/ghcp/sessions', 'POST', { title: 'HTTP fixture' }, { 'idempotency-key': 'create' });
    const response = await create(); assert.equal(response.status, 201);
    const body = await response.json(), key = body.key as string;
    assert.match(key, /^ghcp:/); assert.equal(f.calls.length, 0);
    assert.equal((await (await create()).json()).key, key);
    assert.equal(f.users.copilotJournal.sessionKeys().length, 1);
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
    const deletion = () => f.request(path, 'DELETE', {}, { 'idempotency-key': 'delete-unknown' });
    const deleted = await deletion();
    assert.equal(deleted.status, 202);
    assert.equal((await deleted.json()).command.state, 'outcome_unknown');
    assert.equal(f.users.copilotJournal.deletion(key)?.phase, 'unknown');
    assert.equal((await (await deletion()).json()).command.state, 'outcome_unknown');
    assert.equal((await (await f.request(`${path}/deletion-commands/delete-unknown`)).json()).command.state, 'outcome_unknown');
    f.token.dispose(); assert.equal((await f.request(`${path}/messages`)).status, 401);
  } finally { await f.close(); }
});

test('Copilot model discovery is configured-only and owner-only, including before startup', async () => {
  const f = await fixture(false);
  try {
    const response = await f.request('/models/ghcp');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { models: [{ id: 'fixture', label: 'fixture' }] });
    assert.equal(f.calls.length, 0);
    assert.equal((await f.request('/models/ghcp', 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'not-owner' })).status, 403);
    const delegated = f.tokens.createTransient(['models:read', 'execution:delegate']);
    assert.equal((await f.request('/models/ghcp', 'GET', undefined, { authorization: `Bearer ${delegated.token}` })).status, 403);
    const unscoped = f.tokens.createTransient(['sessions:read']);
    assert.equal((await f.request('/models/ghcp', 'GET', undefined, { authorization: `Bearer ${unscoped.token}` })).status, 403);
    assert.equal((await f.request('/models/claude-code')).status, 404);
  } finally { await f.close(); }
});

test('Copilot lazy tool endpoint requires read authority; list and live projection never include bodies', async () => {
  const f = await fixture();
  try {
    const create = await f.request('/agents/ghcp/sessions', 'POST', {}, { 'idempotency-key': 'tool-create' });
    const key = (await create.json()).key as string, path = `/sessions/${encodeURIComponent(key)}`;
    await f.request(`${path}/messages`, 'POST', { message: 'tool', idempotencyKey: 'tool-send' }); await setImmediate();
    f.calls[0]!.tool();
    const page = await (await f.request(`${path}/messages`)).json();
    const tool = page.messages.find((row: { role: string }) => row.role === 'tool');
    assert.equal(tool.toolDetailAvailable, true); assert.ok(!JSON.stringify(page).includes('LAZY_TOOL_BODY'));
    assert.ok(!JSON.stringify(f.deck.getMessages(key)).includes('LAZY_TOOL_BODY'));
    assert.equal(f.deck.getSession(key)?.model, 'fixture');
    const detailPath = `${path}/messages/${encodeURIComponent(tool.id)}`;
    const detail = await f.request(detailPath);
    assert.equal(detail.status, 200); assert.equal((await detail.json()).message.text, 'LAZY_TOOL_BODY');
    const unscoped = f.tokens.createTransient(['sessions:read']);
    assert.equal((await f.request(detailPath, 'GET', undefined, { authorization: `Bearer ${unscoped.token}` })).status, 403);
    assert.equal((await f.request(detailPath, 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'foreign' })).status, 403);
    f.token.dispose(); assert.equal((await f.request(detailPath)).status, 401);
  } finally { await f.close(); }
});

test('Copilot authenticated HTTP history and DeckStore stream share stable IDs, queue order and revoked access', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/agents/ghcp/sessions', 'POST', {}, { 'idempotency-key': 'stream-create' });
    const key = (await created.json()).key as string, path = `/sessions/${encodeURIComponent(key)}`;
    await f.request(`${path}/messages`, 'POST', { message: 'hello', idempotencyKey: 'stream-send' });
    await setImmediate();
    f.calls[0]!.partial('Fixture');
    const live = await (await f.request(`${path}/messages?limit=1`)).json();
    const id = live.messages[0].id as string;
    assert.equal(live.messages[0].text, 'Fixture'); assert.match(id, /^ghcp-message:/);
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
    assert.equal(f.users.copilotTranscript.liveMessages(key).length, 0);
    f.token.dispose(); assert.equal((await f.request(`${path}/messages`)).status, 401);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('Copilot public routes reject unready admission and delegated reads/creation before claiming receipts', async () => {
  const f = await fixture(false);
  try {
    const response = await f.request('/agents/ghcp/sessions', 'POST', {}, { 'idempotency-key': 'not-ready' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Agent is not ready', code: 'agent_not_ready', runtime: 'ghcp', readiness: 'starting' });
    assert.equal((await (await f.request('/health')).json()).copilot.status, 'starting');
    const capabilities = await (await f.request('/capabilities')).json();
    assert.equal(capabilities.runtimes.ghcp.status, 'starting');
    assert.equal(capabilities.runtimes.ghcp.features.compact, true);
    assert.equal(capabilities.runtimes.hermes.features.compact, false);
    assert.equal(capabilities.runtimes['claude-code'].status, 'disabled');
    assert.equal(f.users.copilotJournal.sessionKeys().length, 0);
    const headers = { 'x-agentopsdeck-execution-grant': 'synthetic' };
    assert.equal((await f.request('/agents/ghcp/sessions', 'POST', {}, headers)).status, 403);
    assert.equal((await f.request('/sessions/ghcp%3Asynthetic/messages', 'GET', undefined, headers)).status, 403);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('Copilot readiness reflects maintenance without admitting native work', async () => {
  const f = await fixture();
  try {
    assert.equal((await (await f.request('/health')).json()).copilot.status, 'ready');
    const pause = f.copilot.pauseQueueWorker(); await pause.drained;
    assert.equal((await (await f.request('/capabilities')).json()).runtimes.ghcp.status, 'maintenance');
    const denied = await f.request('/agents/ghcp/sessions', 'POST', {}, { 'idempotency-key': 'maintenance' });
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).readiness, 'maintenance');
    assert.equal(f.users.copilotJournal.sessionKeys().length, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(pause.resume(), true);
    assert.equal((await (await f.request('/health')).json()).copilot.status, 'ready');
  } finally { await f.close(); }
});

test('Copilot public queue supports versioned edit/cancel and exact-run stop', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/agents/ghcp/sessions', 'POST', {}, { 'idempotency-key': 'create' });
    const key = (await created.json()).key as string, path = `/sessions/${encodeURIComponent(key)}`;
    await f.request(`${path}/messages`, 'POST', { message: 'first', idempotencyKey: 'first' });
    await setImmediate();
    const queued = await f.request(`${path}/messages`, 'POST', { message: 'second', idempotencyKey: 'second' });
    const second = await queued.json(); assert.equal(second.queueDisposition, 'waiting');
    const id = second.idempotencyKey as string;
    const refreshed = await (await f.request(`${path}/messages`)).json();
    assert.equal(refreshed.messages.at(-1).id, id);
    assert.equal(refreshed.messages.at(-1).status, 'queued');
    const version = f.users.turns.version('ghcp', key, id)!;
    for (const headers of [{ 'if-match': `"${version}"` },
      { 'if-match': `"${version}"`, 'idempotency-key': 'compact-edit' }]) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const rejected = await f.request(`${path}/queue/${id}`, 'PATCH', { message: '/compact focus' }, headers);
        assert.equal(rejected.status, 409);
        if ('idempotency-key' in headers) assert.equal((await rejected.json()).command.state, 'rejected');
        assert.equal(f.users.turns.version('ghcp', key, id), version);
      }
    }
    assert.equal((await (await f.request(`${path}/messages`)).json()).messages.at(-1).text, 'second');
    const edit = await f.request(`${path}/queue/${id}`, 'PATCH', { message: 'edited' },
      { 'if-match': `"${version}"`, 'idempotency-key': 'edit' });
    assert.equal(edit.status, 200);
    assert.equal((await (await f.request(`${path}/messages`)).json()).messages.at(-1).text, 'edited');
    const cancelHeaders = { 'if-match': `"${f.users.turns.version('ghcp', key, id)}"`, 'idempotency-key': 'cancel' };
    assert.equal((await f.request(`${path}/queue/${id}`, 'DELETE', undefined, cancelHeaders)).status, 200);
    assert.equal((await f.request(`${path}/queue/${id}`, 'DELETE', undefined, cancelHeaders)).status, 200);
    assert.equal((await (await f.request(`${path}/messages`)).json()).messages.some((row: { id: string }) => row.id === id), false);
    assert.equal((await f.request(`${path}/messages`, 'POST', { message: '/stop', expectedRunId: 'stale', idempotencyKey: 'stale-stop' })).status, 409);
    const expectedRunId = f.users.copilotJournal.current(key)!.id;
    assert.equal((await f.request(`${path}/messages`, 'POST', { message: '/stop', expectedRunId, idempotencyKey: 'stop' })).status, 200);
    await setImmediate(); assert.equal(f.calls.length, 1);
    assert.equal(f.users.turns.maintenanceCount(), 0);
  } finally { await f.close(); }
});

test('Copilot HTTP waiting inputs batch into one successor run and retain exact IDs across refresh', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/agents/ghcp/sessions', 'POST', {}, { 'idempotency-key': 'create' });
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
