'use strict';
const path=require('node:path'),cp=require('node:child_process'),life=require('./lifecycle.cjs'),receipts=require('./startup-receipts.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Manager {
 constructor(options){this.o=options;this.busy=false;}
 async run(action){
  if(!['start','stop','restart'].includes(action))return {code:12,state:'invalid-action'};
  if(this.busy)return {code:11,state:'operation-busy'};
  this.busy=true;let lease;
  try{lease=await life.acquire(path.join(this.o.data,'.desktop-operation'),{open:()=>{}});if(lease.duplicate)return {code:11,state:'operation-busy'};return await this.perform(action);}
  catch{return {code:12,state:'operation-failed'};}
  finally{try{if(lease&&!lease.duplicate){lease.server.close();lease.release();}}finally{this.busy=false;}}
 }
 async observe(observedOwner){
  const o=this.o,owner=observedOwner||await life.status(o.data),receipt=receipts.read(o.data);
  if(owner.code!==0&&owner.code!==10)return {code:11,state:'ownership-unresolved',receipt};
  if(owner.code===10){try{if(await o.ready())return {code:0,state:'running',receipt,ownerRunning:true};}catch{return {code:11,state:'readiness-unconfirmed',receipt,ownerRunning:true};}return {code:11,state:'starting',receipt,ownerRunning:true};}
  if(receipt&&['spawn-failed','monitor-failed'].includes(receipt.phase))return {code:12,state:'start-failed',receipt};
  if(receipt?.phase==='exited'&&receipt.childExit)return {code:receipt.ready?0:12,state:receipt.ready?'stopped':'start-failed',receipt};
  const monitor=await life.status(path.join(o.data,'.desktop-startup'));
  if(monitor.code===10)return {code:11,state:'starting',receipt,monitorRunning:true};
  if(monitor.code!==0)return {code:11,state:'startup-observation-unresolved',receipt};
  if(receipt?.phase==='starting')return {code:11,state:'startup-observation-lost',receipt};
  return {code:0,state:'stopped',receipt};
 }
 async perform(action){
  const o=this.o;
  if(action==='restart'||action==='stop'){
   // A service not yet published can still be about to spawn. Never call that
   // safely stopped, or start a replacement while its same-user monitor lives.
   const pending=await life.status(path.join(o.data,'.desktop-startup'));
   const owner=await life.status(o.data);
   if(owner.code===0&&pending.code!==0)return {code:11,state:'stop-unconfirmed'};
   const stopped=await life.stop(o.data,o.stopTimeout||15000);if(stopped.code!==0)return {code:11,state:'stop-unconfirmed'};
   if(action==='stop')return {code:0,state:'stopped'};
   // The old companion must have observed real child close before a restart.
   const drained=await life.status(path.join(o.data,'.desktop-startup'));if(drained.code!==0)return {code:11,state:'stop-unconfirmed'};
  }
  const before=await life.status(o.data);
  if(before.code!==0&&before.code!==10)return {code:11,state:'ownership-unresolved'};
  let ended=false,launched=false,monitorExit;const began=Date.now();
  if(before.code===0){const monitor=await life.status(path.join(o.data,'.desktop-startup'));if(monitor.code!==0&&monitor.code!==10)return {code:11,state:'startup-observation-unresolved'};
   if(monitor.code===0){receipts.write(o.data,{version:1,phase:'starting',stage:'monitor',elapsedMs:0,ready:false,events:[]});
    const child=o.launch?o.launch():cp.spawn(path.join(o.root,'runtime','node.exe'),[path.join(o.root,'startup-worker.cjs'),o.data],{windowsHide:true,stdio:'ignore',shell:false,cwd:o.root,detached:true});
    child.on('error',()=>{ended=true;});child.on('exit',(code,signal)=>{ended=true;monitorExit=receipts.termination(code,signal);});child.unref();launched=true;
   }
  }
  const deadline=Date.now()+Math.min(o.startTimeout||1500,3000);
  do{const result=await this.observe();
   if(result.state==='running')return {...result,state:before.code===10?'already-running':'applied'};
   if(result.code===12||['ownership-unresolved','readiness-unconfirmed','startup-observation-unresolved'].includes(result.state))return result;
   if(ended&&launched){let receipt=receipts.read(o.data);if(result.monitorRunning||result.ownerRunning&&receipt?.stage==='duplicate')return {code:11,state:'starting',receipt};if(result.ownerRunning)return {code:11,state:'startup-observation-lost',receipt};if(!receipt||receipt.stage==='monitor'){receipt={version:1,phase:'monitor-failed',stage:'monitor',elapsedMs:Math.max(0,Date.now()-began),ready:false,events:[],...(monitorExit?{childExit:monitorExit}:{})};receipts.write(o.data,receipt);}return {code:12,state:'start-failed',receipt,stage:'monitor'};}
   if(Date.now()>=deadline)return {code:11,state:'starting',receipt:result.receipt};
   await sleep(100);
  }while(true);
 }
}
module.exports={Manager};
