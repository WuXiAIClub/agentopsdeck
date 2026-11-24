import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { reportReadonlySqlOwnerFailure } from './readonly-sql-owner-diagnostics.js';
import type { ReadonlyOwnerFailurePoint } from './readonly-sql-owner-diagnostics.js';

const steps = { auth: { open: 1, read: 2, close: 3 }, hub: { open: 4, read: 5, close: 6 } } as const;
const sqlError = () => Object.assign(Error('PRIVATE_SQL_PATH_TOKEN'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });

for (const [fault, code] of [['main', 1], ['directory', 2], ['sidecar', 3]] as const)
test(`real Hub readonly startup identifies ${fault} refusal without weakening identity or leaking paths`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-readonly-identity-point-')), file = join(dir, 'private.sqlite');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE harmless(n)'); db.close();
  const before = readFileSync(file), stat = lstatSync(file), source = import.meta.url.endsWith('.ts');
  let suppliedFile = file, suppliedIno = stat.ino;
  if (fault === 'main') suppliedIno++;
  if (fault === 'directory') { mkdirSync(join(dir, 'sub')); suppliedFile = `${dir}/sub/../private.sqlite`; }
  if (fault === 'sidecar') { const owner = join(dir,'sidecar-owner'); writeFileSync(owner,''); linkSync(owner, `${file}-journal`); }
  const entry = new URL(`../hub/delivery-reader-worker.${source ? 'ts' : 'js'}`, import.meta.url).href;
  const worker = new Worker(`(async () => {
    const { workerData, parentPort } = require('node:worker_threads');
    if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry,workerData.entry); }
    else await import(workerData.entry);
  })().catch(() => { process.exitCode=1; require('node:worker_threads').parentPort.close(); });`, {
    eval:true, execArgv:[], stdout:true, stderr:true, workerData:{file:suppliedFile,dev:stat.dev,ino:suppliedIno,entry,
      loader:source ? import.meta.resolve('tsx/esm/api') : undefined},
  });
  const messages: unknown[] = []; let output = '';
  worker.on('message', message => messages.push(message));
  worker.stdout.on('data', chunk => { output += chunk; }); worker.stderr.on('data', chunk => { output += chunk; });
  const exit = once(worker,'exit'), watchdog = setTimeout(() => { void worker.terminate(); },10_000);
  try {
    assert.equal((await exit)[0],1);
    assert.deepEqual(messages,[{kind:'readonly-owner-failure',step:4,ownerFailureCode:code}]);
    assert.deepEqual(readFileSync(file),before); assert.doesNotMatch(output,/private\.sqlite|agentopsdeck-readonly-identity-point/);
    const rows = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.ok(rows.some(row => row.operation === 'readonly-sql-owner-failure' && row.step === 4
      && row.ownerFailureCode === code && row.classificationUnknown === 1));
    assert.ok(rows.every(row => row.settled === undefined && row.recovered === undefined));
  } finally { clearTimeout(watchdog); await worker.terminate(); rmSync(dir,{recursive:true,force:true}); }
});

for (const [point, code] of Object.entries({ 'main-identity': 1, 'directory-identity': 2, 'sidecar-identity': 3,
  'database-open': 4, 'configure-readonly': 5, protocol: 6, 'snapshot-read': 7, reply: 8, close: 9 }))
test(`readonly failure point ${point} is numeric observation only`, () => {
  const diagnostics = new PerformanceDiagnostics(() => {});
  reportReadonlySqlOwnerFailure('hub', 'open', Error('PRIVATE_SQL_PATH_TOKEN'), diagnostics, point as ReadonlyOwnerFailurePoint);
  const row = diagnostics.snapshot().events[0]!;
  assert.equal(row.ownerFailureCode, code); assert.equal(row.classificationUnknown, 1);
  assert.equal(row.settled, undefined); assert.equal(row.recovered, undefined);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE_SQL_PATH_TOKEN/);
});

for (const owner of ['auth', 'hub'] as const) for (const phase of ['open', 'read', 'close'] as const)
test(`${owner} readonly ${phase} diagnostic is numeric, fixed and not settlement authority`, () => {
  const logs = new PerformanceDiagnostics(() => {});
  reportReadonlySqlOwnerFailure(owner, phase, sqlError(), logs);
  const row = logs.snapshot().events[0]!;
  assert.equal(row.operation, 'readonly-sql-owner-failure'); assert.equal(row.step, steps[owner][phase]);
  assert.equal(row.sqlErrorCode, 10); assert.equal(row.category, 'failed');
  assert.equal(row.unknown, phase === 'close' ? 1 : undefined); assert.equal(row.settled, undefined);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE|SELECT|sqlite|path|token/i);
});

for (const kind of ['getter', 'proxy'] as const)
test(`readonly owner diagnostics never execute ${kind} exception properties`, () => {
  let inspected = 0;
  const error = kind === 'proxy' ? new Proxy({}, {
    get() { inspected++; throw Error('PRIVATE'); }, getOwnPropertyDescriptor() { inspected++; throw Error('PRIVATE'); },
  }) : Object.defineProperties({}, {
    code: { get() { inspected++; return 'ERR_SQLITE_ERROR'; } }, errcode: { get() { inspected++; return 10; } },
  });
  const logs = new PerformanceDiagnostics(() => {});
  assert.doesNotThrow(() => reportReadonlySqlOwnerFailure('auth', 'open', error, logs));
  assert.equal(inspected, 0); assert.equal(logs.snapshot().events[0]!.classificationUnknown, 1);
});

test('readonly owner diagnostics survive sink and trace factory failures', () => {
  const logs = new PerformanceDiagnostics(() => { throw Error('PRIVATE sink'); });
  assert.doesNotThrow(() => reportReadonlySqlOwnerFailure('hub', 'close', sqlError(), logs));
  assert.equal(logs.snapshot().events[0]!.delivery, 'failed');
  const broken = Object.assign(new PerformanceDiagnostics(() => {}), { start() { throw Error('PRIVATE trace'); } });
  assert.doesNotThrow(() => reportReadonlySqlOwnerFailure('auth', 'close', sqlError(), broken));
});

test('ordinary SQL failure traffic does not consume the readonly owner lifecycle budget', () => {
  const lines: string[] = [], logs = new PerformanceDiagnostics(line => lines.push(line), () => 0);
  for (let i = 0; i < 61; i++) logs.start('auth-passkey-read').finish(true);
  reportReadonlySqlOwnerFailure('auth', 'close', sqlError(), logs);
  assert.equal(logs.snapshot().events.at(-1)!.delivery, 'delivered');
  assert.equal(lines.map(line => JSON.parse(line)).at(-1).operation, 'readonly-sql-owner-failure');
});

for (const owner of ['auth', 'hub'] as const) for (const scenario of ['open', 'read', 'close', 'open-close', 'close-repeat'] as const)
{ const phase = scenario === 'open-close' ? 'open' : scenario === 'close-repeat' ? 'close' : scenario;
test(`${owner} real readonly worker ${scenario} failure is logged before sanitized exit`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-readonly-owner-sql-')), file = join(dir, 'private.sqlite');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE harmless(n)'); db.close(); chmodSync(file, 0o600);
  const before = readFileSync(file), { dev, ino } = lstatSync(file), source = import.meta.url.endsWith('.ts');
  const entry = new URL(owner === 'auth' ? `../auth/sqlite-display-worker.${source ? 'ts' : 'js'}`
    : `../hub/delivery-reader-worker.${source ? 'ts' : 'js'}`, import.meta.url).href;
  // Fault injection is isolated to this test worker's original connection.
  // The production worker receives neither callbacks nor an injection flag.
  const worker = new Worker(`(async () => {
    const { workerData, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    if (workerData.scenario === 'open-close' || workerData.scenario === 'close-repeat') {
      DatabaseSync.prototype.close = function() {
        throw Object.assign(Error('PRIVATE_SQL_PATH_TOKEN cleanup'), {code:'ERR_SQLITE_ERROR',errcode:11});
      };
    }
    if (workerData.phase === 'open' || workerData.phase === 'close') {
      const method = workerData.phase === 'open' ? 'exec' : 'close';
      const original = DatabaseSync.prototype[method]; let calls = 0;
      DatabaseSync.prototype[method] = function(...args) {
        if (++calls === 1) throw Object.assign(Error('PRIVATE_SQL_PATH_TOKEN'), {code:'ERR_SQLITE_ERROR',errcode:10});
        return original.apply(this,args);
      };
    }
    if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry,workerData.entry); }
    else await import(workerData.entry);
  })().catch(() => { process.exitCode=1; require('node:worker_threads').parentPort.close(); });`, {
    eval: true, execArgv: [], workerData: { file, dev, ino, entry, phase, scenario,
      loader: source ? import.meta.resolve('tsx/esm/api') : undefined }, stdout: true, stderr: true,
  });
  let output = ''; const messages: { kind?: string }[] = [];
  worker.stdout.on('data', chunk => { output += chunk; }); worker.stderr.on('data', chunk => { output += chunk; });
  const exit = once(worker, 'exit');
  // Test watchdog is not a production recovery or replacement policy.
  const timeout = setTimeout(() => { void worker.terminate(); }, 10_000);
  worker.on('message', message => {
    messages.push(message);
    if (message.kind !== 'ready') return;
    worker.postMessage(phase === 'close' ? {id:1,kind:'close'} : owner === 'auth' ? {id:1,kind:'status'}
      : {id:1,kind:'page',read:{owner:'default',domains:[['node','current']]}});
  });
  try {
    const [code] = await exit; assert.equal(code, 1);
    assert.doesNotMatch(output, /PRIVATE_SQL_PATH_TOKEN/); assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(messages.filter(message => message.kind !== 'readonly-owner-failure'), phase === 'open' ? [] : [{kind:'ready'}]);
    const rows = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.deepEqual(messages.filter(message => message.kind === 'readonly-owner-failure'),
      rows.filter(row => row.operation === 'readonly-sql-owner-failure').map(row => ({kind:'readonly-owner-failure',step:row.step,
        ...(row.sqlErrorCode === undefined ? {} : {sqlErrorCode:row.sqlErrorCode}),
        ...(row.ownerFailureCode === undefined ? {} : {ownerFailureCode:row.ownerFailureCode})})));
    // Hub snapshot diagnostics retain the original SQL code before their
    // sanitized failure reaches the worker's owner-lifecycle catch.
    assert.ok(rows.some(row => row.operation === (owner === 'hub' && phase === 'read'
      ? 'hub-delivery-read' : 'readonly-sql-owner-failure') && row.step === (owner === 'hub' && phase === 'read'
      ? 2 : steps[owner][phase]) && row.sqlErrorCode === (phase === 'read' ? 1 : 10)));
    assert.ok(rows.every(row => row.settled === undefined));
    if (owner === 'hub') assert.ok(rows.some(row => row.operation === 'readonly-sql-owner-failure'
      && row.ownerFailureCode === (phase === 'open' ? 5 : phase === 'close' ? 9 : 7)));
    if (scenario === 'open-close' || scenario === 'close-repeat') {
      assert.ok(rows.some(row => row.operation === 'readonly-sql-owner-failure'
        && row.step === steps[owner].close && row.sqlErrorCode === 11 && row.unknown === 1));
      assert.equal(rows.filter(row => row.operation === 'readonly-sql-owner-failure').length, 2);
    }
  } finally { clearTimeout(timeout); await worker.terminate(); rmSync(dir, {recursive:true,force:true}); }
});
}
