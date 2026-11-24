import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker, threadId } from 'node:worker_threads';
import { PerformanceDiagnostics } from './performance.js';

test('pending and settled logs retain owner identity and the original epoch start', () => {
  let clock = 100;
  const rows: Record<string, any>[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => clock);
  const trace = d.start('storage-admission-release');
  clock = 125; trace.reportPending({ unknown: 1 });
  clock = 180; trace.add('settled', 1); trace.finish();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.processId, process.pid); assert.equal(row.threadId, threadId);
    assert.equal(row.startedAtUnixMs, Math.floor(performance.timeOrigin + 100));
    assert.equal(row.instance, rows[0]!.instance); assert.equal(row.sequence, rows[0]!.sequence);
  }
  assert.equal(rows[0]!.observedAtUnixMs, Math.floor(performance.timeOrigin + 125));
  assert.equal(rows[1]!.observedAtUnixMs, Math.floor(performance.timeOrigin + 180));
  assert.equal(rows[1]!.elapsedMs, 80);
  assert.deepEqual(d.snapshot().events.map(row => row.processId), [process.pid, process.pid]);
});

test('real worker logs distinguish thread ownership without exposing inputs', async () => {
  const module = new URL(import.meta.url.endsWith('.ts') ? './performance.ts' : './performance.js', import.meta.url).href;
  const worker = new Worker("const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const loaded=workerData.loader?await (await import(workerData.loader)).tsImport(workerData.entry,workerData.entry):await import(workerData.entry);const d=new loaded.PerformanceDiagnostics(line=>parentPort.postMessage(JSON.parse(line)));const t=d.start('storage-coordinator-recovery');t.add('unknown',1);t.finish(true);})().catch(()=>process.exitCode=1);", { eval: true, workerData: { entry: module, loader: import.meta.url.endsWith('.ts') ? import.meta.resolve('tsx/esm/api') : undefined } });
  const id = worker.threadId;
  const rows: Record<string, any>[] = [];
  worker.on('message', row => rows.push(row));
  await new Promise<void>((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('worker failed')));});
  assert.equal(rows.length, 1); assert.equal(rows[0]!.processId, process.pid);
  assert.equal(rows[0]!.threadId, id); assert.notEqual(id, threadId);
  assert.ok(Number.isSafeInteger(rows[0]!.observedAtUnixMs));
  assert.ok(Math.abs(Date.now() - rows[0]!.observedAtUnixMs) < 10000);
  assert.doesNotMatch(JSON.stringify(rows), /file:|workerData|performance\.js/);
});

test('limiter and failing sink preserve timestamped recovery evidence without changing outcomes', () => {
  const d = new PerformanceDiagnostics(() => { throw Error('private-token-and-path'); }, () => 25);
  for (let n = 0; n < 80; n++) d.start('storage-coordinator-recovery').finish(true);
  const events = d.snapshot().events;
  assert.equal(events.length, 80); assert.equal(events.at(-1)?.delivery, 'rate-limited');
  for (const event of events) {
    assert.equal(event.processId, process.pid); assert.equal(event.threadId, threadId);
    assert.ok(Number.isSafeInteger(event.startedAtUnixMs));
  }
  assert.doesNotMatch(JSON.stringify(d.snapshot()), /private-token|private.*path/);
});
