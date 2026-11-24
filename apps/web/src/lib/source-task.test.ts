import assert from 'node:assert/strict';
import test from 'node:test';
import { issueTask,importSourceTask } from './source-task.js';
import { validBoardContent } from '@agentopsdeck/shared';
import type { IssuePageView } from './issue-card.js';
const item:IssuePageView['items'][number]={identity:{provider:'gitlab',origin:'https://example.invalid',connection:'source',project:'1',kind:'issue',remoteId:'2'},sourceKey:'a'.repeat(64),title:'Remote task',state:'closed',url:'https://example.invalid/task/2',body:'Description',updatedAt:1};
test('source import is bounded, stable across edits/reloads, idempotent, and never overwrites task changes',()=>{
  const task=issueTask(item),board={title:'Board',tasks:[]};assert.equal(task.status,'todo');assert.equal(validBoardContent({title:'Board',tasks:[task]}),true);
  const first=importSourceTask(board,task);assert.equal(first.outcome,'applied');
  const changed={...first.board,tasks:[{...task,title:'Local edit',status:'doing' as const}]};
  const second=importSourceTask(JSON.parse(JSON.stringify(changed)),issueTask({...item,title:'Remote edit',body:'new'}));
  assert.equal(second.outcome,'exists');assert.deepEqual(second.board,changed);
  assert.notEqual(issueTask({...item,sourceKey:'b'.repeat(64)}).id,task.id);
  const large=issueTask({...item,title:'x'.repeat(2048),body:'y'.repeat(65536),url:'https://example.invalid/'+ 'z'.repeat(4000)});
  assert.equal(validBoardContent({title:'Board',tasks:[large]}),true);assert.ok(large.detail.includes('truncated'));
});
test('source import refuses capacity, invalid payload, and ID collision without modifying the board',()=>{
  const task=issueTask(item),board={title:'Board',tasks:[{...task,detail:'User task'}]};
  assert.equal(importSourceTask(board,task).outcome,'unavailable');
  assert.equal(importSourceTask({title:'Board',tasks:[]},{...task,title:''}).outcome,'unavailable');
  const full={title:'Board',tasks:Array.from({length:200},(_,i)=>({...task,id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`}))};
  assert.equal(importSourceTask(full,task).outcome,'too-large');assert.equal(full.tasks.length,200);
});
