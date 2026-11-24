import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { reportMaintenanceSqlOwnerFailure } from './maintenance-sql-owner-diagnostics.js';

for (const [phase, step] of Object.entries({ open: 1, read: 2, close: 3, command: 4 }))
test(`maintenance SQL ${phase} diagnostic uses a fixed numeric phase without settlement authority`, () => {
  const diagnostics = new PerformanceDiagnostics(() => {});
  reportMaintenanceSqlOwnerFailure(phase as 'open' | 'read' | 'close' | 'command',
    Object.assign(Error('PRIVATE_SQL_TOKEN'), { code: 'ERR_SQLITE_ERROR', errcode: 10 }), diagnostics);
  const row = diagnostics.snapshot().events[0]!;
  assert.equal(row.operation, 'maintenance-sql-owner-failure'); assert.equal(row.step, step);
  assert.equal(row.sqlErrorCode, 10); assert.equal(row.category, 'failed');
  assert.equal(row.unknown, phase === 'close' ? 1 : undefined);
  assert.equal(row.settled, undefined); assert.equal(row.commitMs, undefined);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE_SQL_TOKEN/);
});

for (const form of ['getter', 'proxy'] as const) test(`maintenance diagnostic does not inspect ${form} exception metadata`, () => {
  let inspections = 0;
  const raw = Object.defineProperty(Error('PRIVATE_SQL_TOKEN'), 'errcode', { get() { inspections++; throw Error('PRIVATE_SQL_TOKEN'); } });
  const error = form === 'proxy' ? new Proxy(raw, {
    get() { inspections++; throw Error('PRIVATE_SQL_TOKEN'); },
    getOwnPropertyDescriptor() { inspections++; throw Error('PRIVATE_SQL_TOKEN'); },
  }) : raw;
  const diagnostics = new PerformanceDiagnostics(() => {});
  assert.doesNotThrow(() => reportMaintenanceSqlOwnerFailure('read', error, diagnostics));
  assert.equal(inspections, 0);
  assert.equal(diagnostics.snapshot().events[0]!.classificationUnknown, 1);
});

test('maintenance diagnostic failure cannot propagate into worker cleanup', () => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE_SQL_TOKEN'); });
  assert.doesNotThrow(() => reportMaintenanceSqlOwnerFailure('close', Error('PRIVATE_SQL_TOKEN'), diagnostics));
});

test('maintenance SQL evidence uses bounded database lifecycle reserve, not process closure budget', () => {
  const rows: { operation: string }[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  for (let i = 0; i < 100; i++) diagnostics.start('storage-admission').finish(true);
  for (let i = 0; i < 100; i++) reportMaintenanceSqlOwnerFailure('read', Error('PRIVATE_SQL_TOKEN'), diagnostics);
  assert.equal(rows.filter(row => row.operation === 'maintenance-sql-owner-failure').length, 60);
  diagnostics.start('process-shutdown').finish(true); assert.equal(rows.at(-1)!.operation, 'process-shutdown');
});

for (const scenario of ['open', 'read', 'close', 'open-close', 'close-repeat'] as const)
test(`maintenance original SQL ${scenario} failure is observable without private payload or receipt repair`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-sql-failure-'));
  const file = join(directory, 'journal.sqlite');
  const db = new DatabaseSync(file); db.close(); chmodSync(file, 0o600);
  const before = readFileSync(file), { dev, ino } = lstatSync(file);
  const source = import.meta.url.endsWith('.ts');
  const phase = scenario.startsWith('open') ? 'open' : scenario.startsWith('close') ? 'close' : 'read';
  const worker = new Worker(`(async () => {
    const {workerData,parentPort} = require('node:worker_threads');
    const {DatabaseSync} = require('node:sqlite');
    if (workerData.scenario === 'open-close' || workerData.scenario === 'close-repeat') {
      DatabaseSync.prototype.close = function() {
        throw Object.assign(Error('PRIVATE_SQL_TOKEN cleanup'), {code:'ERR_SQLITE_ERROR',errcode:11});
      };
    }
    if (workerData.phase === 'open' || workerData.phase === 'close') {
      const method = workerData.phase === 'open' ? 'exec' : 'close';
      const original = DatabaseSync.prototype[method]; let calls = 0;
      DatabaseSync.prototype[method] = function(...args) {
        if (++calls === 1) throw Object.assign(Error('PRIVATE_SQL_TOKEN'), {code:'ERR_SQLITE_ERROR',errcode:10});
        return original.apply(this,args);
      };
    }
    if (workerData.loader) {const {tsImport}=await import(workerData.loader);await tsImport(workerData.entry,workerData.entry);}
    else await import(workerData.entry);
  })().catch(() => {process.exitCode=1;require('node:worker_threads').parentPort.close();});`, {
    eval: true, execArgv: [], stdout: true, stderr: true, workerData: { file, dev, ino, readOnly: true, phase, scenario,
      entry: new URL(source ? './maintenance-journal-worker.ts' : './maintenance-journal-worker.js', import.meta.url).href,
      loader: source ? import.meta.resolve('tsx/esm/api') : undefined },
  });
  let output = '';
  const messages: { kind?: string; ok?: boolean }[] = [];
  worker.stdout.on('data', chunk => { output += chunk; }); worker.stderr.on('data', chunk => { output += chunk; });
  const exit = once(worker, 'exit');
  const watchdog = setTimeout(() => { void worker.terminate(); }, 10_000);
  worker.on('message', message => {
    messages.push(message);
    if (message.kind === 'ready') worker.postMessage(phase === 'close'
      ? { id: 1, kind: 'close', args: [] } : { id: 1, kind: 'get', args: ['request:1'] });
  });
  try {
    await exit;
    assert.deepEqual(readFileSync(file), before);
    assert.doesNotMatch(output, /PRIVATE_SQL_TOKEN/);
    const replies = messages.filter(message => message.kind !== 'sql-owner-failure');
    assert.equal(replies.length, phase === 'open' ? 0 : 2);
    if (phase !== 'open') assert.equal(replies[1]!.ok, false);
    const rows = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      .filter(row => row.operation === 'maintenance-sql-owner-failure');
    assert.ok(rows.some(row => row.step === { open: 1, read: 2, close: 3 }[phase]
      && row.sqlErrorCode === (phase === 'read' ? 1 : 10)));
    assert.ok(rows.every(row => row.settled === undefined && row.commitMs === undefined));
    // The final MessagePort close callback runs AFTER the transport closes.
    // Its original cleanup failure remains in stdout, not a fictitious relay.
    const relayRows = scenario === 'close-repeat' ? rows.slice(0, 1) : rows;
    assert.deepEqual(messages.filter(message => message.kind === 'sql-owner-failure'), relayRows.map(row => ({
      kind: 'sql-owner-failure', owner: 'maintenance', step: row.step,
      ...(row.sqlErrorCode === undefined ? {} : { sqlErrorCode: row.sqlErrorCode }),
    })));
    if (scenario === 'open-close' || scenario === 'close-repeat') {
      assert.ok(rows.some(row => row.step === 3 && row.sqlErrorCode === 11 && row.unknown === 1));
      assert.equal(rows.length, 2);
    }
  } finally { clearTimeout(watchdog); await worker.terminate(); rmSync(directory, { recursive: true, force: true }); }
});
