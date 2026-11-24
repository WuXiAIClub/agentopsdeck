import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { loadConfig } from '../config.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { createConnectorRuntime } from '../connector/runtime.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';
import { OpenClawTurnQueue } from './turn-queue.js';

for (const operation of ['close', 'pause', 'pause-before-fallback'] as const) test(`Connector ${operation} owns a real CLI child and its post-close transcript read`, { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-cli-process-drain-'));
  const openclawHome = join(directory, 'openclaw-home');
  mkdirSync(join(openclawHome, 'agents', 'synthetic', 'sessions'), { recursive: true, mode: 0o700 });
  const saved = { AOD_LOCAL_OPENCLAW_CLI: process.env.AOD_LOCAL_OPENCLAW_CLI, AOD_OPENCLAW_HOME: process.env.AOD_OPENCLAW_HOME, AOD_OPENCLAW_CLI_PATH: process.env.AOD_OPENCLAW_CLI_PATH };
  Object.assign(process.env, { AOD_LOCAL_OPENCLAW_CLI: 'true', AOD_OPENCLAW_HOME: openclawHome, AOD_OPENCLAW_CLI_PATH: process.execPath });
  const file = join(directory, 'connector.sqlite');
  const sessionKey = 'agent:synthetic:dashboard:agentopsdeck-web-drain';
  const nativeSpawn = childProcess.spawn;
  const startQueue = OpenClawTurnQueue.prototype.start;
  let queue!: OpenClawTurnQueue, child: ChildProcessWithoutNullStreams | undefined, exited: Promise<unknown> | undefined;
  let release!: () => void, reading!: () => void;
  const transcript = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reading = resolve; });
  let releaseGateway!: () => void, gatewayEntered!: () => void;
  const gatewayWait = new Promise<void>(resolve => { releaseGateway = resolve; });
  const gatewayReady = new Promise<void>(resolve => { gatewayEntered = resolve; });
  t.mock.method(childProcess, 'spawn', (command: string, args: string[]) => {
    assert.equal(command, process.execPath); assert.equal(args[0], 'agent');
    assert.equal(child, undefined, 'queued successor cannot spawn during shutdown');
    child = nativeSpawn(process.execPath, ['-e', `
      process.stdin.once('data', () => {
        process.stdout.write(JSON.stringify({ result: { payloads: [{ text: 'synthetic final' }] } }));
        process.stdin.destroy();
      });
    `], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: directory, NODE_ENV: 'test' } });
    exited = once(child, 'close');
    return child;
  });
  t.mock.method(fsPromises, 'opendir', async (path: unknown) => {
    assert.equal(String(path), join(openclawHome, 'agents', 'synthetic', 'sessions'));
    reading(); await transcript; return { async *[Symbol.asyncIterator]() {} };
  });
  t.mock.method(OpenClawTurnQueue.prototype, 'start', function(this: OpenClawTurnQueue) { queue = this; });
  syncBuiltinESMExports();
  const runtime = createConnectorRuntime(loadConfig({
    AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'true',
    AOD_CONNECTOR_USERS_DATABASE_FILE: file, AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`,
    AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_QUEUE_FILE: `${file}.queue`,
    AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
    AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates`,
  }), () => false);
  t.after(async () => {
    releaseGateway();
    release();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await runtime.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(directory, { recursive: true, force: true });
  });
  // Real runtime/queue/dispatch/CLI, with only native transport, transcript and
  // periodic scheduling replaced. Nothing invokes an Agent or external host.
  (queue as any).options.refreshSessions = async () => {};
  (queue as any).options.refreshMessages = async () => {};
  t.mock.method(runtime.gateway, 'requestBound', async (_method: string, _params: unknown, _connection: unknown, beforeSend?: () => void) => {
    gatewayEntered();
    if (operation === 'pause-before-fallback') await gatewayWait;
    beforeSend?.(); throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write');
  });
  runtime.store.upsertSession({ sessionKey, agentId: 'synthetic', title: 'Synthetic', status: 'idle' });
  const writes = t.mock.method(runtime.store, 'addMessage');
  for (const id of ['one', 'two']) await queue.enqueueAsync({ id, sessionKey, createdAt: Date.now(),
    payload: { actorId: 'local:daily', message: id, media: [], deliveryMode: 'web-only' } });
  let reconciling: Promise<void>;
  if (operation === 'pause-before-fallback') {
    startQueue.call(queue);
    (queue as any).worker.timer.ref();
    await gatewayReady;
    reconciling = (queue as any).worker.inflight;
  } else reconciling = (queue as any).reconcile(sessionKey);
  await gatewayReady;
  if (operation !== 'pause-before-fallback') await reconciling;
  else assert.equal(child, undefined);
  let closed = false;
  let paused: { fenceId: string; nativeQuiescent: boolean } | undefined;
  const closing = (operation === 'close' ? runtime.close() : (async () => {
    const response = await runtime.app.request('/api/connector/v1/maintenance/commands/pause', { method: 'POST',
      headers: { authorization: `Bearer ${runtime.localMaintenanceToken}` }, body: JSON.stringify({ idempotencyKey: 'pause-original' }) });
    assert.equal(response.status, 200);
    paused = await response.json();
  })()).then(() => { closed = true; });
  if (operation !== 'close') {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await runtime.app.request('/synthetic-mutation', { method: 'POST' })).status === 503) break;
      await delay(5);
    }
    assert.equal((await runtime.app.request('/synthetic-mutation', { method: 'POST' })).status, 503);
    await delay(20);
  }
  assert.equal(closed, false);
  releaseGateway();
  await reconciling;
  assert.ok(child);
  assert.equal(runtime.connectorUsers.openClawExecutions.get(sessionKey)?.origin, 'cli');
  assert.equal(runtime.connectorUsers.turns.head('openclaw', sessionKey)?.id, 'two');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'startup ACK does not release the live child');
  assert.throws(() => new ConnectorUserStore(file, undefined, { runtimeOwner: true }), /locked|busy/i);
  const probe = childProcess.spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { ConnectorUserStore } from ${JSON.stringify(new URL('../connector/connector-user-store.js', import.meta.url).href)};
    assert.throws(() => new ConnectorUserStore(${JSON.stringify(file)}, undefined, { runtimeOwner: true }), /locked|busy/i);
  `], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(probe.status, 0, probe.stderr);
  child.stdin.end('synthetic finish\n'); await exited; await entered;
  assert.equal(closed, false, 'child close does not release transcript/callback work');
  assert.throws(() => new ConnectorUserStore(file, undefined, { runtimeOwner: true }), /locked|busy/i);
  release(); await closing;
  assert.equal(writes.mock.calls.filter(call => call.arguments[0]?.text === 'synthetic final').length, 1);
  if (operation !== 'close') {
    assert.equal(paused?.nativeQuiescent, false);
    assert.throws(() => new ConnectorUserStore(file, undefined, { runtimeOwner: true }), /locked|busy/i);
    assert.equal(runtime.connectorUsers.turns.start('openclaw', sessionKey, 'two'), false);
    runtime.connectorUsers.turns.cancel('openclaw', sessionKey, 'two');
    const resumed = await runtime.app.request('/api/connector/v1/maintenance/commands/resume', { method: 'POST',
      headers: { authorization: `Bearer ${runtime.localMaintenanceToken}` },
      body: JSON.stringify({ idempotencyKey: 'resume-original', fenceId: paused!.fenceId }) });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).state, 'released');
    await runtime.close();
  }
  const next = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  try {
    assert.equal(next.openClawExecutions.get(sessionKey)?.phase, 'completed');
    assert.equal(next.turns.head('openclaw', sessionKey)?.id, operation === 'close' ? 'two' : undefined);
    assert.equal(next.turns.head('openclaw', sessionKey)?.state, operation === 'close' ? 'queued' : undefined);
  } finally { next.close(); }
});
