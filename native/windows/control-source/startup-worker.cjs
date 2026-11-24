'use strict';
// A detached, same-user observation companion, not a service controller.
// Its pipes outlive the short UI helper. No timer ever kills/releases a service.
const path=require('node:path'),cp=require('node:child_process'),life=require('./lifecycle.cjs'),receipts=require('./startup-receipts.cjs');
async function observe(o){
 const lease=await life.acquire(path.join(o.data,'.desktop-startup'),{open:()=>{}});
 if(lease.duplicate)return;
 let child,timer,ended=false,checking=false,released=false,diagnosticWrites=0,lastDiagnosticWrite=-Infinity;
 const start=Date.now(),r={version:1,phase:'starting',stage:'monitor',elapsedMs:0,ready:false,events:[]};
 const save=()=>{r.elapsedMs=Math.max(0,Date.now()-start);try{receipts.write(o.data,r);}catch{/* Diagnostics cannot acquire/release service authority. */}};
 const release=()=>{if(released)return;released=true;if(timer)clearInterval(timer);lease.server.close();lease.release();};
 const event=row=>{if(r.ready)return;if(row.stage)r.stage=row.stage;
  if(r.events.length<32)r.events.push(row);else{let i=r.events.findIndex(e=>e.category!=='failed');if(i<0&&row.category==='failed')i=0;if(i>=0){r.events.splice(i,1);r.events.push(row);}}
  if(diagnosticWrites<32||Date.now()-lastDiagnosticWrite>=250){save();lastDiagnosticWrite=Date.now();diagnosticWrites++;}
 };
 try{
  const before=await life.status(o.data);if(before.code!==0){r.phase=before.code===10?'exited':'monitor-failed';r.stage=before.code===10?'duplicate':'monitor-ownership';save();release();return;}
  save();r.stage='spawn';
  child=cp.spawn(path.join(o.root,'runtime','node.exe'),[path.join(o.root,'desktop-launcher.cjs')],{cwd:o.root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  receipts.drain(child.stdout,event);receipts.drain(child.stderr,event);
  child.on('error',()=>{ended=true;r.phase='spawn-failed';r.stage='spawn';save();});
  child.on('exit',(code,signal)=>{ended=true;if(timer)clearInterval(timer);r.phase='exited';r.childExit=receipts.termination(code,signal);save();});
  child.on('close',()=>{save();release();});
  timer=setInterval(async()=>{if(ended||r.ready||checking)return;checking=true;try{const owner=await life.status(o.data);if(!ended&&owner.code===10&&await o.ready()&&!ended){r.ready=true;save();clearInterval(timer);}}catch{/* Unknown probe is not readiness. */}finally{checking=false;}},500);
  save();
 }catch{ended=true;r.phase=child?'monitor-failed':'spawn-failed';r.stage='spawn';save();if(!child)release();}
}
if(require.main===module){(async()=>{
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('windows-native-required');
 const data=process.argv[2];if(!data||!path.isAbsolute(data))throw Error('state-path-invalid');
 const values=require('./ui-config.cjs').load(path.join(data,'state','.env')).values;
 await observe({root:__dirname,data,ready:()=>require('./ui-helper.cjs').health(values)});
})().catch(()=>{process.exitCode=12;});}
module.exports={observe};
