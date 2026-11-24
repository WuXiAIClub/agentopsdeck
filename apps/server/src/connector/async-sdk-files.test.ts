import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { projectCopilotMessage } from '../copilot/message-projection.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncSdkFiles } from './async-sdk-files.js';
import { registerSdkFilesHttp } from './sdk-files-http.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { ConnectorSdkFilesCommands } from './connector-sdk-files-domain.js';

const authorization = 'Bearer isolated-files', silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
function evidence(runtime: SdkAgentId, key: string, nativeSessionId: string, i: number) {
  const sourceFiles = [{ path: `/original/repo/file-${i}.ts`, kind: 'modified' as const }];
  return runtime === 'claude-code'
    ? { runtime, rows: projectClaudeMessage({ type: 'user', uuid: `result-${i}`, session_id: nativeSessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: 'private-result', is_error: false }] } }, nativeSessionId)
      .map(row => ({ ...row, sourceFiles })) }
    : { runtime, row: { ...projectCopilotMessage({ id: `event-${i}`, type: 'tool.execution_complete', timestamp: new Date(10 + i).toISOString(),
      data: { toolCallId: `tool-${i}`, success: true } })!, sourceFiles }, submittedText: '' };
}
function fixture(runtime: SdkAgentId, timeoutMs = 5_000) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-files-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), authorization.slice(7));
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true }), key = `${runtime}:original`;
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  journal.create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 1 });
  const ref = { key, id: 'execution', epoch: 'epoch' }, scope = { runtime, key, authorization };
  store.turns.enqueue(runtime, { id: 'input', sessionKey: key, createdAt: 2, payload: { text: 'Input', images: [], actorId: 'owner' } });
  journal.begin(ref, ['input'], store.turns);
  const command = createConnectorOwnerCommands(store, tokens);
  let port: Pick<AsyncConnectorOwner, 'command'> = { command };
  const files = new AsyncSdkFiles({ command: (kind, input) => port.command(kind, input) }, { diagnostics: silence, timeoutMs });
  const app = new Hono(); registerSdkFilesHttp(app, '/sessions/:sessionKey', { files, timeoutMs });
  app.get('/sessions/:sessionKey/files', c => c.json({ legacy: true }));
  const request = (suffix = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => app.request(
    `/sessions/${key}/files${suffix}`, { method, headers: { authorization, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  const append = async (i: number) => {
    const input = evidence(runtime, key, 'original-native', i);
    return command('sdkTranscriptAppend', { ...input, ref: { ...ref, nativeSessionId: 'original-native' } });
  };
  return { store, tokens, journal, key, scope, command, files, app, request, append,
    port(value: Pick<AsyncConnectorOwner, 'command'>) { port = value; },
    async close() { await files.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: original evidence index, four HTTP endpoints, explicit resume, idempotent step and completed cancellation`, async t => {
    const f = fixture(runtime);
    try {
      for (let i = 0; i < 55; i++) assert.equal((await f.append(i)).applied, true);
      const result = await f.request(); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
      const page = await result.json(); assert.equal(page.entries.length, 50); assert.equal(page.retained.count, 55); assert.equal(page.rebuildAvailable, true);
      const older = await (await f.request(`?cursor=${encodeURIComponent(page.nextCursor)}`)).json(); assert.equal(older.entries.length, 5);
      assert.equal(new Set([...page.entries, ...older.entries].map(row => row.path)).size, 55);
      assert.equal(JSON.stringify(page).includes('private-result'), false);
      assert.equal((await f.request('?cursor=')).status, 400);
      assert.equal((await f.request('?cursor=invalid')).status, 409);
      const first = await (await f.request('/rebuild', 'POST')).json(); assert.equal(first.step, 0); assert.equal(first.scanned, 0);
      assert.deepEqual(await (await f.request('/rebuild', 'POST')).json(), first);
      assert.equal((await f.request(`/rebuild/${first.id}`, 'POST', { step: 1 })).status, 409);
      const one = await (await f.request(`/rebuild/${first.id}`, 'POST', { step: 0, ignoredLegacyField: true })).json(); assert.equal(one.step, 1);
      assert.deepEqual(await (await f.request(`/rebuild/${first.id}`, 'POST', { step: 0 })).json(), one);
      // Advance the existing clock; no sleeps and no change to cooldown policy.
      let now = Date.now(); t.mock.method(Date, 'now', () => now);
      let progress = one;
      while (progress.state === 'scanning') {
        now += 251;
        progress = await (await f.request(`/rebuild/${first.id}`, 'POST', { step: progress.step })).json();
      }
      assert.equal(progress.state, 'completed'); assert.equal(progress.found, 55); assert.equal(progress.step, 3);
      assert.deepEqual(await (await f.request(`/rebuild/${first.id}`, 'DELETE')).json(), progress);
      const rebuilt = await (await f.request()).json(); assert.equal(rebuilt.retained.count, 55);
      assert.equal((await f.request(`?cursor=${encodeURIComponent(page.nextCursor)}`)).status, 409);
      const next = await (await f.request('/rebuild', 'POST')).json();
      const cancelled = await (await f.request(`/rebuild/${next.id}`, 'DELETE')).json(); assert.equal(cancelled.state, 'cancelled');
      assert.deepEqual(await (await f.request(`/rebuild/${next.id}`, 'POST', { step: 0 })).json(), cancelled);
      assert.equal((await f.request('/rebuild/not-id', 'POST', { step: 0 })).status, 400);
      assert.equal((await f.request(`/rebuild/${randomUUID()}`, 'POST', { step: -1 })).status, 400);
      assert.equal((await f.request(`/rebuild/${randomUUID()}`, 'POST', { step: 0, extra: 'x'.repeat(256) })).status, 413);
      assert.equal((await f.request('', 'GET', undefined, { 'x-agentopsdeck-execution-grant': '' })).status, 403);
      assert.equal((await f.request('', 'GET', undefined, { authorization: '' })).status, 401);
      assert.equal((await f.app.request('/sessions/codex:legacy/files')).status, 200);
      assert.equal(validConnectorOwnerInput('sdkFilesPage', { ...f.scope, sql: 'SELECT 1' }), false);
      assert.equal(validConnectorOwnerInput('sdkFilesStep', { ...f.scope, jobId: next.id, step: '0' }), false);
      assert.equal(validConnectorOwnerInput('sdkFilesStart', { ...f.scope, actorId: 'trusted' }), false);
    } finally { await f.close(); }
  });

  for (const kind of ['sdkFilesPage', 'sdkFilesStart', 'sdkFilesStep', 'sdkFilesCancel'] as const)
    test(`${runtime}: ${kind} withholds paths/progress after revocation before delivery`, async () => {
      const f = fixture(runtime);
      try {
        await f.append(1);
        const job = await f.command('sdkFilesStart', f.scope); assert.ok(!('error' in job));
        f.port({ command: (async (current, input) => {
          const result = await f.command(current, input);
          if (current === kind) f.tokens.revoke(f.tokens.authenticateAuthorization(authorization)!.tokenId);
          return result;
        }) as AsyncConnectorOwner['command'] });
        const suffix = kind === 'sdkFilesPage' ? '' : kind === 'sdkFilesStart' ? '/rebuild' : `/rebuild/${job.body.id}`;
        const result = await f.request(suffix, kind === 'sdkFilesPage' ? 'GET' : kind === 'sdkFilesCancel' ? 'DELETE' : 'POST', kind === 'sdkFilesStep' ? { step: 0 } : undefined);
        assert.equal(result.status, 401); assert.equal((await result.text()).includes('/original/'), false);
      } finally { await f.close(); }
    });

  test(`${runtime}: original credentials, actor isolation, index conflict, deletion and incarnation fences`, async t => {
    const f = fixture(runtime);
    try {
      const job = await f.command('sdkFilesStart', f.scope); assert.ok(!('error' in job));
      for (const scopes of [['messages:send'], ['messages:read', 'execution:delegate']] as const) {
        const actor = f.tokens.create({ label: 'limited', scopes: [...scopes] });
        assert.deepEqual(await f.command('sdkFilesPage', { ...f.scope, authorization: `Bearer ${actor.token}` }), { error: 403 });
      }
      const other = f.tokens.create({ label: 'another-owner', scopes: ['messages:read'] }), otherScope = { ...f.scope, authorization: `Bearer ${other.token}` };
      assert.deepEqual(await f.command('sdkFilesStart', otherScope), { error: 409 });
      assert.deepEqual(await f.command('sdkFilesStep', { ...otherScope, jobId: job.body.id, step: 0 }), { error: 404 });
      assert.deepEqual(await f.command('sdkFilesCancel', { ...otherScope, jobId: job.body.id }), { error: 404 });
      await f.append(1);
      const conflict = await f.command('sdkFilesStep', { ...f.scope, jobId: job.body.id, step: 0 });
      assert.ok(!('error' in conflict)); assert.equal(conflict.body.state, 'conflict');
      const fresh = await f.command('sdkFilesStart', f.scope); assert.ok(!('error' in fresh));
      const original = f.journal.session.bind(f.journal);
      const changed = t.mock.method(f.journal, 'session', (key: string) => { const value = original(key); return value ? { ...value, nativeSessionId: 'replacement-native' } : value; });
      assert.deepEqual(await f.command('sdkFilesCancel', { ...f.scope, jobId: fresh.body.id }), { error: 404 });
      changed.mock.restore();
      f.journal.observeTerminal({ key: f.key, id: 'execution', epoch: 'epoch' }, 'completed', f.store.turns);
      f.journal.confirmSettled({ key: f.key, id: 'execution', epoch: 'epoch' });
      f.journal.beginDeletion(f.key, 'delete');
      assert.deepEqual(await f.command('sdkFilesPage', f.scope), { error: 404 });
      assert.deepEqual(await f.command('sdkFilesStep', { ...f.scope, jobId: fresh.body.id, step: 0 }), { error: 404 });
    } finally { await f.close(); }
  });
}

for (const ending of ['cancel', 'timeout', 'close'] as const)
  test(`files ${ending} retains original physical commit and drains without resubmitting`, async () => {
    const f = fixture('ghcp', ending === 'timeout' ? 25 : 5_000), entered = gate(), release = gate();
    const controller = new AbortController(); let calls = 0, closing: Promise<void> | undefined;
    try {
      await f.append(1);
      const job = await f.command('sdkFilesStart', f.scope); assert.ok(!('error' in job));
      f.port({ command: (async (kind, input) => {
        if (kind === 'sdkFilesStep') { calls++; entered.release(); await release.promise; }
        return f.command(kind, input);
      }) as AsyncConnectorOwner['command'] });
      const pending = f.request(`/rebuild/${job.body.id}`, 'POST', { step: 0 }, {}, controller.signal); await entered.promise;
      if (ending === 'cancel') controller.abort();
      if (ending === 'close') closing = f.files.close();
      assert.equal((await pending).status, ending === 'cancel' ? 408 : 503);
      let drained = false; closing ??= f.files.close(); const done = closing.then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(calls, 1);
      release.release(); await done; assert.equal(calls, 1);
      const committed = await f.command('sdkFilesCancel', { ...f.scope, jobId: job.body.id }); assert.ok(!('error' in committed));
      assert.equal(committed.body.state, 'completed'); assert.equal(f.store.fileIndex.page(f.key).retained?.count, 1);
      assert.equal((await f.request()).status, 503);
    } finally { release.release(); await f.close(); }
  });

test('files bounded physical reads remain reserved after all HTTP waiters cancel', async () => {
  const f = fixture('ghcp'), release = gate(), entered = gate(); let calls = 0;
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  f.port({ command: (async (kind, input) => {
    if (kind === 'sdkFilesPage') { if (++calls === 4) entered.release(); await release.promise; }
    return f.command(kind, input);
  }) as AsyncConnectorOwner['command'] });
  try {
    const pending = controllers.map(controller => f.request('', 'GET', undefined, {}, controller.signal));
    await entered.promise; controllers.forEach(controller => controller.abort());
    assert.ok((await Promise.all(pending)).every(result => result.status === 408));
    assert.equal((await f.request()).status, 503); assert.equal(calls, 4);
    release.release(); await tick(); await tick();
    assert.equal((await f.request()).status, 200); assert.equal(calls, 5);
  } finally { release.release(); await f.close(); }
});

for (const mutation of ['key', 'jobId', 'reader', 'native'] as const)
  test(`files rejects valid foreign ${mutation} without publishing or replaying`, async () => {
    const f = fixture('ghcp');
    try {
      const job = await f.command('sdkFilesStart', f.scope); assert.ok(!('error' in job));
      f.port({ command: (async (kind, input) => {
        if (kind !== 'sdkFilesStep') return f.command(kind, input);
        const result = await f.command('sdkFilesStep', input as ConnectorSdkFilesCommands['sdkFilesStep']['input']);
        if ('error' in result) return result;
        const changed = { ...result, ...(mutation === 'key' ? { key: 'ghcp:foreign' } : {}),
          ...(mutation === 'reader' ? { readerId: 'foreign' } : {}), ...(mutation === 'native' ? { nativeSessionId: 'foreign' } : {}),
          body: { ...result.body, ...(mutation === 'jobId' ? { id: randomUUID() } : {}) } };
        assert.equal(validConnectorOwnerOutput('sdkFilesStep', changed), true); return changed;
      }) as AsyncConnectorOwner['command'] });
      assert.equal((await f.request(`/rebuild/${job.body.id}`, 'POST', { step: 0 })).status, mutation === 'native' || mutation === 'reader' ? 409 : 503);
    } finally { await f.close(); }
  });

test('files real sole worker preserves original index but loses ephemeral rebuild jobs on reopen', { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-files-worker-'));
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'), bootstrapToken: authorization.slice(7),
    sdkModels: { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } } };
  let owner = new AsyncConnectorOwner(config, silence);
  try {
    await owner.open();
    for (const runtime of ['claude-code', 'ghcp'] as const) {
      const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: `create-${runtime}`, payloadJson: '{}' });
      assert.ok('key' in created && created.key); const key = created.key, scope = { runtime, key, authorization };
      const admitted = await owner.command('sdkMessageSend', { ...scope, commandKey: 'input', payloadJson: JSON.stringify({ message: 'Input' }) }); assert.ok(!('error' in admitted));
      const plan = await owner.command('sdkDispatchPlan', { runtime, key }); assert.ok(plan && plan !== 'blocked');
      const execution = await owner.command('sdkDispatchClaim', { runtime, key, id: `run-${runtime}`, epoch: 'epoch', digest: plan.digest }); assert.ok(execution);
      const ref = { key, id: execution.id, epoch: execution.epoch, nativeSessionId: execution.nativeSessionId };
      assert.equal((await owner.command('sdkTranscriptAppend', { ...evidence(runtime, key, execution.nativeSessionId, 1), ref })).applied, true);
      const files = new AsyncSdkFiles(owner, { diagnostics: silence });
      const first = await files.page(scope, new Request('http://local/files')); assert.ok(!('error' in first)); assert.equal(first.body.entries.length, 1);
      const job = await files.start(scope, new Request('http://local/files')); assert.ok(!('error' in job));
      await files.close(); await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open();
      const resumed = new AsyncSdkFiles(owner, { diagnostics: silence });
      assert.deepEqual(await resumed.page(scope, new Request('http://local/files')), first);
      assert.deepEqual(await resumed.step({ ...scope, jobId: job.body.id, step: 0 }, new Request('http://local/files')), { error: 404 });
      const next = await resumed.start(scope, new Request('http://local/files')); assert.ok(!('error' in next)); assert.notEqual(next.body.id, job.body.id);
      const completed = await resumed.step({ ...scope, jobId: next.body.id, step: 0 }, new Request('http://local/files'));
      assert.ok(!('error' in completed)); assert.equal(completed.body.state, 'completed'); assert.equal(completed.body.found, 1);
      await resumed.close();
    }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
