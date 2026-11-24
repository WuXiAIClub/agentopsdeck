'use strict';
const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
async function identity(pid){
 if(!Number.isSafeInteger(pid)||pid<1)return {state:'ambiguous'};
 if(process.platform==='win32'){
  try{return JSON.parse(execFileSync(path.join(__dirname,'AgentOpsDeck.exe'),['--identity',String(pid)],{encoding:'utf8',windowsHide:true,timeout:4000}));}catch{return {state:'ambiguous'};}
 }
 try{process.kill(pid,0);}catch(e){return {state:e.code==='ESRCH'?'dead':'ambiguous'};}
 try{const info=execFileSync('/bin/ps',['-p',String(pid),'-o','uid=','-o','lstart=','-o','comm='],{encoding:'utf8'}).trim();const m=info.match(/^(\d+)\s+(.{24})\s+(.+)$/);if(!m)return {state:'ambiguous'};return {state:'live',pid,owner:m[1],created:m[2],exe:m[3]};}catch{return {state:'ambiguous'};}
}
function same(a,b){return a&&b&&a.pid===b.pid&&a.owner===b.owner&&a.created===b.created&&a.exe.toLowerCase()===b.exe.toLowerCase();}
function reclaim(lock,snapshot){
 // Remove only the two owned files; unknown files or concurrent replacement fail closed.
 for(const f of fs.readdirSync(lock))if(!['pid.txt','owner.json'].includes(f))return false;
 if(read(lock).raw!==snapshot.raw)return false;
 const quarantine=lock+'.stale-'+require('node:crypto').randomUUID();fs.renameSync(lock,quarantine);
 // A release/relaunch can replace the directory after the pre-rename snapshot.
 // Verify the exact quarantined bytes before any unlink; restore or retain on conflict.
 if(read(quarantine).raw!==snapshot.raw||fs.readdirSync(quarantine).some(f=>!['pid.txt','owner.json'].includes(f))){try{if(!fs.existsSync(lock))fs.renameSync(quarantine,lock);}catch{}return false;}
 for(const f of fs.readdirSync(quarantine))fs.unlinkSync(path.join(quarantine,f));fs.rmdirSync(quarantine);return true;
}
function read(lock){
 try {const ownerFile=path.join(lock,'owner.json');if(fs.statSync(ownerFile).size>16384)return {raw:null};const raw=fs.readFileSync(ownerFile,'utf8');let meta;try{meta=JSON.parse(raw);}catch{}let legacyRaw='';try{legacyRaw=fs.readFileSync(path.join(lock,'pid.txt'),'utf8');}catch{}return {raw:raw+'\0'+legacyRaw,meta,legacy:/^[1-9]\d*\s*$/.test(legacyRaw)?Number(legacyRaw):null};}
 catch(e){if(e.code!=='ENOENT')throw e;try{const pid=fs.readFileSync(path.join(lock,'pid.txt'),'utf8');return {raw:pid,legacy:/^[1-9]\d*\s*$/.test(pid)?Number(pid):null};}catch{return {raw:null};}}
}
async function status(data,probe=identity){
 const lock=path.join(data,'.running');if(!fs.existsSync(lock))return {code:0,state:'stopped'};
 try{if(fs.lstatSync(lock).isSymbolicLink())return {code:11,state:'ambiguous'};const s=read(lock);const m=s.meta;const pid=m?.pid??s.legacy;if(!Number.isSafeInteger(pid)||pid<1)return {code:11,state:'malformed'};
 if(s.raw?.includes('\0')&&(!m||m.version!==1||typeof m.created!=='string'||!m.created||typeof m.owner!=='string'||!m.owner||typeof m.exe!=='string'||!m.exe||!Number.isInteger(m.port)||m.port<1||m.port>65535||! /^[a-f0-9]{64}$/.test(m.token??'')))return {code:11,state:'malformed'};
 const live=await probe(pid);if(live.state==='ambiguous')return {code:11,state:'ambiguous'};
 if(live.state==='dead')return reclaim(lock,s)?{code:0,state:'reclaimed-stale'}:{code:11,state:'ambiguous'};
 if(!m||m.version!==1||typeof m.created!=='string'||typeof m.owner!=='string'||typeof m.exe!=='string'||!Number.isInteger(m.port)||m.port<1||m.port>65535||! /^[a-f0-9]{64}$/.test(m.token??''))return {code:11,state:'legacy-or-malformed-live'};
 if(!same(m,live))return reclaim(lock,s)?{code:0,state:'reclaimed-reused-pid'}:{code:11,state:'ambiguous'};
 const me=await probe(process.pid);if(me.state!=='live'||me.owner!==live.owner)return {code:11,state:'ambiguous'};
 return {code:10,state:'running',meta:m};
 }catch{return {code:12,state:'error'};}
}
const net=require('node:net');const crypto=require('node:crypto');
function request(meta,action){return new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port:meta.port});let buffer='';socket.setTimeout(3000,()=>socket.destroy(Error('control unavailable')));socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({token:meta.token,action})+'\n'));socket.on('data',data=>{buffer+=data;if(buffer.length>4096)socket.destroy(Error('invalid control'));if(buffer.includes('\n')){try{resolve(JSON.parse(buffer));}catch(e){reject(e);}socket.destroy();}});socket.on('end',()=>{if(!buffer.includes('\n'))reject(Error('control unavailable'));});});}
async function acquire(data,handlers){
 fs.mkdirSync(data,{recursive:true,mode:0o700});const prior=await status(data);if(prior.code===10){await request(prior.meta,'open');return {duplicate:true};}if(prior.code!==0)throw Error('Ownership unresolved; no process was stopped');
 const lock=path.join(data,'.running');try{fs.mkdirSync(lock,{mode:0o700});}catch{throw Error('Another launch is in progress; retry');}
 const me=await identity(process.pid);if(me.state!=='live'){fs.rmdirSync(lock);throw Error('Cannot establish process identity');}
 const token=crypto.randomBytes(32).toString('hex');let released=false;const release=()=>{if(released)return;released=true;try{if(read(lock).meta?.token!==token)return;for(const f of ['owner.json','pid.txt'])fs.unlinkSync(path.join(lock,f));fs.rmdirSync(lock);}catch{}};
 const server=net.createServer(socket=>{let buffer='';socket.setTimeout(3000,()=>socket.destroy());socket.on('error',()=>{});socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>1024)return socket.destroy();if(!buffer.includes('\n'))return;socket.pause();let msg;try{msg=JSON.parse(buffer);}catch{return socket.destroy();}if(msg.token!==token)return socket.destroy();
 if(msg.action==='open'){Promise.resolve(handlers.open?.()).then(()=>socket.end('{"ok":true}\n')).catch(()=>socket.end('{"ok":false}\n'));}
 else if(msg.action==='stop'){if(!handlers.stop||handlers.canStop&& !handlers.canStop())return socket.end('{"ok":false}\n');socket.end('{"ok":true}\n',()=>{handlers.stop();});}else socket.destroy();});});
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});fs.writeFileSync(path.join(lock,'pid.txt'),String(process.pid),{flag:'wx',mode:0o600});fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({...me,version:1,port:server.address().port,token}),{flag:'wx',mode:0o600});process.once('exit',release);return {duplicate:false,release,server};}catch(e){server.close();release();throw e;}
}
async function stop(data,timeout=15000){const before=await status(data);if(before.code===0)return before;if(before.code!==10)return {code:11,state:'unsafe'};try{const again=await identity(before.meta.pid);if(!same(again,before.meta))return {code:11,state:'unsafe'};if(!(await request(before.meta,'stop')).ok)return {code:11,state:'stop-refused'};
 const deadline=Date.now()+timeout;while(Date.now()<deadline){const now=await identity(before.meta.pid);if(now.state==='dead'||now.state==='live'&&!same(now,before.meta)){const after=await status(data);return after.code===0?{code:0,state:'graceful-stopped'}:{code:11,state:'unsafe'};}await new Promise(r=>setTimeout(r,100));}return {code:11,state:'busy-or-draining'};
 }catch{return {code:11,state:'control-unavailable'};}}
module.exports={identity,same,status,acquire,stop,request};
if(require.main===module){const data=process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'AgentOpsDeck');(async()=>{if(!data)throw Error();let result=process.argv[2]==='stop'?await stop(data):process.argv[2]==='status'?await status(data):{code:12,state:'invalid-command'};console.log(result.state);process.exitCode=result.code;})().catch(()=>{console.log('error');process.exitCode=12;});}
