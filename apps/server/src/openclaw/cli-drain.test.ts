import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';
import { DeckStore } from '../projection/deck-store.js';
import { startOpenClawAgentFallback } from './cli.js';
import { createOpenClawDispatch } from './dispatch.js';

function barrier() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const failure of [false, true]) test(`CLI lifetime includes stdio close and asynchronous completion finally, failure=${failure}`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'aod-cli-drain-'));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const saved = { AOD_LOCAL_OPENCLAW_CLI: process.env.AOD_LOCAL_OPENCLAW_CLI, AOD_OPENCLAW_HOME: process.env.AOD_OPENCLAW_HOME, AOD_OPENCLAW_CLI_PATH: process.env.AOD_OPENCLAW_CLI_PATH };
  Object.assign(process.env, { AOD_LOCAL_OPENCLAW_CLI: 'true', AOD_OPENCLAW_HOME: home, AOD_OPENCLAW_CLI_PATH: process.execPath });
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  const finish = barrier();
  let lifetime: Promise<void> | undefined, closed = false, callbacks = 0;
  t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(async () => {
    finish.release(); child.emit('close', 0, null); await lifetime;
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  });
  t.mock.method(console, 'warn', () => {});
  const starting = startOpenClawAgentFallback('synthetic', undefined, 'synthetic', 'input', 'one', async () => {
    callbacks++;
    try { if (failure) throw new Error('synthetic callback failure'); }
    finally { await finish.pending; }
  }, pending => { lifetime = pending; void pending.then(() => { closed = true; }); });
  child.emit('exit', 0, null);
  assert.deepEqual(await starting, { ok: true });
  assert.ok(lifetime, 'ownership must be registered before startup returns');
  await tick(); assert.equal(closed, false, 'exit is not stdio close');
  child.emit('close', 0, null);
  await tick(); assert.equal(callbacks, 1);
  assert.equal(closed, false, 'completion finally still owns its side effects');
  finish.release(); await lifetime;
  assert.equal(closed, true); assert.equal(callbacks, 1, 'callback errors must not invoke a second completion');
});

for (const fault of ['throw', 'error']) test(`CLI releases failed spawn lifetime only after its actual boundary: ${fault}`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'aod-cli-drain-fault-'));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const saved = { AOD_LOCAL_OPENCLAW_CLI: process.env.AOD_LOCAL_OPENCLAW_CLI, AOD_OPENCLAW_HOME: process.env.AOD_OPENCLAW_HOME, AOD_OPENCLAW_CLI_PATH: process.env.AOD_OPENCLAW_CLI_PATH };
  Object.assign(process.env, { AOD_LOCAL_OPENCLAW_CLI: 'true', AOD_OPENCLAW_HOME: home, AOD_OPENCLAW_CLI_PATH: process.execPath });
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  let lifetime: Promise<void> | undefined, closed = false;
  t.mock.method(childProcess, 'spawn', () => { if (fault === 'throw') throw new Error('synthetic spawn failure'); return child; });
  syncBuiltinESMExports();
  t.after(async () => {
    child.emit('close', -1, null); await lifetime; t.mock.restoreAll(); syncBuiltinESMExports();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  });
  const starting = startOpenClawAgentFallback('synthetic', undefined, 'synthetic', 'input', 'one', undefined,
    pending => { lifetime = pending; void pending.then(() => { closed = true; }); });
  if (fault === 'error') child.emit('error', new Error('synthetic spawn failure'));
  assert.equal((await starting).ok, false);
  assert.ok(lifetime);
  await tick(); assert.equal(closed, fault === 'throw');
  if (fault === 'error') { child.emit('error', new Error('late error')); child.emit('close', -1, null); }
  await lifetime; assert.equal(closed, true);
});

for (const boundary of ['entry', 'gateway', 'fallback']) test(`dispatch shutdown prevents a new native write at ${boundary}`, async t => {
  const db = new ConnectorUserStore(':memory:');
  t.after(() => db.close());
  const gate = barrier();
  let calls = 0, cliCalls = 0;
  const dispatch = createOpenClawDispatch({ store: new DeckStore(), executions: db.openClawExecutions,
    authorizeTurn: () => true, allowCliFallback: true, message: text => text,
    gateway: { requestBound: async (_method: string, _params: unknown, _connection: unknown, beforeSend: () => void) => {
      if (boundary === 'gateway') await gate.pending;
      beforeSend(); calls++;
      await gate.pending;
      throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write');
    } } as any,
    startCli: async () => { cliCalls++; return { ok: true }; },
  });
  const sessionKey = 'agent:main:synthetic';
  db.openClawExecutions.begin(sessionKey, 'one');
  t.after(() => gate.release());
  if (boundary === 'entry') dispatch.stopAdmissions();
  const sending = dispatch({ id: 'one', sessionKey, createdAt: 1, state: 'dispatching',
    payload: { message: 'input', media: [], deliveryMode: 'web-only' } }, []);
  const rejected = assert.rejects(sending, /closed/i);
  dispatch.stopAdmissions(); gate.release(); await rejected;
  await dispatch.close();
  assert.equal(calls, boundary === 'fallback' ? 1 : 0);
  assert.equal(cliCalls, 0);
});

test('dispatch drains every admitted CLI lifetime after startup ACK, without manufacturing completion', async t => {
  const db = new ConnectorUserStore(':memory:');
  const jobs = [barrier(), barrier()];
  let admitted = 0;
  const dispatch = createOpenClawDispatch({ store: new DeckStore(), executions: db.openClawExecutions,
    authorizeTurn: () => true, allowCliFallback: true, message: text => text,
    gateway: { requestBound: async () => { throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write'); } } as any,
    startCli: async (_key, _agent, _display, _message, _id, _complete, own) => {
      own!(jobs[admitted++]!.pending); return { ok: true };
    },
  });
  t.after(async () => { for (const job of jobs) job.release(); await dispatch.close(); db.close(); });
  for (const id of ['one', 'two']) {
    const sessionKey = `agent:main:${id}`;
    db.openClawExecutions.begin(sessionKey, id);
    await dispatch({ id, sessionKey, createdAt: 1, state: 'dispatching', payload: { message: id, media: [], deliveryMode: 'web-only' } }, []);
  }
  let closed = false;
  const closing = dispatch.close();
  assert.equal(dispatch.close(), closing);
  void closing.then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  jobs[0]!.release(); await tick(); assert.equal(closed, false);
  jobs[1]!.release(); await closing;
  for (const id of ['one', 'two']) assert.equal(db.openClawExecutions.get(`agent:main:${id}`)?.phase, 'starting');
});
