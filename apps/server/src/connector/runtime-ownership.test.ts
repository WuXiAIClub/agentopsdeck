import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorRuntime } from './runtime.js';
import { loadConfig } from '../config.js';
import { startupApplicationCleanup } from '../lifecycle/startup-cleanup.js';


function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-runtime-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'connector.sqlite');
}
const source = import.meta.url.endsWith('.ts');
const moduleUrl = new URL(source ? './connector-user-store.ts' : './connector-user-store.js', import.meta.url).href;
const childLoader = source ? ['--import', import.meta.resolve('tsx')] : [];
const owner = (file: string) => new ConnectorUserStore(file, undefined, { runtimeOwner: true });
function child(script: string) {
  const result = spawnSync(process.execPath, [...childLoader, '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
}
function assertLockedInChild(file: string) {
  child(`import assert from 'node:assert/strict';
    import { ConnectorUserStore } from ${JSON.stringify(moduleUrl)};
    assert.throws(() => new ConnectorUserStore(${JSON.stringify(file)}, undefined, { runtimeOwner: true }), /locked|busy/i);`);
}

function runtimeConfig(file: string) {
  return loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_CONNECTOR_USERS_DATABASE_FILE: file, AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`,
    AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_QUEUE_FILE: `${file}.queue`,
    AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
    AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates` });
}

for (const first of ['resolve', 'reject'] as const) test(`runtime drains both cancelled legacy event authority owners, first ${first}`, { timeout: 5000 }, async context => {
  const file = fixture(context), config = runtimeConfig(file);
  const runtime = createConnectorRuntime(config, () => true, { deferActivation: true });
  const originals = [0, 1].map(() => {
    let resolve!: (value: boolean) => void, reject!: (error: unknown) => void;
    const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject, calls: 0 };
  });
  const apps = originals.map(original => {
    const app = new Hono(); runtime.registerLegacyRoutes(app, () => { original.calls++; return original.promise; }); return app;
  });
  let storageCloses = 0, closed = false;
  const storageClose = ConnectorUserStore.prototype.close;
  context.mock.method(ConnectorUserStore.prototype, 'close', function(this: ConnectorUserStore) {
    storageCloses++; return storageClose.call(this);
  });
  const controllers = originals.map(() => new AbortController());
  const requests = apps.map((app, i) => app.request('/api/events/stream', { signal: controllers[i]!.signal }));
  let closing: Promise<void> | undefined;
  try {
    const deadline = AbortSignal.timeout(3000);
    while (originals.some(original => original.calls !== 1)) { deadline.throwIfAborted(); await new Promise<void>(resolve => setImmediate(resolve)); }
    for (const controller of controllers) controller.abort();
    for (const request of requests) assert.equal((await request).status, 408);
    closing = runtime.close(); void closing.then(() => { closed = true; }); assert.equal(runtime.close(), closing);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.equal(storageCloses, 0);
    if (first === 'resolve') originals[0]!.resolve(true); else originals[0]!.reject(Error('PRIVATE first SQL error'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.equal(storageCloses, 0);
    for (const app of apps) assert.equal((await app.request('/api/events/stream')).status, 503);
  } finally {
    originals[0]!.resolve(false);
    if (first === 'resolve') originals[1]!.reject(Error('PRIVATE second SQL error')); else originals[1]!.resolve(true);
    for (const controller of controllers) controller.abort();
    await Promise.all(requests); await (closing ?? runtime.close());
  }
  assert.equal(storageCloses, 1); assert.equal(closed, true);
  assert.deepEqual(originals.map(original => original.calls), [1, 1]);
  const lateApp = new Hono(); runtime.registerLegacyRoutes(lateApp, () => assert.fail('closed runtime cannot dispatch authority'));
  assert.equal((await lateApp.request('/api/events/stream')).status, 503);
});

test('Codex-only empty runtime advertises Codex without inventing main or calling Gateway', async context => {
  const file = fixture(context), config = runtimeConfig(file);
  config.codex.enabled = true;
  const runtime = createConnectorRuntime(config, () => true);
  runtime.gateway.request = async () => assert.fail('disabled OpenClaw must not be queried');
  try {
    const app = new Hono();
    runtime.registerLegacyRoutes(app);
    const response = await app.request('/api/agents');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.agents.map((agent: { id: string }) => agent.id), ['codex']);
    assert.equal(body.degraded, undefined);
    const connector = await runtime.app.request('/api/connector/v1/agents', { headers: { authorization: `Bearer ${runtime.localToken}` } });
    assert.deepEqual((await connector.json()).agents.map((agent: { id: string }) => agent.id), ['codex']);
  } finally { await runtime.close(); }
});

test('real runtime async registry discovery preserves both agent HTTP formats and ignores non-directories', async context => {
  const file = fixture(context), config = runtimeConfig(file), registry = `${file}.registry`;
  mkdirSync(join(registry, 'agents', 'local-目录'), { recursive: true });
  writeFileSync(join(registry, 'agents', 'not-an-agent'), 'fixture');
  const previous = process.env.AOD_OPENCLAW_HOME;
  process.env.AOD_OPENCLAW_HOME = registry;
  context.after(() => {
    if (previous === undefined) delete process.env.AOD_OPENCLAW_HOME;
    else process.env.AOD_OPENCLAW_HOME = previous;
  });
  config.localOpenClawCli = true; config.codex.enabled = true;
  const runtime = createConnectorRuntime(config, () => true, { deferActivation: true });
  runtime.gateway.request = async () => { throw Error('fixture gateway unavailable'); };
  try {
    const app = new Hono(); runtime.registerLegacyRoutes(app);
    const [local, connector] = await Promise.all([
      app.request('/api/agents'),
      runtime.app.request('/api/connector/v1/agents', { headers: { authorization: `Bearer ${runtime.localToken}` } }),
    ]);
    assert.equal(local.status, 200); assert.equal(connector.status, 200);
    const hubValue = await local.json(), connectorValue = await connector.json();
    for (const value of [hubValue, connectorValue]) {
      assert.deepEqual(value.agents.map((agent: { id: string }) => agent.id).sort(), ['codex', config.defaultAgentId, 'local-目录'].sort());
      assert.equal(value.agents.find((agent: { id: string }) => agent.id === 'codex').label, 'Codex · local harness');
    }
    assert.equal(hubValue.degraded, true); assert.equal(connectorValue.degraded, undefined);
    assert.equal(typeof hubValue.updatedAt, 'number'); assert.deepEqual(Object.keys(connectorValue), ['agents']);
  } finally { await runtime.close(); }
});

async function maintenanceRequest(runtime: ReturnType<typeof createConnectorRuntime>, operation: string, body?: object) {
  return runtime.app.request(`/api/connector/v1/maintenance/${operation}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${runtime.localMaintenanceToken}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

for (const kind of ['sessions', 'history', 'codex-history'] as const) for (const failed of [false, true]) {
  test(`maintenance drains direct ${kind} ${failed ? 'failure cleanup' : 'publication'} before settling and resumes the same runtime`, async context => {
    const file = fixture(context), config = runtimeConfig(file);
    config.gatewayWsUrl = 'ws://synthetic.invalid';
    const runtime = createConnectorRuntime(config, () => false);
    const nodeId = runtime.connectorUsers.nodeId, sessionKey = kind === 'codex-history' ? 'codex:synthetic' : 'agent:main:synthetic';
    runtime.store.replaceSessions([{ key: sessionKey }]);
    runtime.gateway.connectionId = () => 'synthetic-connection';
    let enter!: () => void, release!: () => void, reads = 0;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = async () => { reads++; enter(); await held; if (failed) throw new Error('synthetic projection failure'); };
    runtime.gateway.requestWithConnection = async <T>(method: string) => {
      await read();
      return { connectionId: 'synthetic-connection', payload: (method === 'sessions.list'
        ? { sessions: [{ key: sessionKey }] } : { messages: [] }) as T };
    };
    runtime.codex.refreshSession = read;
    const pending = (kind === 'sessions' ? runtime.refreshSessions() : runtime.refreshMessages(sessionKey))
      .then(() => undefined, error => error);
    context.after(async () => { release(); await pending; await runtime.close(); });
    await started;
    let settled = false;
    const pauseRequest = maintenanceRequest(runtime, 'commands/pause', { idempotencyKey: 'original-pause' })
      .then(response => { settled = true; return response; });
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await (await maintenanceRequest(runtime, 'status')).json();
        if (status.state === 'paused') break;
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
      assert.equal((await (await maintenanceRequest(runtime, 'status')).json()).state, 'paused');
      await new Promise<void>(resolve => setTimeout(resolve, 30));
      assert.equal(settled, false, 'the original receipt cannot settle while an admitted projection still owns writes');
      assert.equal(reads, 1);
      assert.throws(() => owner(file), /locked|busy/i);
    } finally { release(); }
    const pauseResponse = await pauseRequest, paused = await pauseResponse.json();
    assert.equal(pauseResponse.status, 200);
    assert.equal(paused.nativeQuiescent, false);
    const outcome = await pending;
    if (failed) assert.match(String(outcome), /synthetic projection failure/);
    else assert.equal(outcome, undefined);
    await assert.rejects(runtime.refreshSessions(), /maintenance/i);
    await assert.rejects(runtime.refreshMessages('agent:main:synthetic'), /maintenance/i);
    await assert.rejects(runtime.refreshMessages('codex:synthetic'), /maintenance/i);
    assert.equal(reads, 1);
    const resumed = await maintenanceRequest(runtime, 'commands/resume', { idempotencyKey: 'original-resume', fenceId: paused.fenceId });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).state, 'released');
    if (failed) await assert.rejects(kind === 'sessions' ? runtime.refreshSessions() : runtime.refreshMessages(sessionKey), /synthetic projection failure/);
    else await (kind === 'sessions' ? runtime.refreshSessions() : runtime.refreshMessages(sessionKey));
    assert.equal(reads, 2);
    assert.equal(runtime.connectorUsers.nodeId, nodeId);
  });
}

test('runtime maintenance blocks projection GET and HEAD but preserves authenticated original maintenance recovery', async context => {
  const file = fixture(context), config = runtimeConfig(file);
  const runtime = createConnectorRuntime(config, () => false);
  context.after(() => runtime.close());
  const paused = await (await maintenanceRequest(runtime, 'commands/pause', { idempotencyKey: 'pause' })).json();
  for (const method of ['GET', 'HEAD', 'POST']) {
    const response = await runtime.app.request('/api/connector/v1/sessions/state', { method,
      headers: { authorization: `Bearer ${runtime.localToken}` } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await runtime.app.request('/api/connector/v1/maintenance/status')).status, 403);
  assert.equal((await runtime.app.request('/api/connector/v1/maintenance/status/extra')).status, 503);
  assert.equal((await runtime.app.request('/api/connector/v1/identity', {
    headers: { authorization: `Bearer ${runtime.localToken}` },
  })).status, 200);
  const receipt = await (await maintenanceRequest(runtime, 'commands/pause/pause')).json();
  assert.equal(receipt.command.id, paused.command.id);
  assert.equal(receipt.command.state, 'accepted');
  const recoveryPath = '/api/connector/v1/maintenance/storage/recovery';
  for (const method of ['GET', 'HEAD']) {
    const denied = await runtime.app.request(recoveryPath, { method });
    assert.equal(denied.status, 403, 'paused read-only recovery must still reach fresh authorization');
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    const observed = await runtime.app.request(recoveryPath, { method,
      headers: { authorization: `Bearer ${runtime.localMaintenanceToken}` } });
    assert.equal(observed.status, 200);
    assert.equal(observed.headers.get('cache-control'), 'no-store');
    if (method === 'GET') {
      const snapshot = await observed.json();
      assert.deepEqual(snapshot.connection, { state: 'ready', attempts: 0 });
      assert.equal(snapshot.performance.scope, 'process');
    }
  }
  for (const [path, method] of [[recoveryPath, 'POST'], [recoveryPath, 'PUT'],
    [recoveryPath + '/extra', 'GET'], ['/api/connector/v1/maintenance/storage', 'GET'],
    ['/api/connector/v1/maintenance/storage/checkpoint', 'POST']] as const) {
    assert.equal((await runtime.app.request(path, { method,
      headers: { authorization: `Bearer ${runtime.localMaintenanceToken}` } })).status, 503,
    'only the exact read-only recovery observation may cross the pause fence');
  }
  assert.equal((await runtime.app.request('/api/connector/v1/sessions/state')).status, 503);
  assert.deepEqual(await (await maintenanceRequest(runtime, 'commands/pause/pause')).json(), receipt,
    'observation cannot release or rewrite the original pause receipt');
  const resumed = await maintenanceRequest(runtime, 'commands/resume', { idempotencyKey: 'resume', fenceId: paused.fenceId });
  assert.equal(resumed.status, 200);
  assert.equal((await runtime.app.request('/api/connector/v1/maintenance/status/extra')).status, 404);
});

test('maintenance preserves the reloadable control UI and legacy health without reopening legacy projections', async context => {
  const runtime = createConnectorRuntime(runtimeConfig(fixture(context)), () => false);
  context.after(() => runtime.close());
  const legacy = new Hono();
  runtime.registerLegacyRoutes(legacy);
  legacy.get('/', context => context.html('<title>Maintenance controls</title>'));
  legacy.get('/assets/control.js', context => context.text('synthetic controls'));
  const pause = await maintenanceRequest(runtime, 'commands/pause', { idempotencyKey: 'pause' });
  assert.equal(pause.status, 200);
  assert.equal((await legacy.request('/')).status, 200);
  assert.equal((await legacy.request('/assets/control.js')).status, 200);
  assert.equal((await legacy.request('/api/health')).status, 200);
  assert.equal((await legacy.request('/api/sessions/state')).status, 503);
  assert.equal((await legacy.request('/api/health/extra')).status, 503);
  assert.equal((await legacy.request('/assets/control.js', { method: 'POST' })).status, 503);
});

test('restart restores projection admission fence and original receipts before either adapter can refresh', async context => {
  const file = fixture(context), config = runtimeConfig(file);
  const original = createConnectorRuntime(config, () => false);
  context.after(() => original.close());
  const paused = await (await maintenanceRequest(original, 'commands/pause', { idempotencyKey: 'pause-before-restart' })).json();
  await original.close();
  const runtime = createConnectorRuntime(config, () => false);
  context.after(() => runtime.close());
  let reads = 0;
  runtime.codex.refreshSession = async () => { reads++; };
  assert.equal(runtime.connectorUsers.nodeId, original.connectorUsers.nodeId);
  await assert.rejects(runtime.refreshSessions(), /maintenance/);
  await assert.rejects(runtime.refreshMessages('codex:synthetic'), /maintenance/);
  assert.equal(reads, 0);
  const receipt = await (await maintenanceRequest(runtime, 'commands/pause/pause-before-restart')).json();
  assert.equal(receipt.command.id, paused.command.id);
  const wrong = await maintenanceRequest(runtime, 'commands/resume', { idempotencyKey: 'wrong-fence', fenceId: 'foreign' });
  assert.equal(wrong.status, 409);
  await assert.rejects(runtime.refreshMessages('codex:synthetic'), /maintenance/);
  const resumed = await maintenanceRequest(runtime, 'commands/resume', { idempotencyKey: 'resume-after-restart', fenceId: paused.fenceId });
  assert.equal(resumed.status, 200);
  await runtime.refreshMessages('codex:synthetic');
  assert.equal(reads, 1);
  const second = await (await maintenanceRequest(runtime, 'commands/pause', { idempotencyKey: 'pause-new' })).json();
  assert.notEqual(second.fenceId, paused.fenceId);
  const duplicate = await maintenanceRequest(runtime, 'commands/resume', { idempotencyKey: 'resume-after-restart', fenceId: paused.fenceId });
  assert.equal(duplicate.status, 200);
  await assert.rejects(runtime.refreshMessages('codex:synthetic'), /maintenance/);
  const finalResume = await maintenanceRequest(runtime, 'commands/resume', { idempotencyKey: 'resume-new', fenceId: second.fenceId });
  assert.equal(finalResume.status, 200);
  await runtime.refreshMessages('codex:synthetic');
  assert.equal(reads, 2);
});

for (const kind of ['sessions', 'history'] as const) for (const failed of [false, true]) {
  test(`runtime shutdown owns direct ${kind} projection until ${failed ? 'failure cleanup' : 'publication'} finishes`, async context => {
    const file = fixture(context), config = runtimeConfig(file);
    config.gatewayWsUrl = 'ws://synthetic.invalid';
    const runtime = createConnectorRuntime(config, () => false), sessionKey = 'agent:main:synthetic';
    runtime.store.replaceSessions([{ key: sessionKey }]);
    runtime.gateway.connectionId = () => 'synthetic-connection';
    let enter!: () => void, release!: () => void, closed = false, reads = 0;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    runtime.gateway.requestWithConnection = async <T>(method: string) => {
      reads++; enter(); await held;
      if (failed) throw new Error('synthetic projection failure');
      return { connectionId: 'synthetic-connection', payload: (method === 'sessions.list'
        ? { sessions: [{ key: sessionKey, label: 'Published before release' }] }
        : { sessionKey, messages: [{ id: 'synthetic-reply', role: 'assistant', text: 'Published before release', createdAt: 1 }] }) as T };
    };
    const pending = (kind === 'sessions' ? runtime.refreshSessions() : runtime.refreshMessages(sessionKey)).then(() => undefined, error => error);
    context.after(async () => { release(); await pending; await runtime.close(); });
    await started;
    const closing = runtime.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      assert.equal(closed, false, 'closing must not release SQLite while a directly owned projection is pending');
      assert.throws(() => owner(file), /locked|busy/i);
      await assert.rejects(runtime.refreshSessions(), /closing|closed/i);
      await assert.rejects(runtime.refreshMessages(sessionKey, { fresh: true }), /closing|closed/i);
      assert.equal(reads, 1);
    } finally { release(); await closing; }
    const result = await pending;
    if (failed) assert.match(String(result), /synthetic projection failure/);
    else assert.equal(result, undefined, 'accepted publication finishes before SQLite is closed');
    const next = owner(file); context.after(() => next.close());
    assert.equal(next.nodeId, runtime.connectorUsers.nodeId);
  });
}

test('closed runtime rejects direct projection refresh before consulting either native adapter', async context => {
  const file = fixture(context), runtime = createConnectorRuntime(runtimeConfig(file), () => false);
  await runtime.close();
  let reads = 0;
  runtime.codex.refreshSession = async () => { reads++; };
  await assert.rejects(runtime.refreshSessions({ maxAgeMs: 60_000 }), /closing|closed/i);
  await assert.rejects(runtime.refreshMessages('agent:main:synthetic'), /closing|closed/i);
  await assert.rejects(runtime.refreshMessages('codex:synthetic'), /closing|closed/i);
  assert.equal(reads, 0);
});

test('runtime acquires ownership before accessing credentials or constructing native adapters', t => {
  const file = fixture(t), first = owner(file), config = runtimeConfig(file);
  t.after(() => first.close());
  Object.defineProperty(config.connector, 'tokenFile', { get() { throw new Error('credentials must not be accessed'); } });
  assert.throws(() => createConnectorRuntime(config, () => false), /locked|busy/i);
  assertLockedInChild(file);
});

test('runtime assembly failure releases the owner connection after epoch initialization', async t => {
  const file = fixture(t), config = runtimeConfig(file);
  Object.defineProperty(config, 'artifactReceiver', { get() { throw new Error('synthetic assembly failure'); } });
  assert.throws(() => createConnectorRuntime(config, () => false), /synthetic assembly failure/);
  await startupApplicationCleanup.waitForCurrentCleanup();
  const next = owner(file); t.after(() => next.close());
  assertLockedInChild(file);
});

test('invalid legacy mirror evidence fails before native construction and releases runtime ownership', async context => {
  const file = fixture(context), config = runtimeConfig(file);
  writeFileSync(config.mirrorOutboxFile, '{broken legacy evidence');
  Object.defineProperty(config, 'artifactReceiver', { get() { throw new Error('native resources must not be constructed'); } });
  assert.throws(() => createConnectorRuntime(config, () => false), /mirror outbox JSON/);
  await startupApplicationCleanup.waitForCurrentCleanup();
  assert.equal(readFileSync(config.mirrorOutboxFile, 'utf8'), '{broken legacy evidence');
  const next = owner(file);
  context.after(() => next.close());
  assert.deepEqual(next.mirrorOutbox.list(), []);
  assertLockedInChild(file);
});

test('runtime shutdown retains ownership until its existing workers drain, and closes once', async t => {
  const file = fixture(t), runtime = createConnectorRuntime(runtimeConfig(file), () => false);
  let release!: () => void;
  const drained = new Promise<void>(resolve => { release = resolve; });
  const close = runtime.codex.close.bind(runtime.codex);
  runtime.codex.close = async () => { await close(); await drained; };
  t.after(async () => { release(); await runtime.close(); });
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  try { assert.throws(() => owner(file), /locked|busy/i); assertLockedInChild(file); }
  finally { release(); await closing; }
  const next = owner(file); t.after(() => next.close());
  assert.equal(next.nodeId, runtime.connectorUsers.nodeId);
});

for (const deferActivation of [false, true]) test(`shutdown observes unused binding readiness with deferred activation ${deferActivation}`, async context => {
  const file = fixture(context), config = runtimeConfig(file);
  // No managed tools means no startup consumer awaits the aggregate readiness.
  // Closing in the construction turn must still own its later rejection. Node's
  // test runner fails this regression on unhandled activity after settlement.
  const runtime = createConnectorRuntime(config, () => false, { deferActivation });
  await runtime.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  const next = owner(file);
  try { assert.equal(next.nodeId, runtime.connectorUsers.nodeId); }
  finally { next.close(); }
});

for (const afterEffect of [false, true]) test(`runtime shutdown retries only exact Connector owner close after lost ${afterEffect ? 'ACK' : 'effect'}`, async t => {
  const file = fixture(t), runtime = createConnectorRuntime(runtimeConfig(file), () => false);
  const original = Error('private-synthetic-close'), closeOwner = runtime.connectorUsers.close.bind(runtime.connectorUsers);
  const closeNative = runtime.codex.close.bind(runtime.codex);
  let closes = 0, drains = 0;
  runtime.codex.close = async () => { drains++; await closeNative(); };
  t.mock.method(runtime.connectorUsers, 'close', () => {
    closes++;
    if (closes === 1) { if (afterEffect) closeOwner(); throw original; }
    closeOwner();
  });
  try {
    await assert.rejects(runtime.close(), error => error === original);
    if (!afterEffect) assertLockedInChild(file);
    await assert.rejects(runtime.refreshSessions(), /closing|closed/i);
    const retry = runtime.close(); assert.equal(runtime.close(), retry); await retry;
    assert.equal(closes, 2); assert.equal(drains, 1);
    await runtime.close(); assert.equal(closes, 2);
    const next = owner(file); try { assert.equal(next.nodeId, runtime.connectorUsers.nodeId); } finally { next.close(); }
  } finally { await runtime.close(); }
});

for (const method of ['stopAdmissions', 'close'] as const) test(`runtime ${method} stops turn starts synchronously while admitted handlers drain`, async t => {
  const file = fixture(t), runtime = createConnectorRuntime(runtimeConfig(file), () => false);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  runtime.app.post('/synthetic-drain', async c => { entered(); await held; return c.text('done'); });
  const request = runtime.app.request('/synthetic-drain', { method: 'POST' });
  await started;
  const users = runtime.connectorUsers, sessionKey = 'codex:synthetic-stop';
  await users.turns.enqueueAsync('codex', { id: 'queued', sessionKey, createdAt: 1, payload: { text: 'retained' } });
  const draining = runtime[method]();
  try {
    assert.equal(users.turns.start('codex', sessionKey, 'queued'), false);
    assert.equal(users.codexExecutions.begin(sessionKey, 'new', 'synthetic'), false);
    assert.equal(users.openClawExecutions.begin('agent:synthetic', 'new'), false);
    assert.equal(users.turns.head('codex', sessionKey)?.state, 'queued');
    assert.throws(() => owner(file), /locked|busy/i);
  } finally { release(); await request; await draining; await runtime.close(); }
});

test('runtime ownership survives COMMIT and rejects same-process and cross-process contenders without changing facts', t => {
  const file = fixture(t), first = owner(file);
  t.after(() => first.close());
  first.events.beginEpoch();
  first.openClawExecutions.begin('dashboard:synthetic', 'command');
  const cursor = first.events.latestEventId(), fact = first.openClawExecutions.get('dashboard:synthetic');
  assertLockedInChild(file);
  assert.throws(() => owner(file), /locked|busy/i);
  // An independent filesystem open/close must not release this process's SQLite lock.
  assertLockedInChild(file);
  assert.throws(() => new ConnectorUserStore(file), /locked|busy/i);
  assertLockedInChild(file);
  assert.equal(first.events.latestEventId(), cursor);
  assert.deepEqual(first.openClawExecutions.get('dashboard:synthetic'), fact);
  first.createUser('Still writable');
});

test('runtime owner excludes direct readers; API-side reads through its connection still work', t => {
  const file = fixture(t), first = owner(file);
  t.after(() => first.close());
  const reader = new DatabaseSync(file, { readOnly: true });
  try { assert.throws(() => reader.prepare('SELECT * FROM connector_users').all(), /locked|busy/i); }
  finally { reader.close(); }
  assertLockedInChild(file);
  assert.equal(first.listUsers().length, 1);
});

test('normal close releases ownership and preserves identity and uncertain execution on takeover', t => {
  const file = fixture(t), first = owner(file);
  const id = first.nodeId;
  first.events.beginEpoch();
  first.openClawExecutions.begin('dashboard:synthetic', 'command');
  const cursor = first.events.latestEventId();
  first.close();
  const next = owner(file); t.after(() => next.close());
  assert.equal(next.nodeId, id);
  assert.equal(next.events.latestEventId(), cursor, 'acquiring ownership does not itself advance the epoch');
  next.events.beginEpoch(); next.openClawExecutions.recoverInterrupted();
  assert.equal(next.openClawExecutions.get('dashboard:synthetic')?.phase, 'unknown');
  assert.equal(next.openClawExecutions.begin('dashboard:synthetic', 'successor'), false);
});

test('process termination releases the lock without a TTL and does not turn uncertain work into retryable work', async t => {
  const file = fixture(t);
  const proc = spawn(process.execPath, [...childLoader, '--input-type=module', '-e', `
    import { ConnectorUserStore } from ${JSON.stringify(moduleUrl)};
    const store = new ConnectorUserStore(${JSON.stringify(file)}, undefined, { runtimeOwner: true });
    store.events.beginEpoch(); store.openClawExecutions.begin('dashboard:synthetic', 'command');
    process.send('ready'); setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  const ready = await Promise.race([
    // Readiness is a protocol signal, independent of diagnostic stdout.
    once(proc, 'message').then(([message]) => message),
    once(proc, 'exit').then(() => { throw new Error('owner exited before readiness'); }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('owner readiness timeout')), 10_000); timer.unref(); t.after(() => clearTimeout(timer)); }),
  ]);
  assert.equal(ready, 'ready');
  if (process.platform !== 'win32') proc.kill('SIGSTOP');
  assert.throws(() => owner(file), /locked|busy/i);
  const exit = once(proc, 'exit'); proc.kill('SIGKILL'); await exit;
  const next = owner(file); t.after(() => next.close());
  next.events.beginEpoch(); next.openClawExecutions.recoverInterrupted();
  assert.equal(next.openClawExecutions.get('dashboard:synthetic')?.phase, 'unknown');
  assert.equal(next.openClawExecutions.begin('dashboard:synthetic', 'successor'), false);
});

test('ownership is per database, while non-runtime handles retain their existing sharing behavior', t => {
  const file = fixture(t), first = owner(file), other = owner(`${file}.other`);
  t.after(() => { first.close(); other.close(); });
  assert.notEqual(first.nodeId, other.nodeId);
  const plain = new ConnectorUserStore(`${file}.plain`), second = new ConnectorUserStore(`${file}.plain`);
  try { assert.equal(plain.nodeId, second.nodeId); }
  finally { plain.close(); second.close(); }
});

test('migration failure releases ownership for a corrected next startup', t => {
  const file = fixture(t), db = new DatabaseSync(file);
  db.exec('CREATE TABLE connector_users (wrong_schema TEXT)'); db.close();
  assert.throws(() => owner(file), /column/);
  const repair = new DatabaseSync(file);
  repair.exec('DROP TABLE connector_users'); repair.close();
  const next = owner(file); t.after(() => next.close());
  assert.equal(next.listUsers().length, 1);
  assertLockedInChild(file);
});

test('new and reopened runtime database files have private permissions', t => {
  const file = fixture(t), first = owner(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  first.close(); chmodSync(file, 0o644);
  const next = owner(file); t.after(() => next.close());
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
