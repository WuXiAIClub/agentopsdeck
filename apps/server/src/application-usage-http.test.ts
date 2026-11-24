import assert from 'node:assert/strict';
import { awaitHttpAdmission, controlledHttpDeadline } from './lifecycle/http-deadline-test-support.js';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { ConnectorUserStore } from './connector/connector-user-store.js';
import { AsyncConnectorOwner } from './connector/async-connector-owner.js';
import { AsyncCodexPublicUsage } from './connector/async-codex-public-usage.js';
import { AsyncSdkUsage } from './connector/async-sdk-usage.js';
import { applicationInteractionTestSupport, type InteractionApplicationOptions } from './connector/application-interaction-test-support.js';
import { applicationUsageIntent } from './connector/application-usage-transaction.js';
import { validConnectorOwnerInput } from './connector/connector-owner-domain.js';

const silence = new PerformanceDiagnostics(() => {}), range = { from: 0, to: 120_000, bucketMs: 60_000 };
type Runtime = 'codex' | 'claude-code' | 'ghcp';
function gate() { let release!: () => void; return { promise: new Promise<void>(ok => { release = ok; }), release: () => release() }; }
async function fixture(t: TestContext, runtime: Runtime, options: InteractionApplicationOptions) {
  const root = mkdtempSync(join(tmpdir(), 'application-usage-')), cleanup: Array<() => unknown> = [];
  t.after(async () => { try { for (const close of cleanup.reverse()) await close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const key = `${runtime}:original`, config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json') };
  const tokens = new ConnectorTokenStore(config.tokenFile), reader = tokens.create({ label: 'original', scopes: ['messages:read'] });
  const support = await applicationInteractionTestSupport(root, options, silence, reader.token); cleanup.push(() => support.close());
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  try {
    if (runtime !== 'codex') (runtime === 'ghcp' ? seed.copilotJournal : seed.claudeJournal).create({ key, nativeSessionId: 'original-native', title: 'Original', createdAt: 1 });
    seed.tokenUsage.record(runtime, key, 'private-provider-event', { inputTokens: 12, outputTokens: 3 }, 'original-model', 10);
  } finally { seed.close(); }
  const owner = new AsyncConnectorOwner(config, silence, undefined, 30_000, support.endpoint);
  cleanup.push(() => owner.close()); await owner.open();
  let hook: ((kind: string, run: () => Promise<unknown>) => Promise<unknown>) | undefined;
  const port = { command: (async (kind, input) => { const run = () => owner.command(kind, input); return hook ? hook(kind, run) : run(); }) as AsyncConnectorOwner['command'] };
  const codex = new AsyncCodexPublicUsage({ owner: port, local() {}, sessionExists: value => value === key, diagnostics: silence, timeoutMs: options.timeoutMs ?? 5000 });
  const sdk = new AsyncSdkUsage(port, { diagnostics: silence, timeoutMs: options.timeoutMs ?? 5000 });
  cleanup.push(() => Promise.all([codex.close(), sdk.close()]));
  const app = new Hono(); support.registerUsage(app, { codex: { usage: codex }, sdk: { usage: sdk } });
  app.all('*', c => c.json({ legacy: true }, 404));
  const request = (suffix = '?from=0&to=120000&bucketMs=60000', method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(
    `/api/sessions/${key}/token-usage${suffix}`, { method, headers: { ...support.headers, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const scope = { runtime, key, authorization: `Bearer ${reader.token}` };
  return { request, owner, support, key, codex, sdk, hook(value: typeof hook) { hook = value; },
    machineRead: (requestId: string) => runtime === 'codex'
      ? owner.command('codexPublicUsageSnapshotRead', { ...scope, runtime, requestId })
      : owner.command('sdkUsageSnapshotRead', { ...scope, runtime, requestId }) };
}

test('usage intents are exact and only snapshot creation accepts original evidence', () => {
  const input = { key: 'codex:original', ...range, requestId: randomUUID() }, intent = applicationUsageIntent('codex', input);
  assert.deepEqual(Object.keys(intent).sort(), ['action', 'runtime', 'resource', 'commandKey', 'payloadDigest'].sort());
  assert.notEqual(intent.payloadDigest, applicationUsageIntent('codex', { ...input, to: 180_000 }).payloadDigest);
  for (const runtime of ['codex', 'claude-code', 'ghcp'] as const) {
    const prefix = runtime === 'codex' ? 'codexPublic' : 'sdk', scope = { ...input, runtime, key: `${runtime}:original`, authorization: 'Bearer original' };
    assert.equal(validConnectorOwnerInput(`${prefix}UsageSnapshotCreate`, { ...scope, application: { cookie: 'original' } }), true);
    assert.equal(validConnectorOwnerInput(`${prefix}UsageSnapshotCreate`, { ...scope, application: { actor: 'forged' } }), false);
    assert.equal(validConnectorOwnerInput(`${prefix}UsageRange`, { runtime, key: scope.key, authorization: scope.authorization, ...range, application: {} }), false);
  }
});

for (const runtime of ['codex', 'claude-code', 'ghcp'] as const) {
  for (const role of ['hub', 'standalone'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [true, false])
    test(`${runtime} usage original ${role}/${mode}/${withKey ? 'Key' : 'no-Key'} preserves immutable snapshot wire`, async t => {
      const f = await fixture(t, runtime, { role, mode, withKey });
      const read = await f.request(); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
      assert.equal((await read.json()).buckets[0].inputTokens, 12);
      const exported = await f.request('/export?from=0&to=120000&bucketMs=60000'); assert.equal(exported.status, 200);
      assert.equal((await exported.text()).includes('private-provider-event'), false);
      const selection = { ...range, requestId: randomUUID() }, response = await f.request('/snapshots', 'POST', selection);
      assert.equal(response.status, 200); const snapshot = await response.json(); assert.equal(snapshot.requestId, selection.requestId);
      assert.deepEqual(await (await f.request('/snapshots', 'POST', selection)).json(), snapshot);
      assert.equal((await f.request('/snapshots', 'POST', { ...selection, to: 180_000 })).status, 409);
      assert.deepEqual(await (await f.request(`/snapshots/${selection.requestId}`)).json(), snapshot);
      assert.equal((await f.request('?from=invalid')).status, 400);
      assert.equal((await f.request('/snapshots', 'POST', { ...range, requestId: 'invalid' })).status, 400);
      assert.equal((await f.request('', 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'forged' })).status, 403);
      assert.equal((await f.request('', 'GET', undefined, { 'x-agentopsdeck-expected-node-id': 'forged' })).status, 403);
    });
  test(`${runtime} snapshot worker denies revoked application identity before original SQL`, async t => {
    const f = await fixture(t, runtime, { role: 'hub', mode: 'sqlite' }), selection = { ...range, requestId: randomUUID() };
    let entered = false;
    f.hook(async (kind, run) => { if (kind.endsWith('UsageSnapshotCreate')) { entered = true; await f.support.revoke(); } return run(); });
    assert.notEqual((await f.request('/snapshots', 'POST', selection)).status, 200); assert.equal(entered, true);
    assert.deepEqual(await f.machineRead(selection.requestId), { error: 404 });
  });
  test(`${runtime} logout after snapshot commit hides delivery but retains exact original receipt`, async t => {
    const f = await fixture(t, runtime, { role: 'standalone', mode: 'json' }), selection = { ...range, requestId: randomUUID() };
    f.hook(async (kind, run) => { const result = await run(); if (kind.endsWith('UsageSnapshotCreate')) await f.support.revoke(); return result; });
    assert.notEqual((await f.request('/snapshots', 'POST', selection)).status, 200);
    const result = await f.machineRead(selection.requestId); assert.ok('body' in result); assert.equal(result.body.requestId, selection.requestId);
  });
  test(`${runtime} snapshot HTTP deadline and close retain physical work without resubmission`, async t => {
    const f = await fixture(t, runtime, { role: 'hub', mode: 'json', timeoutMs: 250 }), entered = gate(), release = gate();
    const selection = { ...range, requestId: randomUUID() }; let calls = 0;
    f.hook(async (kind, run) => { if (kind.endsWith('UsageSnapshotCreate')) { calls++; entered.release(); await release.promise; } return run(); });
    const clock = controlledHttpDeadline(t);
    try {
      const response = f.request('/snapshots', 'POST', selection); await awaitHttpAdmission(entered.promise, response);
      assert.equal((await clock.expire(250, response)).status, 503);
      let drained = false;
      const closing = Promise.all([f.support.closeUsage(), f.codex.close(), f.sdk.close()]).then(() => { drained = true; });
      await new Promise<void>(ok => setImmediate(ok)); assert.equal(drained, false); assert.equal(calls, 1);
      release.release(); await closing; assert.equal(calls, 1);
      const result = await f.machineRead(selection.requestId); assert.ok('body' in result); assert.equal(result.body.requestId, selection.requestId);
      assert.equal((await f.request()).status, 503);
    } finally { clock.restore(); release.release(); }
  });
}
