'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const CONFIRM='RESTART\tfull-windows-restart\nFAILURE\tsame-startup11-lease-stage16\nMARKER\tcontinuously-present-since-pre-restart-failure\nCLOCK\tno-clock-or-timestamp-edit\nRESTORE\tno-marker-restore-rename-or-prior-recovery\nPOSTBOOT\tno-successful-Claude-work-or-unresolved-native-cleanup\n';
const confirmed=input=>input===CONFIRM;
const nativeRefusal=line=>/^REFUSED\t(?:[1-9]|1[0-6])$/.test(line)?'repair-native-refused-'+line.slice(8):null;
const id=s=>typeof s==='string'&&/^node_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
function validate(marker,binding,nodeId,storeFile){
 if(!id(nodeId)||marker.length>8192||binding.length>8192)throw Error('repair-identity-refused');
 const m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(marker));
 if(m.format!==1||m.nodeId!==nodeId||!Number.isSafeInteger(m.pid)||m.pid<1||typeof m.token!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(m.token)||Object.keys(m).sort().join(',')!=='format,nodeId,pid,token'||!binding.equals(Buffer.from(JSON.stringify({format:1,nodeId,storeFile}))))throw Error('repair-identity-refused');
 return true;
}
function existingFence(file){
 // Native caller pins this EXISTING canonical file against deletion first.
 // Extra lstat check is fail-closed on hosts, NOT the Windows race authority.
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('repair-db-refused');
 const {DatabaseSync}=require('node:sqlite');let db=new DatabaseSync(file,{timeout:0});
 try{db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');db.exec('PRAGMA query_only=ON;');const rows=db.prepare('SELECT singleton,node_id FROM connector_identity LIMIT 2').all();if(rows.length!==1||rows[0].singleton!==1||!id(rows[0].node_id))throw Error();return{nodeId:rows[0].node_id,close(){db.close();if(db.isOpen)throw Error('repair-close-unconfirmed');}};}catch{db.close();throw Error('repair-sql-fence-refused');}
}
function nativeSession(root,home,db,config,expected){
 const child=spawn(path.join(root,'AgentOpsDeck.exe'),['--repair-held'],{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore']});
 let pending=[],lines=[],buffer='',ended=false,failed=false,total=0;
 const fail=()=>{failed=true;for(const p of pending.splice(0))p.reject(Error('repair-native-unconfirmed'));};
 child.stdout.on('data',chunk=>{if(failed)return;total+=chunk.length;buffer+=chunk;if(total>70000){child.stdin.destroy();child.kill();fail();return;}let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n).replace(/\r$/,'');buffer=buffer.slice(n+1);const p=pending.shift();p?p.resolve(line):lines.push(line);}});
 child.on('error',fail);child.stdin.on('error',fail);
 const exited=new Promise(resolve=>child.on('close',code=>{ended=true;for(const p of pending.splice(0))p.reject(Error('repair-native-unconfirmed'));resolve(code);}));
 const timer=setTimeout(()=>{child.stdin.destroy();child.kill();fail();},55000);
 const next=()=>failed?Promise.reject(Error('repair-native-unconfirmed')):lines.length?Promise.resolve(lines.shift()):ended?Promise.reject(Error('repair-native-unconfirmed')):new Promise((resolve,reject)=>pending.push({resolve,reject}));
 child.stdin.write([home,db,config,require('node:crypto').createHash('sha256').update(expected).digest('hex')].join('\n')+'\n');
 return{next,commit:()=>{if(ended||failed||lines.length||buffer)throw Error('repair-native-unconfirmed');child.stdin.end('COMMIT\n');},abort:()=>{if(!child.stdin.writableEnded&&!child.stdin.destroyed)child.stdin.end('CANCEL\n');},async close(){if(!child.stdin.writableEnded&&!child.stdin.destroyed)child.stdin.end();const code=await exited;clearTimeout(timer);return failed||lines.length||buffer?null:code;}};
}
async function run(input,env=process.env,root=__dirname){
 if(!confirmed(input))return{code:12,state:'repair-cancelled-no-change'};
 if(process.platform!=='win32')return{code:12,state:'windows-native-required'};
 const lifecycle=require('./lifecycle.cjs'),{Manager}=require('./ui-manager.cjs');
 const data=path.join(env.LOCALAPPDATA||'','AgentOpsDeck'),file=path.join(data,'state','.env');let lease,session,fence;
 try{
  lease=await lifecycle.acquire(path.join(data,'.desktop-operation'),{open:()=>{}});if(lease.duplicate)return{code:11,state:'operation-busy'};
  if((await new Manager({data,root}).perform('stop')).code!==0||(await lifecycle.status(data)).code!==0||(await lifecycle.status(path.join(data,'.desktop-startup'))).code!==0)return{code:11,state:'repair-stop-unconfirmed'};
  const expected=fs.readFileSync(file),values=require('./ui-config.cjs').parse(expected).values;
  if(values.AOD_CLAUDE_ENABLED!=='true'||values.AOD_CLAUDE_DEDICATED!=='true')throw Error();
  // Same original launcher sanitized environment/default cwd; no prepare(),
  // which may create directories/access keys. No credentials enter protocol.
  const state=path.join(data,'state'),home=values.AOD_CLAUDE_HOME,db=values.AOD_CONNECTOR_USERS_DATABASE_FILE||path.join(state,'.agentopsdeck-connector-users.sqlite');
  if(!home||!path.win32.isAbsolute(home)||!path.win32.isAbsolute(db))throw Error();
  session=nativeSession(root,home,db,file,expected);
  const first=await session.next(),refused=nativeRefusal(first);if(refused)return{code:12,state:refused};
  const held=first.split('\t');if(held.length!==3||held[0]!=='HELD'||held.slice(1).some(x=>!x||x.length>16384||!/^(?:[a-f0-9]{2})+$/.test(x)))throw Error();
  fence=existingFence(db);validate(Buffer.from(held[1],'hex'),Buffer.from(held[2],'hex'),fence.nodeId,db);
  fence.close();fence=null;
  // SQLite is now CLOSED. Native verifies same DB object before share=0 bridge.
  // Recheck stopped state under the still-held original desktop operation lease.
  if((await lifecycle.status(data)).code!==0||(await lifecycle.status(path.join(data,'.desktop-startup'))).code!==0||!fs.readFileSync(file).equals(expected))throw Error();
  session.commit();const result=await session.next(),code=await session.close();session=null;
  if(code!==null&&nativeRefusal(result))return{code:12,state:nativeRefusal(result)};
  if(result==='CANCELLED')return{code:12,state:'repair-cancelled-no-change'};
  return result==='DONE'&&code===0?{code:0,state:'repair-backed-up-no-workers-started'}:{code:12,state:'repair-unconfirmed-inspect-no-retry'};
 }catch{return{code:12,state:'repair-refused-or-unconfirmed-no-retry'};}
 finally{if(fence)try{fence.close();}catch{}if(session){session.abort();await session.close();}if(lease&&!lease.duplicate){lease.server.close();lease.release();}}
}
module.exports={CONFIRM,confirmed,validate,existingFence,run};
