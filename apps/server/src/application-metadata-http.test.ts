import assert from 'node:assert/strict';
import { awaitHttpAdmission, controlledHttpDeadline } from './lifecycle/http-deadline-test-support.js';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from './auth/connector-token.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { ConnectorUserStore } from './connector/connector-user-store.js';
import { AsyncConnectorOwner } from './connector/async-connector-owner.js';
import { AsyncCodexCatalog } from './connector/async-codex-catalog.js';
import { AsyncSdkMetadata } from './connector/async-sdk-metadata.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { applicationInteractionTestSupport, type InteractionApplicationOptions } from './connector/application-interaction-test-support.js';

const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release }; }
async function fixture(t: TestContext, options: InteractionApplicationOptions) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-application-metadata-'));
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  t.after(async () => { try { for (const close of cleanup.reverse()) await close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const config = { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    sdkModels: { 'claude-code': { model: 'original', modelChoices: ['alternate'] }, ghcp: { model: 'original' } } };
  const tokens = new ConnectorTokenStore(config.tokenFile);
  const reader = tokens.create({ label: 'isolated original transport', scopes: ['models:read', 'messages:read'] });
  const support = await applicationInteractionTestSupport(root, options, silence, reader.token);
  cleanup.push(() => support.close());
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  try {
    seed.claudeJournal.create({ key: 'claude-code:original', nativeSessionId: 'original-claude', title: 'Original', createdAt: 1 });
    seed.copilotJournal.create({ key: 'ghcp:original', nativeSessionId: 'original-ghcp', title: 'Original', createdAt: 1 });
  } finally { seed.close(); }
  const owner = new AsyncConnectorOwner(config, silence, undefined, 30_000, support.endpoint);
  cleanup.push(() => owner.close()); await owner.open();
  let hook: ((kind: string, run: () => Promise<unknown>) => Promise<unknown>) | undefined;
  let nativeHook: (() => Promise<void>) | undefined, nativeCalls = 0, enabled = true, connected = true, configured = true;
  const port = { command: (async (kind, input) => {
    const run = () => owner.command(kind, input); return hook ? hook(kind, run) : run();
  }) as AsyncConnectorOwner['command'] };
  const catalog = new AsyncCodexCatalog({ owner: port, diagnostics: silence, local() {}, sessionExists: key => key === 'codex:original', defaultModel: 'default',
    runtime: { get enabled() { return enabled; },
      async listModels() { nativeCalls++; await nativeHook?.(); return [{ id: 'native', label: 'Native' }]; },
      async listSessionSkills() { nativeCalls++; await nativeHook?.(); return { skills: [], observedAt: 1, limited: false, discoveryErrors: 0, usage: 'unknown' }; } } });
  const metadata = new AsyncSdkMetadata(port, { diagnostics: silence, timeoutMs: 5_000 });
  cleanup.push(() => Promise.all([catalog.close(), metadata.close()]));
  const app = new Hono(); support.registerMetadata(app, { codex: { catalog }, sdk: { metadata, ready: () => connected, configured: () => configured } });
  app.all('*', c => c.json({ legacy: true }, 404));
  const request = (path: string, headers: Record<string, string> = {}, signal?: AbortSignal) => app.request(`/api/${path}`, {
    headers: { ...support.headers, ...headers }, ...(signal ? { signal } : {}),
  });
  return { request, owner, support, catalog, metadata, transport: reader.token, nativeCalls: () => nativeCalls,
    hook(value: typeof hook) { hook = value; }, nativeHook(value: typeof nativeHook) { nativeHook = value; },
    enabled(value: boolean) { enabled = value; }, connected(value: boolean) { connected = value; }, configured(value: boolean) { configured = value; } };
}

for (const role of ['hub', 'standalone'] as const) for (const mode of ['sqlite', 'json'] as const) for (const withKey of [true, false])
  test(`${role}/${mode}/${withKey ? 'Cookie' : 'no Key'} original frontend catalogs, skills and SDK state`, async t => {
    const f = await fixture(t, { role, mode, withKey });
    for (const runtime of ['codex', 'claude-code', 'ghcp']) {
      const response = await f.request(`models/${runtime}`);
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); assert.ok(body.models.length > 0); assert.ok(body.models.every((m: { id: string }) => typeof m.id === 'string'));
      if (runtime !== 'codex') {
        const state = await f.request(`sessions/${runtime}:original/state`); assert.equal(state.status, 200);
        assert.equal((await state.json()).status, 'idle');
      }
    }
    const skills = await f.request('sessions/codex:original/skills'); assert.equal(skills.status, 200);
    assert.deepEqual((await skills.json()).skills, []);
    assert.equal((await f.request('models/openclaw')).status, 404);
    for (const path of ['models/codex', 'models/claude-code', 'sessions/codex:original/skills', 'sessions/ghcp:original/state']) {
      assert.equal((await f.request(path, { 'x-agentopsdeck-execution-grant': 'forged' })).status, 403);
      assert.equal((await f.request(path, { [EXPECTED_NODE_HEADER]: 'forged' })).status, 403);
    }
  });

for (const path of ['models/codex', 'sessions/codex:original/skills', 'models/claude-code', 'sessions/ghcp:original/state'])
  test(`${path}: original application logout suppresses delivery, transport remains original`, async t => {
    const f = await fixture(t, { role: 'hub', mode: 'sqlite' });
    let revoked = false;
    f.hook(async (_kind, run) => { const value = await run(); if (!revoked) { revoked = true; await f.support.revoke(); } return value; });
    assert.equal((await f.request(path)).status, 403); assert.equal(revoked, true);
    f.hook(undefined);
    const direct = await f.catalog.models({ authorization: `Bearer ${f.transport}` }); assert.ok('value' in direct);
    assert.equal((await f.request(path, { cookie: '', authorization: `Bearer ${f.transport}` })).status, 403);
  });

test('disabled/offline catalogs retain original distinctions and no fallback', async t => {
  const f = await fixture(t, { role: 'standalone', mode: 'json' });
  f.enabled(false); assert.equal((await f.request('models/codex')).status, 404);
  assert.equal((await f.request('sessions/codex:original/skills')).status, 409); assert.equal(f.nativeCalls(), 0);
  f.connected(false); assert.equal((await f.request('models/claude-code')).status, 200);
  const state = await f.request('sessions/claude-code:original/state'); assert.equal(state.status, 200);
  f.configured(false); assert.equal((await f.request('models/claude-code')).status, 404);
});

for (const ending of ['timeout', 'cancel', 'close'] as const)
  test(`${ending}: original catalog query retained and drained once, no late frontend delivery`, async t => {
    const f = await fixture(t, { role: 'standalone', mode: 'sqlite', timeoutMs: ending === 'timeout' ? 1_000 : 10_000 });
    const entered = gate(), retained = gate(), controller = new AbortController();
    f.nativeHook(async () => { entered.release(); await retained.promise; });
    const clock = ending === 'timeout' ? controlledHttpDeadline(t) : undefined;
    try {
      const response = f.request('models/codex', {}, controller.signal);
      await awaitHttpAdmission(entered.promise, response);
      if (clock) assert.equal((await clock.expire(1000, response)).status, 503);
      if (ending === 'cancel') controller.abort();
      if (ending !== 'close') assert.notEqual((await response).status, 200);
      let closed = false;
      const closing = Promise.all([f.support.closeMetadata(), f.catalog.close(), f.metadata.close()]).then(() => { closed = true; });
      await tick(); assert.equal(closed, false); assert.equal(f.nativeCalls(), 1);
      retained.release(); assert.notEqual((await response).status, 200); await closing;
      assert.equal((await f.request('models/codex')).status, 503); assert.equal(f.nativeCalls(), 1);
    } finally { clock?.restore(); retained.release(); }
  });
