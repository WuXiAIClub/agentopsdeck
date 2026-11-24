import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import type { ChatMessage } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { projectionFileEvidence } from '../messages/session-file-evidence.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncCodexFiles } from './async-codex-files.js';
import { registerCodexFilesHttp } from './codex-files-http.js';

const key = 'codex:original', silence = new PerformanceDiagnostics(() => {});
const evidence = (count: number): ChatMessage[] => Array.from({ length: count }, (_, i) => ({ id: `tool:${i}`, sessionKey: key,
  role: 'tool', toolPhase: 'result', status: 'sent', createdAt: i, text: 'PRIVATE',
  sourceFiles: [{ path: `/original/repo/file-${i}.ts`, kind: 'modified' }] }));
function gate() { let release!: () => void; return { promise: new Promise<void>(ok => { release = ok; }), release: () => release() }; }
async function fixture(t: TestContext, count = 55, timeoutMs = 5000) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-files-'));
  const config = { file: join(directory, 'original.sqlite'), tokenFile: join(directory, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile);
  const reader = tokens.create({ label: 'reader', scopes: ['messages:read'] });
  const other = tokens.create({ label: 'other', scopes: ['messages:read'] });
  const sender = tokens.create({ label: 'sender', scopes: ['messages:send'] });
  const delegate = tokens.create({ label: 'delegate', scopes: ['messages:read', 'execution:delegate'] });
  const deleter = tokens.create({ label: 'deleter', scopes: ['sessions:create'] });
  const store = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  try { if (count >= 0) store.fileIndex.replaceProjection(key, evidence(count)); } finally { store.close(); }
  let owner = new AsyncConnectorOwner(config, silence); await owner.open();
  let command: AsyncConnectorOwner['command'] = (kind, input) => owner.command(kind, input);
  let exists = true, local = true;
  const files = new AsyncCodexFiles({ owner: { command: (kind, input) => command(kind, input) }, diagnostics: silence, timeoutMs,
    sessionExists: session => exists && session === key, local() { if (!local) throw Error('local unavailable'); } });
  const app = new Hono(); registerCodexFilesHttp(app, '/sessions/:sessionKey', { files, timeoutMs });
  app.get('/sessions/:sessionKey/files', c => c.json({ legacy: true }));
  const scope = { runtime: 'codex' as const, key, authorization: `Bearer ${reader.token}` };
  const request = (suffix = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    app.request(`/sessions/${key}/files${suffix}`, { method, headers: { authorization: scope.authorization, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  t.after(async () => { try { await files.close(); await owner.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  return { files, request, app, scope, tokens, reader, other, sender, delegate, deleter, get owner() { return owner; },
    port(value: AsyncConnectorOwner['command']) { command = value; }, exists(value: boolean) { exists = value; }, local(value: boolean) { local = value; },
    async restart() { await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open(); } };
}

test('Codex files DTOs reject SQL, caller authority and invalid scope/job selection', () => {
  const scope = { runtime: 'codex', key, authorization: 'Bearer original' };
  assert.equal(validConnectorOwnerInput('codexFilesPage', scope), true);
  for (const extra of [{ sql: 'SELECT 1' }, { actor: 'trusted' }, { runtime: 'ghcp' }, { key: 'ghcp:original' },
    { authorization: 'Bearer\nsecret' }, { nativeSessionId: 'foreign' }, { cursor: '' }])
    assert.equal(validConnectorOwnerInput('codexFilesPage', { ...scope, ...extra }), false);
  assert.equal(validConnectorOwnerInput('codexFilesStep', { ...scope, jobId: randomUUID(), step: '0' }), false);
  assert.equal(validConnectorOwnerInput('codexFilesCancel', { ...scope, jobId: 'bad' }), false);
  assert.equal(validConnectorOwnerOutput('codexFilesDeliver', { runtime: 'codex', key, readerId: 'reader' }), false);
});

test('sole worker paginates original verified evidence and completes bounded idempotent rebuild', async t => {
  const f = await fixture(t);
  const response = await f.request(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const page = await response.json(), older = await (await f.request(`?cursor=${encodeURIComponent(page.nextCursor)}`)).json();
  assert.equal(page.entries.length, 50); assert.equal(older.entries.length, 5); assert.equal(page.rebuildAvailable, true);
  assert.equal(new Set([...page.entries, ...older.entries].map(row => row.path)).size, 55);
  assert.equal(JSON.stringify(page).includes('PRIVATE'), false);
  const first = await (await f.request('/rebuild', 'POST')).json(); assert.equal(first.step, 0);
  assert.deepEqual(await (await f.request('/rebuild', 'POST')).json(), first);
  assert.equal((await f.request(`/rebuild/${first.id}`, 'POST', { step: 1 })).status, 409);
  assert.equal((await f.request('/rebuild', 'POST', undefined, { authorization: `Bearer ${f.other.token}` })).status, 409);
  assert.equal((await f.request(`/rebuild/${first.id}`, 'DELETE', undefined, { authorization: `Bearer ${f.other.token}` })).status, 404);
  let progress = await (await f.request(`/rebuild/${first.id}`, 'POST', { step: 0 })).json();
  assert.equal(progress.scanned, 20);
  assert.deepEqual(await (await f.request(`/rebuild/${first.id}`, 'POST', { step: 0 })).json(), progress);
  while (progress.state === 'scanning') {
    await delay(260);
    progress = await (await f.request(`/rebuild/${first.id}`, 'POST', { step: progress.step })).json();
  }
  assert.equal(progress.state, 'completed'); assert.equal(progress.found, 55); assert.equal(progress.step, 3);
  assert.deepEqual(await (await f.request(`/rebuild/${first.id}`, 'DELETE')).json(), progress);
  assert.equal((await f.request(`?cursor=${encodeURIComponent(page.nextCursor)}`)).status, 409);
  const next = await (await f.request('/rebuild', 'POST')).json();
  assert.equal((await (await f.request(`/rebuild/${next.id}`, 'DELETE')).json()).state, 'cancelled');
  await f.restart();
  assert.equal((await (await f.request()).json()).retained.count, 55);
  assert.equal((await f.request(`/rebuild/${next.id}`, 'POST', { step: 0 })).status, 404);
  assert.notEqual((await (await f.request('/rebuild', 'POST')).json()).id, next.id);
});

test('legacy session without snapshot remains readable but cannot fabricate a rebuild', async t => {
  const f = await fixture(t, -1), page = await (await f.request()).json();
  assert.equal(page.entries.length, 0); assert.notEqual(page.rebuildAvailable, true);
  assert.equal((await f.request('/rebuild', 'POST')).status, 404);
});

test('Codex files wire preserves validation, authority and local fences without selecting SDK fallback', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('', 'GET', undefined, { authorization: '' })).status, 401);
  for (const actor of [f.sender, f.delegate]) assert.equal((await f.request('', 'GET', undefined, { authorization: `Bearer ${actor.token}` })).status, 403);
  assert.equal((await f.request('', 'GET', undefined, { 'x-agentopsdeck-execution-grant': '' })).status, 403);
  assert.equal((await f.request('?cursor=')).status, 400); assert.equal((await f.request('?cursor=invalid')).status, 409);
  assert.equal((await f.request('/rebuild/bad', 'POST', { step: 0 })).status, 400);
  assert.equal((await f.request(`/rebuild/${randomUUID()}`, 'POST', { step: -1 })).status, 400);
  assert.equal((await f.request(`/rebuild/${randomUUID()}`, 'POST', { step: 0, ignored: 'x'.repeat(256) })).status, 413);
  assert.deepEqual(await (await f.app.request('/sessions/ghcp:original/files')).json(), { legacy: true });
  f.exists(false); assert.equal((await f.request()).status, 404);
  f.exists(true); f.local(false); assert.equal((await f.request()).status, 503);
});

for (const boundary of ['revoke', 'deck', 'delete', 'generation'] as const)
  test(`files delivery independently fences ${boundary} after actual worker read`, async t => {
    const f = await fixture(t);
    f.port((async (kind, input) => {
      const result = await f.owner.command(kind, input);
      if (kind === 'codexFilesPage') {
        if (boundary === 'revoke') f.tokens.revoke(f.reader.record.id);
        else if (boundary === 'deck') f.exists(false);
        else if (boundary === 'delete') {
          const claimed = await f.owner.command('codexDeletionClaim', { key, authorization: `Bearer ${f.deleter.token}`, commandKey: 'delete' });
          assert.ok(!('error' in claimed));
        } else assert.equal(await f.owner.command('codexFileIndexProjection', { sessionKey: key, expected: null, evidence: projectionFileEvidence(key, evidence(1)) }), true);
      }
      return result;
    }) as AsyncConnectorOwner['command']);
    const response = await f.request(); assert.equal(response.status, boundary === 'revoke' ? 401 : boundary === 'generation' ? 409 : 404);
    assert.equal((await response.text()).includes('/original/repo'), false);
  });

for (const mutation of ['key', 'runtime', 'readerId', 'generation', 'jobId'] as const)
  test(`files rejects substituted ${mutation} result before publication`, async t => {
    const f = await fixture(t, 1);
    const started = await (await f.request('/rebuild', 'POST')).json();
    f.port((async (kind, input) => {
      if (kind !== 'codexFilesStep') return f.owner.command(kind, input);
      const result = await f.owner.command('codexFilesStep', input as Parameters<typeof f.files.step>[0]);
      assert.ok(!('error' in result));
      return { ...result, ...(mutation === 'key' ? { key: 'codex:foreign' } : {}), ...(mutation === 'runtime' ? { runtime: 'ghcp' } : {}),
        ...(mutation === 'readerId' ? { readerId: 'foreign' } : {}), ...(mutation === 'generation' ? { generation: randomUUID() } : {}),
        ...(mutation === 'jobId' ? { body: { ...result.body, id: randomUUID() } } : {}) };
    }) as AsyncConnectorOwner['command']);
    assert.equal((await f.request(`/rebuild/${started.id}`, 'POST', { step: 0 })).status,
      mutation === 'readerId' || mutation === 'generation' ? 409 : 503);
  });

for (const ending of ['timeout', 'abort', 'close'] as const)
  test(`files ${ending} retains actual rebuild ownership until original settlement without replay`, async t => {
    const f = await fixture(t, 1, 80), started = await (await f.request('/rebuild', 'POST')).json();
    const entered = gate(), release = gate(), controller = new AbortController(); let steps = 0;
    f.port((async (kind, input) => {
      if (kind === 'codexFilesStep') { steps++; entered.release(); await release.promise; }
      return f.owner.command(kind, input);
    }) as AsyncConnectorOwner['command']);
    try {
      const pending = f.request(`/rebuild/${started.id}`, 'POST', { step: 0 }, {}, controller.signal); await entered.promise;
      if (ending === 'abort') controller.abort();
      let closing = ending === 'close' ? f.files.close() : undefined;
      assert.equal((await pending).status, ending === 'abort' ? 408 : 503);
      let drained = false; closing ??= f.files.close(); const drain = closing.then(() => { drained = true; });
      await new Promise<void>(ok => setImmediate(ok)); assert.equal(drained, false); assert.equal(steps, 1);
      release.release(); await drain; assert.equal(steps, 1); assert.equal((await f.request()).status, 503);
      const recovered = await f.owner.command('codexFilesStep', { ...f.scope, jobId: started.id, step: 0 });
      assert.ok(!('error' in recovered)); assert.equal(recovered.body.state, 'completed'); assert.equal(recovered.body.step, 1);
    } finally { release.release(); }
  });

test('four retained physical requests bound capacity after waiter timeout', async t => {
  const f = await fixture(t, 1, 150), release = gate(); let count = 0; const entered = gate();
  f.port((async (kind, input) => { if (kind === 'codexFilesPage') { if (++count === 4) entered.release(); await release.promise; } return f.owner.command(kind, input); }) as AsyncConnectorOwner['command']);
  try {
    const requests = Array.from({ length: 4 }, () => f.request()); await entered.promise;
    assert.equal((await f.request()).status, 503); assert.equal(count, 4);
    for (const response of await Promise.all(requests)) assert.equal(response.status, 503);
    assert.equal((await f.request()).status, 503); assert.equal(count, 4);
    release.release(); await f.files.close();
  } finally { release.release(); }
});
