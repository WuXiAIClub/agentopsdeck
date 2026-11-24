import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { QuickChatStore } from './quick-chat-store.js';
import { QuickChatService } from './quick-chat-service.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const secret = 'PRIVATE-DIAGNOSTIC-FIXTURE';
const config = { url: 'https://provider.invalid/v1/responses', model: 'fixture', token: secret, users: ['alice', 'bob', 'carol'] };
const completed = () => new Response(JSON.stringify({ status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:secret}]}] }), {headers:{'content-type':'application/json'}});
const profile = { id:'fixture-profile',name:secret,target:'hub-standalone',model:'fixture',outputLimit:100 };
for (const failure of ['transport','response','parse','durable','none'] as const) {
  for (const sinkFails of [false,true]) test(`original chat settlement logs ${failure}, sink failure=${sinkFails}, without replay or public secrets`, async () => {
    const db = new DatabaseSync(':memory:'), lines: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => { if (sinkFails) throw Error(secret); lines.push(line); }, () => 0);
    const store = new QuickChatStore(db,Date.now,Buffer.alloc(32,1));
    if (failure === 'durable') store.complete = () => { throw Error(secret); };
    let calls = 0;
    const service = new QuickChatService(store,config,async () => {
      calls++;
      if (failure === 'transport') throw Error(secret);
      if (failure === 'response') return new Response(secret,{status:503});
      if (failure === 'parse') return new Response(secret,{headers:{'content-type':'application/json'}});
      return completed();
    },1000,{diagnostics});
    try {
      service.saveProfile('alice',0,profile);
      const id = randomUUID(), result = await service.send('alice',id,profile.id,1,secret,() => true);
      assert.equal(result.receipt.state,failure === 'none' ? 'completed' : 'unknown');
      assert.equal((await service.send('alice',id,profile.id,1,secret,() => true)).receipt.state,result.receipt.state);
      assert.equal(calls,1);
      const events = diagnostics.snapshot().events.filter(e => e.operation === 'hub-quick-chat' && e.phase === 'finished');
      if (failure === 'none') {
        // Routine success can be omitted from the bounded recovery snapshot.
        if (!sinkFails) assert.ok(lines.some(l => { const e = JSON.parse(l); return e.operation === 'hub-quick-chat' && e.step === 15 && e.settled === 1; }));
      } else {
        assert.equal(events.length,1);
        assert.equal(events[0]!.unknown,1);
        assert.equal(events[0]!.step, failure === 'transport' ? 12 : failure === 'response' ? 13 : failure === 'parse' ? 14 : 15);
      }
      assert.doesNotMatch(JSON.stringify([lines,diagnostics.snapshot()]),new RegExp(secret+'|provider.invalid|'+id));
      assert.equal(db.isTransaction,false);
    } finally { service.close(); db.close(); }
  });
}

test('expiry sweep failure is logged without changing UNKNOWN or suppressing the next sweep', t => {
  t.mock.timers.enable({apis:['setInterval']});
  const db = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {},() => 0);
  const store = new QuickChatStore(db,Date.now,Buffer.alloc(32,1)), original = store.purgeExpired.bind(store);
  let sweeps = 0;
  store.purgeExpired = () => { sweeps++; if (sweeps === 2) throw Error(secret); original(); };
  const service = new QuickChatService(store,config,fetch,1000,{diagnostics});
  try {
    service.saveProfile('alice',0,profile);
    const id = randomUUID(), capability = {ephemeralRequest:true,noPersistentThread:true,originalLookup:true,maxOutput:100,epoch:'fixture'};
    store.admit('alice',id,profile.id,1,secret,capability,() => true);
    store.claim('alice',id,secret,capability,() => true);
    t.mock.timers.tick(60_000);
    const events = diagnostics.snapshot().events.filter(e => e.operation === 'hub-quick-chat' && e.step === 16);
    assert.equal(events.length,1); assert.equal(events[0]!.unknown,1);
    t.mock.timers.tick(60_000); assert.equal(sweeps,3);
    assert.equal(store.receipt('alice',id)!.state,'unknown');
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()),new RegExp(secret));
  } finally { service.close(); t.mock.timers.reset(); db.close(); }
});

test('ignored provider cancellation logs pending work but cannot free a provider slot', {timeout:3000}, async () => {
  const db = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {},() => 0);
  const store = new QuickChatStore(db,Date.now,Buffer.alloc(32,1)), settle: Array<(r:Response)=>void> = [];
  let calls = 0;
  const service = new QuickChatService(store,config,async () => { calls++; return new Promise<Response>(r => settle.push(r)); },10,{diagnostics});
  const keepAlive = setInterval(() => {},20);
  try {
    for (const owner of config.users) service.saveProfile(owner,0,profile);
    const ids = [randomUUID(),randomUUID()];
    const results = await Promise.all(ids.map((id,i) => service.send(config.users[i]!,id,profile.id,1,secret,() => true)));
    assert.ok(results.every(r => r.receipt.state === 'unknown'));
    const pending = diagnostics.snapshot().events.filter(e => e.operation === 'hub-quick-chat' && e.phase === 'pending');
    assert.equal(pending.length,2); assert.ok(pending.every(e => e.pending === 1 && e.unknown === 1 && e.cancelled === 1));
    await assert.rejects(service.send('carol',randomUUID(),profile.id,1,secret,() => true),/provider-capacity/);
    assert.equal(calls,2);
    for (const resolve of settle) resolve(completed());
    await new Promise<void>(r => setImmediate(r));
    assert.ok(ids.every((id,i) => store.receipt(config.users[i]!,id)!.state === 'unknown'));
    const final = diagnostics.snapshot().events.filter(e => e.operation === 'hub-quick-chat' && e.phase === 'finished');
    assert.equal(final.length,2); assert.ok(final.every(e => e.unknown === 1 && e.cancelled === 1));
  } finally { for (const resolve of settle) resolve(completed()); clearInterval(keepAlive); service.close(); await new Promise<void>(r => setImmediate(r)); db.close(); }
});
