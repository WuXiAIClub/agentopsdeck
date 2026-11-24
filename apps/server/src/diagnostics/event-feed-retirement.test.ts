import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from './performance.js';

test('routine original feed settlement remains queryable without consuming shutdown reserve', () => {
  const diagnostics = new PerformanceDiagnostics(()=>{},()=>1);
  for(let index=0;index<80;index++) {
    const trace=diagnostics.start('hub-event-broker'); trace.add('step',5); trace.add('settled',1); trace.finish();
  }
  const local=diagnostics.snapshot().events.filter(e=>e.step===5);
  assert.equal(local.length,80); assert.equal(local.filter(e=>e.delivery==='delivered').length,20);
  const drain=diagnostics.start('hub-event-broker'); drain.add('step',4); drain.add('settled',1); drain.finish();
  assert.equal(diagnostics.snapshot().events.at(-1)!.delivery,'delivered');
});

test('feed retirement evidence stays bounded and cannot expose failure bodies', () => {
  const diagnostics=new PerformanceDiagnostics(()=>{throw Error('private-token');},()=>1);
  for(let index=0;index<500;index++) {
    const trace=diagnostics.start('hub-event-broker'); trace.add('step',6); trace.add('deferred',1); trace.finish(true);
  }
  const result=diagnostics.snapshot();
  assert.equal(result.events.length,result.capacity); assert.equal(result.totals.sinkFailures,60);
  assert.doesNotMatch(JSON.stringify(result),/private-token/);
});

test('routine rotation settlement has bounded evidence and separate shutdown reserve', () => {
  const diagnostics = new PerformanceDiagnostics(()=>{},()=>1);
  for(let index=0;index<500;index++) {
    const trace=diagnostics.start('hub-event-broker'); trace.add('step',7); trace.add('settled',1); trace.finish();
  }
  const snapshot=diagnostics.snapshot();
  assert.equal(snapshot.events.length,snapshot.capacity);
  assert.ok(snapshot.events.every(e=>e.step===7));
  const drain=diagnostics.start('hub-event-broker'); drain.add('step',4); drain.add('settled',1); drain.finish();
  assert.equal(diagnostics.snapshot().events.at(-1)!.delivery,'delivered');
});

test('async directory settlement survives routine throttling without spending shutdown reserve', () => {
  const diagnostics = new PerformanceDiagnostics(() => {}, () => 1);
  for (let index = 0; index < 80; index++) {
    const trace = diagnostics.start('hub-event-broker'); trace.add('step', 8); trace.add('settled', 1); trace.finish();
  }
  const rows = diagnostics.snapshot().events.filter(e => e.step === 8);
  assert.equal(rows.length, 80);
  assert.equal(rows.filter(e => e.delivery === 'rate-limited').length, 60);
  const drain = diagnostics.start('hub-event-broker'); drain.add('step', 4); drain.add('settled', 1); drain.finish();
  assert.equal(diagnostics.snapshot().events.at(-1)!.delivery, 'delivered');
});
