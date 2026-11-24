import assert from 'node:assert/strict';
import { Server, createServer } from 'node:http';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { EXPECTED_NODE_HEADER } from '../connector/node-identity.js';
import type { MaintenanceAdapter, MaintenanceJob } from './connector-maintenance.js';
import { startMaintenanceHost, maintenanceHostStartupRecovery, closeFailedMaintenanceStartup } from './maintenance-host.js';
import { MAINTENANCE_API, MAINTENANCE_PROTOCOL_HEADER, createMaintenanceApp } from './maintenance-http.js';
import { SqliteMaintenanceJournal } from './maintenance-journal.js';
import { MaintenanceReceiptReader } from './maintenance-receipt-reader.js';
import { MaintenanceSupervisor } from './maintenance-supervisor.js';
import { AsyncMaintenanceJournal, MaintenanceJournalUnavailable } from './async-maintenance-journal.js';
import type { Worker } from 'node:worker_threads';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

const release = { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
type Host = Awaited<ReturnType<typeof startMaintenanceHost>>;

test('failed startup reports promptly but fences construction until the exact original journal exits', async t => {
  const f = fixture(t), open = AsyncMaintenanceJournal.prototype.open, close = AsyncMaintenanceJournal.prototype.close;
  let original: AsyncMaintenanceJournal | undefined, opens = 0, closes = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(AsyncMaintenanceJournal.prototype, 'open', async function (this: AsyncMaintenanceJournal) {
    opens++; await open.call(this);
    if (!original) { original = this; throw Error('private-startup-fault'); }
  });
  t.mock.method(AsyncMaintenanceJournal.prototype, 'close', function (this: AsyncMaintenanceJournal) {
    if (this !== original) return close.call(this);
    closes++; return pending.then(() => close.call(this));
  });
  try {
    await assert.rejects(f.start(), error => {
      assert.doesNotMatch(String(error), /private-startup-fault/); return true;
    });
    assert.deepEqual(maintenanceHostStartupRecovery(), { pending: 1, retryable: 0 });
    await assert.rejects(f.start());
    const cleanup = closeFailedMaintenanceStartup();
    assert.equal(opens, 1); assert.equal(closes, 1); assert.deepEqual(f.calls, []);
    release(); await cleanup;
    assert.deepEqual(maintenanceHostStartupRecovery(), { pending: 0, retryable: 0 });
    const host = await f.start(); assert.equal((await f.request(host, '/status')).status, 200);
  } finally { release(); await closeFailedMaintenanceStartup(); }
});

test('refused startup journal cleanup retains the same owner and explicit retry never replays construction', async t => {
  const f = fixture(t), open = AsyncMaintenanceJournal.prototype.open, close = AsyncMaintenanceJournal.prototype.close;
  let original: AsyncMaintenanceJournal | undefined, opens = 0, closes = 0;
  t.mock.method(AsyncMaintenanceJournal.prototype, 'open', async function (this: AsyncMaintenanceJournal) {
    opens++; await open.call(this);
    if (!original) { original = this; throw Error('private-startup-fault'); }
  });
  t.mock.method(AsyncMaintenanceJournal.prototype, 'close', function (this: AsyncMaintenanceJournal) {
    if (this !== original) return close.call(this);
    if (++closes === 1) throw Error('private-close-fault');
    return close.call(this);
  });
  await assert.rejects(f.start());
  await until(() => maintenanceHostStartupRecovery().retryable === 1);
  await assert.rejects(f.start()); assert.equal(opens, 1); assert.equal(closes, 1);
  await delay(1100);
  await closeFailedMaintenanceStartup();
  assert.equal(opens, 1); assert.equal(closes, 2); assert.deepEqual(f.calls, []);
  await f.start(); assert.equal(opens, 2);
});

test('failed bind retains journal behind refused listener cleanup then retries only original owners', async t => {
  const f = fixture(t), occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const address = occupied.address(); assert.ok(address && typeof address !== 'string');
  const closeServer = Server.prototype.close, closeJournal = AsyncMaintenanceJournal.prototype.close;
  let listenerAttempts = 0, journalCloses = 0;
  t.mock.method(Server.prototype, 'close', function (this: Server, callback?: (error?: Error) => void) {
    if (!this.listening && ++listenerAttempts === 1) throw Error('private-listener-close');
    return closeServer.call(this, callback);
  });
  t.mock.method(AsyncMaintenanceJournal.prototype, 'close', function (this: AsyncMaintenanceJournal) {
    journalCloses++; return closeJournal.call(this);
  });
  await assert.rejects(f.start({ port: address.port }));
  await until(() => maintenanceHostStartupRecovery().retryable === 1);
  assert.equal(journalCloses, 0);
  await assert.rejects(f.start()); assert.deepEqual(f.calls, []);
  await delay(1100); await closeFailedMaintenanceStartup();
  assert.equal(listenerAttempts, 2); assert.equal(journalCloses, 1);
  await f.start();
});

test('HTTP halted host inspects original durable receipts after actual SQL worker exit, never readmitting writes', async t => {
  let original: AsyncMaintenanceJournal | undefined;
  const open = AsyncMaintenanceJournal.prototype.open;
  t.mock.method(AsyncMaintenanceJournal.prototype, 'open', async function (this: AsyncMaintenanceJournal) {
    original = this; return open.call(this);
  });
  const f = fixture(t), host = await f.start({ tickMs: 60_000 });
  assert.equal((await f.command(host)).status, 202);
  const saved = await f.receipt(host);
  await (original as unknown as { worker: Worker }).worker.terminate();
  await until(() => host.workerFailed && original!.snapshot().ownerExitConfirmed);
  assert.deepEqual(await f.receipt(host), saved);
  const status = await (await f.request(host, '/status')).json();
  assert.equal(status.workerState, 'halted'); assert.equal(status.blocked, true);
  const recovery = await (await f.request(host, '/recovery')).json();
  assert.equal(recovery.transport.unavailable, true);
  assert.equal(recovery.transport.ownerExitConfirmed, true);
  assert.deepEqual(status.job, saved); assert.equal((await f.command(host)).status, 503);
  assert.equal((await f.request(host, '/commands/absent')).status, 404);
  assert.deepEqual(f.calls, []);
  f.tokens.revoke(f.owner.record.id);
  assert.equal((await f.request(host, '/status')).status, 403);
  assert.equal((await f.request(host, '/commands/request:1')).status, 403);
});

test('HTTP host halt unrelated to SQL transport retains healthy original receipt reads', async t => {
  let halt = false;
  t.mock.method(MaintenanceSupervisor.prototype, 'tick', () => halt
    ? Promise.reject(new MaintenanceJournalUnavailable()) : Promise.resolve(undefined));
  const f = fixture(t), host = await f.start();
  assert.equal((await f.command(host)).status, 202);
  const saved = await f.receipt(host);
  halt = true;
  await until(() => host.workerFailed);
  assert.deepEqual(await f.receipt(host), saved);
  const status = await (await f.request(host, '/status')).json();
  assert.equal(status.workerState, 'halted');
  const recovery = await (await f.request(host, '/recovery')).json();
  assert.equal(recovery.transport.unavailable, false);
  assert.equal((await f.command(host)).status, 503);
  assert.deepEqual(f.calls, []);
});

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'maintenance host condition timed out');
    await delay(20);
  }
}

function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-host-'));
  const journalDirectory = join(directory, 'supervisor'), runtime = join(directory, 'runtime');
  mkdirSync(journalDirectory, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
  const tokenFile = join(runtime, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, 'synthetic-bootstrap');
  const owner = tokens.create({ label: 'test lifecycle', scopes: ['connector:lifecycle'] });
  const calls: string[] = [];
  const unexpected = async () => { calls.push('unexpected'); throw new Error('private diagnostic'); };
  const adapter: MaintenanceAdapter = {
    authorize: async () => true,
    prepare: async () => { calls.push('prepare'); return release; },
    inspect: async job => ({ nodeId: job.nodeId, observedAt: Date.now(), nativeVerified: true,
      activeRuns: 1, backgroundTerminals: 0, pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0 }),
    fence: unexpected, releaseFence: unexpected, stop: unexpected, stopped: unexpected,
    backup: unexpected, activate: unexpected, start: unexpected, ready: unexpected,
  };
  const options = { nodeId: 'node:1', journalFile: join(journalDirectory, 'journal.sqlite'), tokenFile,
    protectedRoots: [runtime], adapter, operations: ['restart'] as ('restart' | 'upgrade')[], port: 0, tickMs: 50 };
  const hosts: Host[] = [];
  const start = async (overrides: Partial<typeof options> = {}) => {
    const host = await startMaintenanceHost({ ...options, ...overrides }); hosts.push(host); return host;
  };
  const headers = { authorization: `Bearer ${owner.token}`, [EXPECTED_NODE_HEADER]: options.nodeId,
    [MAINTENANCE_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' };
  const request = (host: Host, suffix: string, body?: unknown) => fetch(`http://127.0.0.1:${host.port}${MAINTENANCE_API}${suffix}`, {
    headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const command = (host: Host, commandKey = 'request:1') => request(host, '/commands', { commandKey, operation: 'restart' });
  const receipt = async (host: Host) => {
    const response = await request(host, '/commands/request:1'); assert.equal(response.status, 200);
    return (await response.json() as { command: MaintenanceJob }).command;
  };
  t.after(async () => {
    try { await Promise.all(hosts.map(host => host.close())); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, journalDirectory, runtime, options, adapter, tokens, owner, calls, start, request, command, receipt };
}

test('host exposes read-only original maintenance SQL owner state without starting business effects', async t => {
  const f = fixture(t), host = await f.start({ tickMs: 60_000 });
  const response = await f.request(host, '/recovery'); assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.scope, 'maintenance-journal'); assert.deepEqual(state.connection, { state: 'ready', attempts: 0 });
  assert.deepEqual(state.transport, { scope: 'process', pending: 0, accepted: 0, unavailable: false,
    closing: false, ownerExitConfirmed: false });
  assert.equal(state.workerState, 'running'); assert.deepEqual(f.calls, []);
  assert.equal((await f.request(host, '/commands/request:1')).status, 404);
});

test('host binds real HTTP, keeps a private journal and resumes original receipts without readmission', async t => {
  const f = fixture(t), first = await f.start({ tickMs: 60_000 });
  assert.equal((await f.command(first)).status, 202);
  const original = await f.receipt(first);
  assert.equal(statSync(f.options.journalFile).mode & 0o777, 0o600);
  assert.deepEqual(f.calls, [], 'HTTP admission is not an effect');
  await first.close();
  const second = await f.start({ tickMs: 60_000 });
  assert.deepEqual(await f.receipt(second), original);
  assert.equal((await f.command(second)).status, 202);
  assert.deepEqual(await f.receipt(second), original);
  const status = await (await f.request(second, '/status')).json();
  assert.equal(status.workerState, 'running'); assert.equal(status.blocked, true);
  assert.deepEqual(f.calls, []);
});

test('fresh on-disk revocation blocks reads and execution even while Connector would be unavailable', async t => {
  const f = fixture(t), host = await f.start();
  assert.equal((await f.command(host)).status, 202);
  await until(async () => (await f.receipt(host)).stage === 'drain');
  f.tokens.revoke(f.owner.record.id);
  assert.equal((await f.request(host, '/status')).status, 403);
  assert.equal((await f.request(host, '/commands/request:1')).status, 403);
  const db = new DatabaseSync(f.options.journalFile, { readOnly: true }), journal = new MaintenanceReceiptReader(db);
  try { await until(() => journal.unresolved('node:1')?.reason === 'authorization_changed'); }
  finally { db.close(); }
  assert.deepEqual(f.calls, ['prepare']);
});

test('close waits for an in-flight effect, persists its result, and reopening does not replay it', async t => {
  const f = fixture(t);
  let complete!: () => void, entered = false;
  const held = new Promise<void>(resolve => { complete = resolve; });
  f.adapter.prepare = async () => { entered = true; f.calls.push('prepare'); await held; return release; };
  const host = await f.start();
  try {
    assert.equal((await f.command(host)).status, 202);
    await until(() => entered);
    let closed = false;
    const closing = host.close().then(() => { closed = true; });
    await delay(80); assert.equal(closed, false);
    complete(); await closing;
  } finally { complete(); }
  const next = await f.start({ tickMs: 60_000 });
  assert.equal((await f.receipt(next)).stage, 'drain');
  assert.equal((await f.receipt(next)).executing, undefined);
  assert.deepEqual(f.calls, ['prepare']);
});

test('host close exposes exact original pending attempt, including concurrent callers', async t => {
  const f = fixture(t), host = await f.start({ tickMs: 60_000 });
  const original = host.close();
  assert.equal(host.close(), original);
  await original;
  assert.equal(host.close.snapshot().state, 'closed');
});

test('listener refusal fences submissions and explicit close retry drains the same host', async t => {
  const f = fixture(t), host = await f.start({ tickMs: 60_000 });
  const nativeClose = Server.prototype.close;
  let refusals = 0;
  Server.prototype.close = function (...args: Parameters<Server['close']>) {
    const address = this.address();
    if (address && typeof address !== 'string' && address.port === host.port && refusals++ === 0) {
      throw Error('private-listener-refusal');
    }
    return Reflect.apply(nativeClose, this, args);
  };
  try {
    await assert.rejects(host.close());
    assert.equal(host.close.snapshot().state, 'cleanup-required');
    assert.equal((await f.command(host)).status, 503);
    const recoveryResponse = await f.request(host, '/recovery');
    assert.equal(recoveryResponse.status, 200);
    const recovery = await recoveryResponse.json();
    assert.equal(recovery.workerState, 'stopping');
    assert.equal(recovery.transport.closing, false, 'listener refusal retains the original readable journal');
    assert.deepEqual(f.calls, []);
  } finally {
    Server.prototype.close = nativeClose;
    await host.close();
  }
  assert.equal(host.close.snapshot().state, 'closed');
  const next = await f.start({ tickMs: 60_000 });
  assert.equal((await f.request(next, '/commands/request:1')).status, 404);
  assert.deepEqual(f.calls, []);
});

test('persisted unknown effects are visible and never automatically invoked after host reopen', async t => {
  const f = fixture(t), first = await f.start({ tickMs: 60_000 });
  await f.command(first);
  const job = await f.receipt(first);
  await first.close();
  const db = new DatabaseSync(f.options.journalFile), journal = new SqliteMaintenanceJournal(db);
  assert.equal(await journal.compareAndSwap(job, { ...job, executing: true, revision: 1 }), true);
  db.close();
  const next = await f.start();
  await delay(180);
  assert.equal((await f.receipt(next)).executing, true);
  assert.equal((await f.command(next, 'request:2')).status, 409);
  assert.deepEqual(f.calls, []);
});

test('bind failure cleans up and caller policy mutations cannot redirect an admitted host', async t => {
  const f = fixture(t), first = await f.start({ tickMs: 60_000 });
  await assert.rejects(f.start({ port: first.port }), /configuration or storage is unavailable/);
  assert.equal((await f.request(first, '/status')).status, 200);
  f.options.operations.push('upgrade');
  f.options.nodeId = 'node:replacement'; f.options.tokenFile = join(f.directory, 'missing');
  assert.equal((await f.request(first, '/commands', { commandKey: 'request:1', operation: 'upgrade' })).status, 400);
  assert.equal((await f.command(first)).status, 202);
});

test('unsafe storage paths, links and public journal permissions fail before listening', async t => {
  const f = fixture(t);
  await assert.rejects(f.start({ journalFile: join(f.runtime, 'journal.sqlite') }));
  await assert.rejects(f.start({ protectedRoots: [f.directory] }));
  chmodSync(f.journalDirectory, 0o755);
  await assert.rejects(f.start());
  chmodSync(f.journalDirectory, 0o700);
  const target = join(f.directory, 'target'); writeFileSync(target, '', { mode: 0o600 });
  symlinkSync(target, f.options.journalFile);
  await assert.rejects(f.start()); rmSync(f.options.journalFile);
  linkSync(target, f.options.journalFile);
  await assert.rejects(f.start()); rmSync(f.options.journalFile);
  writeFileSync(f.options.journalFile, '', { mode: 0o644 });
  chmodSync(f.options.journalFile, 0o644); // Do not depend on the runner's private umask.
  await assert.rejects(f.start());
  chmodSync(f.options.journalFile, 0o600);
  const host = await f.start();
  assert.equal((await f.request(host, '/status')).status, 200);
});

test('a journal fault halts automatic ticks and rejects new work without exposing diagnostics', async t => {
  const f = fixture(t), host = await f.start();
  const db = new DatabaseSync(f.options.journalFile);
  db.exec('DROP TABLE connector_maintenance_jobs');
  await until(() => host.workerFailed);
  const response = await f.command(host);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Maintenance worker is not running; inspect the existing receipt' });
  // Repairing storage externally must not silently resume the worker.
  new SqliteMaintenanceJournal(db); db.close();
  const status = await (await f.request(host, '/status')).json();
  assert.equal(status.workerState, 'halted');
  await delay(100); assert.deepEqual(f.calls, []);
});

for (const fault of ['start', 'clock', 'sink', 'add', 'add-getter', 'finish', 'finish-getter'] as const) {
  test('host halt '+fault+' observation failure retains receipts and never restarts effects', async t => {
    const f=fixture(t), start=performanceDiagnostics.start.bind(performanceDiagnostics);
    let armed=false, ticks=0, observations=0;
    t.mock.method(performanceDiagnostics,'start',(operation: Parameters<PerformanceDiagnostics['start']>[0])=>{
      if(operation!=='maintenance-host-halt') return start(operation);
      observations++;
      if(fault==='start') throw Error('private-halt-start');
      if(fault==='clock'||fault==='sink') {
        const diagnostic=new PerformanceDiagnostics(()=>{if(fault==='sink') throw Error('private-halt-sink');},
          ()=>{if(fault==='clock') throw Error('private-halt-clock'); return 1;});
        return diagnostic.start(operation);
      }
      return {
        get add(){if(fault==='add-getter') throw Error('private-halt-add-getter');
          return ()=>{if(fault==='add') throw Error('private-halt-add');};},
        reportPending(){},
        get finish(){if(fault==='finish-getter') throw Error('private-halt-finish-getter');
          return ()=>{if(fault==='finish') throw Error('private-halt-finish');};},
      };
    });
    t.mock.method(MaintenanceSupervisor.prototype,'tick',async()=>{if(!armed)return;ticks++; throw Error('private-original-tick-failure');});
    const host=await f.start({tickMs:50});
    assert.equal((await f.command(host)).status,202);
    const original=await f.receipt(host);
    armed=true;
    await until(()=>host.workerFailed);
    assert.equal(observations,1); assert.equal(ticks,1);
    assert.equal((await f.command(host,'request:2')).status,503);
    assert.deepEqual(await f.receipt(host),original);
    assert.equal((await (await f.request(host,'/status')).json()).workerState,'halted');
    await delay(110); assert.equal(ticks,1); assert.deepEqual(f.calls,[]);
  });
}

test('halted/stopping API keeps original receipts readable and exposes worker state', async t => {
  const f = fixture(t), host = await f.start({ tickMs: 60_000 });
  await f.command(host); await host.close();
  const db = new DatabaseSync(f.options.journalFile);
  try {
    const supervisor = new MaintenanceSupervisor(new SqliteMaintenanceJournal(db), f.adapter, async () => true,
      { nodeId: 'node:1', operations: ['restart'] });
    for (const state of ['halted', 'stopping'] as const) {
      const app = createMaintenanceApp({ supervisor, tokens: () => new ConnectorTokenStore(f.options.tokenFile), workerState: () => state });
      const headers = { authorization: `Bearer ${f.owner.token}`, [EXPECTED_NODE_HEADER]: 'node:1', [MAINTENANCE_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' };
      assert.equal((await app.request(`${MAINTENANCE_API}/commands/request:1`, { headers })).status, 200);
      assert.equal((await (await app.request(`${MAINTENANCE_API}/status`, { headers })).json()).workerState, state);
      assert.equal((await app.request(`${MAINTENANCE_API}/commands`, { headers, method: 'POST',
        body: JSON.stringify({ commandKey: 'request:2', operation: 'restart' }) })).status, 503);
    }
  } finally { db.close(); }
});
