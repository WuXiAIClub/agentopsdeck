import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { ConnectorUserStore } from './connector/connector-user-store.js';
import { AsyncConnectorOwner } from './connector/async-connector-owner.js';
import { AsyncCodexFiles } from './connector/async-codex-files.js';
import { AsyncSdkFiles } from './connector/async-sdk-files.js';
import { applicationInteractionTestSupport, type InteractionApplicationOptions } from './connector/application-interaction-test-support.js';
import { applicationFilesIntent } from './connector/application-files-transaction.js';
import { validConnectorOwnerInput } from './connector/connector-owner-domain.js';

const silence = new PerformanceDiagnostics(() => {});
type Runtime = 'codex' | 'claude-code' | 'ghcp';
async function fixture(t: TestContext, runtime: Runtime, options: InteractionApplicationOptions) {
  const root = mkdtempSync(join(tmpdir(), 'application-files-')), cleanup: Array<() => unknown> = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const key = `${runtime}:original`, config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile), reader = tokens.create({ label: 'original', scopes: ['messages:read'] });
  const support = await applicationInteractionTestSupport(root, options, silence, reader.token);
  cleanup.push(() => support.close());
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  try {
    if (runtime === 'codex') seed.fileIndex.replaceProjection(key, [{ id: 'tool', sessionKey: key, role: 'tool', toolPhase: 'result',
      status: 'sent', createdAt: 1, text: 'PRIVATE', sourceFiles: [{ path: '/original/repo/file.ts', kind: 'modified' }] }]);
    else (runtime === 'ghcp' ? seed.copilotJournal : seed.claudeJournal).create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 1 });
  } finally { seed.close(); }
  const owner = new AsyncConnectorOwner(config, silence, undefined, 30_000, support.endpoint);
  cleanup.push(() => owner.close()); await owner.open();
  let hook: ((kind: string, run: () => Promise<unknown>) => Promise<unknown>) | undefined;
  const port = { command: (async (kind, input) => {
    const run = () => owner.command(kind, input); return hook ? hook(kind, run) : run();
  }) as AsyncConnectorOwner['command'] };
  const codex = new AsyncCodexFiles({ owner: port, local() {}, sessionExists: value => value === key, diagnostics: silence,
    timeoutMs: options.timeoutMs ?? 5000 });
  const sdk = new AsyncSdkFiles(port, { diagnostics: silence, timeoutMs: options.timeoutMs ?? 5000 });
  cleanup.push(() => Promise.all([codex.close(), sdk.close()]));
  const app = new Hono(); support.registerFiles(app, { codex: { files: codex }, sdk: { files: sdk } });
  app.all('*', c => c.json({ legacy: true }, 404));
  const request = (suffix = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(
    `/api/sessions/${key}/files${suffix}`, { method, headers: { ...support.headers, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { request, owner, support, key, codex, sdk, hook(value: typeof hook) { hook = value; },
    machineStart: () => runtime === 'codex'
      ? owner.command('codexFilesStart', { runtime, key, authorization: `Bearer ${reader.token}` })
      : owner.command('sdkFilesStart', { runtime, key, authorization: `Bearer ${reader.token}` }) };
}

test('file intents contain only exact command scope fields and strict worker DTO evidence', () => {
  const intent = applicationFilesIntent('codex', 'step', { key: 'codex:original', jobId: 'original', step: 0 });
  assert.deepEqual(Object.keys(intent).sort(), ['action', 'runtime', 'resource', 'commandKey', 'payloadDigest'].sort());
  assert.notEqual(intent.payloadDigest, applicationFilesIntent('codex', 'step', { key: 'codex:original', jobId: 'original', step: 1 }).payloadDigest);
  for (const runtime of ['codex', 'claude-code', 'ghcp'] as const) {
    const prefix = runtime === 'codex' ? 'codex' : 'sdk', scope = { runtime, key: `${runtime}:original`, authorization: 'Bearer original' };
    assert.equal(validConnectorOwnerInput(`${prefix}FilesStart`, { ...scope, application: { cookie: 'original' } }), true);
    assert.equal(validConnectorOwnerInput(`${prefix}FilesStart`, { ...scope, application: { actor: 'forged' } }), false);
    assert.equal(validConnectorOwnerInput(`${prefix}FilesPage`, { ...scope, application: {} }), false);
  }
});

for (const runtime of ['codex', 'claude-code', 'ghcp'] as const) {
  for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false])
    test(`${runtime} files original application ${role}/${mode}/${withKey ? 'Key' : 'no-Key'} complete rebuild wire`, async t => {
      const f = await fixture(t, runtime, { role, mode, withKey });
      const page = await f.request(); assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.equal(JSON.stringify(await page.json()).includes('PRIVATE'), false);
      const started = await f.request('/rebuild', 'POST'); assert.equal(started.status, 200); const first = await started.json();
      assert.equal(first.step, 0); assert.deepEqual(await (await f.request('/rebuild', 'POST')).json(), first);
      assert.equal((await f.request(`/rebuild/${first.id}`, 'POST', { step: 1 })).status, 409);
      const stepped = await f.request(`/rebuild/${first.id}`, 'POST', { step: 0, ignoredLegacyField: true });
      assert.equal(stepped.status, 200); const complete = await stepped.json(); assert.equal(complete.state, 'completed');
      assert.deepEqual(await (await f.request(`/rebuild/${first.id}`, 'POST', { step: 0 })).json(), complete);
      assert.deepEqual(await (await f.request(`/rebuild/${first.id}`, 'DELETE')).json(), complete);
      const next = await (await f.request('/rebuild', 'POST')).json();
      assert.equal((await (await f.request(`/rebuild/${next.id}`, 'DELETE')).json()).state, 'cancelled');
      assert.equal((await f.request('?cursor=')).status, 400);
      assert.equal((await f.request('', 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'forged' })).status, 403);
    });
  for (const operation of ['Start', 'Step', 'Cancel'] as const)
    test(`${runtime} files worker current Auth denies ${operation} after original HTTP observation`, async t => {
      const f = await fixture(t, runtime, { role: 'hub', mode: 'sqlite' });
      const first = operation === 'Start' ? undefined : await (await f.request('/rebuild', 'POST')).json();
      let reached = false;
      f.hook(async (kind, run) => { if (kind.endsWith(`Files${operation}`)) { reached = true; await f.support.revoke(); } return run(); });
      const response = operation === 'Start' ? await f.request('/rebuild', 'POST') : operation === 'Step'
        ? await f.request(`/rebuild/${first.id}`, 'POST', { step: 0 }) : await f.request(`/rebuild/${first.id}`, 'DELETE');
      assert.equal(reached, true); assert.notEqual(response.status, 200);
      const state = await f.machineStart(); assert.ok('body' in state); assert.equal(state.body.step, 0); assert.equal(state.body.state, 'scanning');
      if (first) assert.equal(state.body.id, first.id);
    });
  test(`${runtime} files suppress delivery after application logout without altering original machine access`, async t => {
    const f = await fixture(t, runtime, { role: 'standalone', mode: 'json' });
    f.hook(async (kind, run) => { const result = await run(); if (kind.endsWith('FilesPage')) await f.support.revoke(); return result; });
    assert.notEqual((await f.request()).status, 200);
    assert.ok('body' in await f.machineStart());
  });
}
