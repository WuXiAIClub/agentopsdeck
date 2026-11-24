import assert from 'node:assert/strict';
import test from 'node:test';
import {readSourceSelection,saveSourceSelection}from'./source-selection.js';
test('source preferences are scoped, bounded metadata only, tolerate invalid/unavailable storage',()=>{
  const values=new Map<string,string>();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v)}});
  const a='a'.repeat(64),b='b'.repeat(64),s={connection:'one',source:'repo'};
  saveSourceSelection(a,'git:a',s);assert.deepEqual(readSourceSelection(a,'git:a'),s);assert.equal(readSourceSelection(a,'git:b'),undefined);assert.equal(readSourceSelection(b,'git:a'),undefined);
  saveSourceSelection(a,'git:bad',{...s,text:'private'} as typeof s);assert.equal(readSourceSelection(a,'git:bad'),undefined);
  for(let i=0;i<65;i++)saveSourceSelection(a,`git:${i}`,s);assert.equal(readSourceSelection(a,'git:a'),undefined);assert.equal(JSON.parse([...values.values()][0]!).length,64);
  values.set(`agentopsdeck.source-selection.v1:${a}`,'bad');assert.equal(readSourceSelection(a,'git:1'),undefined);
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('disabled');}});assert.doesNotThrow(()=>saveSourceSelection(a,'git:a',s));assert.equal(readSourceSelection(a,'git:a'),undefined);Reflect.deleteProperty(globalThis,'localStorage');
});
