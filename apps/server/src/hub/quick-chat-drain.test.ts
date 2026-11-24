import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { QuickChatService } from './quick-chat-service.js';
import { QuickChatStore } from './quick-chat-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';

const config = { url:'https://provider.invalid/v1/responses', model:'model', token:'private-drain-secret', users:['alice'] };
const profile = { id:'profile', name:'Temporary', target:'hub-standalone', model:'model', outputLimit:100 };
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred<T>() { let resolve!: (v:T)=>void; const promise = new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }

for (const mode of ['provider','catalog'] as const) test('Hub drain retains original '+mode+' until real transport and body cleanup settle', async () => {
  const db = new DatabaseSync(':memory:'), logs:string[] = [];
  const diagnostics = new PerformanceDiagnostics(row=>logs.push(JSON.stringify(row)));
  const transport = deferred<Response>(), body = deferred<void>(), dispatched = deferred<void>();
  let calls=0, bodyCancellations=0;
  const store = new QuickChatStore(db,Date.now,Buffer.alloc(32,1));
  const service = new QuickChatService(store,config,async()=>{calls++;dispatched.resolve();return transport.promise;},1_000_000,
    {discoverModels:mode==='catalog',catalogTimeoutMs:1_000_000,diagnostics});
  const id = randomUUID();
  service.saveProfile('alice',0,profile);
  const running = mode==='provider' ? service.send('alice',id,profile.id,1,'private-drain-input',()=>true) : service.catalog('alice',true);
  await dispatched.promise;
  let acknowledged=false;
  const drain = createIndependentDrain([()=>service.close()],'hub-route-drain',diagnostics);
  const closing = drain().then(()=>{acknowledged=true;});
  try {
    await running; await tick();
    assert.equal(acknowledged,false,'HTTP observation ended, not original transport');
    assert.equal(drain.snapshot().pending,1);
    assert.equal(service.close(),service.close(),'one original close acknowledgement');
    assert.equal(service.target('alice'),undefined,'close fences new work');
    if(mode==='provider') assert.equal(store.receipt('alice',id)!.state,'unknown');
    transport.resolve(new Response(new ReadableStream({cancel(){bodyCancellations++;return body.promise;}}),
      {headers:{'content-type':'application/json'}}));
    await tick(); assert.equal(bodyCancellations,1);
    assert.equal(acknowledged,false,'body cancellation is also original work');
    assert.equal(drain.snapshot().pending,1);
    body.resolve(); await closing;
    assert.equal(drain.snapshot().state,'drained'); assert.equal(calls,1);
    if(mode==='provider') assert.equal(store.receipt('alice',id)!.state,'unknown','close never invents provider outcome');
    const closeEvents=diagnostics.snapshot().events.filter(e=>e.operation==='hub-quick-chat'&&e.step===17);
    assert.equal(closeEvents.length,1);assert.equal(closeEvents[0]!.settled,1);
    assert.doesNotMatch(logs.join(''),/private-drain|provider\.invalid|alice/);
  } finally {
    transport.resolve(new Response('{}'));body.resolve();await closing;db.close();
  }
});

for (const mode of ['provider','catalog'] as const) test('original '+mode+' reader cancellation remains owned until the first cleanup settles', async () => {
  const db = new DatabaseSync(':memory:'), store = new QuickChatStore(db,Date.now,Buffer.alloc(32,1));
  const reading = deferred<void>(), cleanup = deferred<void>(); let cancellations = 0;
  const service = new QuickChatService(store,config,async () => new Response(new ReadableStream({
    pull() { reading.resolve(); }, cancel() { cancellations++; return cleanup.promise; }
  }, {highWaterMark:0}), {headers:{'content-type':'application/json'}}),1_000_000,
    {discoverModels:mode==='catalog',diagnostics:new PerformanceDiagnostics(()=>{})});
  const id = randomUUID(); service.saveProfile('alice',0,profile);
  const running = mode==='provider' ? service.send('alice',id,profile.id,1,'input',()=>true) : service.catalog('alice',true);
  await reading.promise;
  let acknowledged = false; const closing = service.close().then(()=>{acknowledged=true;});
  try {
    await running; await tick();
    assert.equal(cancellations,1); assert.equal(acknowledged,false,'a second reader.cancel does not acknowledge the original cleanup');
    if(mode==='provider') assert.equal(store.receipt('alice',id)!.state,'unknown');
    cleanup.resolve(); await closing; assert.equal(acknowledged,true);
  } finally { cleanup.resolve(); await closing; db.close(); }
});

test('reentrant transport close observes published original work rather than an empty owner',async()=>{
  const db=new DatabaseSync(':memory:'),store=new QuickChatStore(db,Date.now,Buffer.alloc(32,1));
  const transport=deferred<Response>(),dispatched=deferred<void>();
  let closeAck:Promise<void>|undefined,closed=false,service:QuickChatService;
  service=new QuickChatService(store,config,async()=>{
    closeAck=service.close();dispatched.resolve();if(closeAck)void closeAck.then(()=>{closed=true;});return transport.promise;
  },1_000_000,{diagnostics:new PerformanceDiagnostics(()=>{throw Error('private observer');})});
  service.saveProfile('alice',0,profile);
  const id=randomUUID(),running=service.send('alice',id,profile.id,1,'input',()=>true);
  try{
    await dispatched.promise;await running;await tick();assert.ok(closeAck instanceof Promise);assert.equal(closed,false);
    transport.resolve(new Response('{}'));await closeAck;assert.equal(closed,true);
    assert.equal(store.receipt('alice',id)!.state,'unknown');
  }finally{transport.resolve(new Response('{}'));await service.close();db.close();}
});

test('close warning reports original UNKNOWN without acknowledging or redispatching it',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const db=new DatabaseSync(':memory:'), store=new QuickChatStore(db,Date.now,Buffer.alloc(32,1));
  const diagnostics=new PerformanceDiagnostics(()=>{},()=>0), transport=deferred<Response>(), dispatched=deferred<void>(); let calls=0;
  const service=new QuickChatService(store,config,async()=>{calls++;dispatched.resolve();return transport.promise;},1_000_000,{diagnostics});
  service.saveProfile('alice',0,profile); const id=randomUUID(), running=service.send('alice',id,profile.id,1,'input',()=>true);
  await dispatched.promise;let acknowledged=false;const closing=service.close().then(()=>{acknowledged=true;});
  try{
    await running;t.mock.timers.tick(30_000);await tick();
    assert.equal(acknowledged,false);assert.equal(calls,1);
    const pending=diagnostics.snapshot().events.filter(e=>e.operation==='hub-quick-chat'&&e.step===17&&e.phase==='pending');
    assert.equal(pending.length,1);assert.equal(pending[0]!.pending,1);assert.equal(pending[0]!.unknown,1);
    assert.equal(store.receipt('alice',id)!.state,'unknown');
    transport.resolve(new Response('{}'));await closing;
    assert.equal(diagnostics.snapshot().events.filter(e=>e.step===17&&e.phase==='finished').length,1);
  }finally{transport.resolve(new Response('{}'));await closing;t.mock.timers.reset();db.close();}
});

test('empty and repeated Quick Chat close acknowledge void and never consult SQL again',async()=>{
  const db=new DatabaseSync(':memory:'),store=new QuickChatStore(db,Date.now,Buffer.alloc(32,1));
  const service=new QuickChatService(store,undefined,fetch,1000,{diagnostics:new PerformanceDiagnostics(()=>{})});
  const first=service.close();db.close();assert.equal(first,service.close());assert.equal(await first,undefined);
});
