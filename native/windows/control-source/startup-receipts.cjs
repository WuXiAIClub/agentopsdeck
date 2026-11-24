'use strict';
// Only fixed enums and bounded numbers cross this boundary. Never store raw text.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const operations=new Set(['process-startup','process-shutdown','process-shutdown-owner','connector-runtime-assembly','combined-application-layer','standalone-connector-layer','sdk-owned-lifecycle','storage-startup-owner','storage-startup-cleanup','storage-startup-admission','storage-coordinator-startup','connector-startup-task','shutdown-drain','shutdown-cleanup','application-drain']);
const stages=new Set(['monitor','monitor-ownership','spawn','guard','prepare','acquire','import','imported','duplicate','failed','observation']);
const metrics=['step','startupStage','pending','unknown','timedOut','ownerFailureCode','leaseStage','controlReason','controlTarget','aclReason','admissionRefusalCode','sqlErrorCode','rollbackErrorCode'];
const startupEnums={leaseStage:[10,11,12,13,14,15,16,17,18,19,20,21,22,23,24],controlReason:[1,2,3,4,5,6,7],controlTarget:[1,2,3,4],aclReason:[1,2,3,4]};
const signals=new Set(['other','SIGTERM','SIGINT','SIGKILL','SIGABRT','SIGSEGV','SIGBREAK','SIGHUP','SIGILL','SIGFPE','SIGBUS','SIGTRAP']);
const num=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=Number.MAX_SAFE_INTEGER;
function diagnostic(j){
 if(!j||typeof j!=='object'||Array.isArray(j))return null;
 if(j.component==='agentopsdeck-desktop-startup')return stages.has(j.stage)?{stage:j.stage}:null;
 if(j.component!=='agentopsdeck-performance'||!operations.has(j.operation)||!['pending','finished'].includes(j.phase)||!['routine','slow','failed'].includes(j.category)||!num(j.elapsedMs))return null;
 const row={operation:j.operation,phase:j.phase,category:j.category,elapsedMs:j.elapsedMs};
 for(const k of metrics)if(Object.hasOwn(j,k)){if(!num(j[k])||(startupEnums[k]&&!startupEnums[k].includes(j[k])))return null;row[k]=j[k];}
 return row;
}
function parseDiagnostic(line){if(typeof line!=='string'||Buffer.byteLength(line)>8192)return null;try{return diagnostic(JSON.parse(line));}catch{return null;}}
function drain(stream,onRow){
 let line='',dropping=false;
 stream.on('error',()=>{});
 stream.on('data',chunk=>{const text=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);let at=0;while(at<text.length){const end=text.indexOf('\n',at),part=text.slice(at,end<0?text.length:end);if(!dropping){if(line.length+part.length>8192){line='';dropping=true;}else line+=part;}if(end<0)break;if(!dropping){const row=parseDiagnostic(line);if(row)onRow(row);}line='';dropping=false;at=end+1;}});
 // Truncated non-newline output is not a structured record.
 stream.on('end',()=>{line='';});
}
function sanitize(j){
 if(!j||j.version!==1||!['starting','exited','spawn-failed','monitor-failed'].includes(j.phase)||!stages.has(j.stage)||!num(j.elapsedMs)||typeof j.ready!=='boolean'||!Array.isArray(j.events)||j.events.length>32)return null;
 const out={version:1,phase:j.phase,stage:j.stage,elapsedMs:j.elapsedMs,ready:j.ready,events:[]};
 for(const e of j.events){const r=e?.stage?diagnostic({component:'agentopsdeck-desktop-startup',stage:e.stage}):diagnostic({component:'agentopsdeck-performance',...e});if(!r)return null;out.events.push(r);}
 if(j.childExit!==undefined){const e=j.childExit;if(!e||!(e.code===null||Number.isInteger(e.code)&&e.code>=-2147483648&&e.code<=4294967295)||!(e.signal===null||signals.has(e.signal)))return null;out.childExit={code:e.code,signal:e.signal};}
 return out;
}
function file(data){return path.join(data,'startup-receipt.json');}
function read(data){try{const p=file(data),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>32768)return null;return sanitize(JSON.parse(fs.readFileSync(p,'utf8')));}catch{return null;}}
function write(data,receipt){const safe=sanitize(receipt);if(!safe)throw Error('invalid-startup-receipt');const target=file(data),tmp=path.join(data,'startup-receipt-'+crypto.randomUUID()+'.tmp');try{try{const s=fs.lstatSync(target);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe-startup-receipt');}catch(e){if(e.code!=='ENOENT')throw e;}fs.writeFileSync(tmp,JSON.stringify(safe)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,target);}finally{try{fs.unlinkSync(tmp);}catch{}}}
function termination(code,signal){return {code:Number.isInteger(code)&&code>=-2147483648&&code<=4294967295?code:null,signal:signal==null?null:signals.has(signal)?signal:'other'};}
module.exports={parseDiagnostic,drain,sanitize,read,write,termination};
