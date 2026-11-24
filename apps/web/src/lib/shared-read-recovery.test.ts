import assert from 'node:assert/strict';
import test from 'node:test';
import {sharedReadRecovery} from './shared-read-recovery.js';
function fixture(read:()=>Promise<void>){
  let time=0,online=true,id=0;
  const timers=new Map<number,{fn:()=>void;at:number}>();
  const recovery=sharedReadRecovery({read,online:()=>online,now:()=>time,random:()=>0,
    schedule:(fn,ms)=>{const token=++id;timers.set(token,{fn,at:time+ms});return token as unknown as ReturnType<typeof setTimeout>;},
    cancel:token=>{timers.delete(token as unknown as number);}});
  return {recovery,timers,setOnline:(v:boolean)=>{online=v;},async step(){const [token,timer]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0]!;time=timer.at;timers.delete(token);timer.fn();for(let i=0;i<10;i++)await Promise.resolve();},next:()=>Math.min(...[...timers.values()].map(t=>t.at))-time};
}
test('transient failures retry quickly; success returns to bounded idle reads',async()=>{
  let reads=0;const f=fixture(async()=>{if(++reads<=2)throw Error('offline');});
  await f.step();assert.equal(f.next(),1500);await f.step();assert.equal(f.next(),3000);await f.step();assert.equal(f.next(),15000);assert.equal(reads,3);f.recovery.stop();assert.equal(f.timers.size,0);
});
test('focus/online wakeups coalesce and cannot bypass Retry-After',async()=>{
  let reads=0;const f=fixture(async()=>{reads++;throw {retryAfterMs:30000};});
  await f.step();for(let i=0;i<20;i++)f.recovery.wake();assert.equal(f.timers.size,1);assert.equal(f.next(),30000);await f.step();assert.equal(reads,2);f.recovery.stop();
});
test('offline reads pause, stop cancels timers and in-flight completion never schedules again',async()=>{
  let reads=0,release!:()=>void;const f=fixture(async()=>{reads++;await new Promise<void>(r=>{release=r;});});
  f.setOnline(false);await f.step();assert.equal(reads,0);f.setOnline(true);f.recovery.wake();await f.step();assert.equal(reads,1);
  for(let i=0;i<5;i++)f.recovery.wake();assert.equal(f.timers.size,0);f.recovery.stop();release();for(let i=0;i<5;i++)await Promise.resolve();assert.equal(f.timers.size,0);
});
