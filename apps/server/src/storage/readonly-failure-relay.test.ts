import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { chmodSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubDeliveryReader } from '../hub/async-delivery-reader.js';
import { AsyncSqliteAuthDisplay } from '../auth/async-sqlite-display.js';
import { createReadonlyFailureReceiver } from './readonly-failure-relay.js';
import { reportReadonlySqlOwnerFailure } from './readonly-sql-owner-diagnostics.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
for (const owner of ['auth','hub'] as const) for (const phase of [0,1,2])
test(`${owner} phase ${phase} notice joins parent diagnostics without authority metrics`, () => {
  const diagnostics = new PerformanceDiagnostics(() => {}, () => 0), step = (owner === 'auth' ? 1 : 4) + phase;
  const receive = createReadonlyFailureReceiver(owner,diagnostics);
  assert.equal(receive({kind:'readonly-owner-failure',step,sqlErrorCode:10,ownerFailureCode:7}),true);
  const row = diagnostics.snapshot().events[0]!;
  assert.equal(row.step,step); assert.equal(row.sqlErrorCode,10); assert.equal(row.ownerFailureCode,7);
  assert.equal(row.unknown,phase === 2 ? 1 : undefined);
  assert.equal(row.settled,undefined); assert.equal(row.recovered,undefined);
});

const invalid: unknown[] = [null, [], {kind:'readonly-owner-failure'}, {kind:'readonly-owner-failure',step:1},
  {kind:'readonly-owner-failure',step:4,sqlErrorCode:undefined}, {kind:'readonly-owner-failure',step:4,sqlErrorCode:NaN},
  {kind:'readonly-owner-failure',step:4,sqlErrorCode:0}, {kind:'readonly-owner-failure',step:4,sqlErrorCode:65536},
  {kind:'readonly-owner-failure',step:4,ownerFailureCode:0}, {kind:'readonly-owner-failure',step:4,ownerFailureCode:10},
  {kind:'readonly-owner-failure',step:4,id:1}, {kind:'readonly-owner-failure',step:4,private:'PRIVATE_PATH_TOKEN'},
  {kind:'readonly-owner-failure',step:4,[Symbol('private')]:1}];
for (const [index,value] of invalid.entries()) test(`malformed notice ${index} cannot bypass normal reply validation`, () => {
  const diagnostics = new PerformanceDiagnostics(() => {});
  assert.equal(createReadonlyFailureReceiver('hub',diagnostics)(value),false);
  assert.deepEqual(diagnostics.snapshot().events,[]);
});

test('notice validation never invokes accessor or Proxy traps', () => {
  let calls = 0;
  const receive = createReadonlyFailureReceiver('hub',new PerformanceDiagnostics(() => {}));
  assert.equal(receive({get kind() { calls++; return 'readonly-owner-failure'; },step:4}),false);
  assert.equal(receive(new Proxy({}, {ownKeys() { calls++; throw Error(); }})),false);
  assert.equal(calls,0);
});

test('notice amplification has a per-original-worker budget without retiring the owner', () => {
  const diagnostics = new PerformanceDiagnostics(() => {}, () => 0), receive = createReadonlyFailureReceiver('hub',diagnostics);
  for(let i=0;i<100;i++) assert.equal(receive({kind:'readonly-owner-failure',step:4}),true);
  assert.equal(diagnostics.snapshot().events.length,16);
  assert.ok(diagnostics.snapshot().events.every(row => row.classificationUnknown === 1));
});

test('relay is best effort, strips exception data and is independent of a broken child clock', () => {
  const notices: unknown[] = [];
  reportReadonlySqlOwnerFailure('hub','open',Object.assign(Error('PRIVATE_PATH_TOKEN'),{code:'ERR_SQLITE_ERROR',errcode:10}),
    new PerformanceDiagnostics(() => { throw Error(); }, () => { throw Error(); }), 'database-open', notice => { notices.push(notice); throw Error(); });
  assert.deepEqual(notices,[{kind:'readonly-owner-failure',step:4,sqlErrorCode:10,ownerFailureCode:4}]);
  assert.equal(JSON.stringify(notices).includes('PRIVATE_PATH_TOKEN'),false);
});

class FakeWorker extends EventEmitter {
  messages: {kind:string; id:number}[] = [];
  postMessage(message: {kind:string;id:number}) { this.messages.push(message); }
  terminate() { return new Promise<number>(() => {}); }
}
for (const owner of ['auth','hub'] as const)
test(`${owner} parent telemetry cannot settle a read, acknowledge close or certify actual exit`, async () => {
  const worker = new FakeWorker(), diagnostics = new PerformanceDiagnostics(() => {}, () => 0);
  const reader = owner === 'hub' ? new AsyncHubDeliveryReader({file:'unused',dev:1,ino:1},diagnostics,() => worker as unknown as Worker)
    : new AsyncSqliteAuthDisplay({file:'unused',dev:1,ino:1},diagnostics,() => worker as unknown as Worker);
  worker.emit('message',{kind:'ready'});
  let settled = false;
  const read = (reader instanceof AsyncHubDeliveryReader ? reader.read({owner:'default',domains:[]}) : reader.read('status'))
    .then(() => { settled=true; });
  await turn(); const request = worker.messages[0]!;
  worker.emit('message',{kind:'readonly-owner-failure',step:owner === 'hub' ? 6 : 3,ownerFailureCode:9});
  let closed = false; const close = reader.close().then(() => { closed=true; });
  await turn(); assert.equal(settled,false); assert.equal(closed,false);
  assert.deepEqual(reader.recoveryState,{unavailable:false,exitConfirmed:false});
  assert.equal(worker.messages.length,1);
  worker.emit('message',{id:request.id,kind:request.kind,ok:true,value:owner === 'hub'
    ? {reset:false,cursor:undefined,events:[]} : {available:false,count:0}});
  await read; await turn(); const closing = worker.messages.at(-1)!;
  assert.equal(closing.kind,'close');
  worker.emit('message',{id:closing.id,kind:'close',ok:true}); await turn(); assert.equal(closed,false);
  worker.emit('exit',0); await close; assert.equal(closed,true);
});

for (const owner of ['auth','hub'] as const)
test(`real ${owner} startup identity refusal is queryable in the parent without a second writer`, async () => {
  const dir = mkdtempSync(join(tmpdir(),'agentopsdeck-readonly-parent-failure-')), file=join(dir,'private.sqlite');
  chmodSync(dir,0o700); const db = new DatabaseSync(file); db.exec('CREATE TABLE harmless(n)'); db.close(); chmodSync(file,0o600);
  const stat = lstatSync(file), diagnostics = new PerformanceDiagnostics(() => {}), config = {file,dev:stat.dev,ino:stat.ino+1};
  const reader = owner === 'hub' ? new AsyncHubDeliveryReader(config,diagnostics) : new AsyncSqliteAuthDisplay(config,diagnostics);
  try {
    await assert.rejects(reader instanceof AsyncHubDeliveryReader ? reader.read({owner:'default',domains:[]}) : reader.read('status'));
    await reader.close();
    const row = diagnostics.snapshot().events.find(row => row.operation === 'readonly-sql-owner-failure');
    assert.ok(row); assert.equal(row.step,owner === 'hub' ? 4 : 1); assert.equal(row.classificationUnknown,1);
    if(owner === 'hub') assert.equal(row.ownerFailureCode,1);
    assert.equal(row.settled,undefined); assert.equal(row.recovered,undefined);
    assert.equal(JSON.stringify(diagnostics.snapshot()).includes(dir),false);
  } finally { await reader.close(); rmSync(dir,{recursive:true}); }
});
