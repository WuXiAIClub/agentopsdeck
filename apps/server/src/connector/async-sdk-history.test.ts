import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HISTORY_DELTA_HEADER } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { projectClaudeToolDetails } from '../claude/tool-details.js';
import { projectCopilotMessage } from '../copilot/message-projection.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { SdkCommands } from './sdk-commands.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkHistory, ReadRequestError } from './async-sdk-history.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { registerSdkHistoryHttp } from './sdk-history-http.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

const authorization = 'Bearer isolated-history';
const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
function fixture(runtime: SdkAgentId) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-history-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), authorization.slice(7));
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const key = `${runtime}:original`, journal = runtime === 'ghcp' ? store.copilotJournal : runtime === 'antigravity' ? store.antigravityJournal : store.claudeJournal;
  journal.create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 1 });
  const ref = { key, id: 'execution', epoch: 'epoch' }, scope = { runtime, key, authorization };
  store.turns.enqueue(runtime, { id: 'input', sessionKey: key, createdAt: 2, payload: { text: 'Input', images: [], actorId: 'owner' } });
  journal.begin(ref, ['input'], store.turns);
  const append = (id: string, text: string) => runtime === 'ghcp'
    ? store.copilotTranscript.append(ref, projectCopilotMessage({ id: `event-${id}`, type: 'assistant.message',
      timestamp: new Date(5000).toISOString(), data: { messageId: id, content: text } })!)
    : runtime === 'antigravity'
      ? store.antigravityTranscript.append(ref, projectCopilotMessage({ id: `event-${id}`, type: 'assistant.message',
        timestamp: new Date(5000).toISOString(), data: { messageId: id, content: text } })!)
    : store.claudeTranscript.append(ref, projectClaudeMessage({ type: 'assistant', uuid: id, session_id: 'original-native',
      parent_tool_use_id: null, message: { role: 'assistant', content: text } }, 'original-native'));
  const command = createConnectorOwnerCommands(store, tokens);
  let port: Pick<AsyncConnectorOwner, 'command'> = { command };
  const history = new AsyncSdkHistory({ command: (kind, input) => port.command(kind, input) }, { diagnostics: silence, timeoutMs: 5_000 });
  const app = new Hono(); registerSdkHistoryHttp(app, '/sessions/:sessionKey', { history });
  let fallback = 0; app.get('/sessions/:sessionKey/messages', c => { fallback++; return c.json({ legacy: true }); });
  const request = (suffix = '', headers: Record<string, string> = {}) => app.request(`/sessions/${key}/messages${suffix}`, { headers: { authorization, ...headers } });
  return { directory, store, tokens, key, ref, journal, scope, append, command, history, request, app,
    port(value: Pick<AsyncConnectorOwner, 'command'>) { port = value; }, fallback: () => fallback,
    async close() { await history.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp', 'antigravity'] as const) {
  test(`${runtime}: history preserves bounded durable/queued page, details, anchors, ETag and delta after fresh authority`, { timeout: 20_000 }, async () => {
    const f = fixture(runtime);
    try {
      for (let i = 0; i < 4; i++) f.append(`reply-${i}`, `Reply ${i} ${'x'.repeat(1500)}`);
      f.store.turns.enqueue(runtime, { id: 'pending', sessionKey: f.key, createdAt: 3, payload: { text: 'Pending', images: [], actorId: 'owner' } });
      const headers = { [HISTORY_DELTA_HEADER]: '1' };
      const first = await f.request('?limit=4', headers); assert.equal(first.status, 200);
      assert.equal(first.headers.get('cache-control'), 'no-store'); const page = await first.json();
      assert.equal(page.messages.length, 4); assert.equal(page.messages.at(-1).id, 'pending');
      assert.equal(page.hiddenCount, 2); assert.equal(page.totalCount, 6); assert.match(page.revision, /^r:/);
      assert.equal(page.revision, stableGatewayRowsRevision(page.messages));
      const etag = first.headers.get('etag')!;
      assert.equal((await f.request('?limit=4', { ...headers, 'if-none-match': etag })).status, 304);
      const older = await f.request(`?limit=2&before=${encodeURIComponent(page.messages[0].id)}`);
      assert.equal(older.status, 200); assert.equal((await older.json()).messages.length, 2);
      const detail = await f.request(`/${encodeURIComponent(page.messages[0].id)}`);
      assert.equal(detail.status, 200); assert.equal((await detail.json()).message.id, page.messages[0].id);
      assert.equal((await f.request('/missing')).status, 404);
      assert.equal((await f.request('?before=missing')).status, 409);
      assert.equal((await f.request('?before=')).status, 400);
      f.append('reply-new', `New ${'z'.repeat(1500)}`);
      const delta = await f.request('?limit=4', { ...headers, 'if-none-match': etag }); assert.equal(delta.status, 200);
      assert.equal(delta.headers.get(HISTORY_DELTA_HEADER), '1'); assert.equal((await delta.json()).base, etag);
      const invalid = await f.request('', { 'x-agentopsdeck-execution-grant': 'not-history-authority' }); assert.equal(invalid.status, 403);
      assert.equal((await f.request('', { authorization: '' })).status, 401);
      assert.equal(f.fallback(), 0);
      assert.equal((await f.app.request('/sessions/codex:old/messages')).status, 200); assert.equal(f.fallback(), 1);
      f.tokens.revoke(f.tokens.authenticateAuthorization(authorization)!.tokenId);
      assert.equal((await f.request('?limit=4', { 'if-none-match': etag })).status, 401, 'cached validators never bypass authority');
    } finally { await f.close(); }
  });

  test(`${runtime}: history HTTP preserves live rows and attachment metadata without attachment bodies`, { timeout: 20_000 }, async () => {
    const f = fixture(runtime);
    try {
      const attachments = [{ name: 'original.txt', mimeType: 'text/plain', data: Buffer.from('private attachment body').toString('base64') }];
      const commands = new SdkCommands({ runtime, store: f.store, journal: f.journal,
        driver: { wake: async () => {}, interrupt: async () => 'accepted' },
        assertAvailable() {}, authorize: () => true, changed() {}, models: { model: 'test' } });
      const admitted = commands.send(f.key, '', { actorId: 'owner', accept: () => () => {} }, attachments);
      if (runtime === 'claude-code') f.store.claudeTranscript.updateStream(f.ref, { messageId: 'live', parentToolUseId: null,
        blocks: [{ blockIndex: 0, text: 'Partial native answer', truncated: false }] });
      else if (runtime === 'ghcp') f.store.copilotTranscript.updateStream(f.ref, { messageId: 'live', text: 'Partial native answer', truncated: false });
      else f.store.antigravityTranscript.updateStream(f.ref, { messageId: 'live', text: 'Partial native answer', truncated: false });
      const response = await f.request(); assert.equal(response.status, 200); const page = await response.json();
      assert.ok(page.messages.some((row: { text: string }) => row.text === 'Partial native answer'));
      const input = page.messages.find((row: { id: string }) => row.id === admitted.idempotencyKey);
      assert.equal(input.media[0].name, 'original.txt'); assert.equal(input.media[0].size, 23);
      assert.equal(JSON.stringify(page).includes('private attachment body'), false);
      assert.equal(JSON.stringify(page).includes(attachments[0]!.data), false);
    } finally { await f.close(); }
  });

  for (const mutation of ['revoke', 'delete', 'reader', 'incarnation'] as const)
    test(`${runtime}: final history delivery refuses ${mutation} after read before publication`, { timeout: 20_000 }, async () => {
      const f = fixture(runtime);
      try {
        f.append('reply', 'Private body');
        f.port({ command: (async (kind, input) => {
          const result: unknown = await f.command(kind, input);
          if (kind === 'sdkHistoryPage' && result && typeof result === 'object' && !('error' in result)) {
            if (mutation === 'revoke') f.tokens.revoke(f.tokens.authenticateAuthorization(authorization)!.tokenId);
            if (mutation === 'delete') {
              f.journal.observeTerminal(f.ref, 'completed', f.store.turns); f.journal.confirmSettled(f.ref);
              f.journal.beginDeletion(f.key, 'delete');
            }
            // Simulate a well-formed but foreign reader/incarnation snapshot.
            if (mutation === 'reader') return { ...result, readerId: 'foreign-reader' };
            if (mutation === 'incarnation') return { ...result, nativeSessionId: 'foreign-native' };
          }
          return result;
        }) as AsyncConnectorOwner['command'] });
        const response = await f.request(); assert.equal(response.status, mutation === 'revoke' ? 401 : mutation === 'delete' ? 404 : 409);
        assert.equal((await response.text()).includes('Private body'), false); assert.equal(response.headers.get('etag'), null);
      } finally { await f.close(); }
    });

  test(`${runtime}: worker history rejects missing read scope and delegation and verifies original delivery`, { timeout: 20_000 }, async () => {
    const f = fixture(runtime);
    try {
      const page = await f.command('sdkHistoryPage', { ...f.scope, limit: 10 }); assert.ok(!('error' in page));
      for (const revision of ['r:0', 'r:z', 'r:3w5e11264sgsf'])
        assert.equal(validConnectorOwnerOutput('sdkHistoryPage', { ...page, body: { ...page.body, revision } }), true);
      for (const revision of ['r:', 'r:A', 'r:00000000000000', 'r:z\n'])
        assert.equal(validConnectorOwnerOutput('sdkHistoryPage', { ...page, body: { ...page.body, revision } }), false);
      assert.deepEqual(await f.command('sdkHistoryDeliver', { ...f.scope, readerId: page.readerId, nativeSessionId: page.nativeSessionId }),
        { runtime, key: f.key, readerId: page.readerId, nativeSessionId: page.nativeSessionId });
      for (const scopes of [['messages:send'], ['messages:read', 'execution:delegate']] as const) {
        const actor = f.tokens.create({ label: 'limited', scopes: [...scopes] });
        assert.deepEqual(await f.command('sdkHistoryPage', { ...f.scope, limit: 10, authorization: `Bearer ${actor.token}` }), { error: 403 });
      }
      assert.equal(validConnectorOwnerInput('sdkHistoryPage', { ...f.scope, limit: 201 }), false);
      assert.equal(validConnectorOwnerInput('sdkHistoryMessage', { ...f.scope, messageId: 'id', allowed: true }), false);
      assert.equal(validConnectorOwnerOutput('sdkHistoryPage', { ...page, body: { ...page.body, messages: [{ ...page.body.messages[0], sessionKey: 'foreign' }] } }), false);
    } finally { await f.close(); }
  });
}

test('Claude history HTTP returns lazy original tool details instead of the summary', { timeout: 20_000 }, async () => {
  const f = fixture('claude-code');
  try {
    const event = { type: 'assistant', uuid: 'tool-message', session_id: 'original-native', parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'original-file' } }] } };
    f.store.claudeTranscript.append(f.ref, projectClaudeMessage(event, 'original-native'), undefined, projectClaudeToolDetails(event, 'original-native'));
    const response = await f.request(); assert.equal(response.status, 200); const page = await response.json();
    const tool = page.messages.find((row: { role: string }) => row.role === 'tool'); assert.ok(tool.toolDetailAvailable);
    const detail = await f.request(`/${encodeURIComponent(tool.id)}`); assert.equal(detail.status, 200);
    assert.match((await detail.json()).message.text, /original-file/);
  } finally { await f.close(); }
});

for (const reason of ['timeout', 'abort', 'close'] as const)
  test(`history ${reason} never releases original work or admits a delivery after cancellation`, { timeout: 20_000 }, async () => {
    const f = fixture('ghcp'), admitted = gate(), ack = gate(), controller = new AbortController(); let calls = 0;
    const history = new AsyncSdkHistory({ command: (async (kind, input) => {
      calls++; admitted.release(); await ack.promise; return f.command(kind, input);
    }) as AsyncConnectorOwner['command'] }, { timeoutMs: reason === 'timeout' ? 15 : 5_000, diagnostics: silence });
    try {
      const pending = history.page({ ...f.scope, limit: 10 }, new Request('http://local/history', { signal: controller.signal }));
      const rejected = assert.rejects(pending, ReadRequestError); await admitted.promise;
      if (reason === 'abort') controller.abort();
      let drained = false; const closing = reason === 'timeout' ? (await rejected, history.close()) : history.close();
      void closing.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
      await assert.rejects(history.page({ ...f.scope, limit: 10 }, new Request('http://local/history')), ReadRequestError);
      ack.release(); await rejected; await closing; assert.equal(drained, true); assert.equal(calls, 1);
    } finally { ack.release(); await history.close(); await f.close(); }
  });

test('SDK history uses the real sole worker and persists native detail across close/reopen', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-history-worker-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: authorization.slice(7),
    sdkModels: { 'claude-code': { model: 'default' }, ghcp: { model: 'default' }, antigravity: { model: 'default' } } };
  let owner = new AsyncConnectorOwner(config, silence);
  try {
    await owner.open();
    for (const runtime of ['claude-code', 'ghcp', 'antigravity'] as const) {
      const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: `create-${runtime}`, payloadJson: '{}' });
      assert.ok('key' in created && created.key);
      const key = created.key, scope = { runtime, key, authorization };
      const admitted = await owner.command('sdkMessageSend', { ...scope, commandKey: 'input', payloadJson: JSON.stringify({ message: 'Durable pending' }) });
      assert.ok(!('error' in admitted));
      const plan = await owner.command('sdkDispatchPlan', { runtime, key }); assert.ok(plan && plan !== 'blocked');
      const execution = await owner.command('sdkDispatchClaim', { runtime, key, id: `run-${runtime}`, epoch: 'epoch', digest: plan.digest });
      assert.ok(execution); const ref = { key, id: execution.id, epoch: execution.epoch, nativeSessionId: execution.nativeSessionId };
      const appended = await owner.command('sdkTranscriptAppend', runtime === 'claude-code'
        ? { runtime, ref, rows: projectClaudeMessage({ type: 'assistant', uuid: 'reply', session_id: ref.nativeSessionId,
          parent_tool_use_id: null, message: { role: 'assistant', content: 'Durable reply' } }, ref.nativeSessionId) }
        : { runtime, ref, row: { nativeEventId: 'reply-event', messageId: 'reply', role: 'assistant', text: 'Durable reply', truncated: false, createdAt: 10 }, submittedText: '' });
      assert.equal(appended.applied, true);
      const history = new AsyncSdkHistory(owner, { diagnostics: silence });
      const first = await history.page({ ...scope, limit: 10 }, new Request('http://local/history'));
      assert.ok(!('error' in first)); const id = first.body.messages.find(row => row.text === 'Durable reply')!.id;
      await history.close(); await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open();
      const resumed = new AsyncSdkHistory(owner, { diagnostics: silence });
      const detail = await resumed.message({ ...scope, messageId: id }, new Request('http://local/history'));
      assert.ok(!('error' in detail)); assert.equal(detail.body.message.text, 'Durable reply'); await resumed.close();
    }
  } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
