import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAppServer} from './app-server.js';
import {RolloutProjection} from './rollout-projection.js';
import {ConnectorUserStore} from '../connector/connector-user-store.js';
import {DeckStore} from '../projection/deck-store.js';
import {RolloutObservationPendingError} from './rollout-reader.js';

function fixture(outcome:'completed'|'failed'|'interrupted'){
  const dir=mkdtempSync(join(tmpdir(),'agentopsdeck-history-io-wait-'));
  const users=new ConnectorUserStore(':memory:'),store=new DeckStore({sessionTitlesFile:join(dir,'titles.json')});
  const codex=new CodexAppServer({enabled:true,command:'must-not-launch',defaultCwd:dir,defaultModel:'fixture',
    approvalPolicy:'never',store,turnQueue:users.turns,executions:users.codexExecutions,authorizeTurn:()=>true,requestTimeoutMs:20});
  const runtime=codex as any,key='codex:synthetic';let release!:()=>void,reads=0,wakes=0,disposals=0;
  const held=new Promise<void>(done=>{release=done;});
  runtime.ensureStarted=async()=>{};runtime.setConnection('synthetic-connection');
  store.upsertSession({sessionKey:key,agentId:'codex',title:'Known',status:'unknown',
    runtime:{turnId:'turn',phase:'running',connection:'connected',sync:'current',lastEventAt:1}});
  store.addMessage({id:'known',sessionKey:key,role:'assistant',text:'Keep visible',createdAt:1});
  runtime.request=async(method:string)=>{
    if(method==='thread/backgroundTerminals/list')return {data:[]};
    assert.equal(method,'thread/read','only reads, never replay or resume');
    return {thread:{id:'synthetic',path:'private-native-path',status:{type:'idle'},turns:[
      {id:'turn',status:outcome,items:[{id:'reply',type:'agentMessage',text:'Recovered'}]},
    ]}};
  };
  runtime.rolloutReader.readSnapshot=async()=>{
    reads++;await held;return new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,
      lines:async function*(){},close:async()=>{disposals++;}}]);
  };
  runtime.turnWorker.wake=()=>{wakes++;};
  return {codex,runtime,users,store,key,release,counts:()=>({reads,wakes,disposals}),async drain(){
    release();await Promise.allSettled([...runtime.rolloutReader.snapshotWaits.keys()]);
  },async close(){release();await codex.close();users.close();rmSync(dir,{recursive:true,force:true});}};
}

for(const outcome of ['completed','failed','interrupted'] as const){
  test(`final ${outcome} history IO timeout preserves execution fencing and recovers after original settlement`,async t=>{
    const f=fixture(outcome);t.after(()=>f.close());
    f.users.codexExecutions.begin(f.key,'command','synthetic-connection');
    f.users.codexExecutions.acknowledge(f.key,'command','synthetic-connection','turn',()=>{});
    f.runtime.handleNotification('turn/completed',{threadId:'synthetic',turn:{id:'turn',status:outcome}});
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.users.codexExecutions.get(f.key)?.sync,'error');assert.equal(f.users.codexExecutions.canStart(f.key),false);
    assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible');assert.equal(f.counts().reads,1);
    f.runtime.reconcileCompletedTurn(f.key,'synthetic',1,'turn',outcome);await f.runtime.completingTurns.get(f.key);
    assert.equal(f.counts().reads,1,'no duplicate IO while original pending');
    await f.drain();assert.equal(f.counts().disposals,1,'late lease never publishes history');
    assert.equal(f.users.codexExecutions.canStart(f.key),false,'settled IO is not execution proof');
    f.runtime.reconcileCompletedTurn(f.key,'synthetic',1,'turn',outcome);await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync,'current');assert.equal(f.counts().reads,2);assert.equal(f.counts().wakes,1);
  });
}

test('fresh history timeout preserves visible messages; only original retirement allows a new snapshot',async t=>{
  const f=fixture('completed');t.after(()=>f.close());
  await assert.rejects(f.codex.refreshSession(f.key,{fresh:true}),/still pending/);
  await assert.rejects(f.codex.refreshSession(f.key,{fresh:true}),/still pending/);assert.equal(f.counts().reads,1);
  assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible');
  await f.drain();assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible');
  await f.codex.refreshSession(f.key,{fresh:true});assert.equal(f.counts().reads,2);
  assert.ok(f.store.getMessages(f.key).some(message=>message.text==='Recovered'));
});

test('final rollout observation consumes only remaining native verification budget and logs safe pending scope',async t=>{
  const f=fixture('completed');t.after(()=>f.close());f.runtime.options.requestTimeoutMs=100;
  f.users.codexExecutions.begin(f.key,'command','synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key,'command','synthetic-connection','turn',()=>{});
  const request=f.runtime.request;
  f.runtime.request=async(method:string)=>{
    if(method==='thread/read')await new Promise(done=>setTimeout(done,30));
    return request(method);
  };
  let budget=0;
  f.runtime.rolloutReader.readProjectedSnapshotWithin=async(_path:unknown,_options:unknown,timeout:number)=>{
    budget=timeout;throw new RolloutObservationPendingError();
  };
  const logs:unknown[][]=[],previous=console.error;console.error=(...args)=>{logs.push(args);};
  try{
    f.runtime.handleNotification('turn/completed',{threadId:'synthetic',turn:{id:'turn',status:'completed'}});
    await f.runtime.completingTurns.get(f.key);
  }finally{console.error=previous;}
  assert.ok(budget>0&&budget<100,'rollout IO must not restart the full verification deadline');
  assert.equal(f.users.codexExecutions.canStart(f.key),false);
  assert.ok(logs.some(args=>JSON.stringify(args).includes('rollout-pending')));
  assert.doesNotMatch(JSON.stringify(logs),/private-native-path/);
});

for(const outcome of ['completed','failed','interrupted'] as const){
  test(`final ${outcome} stalled rollout iteration cannot hang completion, publish late history or unlock execution`,async t=>{
    const f=fixture(outcome);let releaseIteration!:()=>void,reads=0,closes=0;
    const held=new Promise<void>(done=>{releaseIteration=done;});
    t.after(async()=>{releaseIteration();await f.close();});
    f.release();
    f.runtime.rolloutReader.readSnapshot=async()=>{
      reads++;return new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,
        lines:async function*(){await held;yield '';},close:async()=>{closes++;}}]);
    };
    f.users.codexExecutions.begin(f.key,'command','synthetic-connection');
    f.users.codexExecutions.acknowledge(f.key,'command','synthetic-connection','turn',()=>{});
    const logs:unknown[][]=[],previous=console.error;console.error=(...args)=>{logs.push(args);};
    try{
      f.runtime.handleNotification('turn/completed',{threadId:'synthetic',turn:{id:'turn',status:outcome}});
      await f.runtime.completingTurns.get(f.key);
      assert.equal(f.users.codexExecutions.get(f.key)?.sync,'error');
      assert.equal(f.users.codexExecutions.canStart(f.key),false);
      assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible');
      assert.equal(reads,1);assert.equal(closes,0);assert.equal(f.counts().wakes,0);
      assert.ok(logs.some(args=>JSON.stringify(args).includes('history-projection')&&JSON.stringify(args).includes('rollout-pending')));
      assert.doesNotMatch(JSON.stringify(logs),/private-native-path/);
      f.runtime.reconcileCompletedTurn(f.key,'synthetic',1,'turn',outcome);await f.runtime.completingTurns.get(f.key);
      assert.equal(reads,1,'no new iterator while expired original still owns its resource');
      releaseIteration();await f.drain();assert.equal(closes,1);
      assert.equal(f.users.codexExecutions.canStart(f.key),false,'real iterator settlement is not execution proof');
      assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible','late projection cannot publish recovered messages');
      f.runtime.reconcileCompletedTurn(f.key,'synthetic',1,'turn',outcome);await f.runtime.completingTurns.get(f.key);
      assert.equal(reads,2);assert.equal(f.store.getSession(f.key)?.runtime?.sync,'current');
      assert.ok(f.store.getMessages(f.key).some(message=>message.text==='Recovered'));
      assert.equal(f.counts().wakes,1);
    }finally{console.error=previous;releaseIteration();}
  });
}

for(const outcome of ['completed','failed','interrupted'] as const){
  test('fresh '+outcome+' history observes a stalled projection without replacing its iterator or delivering late data',async t=>{
    const f=fixture(outcome);let releaseIteration!:()=>void,reads=0,closes=0;
    const held=new Promise<void>(done=>{releaseIteration=done;});
    t.after(async()=>{releaseIteration();await f.close();});
    f.release();
    f.runtime.rolloutReader.readSnapshot=async()=>{
      reads++;return new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,
        lines:async function*(){await held;yield '';},close:async()=>{closes++;}}]);
    };
    const refresh=f.codex.refreshSession(f.key,{fresh:true});
    const result=await Promise.race([
      refresh.then(()=>({kind:'resolved'}),error=>({kind:'rejected',error})),
      new Promise<{kind:string}>(done=>setTimeout(()=>done({kind:'hung'}),150)),
    ]);
    if(result.kind==='hung'){releaseIteration();await refresh;}
    assert.equal(result.kind,'rejected','history request must stop observing before the original iterator settles');
    assert.ok('error' in result && result.error instanceof RolloutObservationPendingError);
    assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible');
    assert.equal(reads,1);assert.equal(closes,0);assert.equal(f.counts().wakes,0);
    await assert.rejects(f.codex.refreshSession(f.key,{fresh:true}),RolloutObservationPendingError);
    assert.equal(reads,1,'do not replace the still-owned original projection');
    releaseIteration();await f.drain();assert.equal(closes,1);
    assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible','late projection must not publish');
    await f.codex.refreshSession(f.key,{fresh:true});assert.equal(reads,2);
    assert.ok(f.store.getMessages(f.key).some(message=>message.text==='Recovered'));
    assert.equal(f.counts().wakes,0,'display-only history recovery never wakes the send worker');
  });
}

test('fresh interrupted cleanup proof cannot hang the HTTP observer or dispose its active second iterator',async t=>{
  const f=fixture('interrupted');let releaseProof!:()=>void,passes=0,closes=0;
  const held=new Promise<void>(done=>{releaseProof=done;});f.release();
  t.after(async()=>{releaseProof();await f.close();});
  f.runtime.rolloutReader.readSnapshot=async()=>new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,
    lines:async function*(){passes++;if(passes===2)await held;yield '';},close:async()=>{closes++;}}]);
  const refresh=f.codex.refreshSession(f.key,{fresh:true});
  const result=await Promise.race([refresh.then(()=>({kind:'resolved'}),error=>({kind:'rejected',error})),new Promise<{kind:string}>(done=>setTimeout(()=>done({kind:'hung'}),150))]);
  if(result.kind==='hung'){releaseProof();await refresh;}
  assert.equal(result.kind,'rejected','second cleanup iterator must not hang history request');assert.ok('error' in result&&result.error instanceof RolloutObservationPendingError);
  assert.equal(passes,2);assert.equal(closes,0);assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible');assert.equal(f.counts().wakes,0);
  await assert.rejects(f.codex.refreshSession(f.key,{fresh:true}),RolloutObservationPendingError);assert.equal(passes,2);
  releaseProof();await f.drain();assert.equal(closes,1);assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible');
  await f.codex.refreshSession(f.key,{fresh:true});assert.ok(f.store.getMessages(f.key).some(message=>message.text==='Recovered'));assert.equal(f.counts().wakes,0);
});

test('final interrupted second cleanup iteration has bounded observation and cannot release execution protection late',async t=>{
  const f=fixture('interrupted');let releaseProof!:()=>void,passes=0,closes=0,reads=0;
  const held=new Promise<void>(done=>{releaseProof=done;});f.release();t.after(async()=>{releaseProof();await f.close();});
  f.runtime.rolloutReader.readSnapshot=async()=>{reads++;return new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,
    lines:async function*(){passes++;if(passes===2)await held;yield '';},close:async()=>{closes++;}}]);};
  f.users.codexExecutions.begin(f.key,'command','synthetic-connection');f.users.codexExecutions.acknowledge(f.key,'command','synthetic-connection','turn',()=>{});
  f.runtime.handleNotification('turn/completed',{threadId:'synthetic',turn:{id:'turn',status:'interrupted'}});
  const work=f.runtime.completingTurns.get(f.key);
  const result=await Promise.race([work.then(()=>({kind:'settled'})),new Promise<{kind:string}>(done=>setTimeout(()=>done({kind:'hung'}),200))]);
  if(result.kind==='hung'){releaseProof();await work;}
  assert.equal(result.kind,'settled','final observer must not wait forever on cleanup iterator');assert.equal(f.users.codexExecutions.get(f.key)?.sync,'error');
  assert.equal(f.users.codexExecutions.canStart(f.key),false);assert.equal(closes,0);assert.equal(passes,2);assert.equal(f.counts().wakes,0);
  f.runtime.reconcileCompletedTurn(f.key,'synthetic',1,'turn','interrupted');await f.runtime.completingTurns.get(f.key);assert.equal(reads,1);
  releaseProof();await f.drain();assert.equal(closes,1);assert.equal(f.store.getMessages(f.key)[0]?.text,'Keep visible');assert.equal(f.users.codexExecutions.canStart(f.key),false);
  f.runtime.reconcileCompletedTurn(f.key,'synthetic',1,'turn','interrupted');await f.runtime.completingTurns.get(f.key);assert.equal(reads,2);assert.equal(f.store.getSession(f.key)?.runtime?.sync,'current');assert.equal(f.counts().wakes,1);
});
