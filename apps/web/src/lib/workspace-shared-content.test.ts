import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {sharedCard,editableSharedCard,sharedDraft,sharedPending,sharedPendingWarning,validSharedHead,validMigrationTermination,validWriteTermination,sharedRecoveryCopy,updateSharedTask,sharedOverviewSuffix} from './workspace-shared-content.js';
test('only notebook gates request hot overview; partial projections are never full recovery exports',()=>{
  assert.equal(sharedOverviewSuffix('["notebook","hub:default"]'),'?view=hot');
  assert.equal(sharedOverviewSuffix('["taskboard","default"]'),'');
  assert.equal(sharedOverviewSuffix('invalid'),'');
  const snapshot={enabled:false,head:null,native:{kind:'notebook' as const,content:{title:'Note',text:'hot'},revision:2},bindings:[],nativeView:'hot' as const};
  assert.equal(sharedRecoveryCopy(undefined,snapshot),undefined);
  const base={epoch:randomUUID(),revision:0,hash:'a'.repeat(64),content:'full shared document'};
  assert.equal(sharedRecoveryCopy(undefined,{...snapshot,head:base})?.text,base.content);
  assert.equal(sharedRecoveryCopy({base,text:'local draft'},snapshot)?.text,'local draft');
});
test('write recovery proof must match exact epoch, request and canonical resource',()=>{
  const id=randomUUID(),epoch=randomUUID(),resource='["notebook","hub:default"]';
  const intent=sharedPending(JSON.stringify({id,kind:'write',original:`/writes/${epoch}/${id}`}))!;
  const proof={mutationId:id,resource,epoch,state:'not-executed'};
  assert.equal(validWriteTermination(proof,intent,resource),true);
  for(const bad of [null,{}, {...proof,epoch:randomUUID()}, {...proof,resource:'other'}, {...proof,mutationId:randomUUID()}, {...proof,state:'committed'}])assert.equal(validWriteTermination(bad,intent,resource),false);
  assert.equal(validWriteTermination(proof,{...intent,kind:'migration'},resource),false);
});
test('independent recovery copy prioritizes exact local draft, including malformed JSON',()=>{
  const content=JSON.stringify({kind:'notebook',content:{title:'Note',text:'saved'}}),base={epoch:randomUUID(),revision:0,hash:'a'.repeat(64),content};
  const snapshot={enabled:true,head:base,native:null,bindings:[]};
  assert.deepEqual(sharedRecoveryCopy({base,text:'unfinished {'},snapshot),{text:'unfinished {',filename:'agentopsdeck-local-draft.json'});
  assert.equal(sharedRecoveryCopy(undefined,snapshot)?.text,content);
  assert.equal(sharedRecoveryCopy(undefined,undefined),undefined);
  const native={kind:'notebook' as const,content:{title:'Native',text:'read'},revision:2};
  assert.equal(sharedRecoveryCopy(undefined,{...snapshot,head:null,native})?.text,JSON.stringify(native));
});
test('editing unlock requires exact request, resource and authoritative termination state',()=>{
  const id=randomUUID(),resource=JSON.stringify(['notebook','hub:'+randomUUID()]);
  const proof={mutationId:id,resource,state:'not-executed'};
  assert.equal(validMigrationTermination(proof,id,resource),true);
  for(const value of [null,{}, {...proof,mutationId:randomUUID()}, {...proof,resource:'other'}, {...proof,state:'unknown'}, {...proof,state:'committed'}])
    assert.equal(validMigrationTermination(value,id,resource),false);
  assert.equal(validMigrationTermination(proof,id,'bad-json'),false);
  assert.equal(validMigrationTermination({mutationId:id,resource:'["taskboard","default"]',state:'not-executed'},id,'["statuscard","default"]'),true);
});
test('shared editor retains empty title drafts without allowing invalid saves',()=>{
  const text=JSON.stringify({kind:'notebook',content:{title:'',text:'draft'}});
  assert.equal(sharedCard(text),undefined);assert.equal(editableSharedCard(text)?.content.title,'');
  assert.equal(editableSharedCard('{'),undefined);assert.equal(editableSharedCard('{"kind":"taskboard","content":{"title":"x","tasks":[null]}}'),undefined);
});
test('shared task edits retain identity and unedited metadata',()=>{
  const id=randomUUID(),card=sharedCard(JSON.stringify({kind:'taskboard',content:{title:'Board',tasks:[{id,title:'Task',detail:'d',status:'todo',tags:['x'],priority:'high',dueDate:'2026-10-08'}]}}))!;
  const next=updateSharedTask(card,id,{title:''});assert.equal(sharedCard(JSON.stringify(next)),undefined);
  assert.ok(editableSharedCard(JSON.stringify(next)));assert.equal(card.content.title,'Board');
  if(next.kind!=='taskboard')assert.fail();assert.deepEqual(next.content.tasks[0],{id,title:'',detail:'d',status:'todo',tags:['x'],priority:'high',dueDate:'2026-10-08'});
  assert.throws(()=>updateSharedTask(card,id,{id:randomUUID()}),/task-field/);
});
test('stored pending lookup must exactly name original ID and kind',()=>{
  const id=randomUUID(),epoch=randomUUID(),binding=randomUUID();
  for(const [kind,original] of [['migration',`/migrations/${id}`],['write',`/writes/${epoch}/${id}`],['binding',`/bindings/${id}`],['resolution',`/bindings/${binding}/proposals/${id}`]]){
    assert.ok(sharedPending(JSON.stringify({id,kind,original})));
    assert.equal(sharedPending(JSON.stringify({id:randomUUID(),kind,original})),undefined);
    assert.equal(sharedPending(JSON.stringify({id,kind,original:original+'?x=y'})),undefined);
  }
  assert.equal(sharedPending(JSON.stringify({id,kind:'binding',original:`/migrations/${id}`})),undefined);
});
test('restored draft has valid base and bounded text, malformed data fails closed',()=>{
  const content=JSON.stringify({kind:'notebook',content:{title:'Note',text:'base'}}),base={epoch:randomUUID(),revision:0,hash:createHash('sha256').update(content).digest('hex'),content};
  assert.ok(validSharedHead(base));assert.ok(sharedDraft(JSON.stringify({base,text:'incomplete {'})));
  assert.equal(sharedDraft(JSON.stringify({base,text:'x'.repeat(2*1024*1024+1)})),undefined);
  assert.equal(validSharedHead({...base,revision:-1}),false);assert.equal(sharedDraft('{'),undefined);
});
test('hiding a warning preserves the exact pending intent across refresh and restore',()=>{
  const id=randomUUID(),epoch=randomUUID(),binding=randomUUID();
  for(const [kind,original] of [['migration',`/migrations/${id}`],['write',`/writes/${epoch}/${id}`],['binding',`/bindings/${id}`],['resolution',`/bindings/${binding}/proposals/${id}`]]){
    const intent=sharedPending(JSON.stringify({id,kind,original}))!;
    const hidden=sharedPendingWarning(intent,true);
    assert.deepEqual(hidden,{...intent,warningDismissed:true});
    assert.deepEqual(sharedPending(JSON.stringify(hidden)),hidden);
    assert.deepEqual(sharedPendingWarning(hidden,false),intent);
    assert.deepEqual(sharedPendingWarning(hidden,true),hidden);
    assert.equal(intent.warningDismissed,undefined);
    assert.equal(sharedPending(JSON.stringify({...hidden,id:randomUUID()})),undefined);
    assert.equal(sharedPending(JSON.stringify({...intent,warningDismissed:'true'})),undefined);
  }
});
