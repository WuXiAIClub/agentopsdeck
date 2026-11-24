'use strict';
// Actual source/host filesystem/SQLite; simulated Windows process + native port.
// VM composition is test-only: no shipping CLI/env override or exported factory.
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream'),{DatabaseSync}=require('node:sqlite');
const source=process.env.REPAIR_SOURCE_TEST_FILE||path.join(__dirname,'repair.cjs');
const payload=__dirname; // Handoff: use the exact bundled .12 control dependency, not an external workspace.
const realConfig=require(path.join(payload,'ui-config.cjs'));
const node='node_12345678-1234-4234-8234-123456789abc';
function fixture(o={}){
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||__dirname,'repair-orchestration-')),data=path.join(dir,'AgentOpsDeck'),state=path.join(data,'state');fs.mkdirSync(state,{recursive:true});
 const config=path.join(state,'.env'),db=path.join(state,'.agentopsdeck-connector-users.sqlite'),marker=path.join(state,'marker'),binding=path.join(state,'binding'),backup=marker+'.backup';
 fs.writeFileSync(config,'AOD_CLAUDE_ENABLED=true\nAOD_CLAUDE_DEDICATED=true\nAOD_CLAUDE_HOME=C:\\private\\claude\nAGENTOPSDECK_CONNECTOR_USERS_DATABASE_FILE=C:\\ignored-by-original-launcher.sqlite\n');
 const sql=new DatabaseSync(db);sql.exec('CREATE TABLE connector_identity(singleton INTEGER PRIMARY KEY,node_id TEXT NOT NULL)');sql.prepare('INSERT INTO connector_identity VALUES(1,?)').run(node);sql.close();
 fs.writeFileSync(marker,JSON.stringify({format:1,token:'12345678-1234-4234-8234-123456789abc',pid:42,nodeId:node}));fs.writeFileSync(binding,JSON.stringify({format:1,nodeId:node,storeFile:db}));
 const before=[config,db,marker,binding].map(f=>fs.readFileSync(f)),events=[];let held=false,child,timer,closed=false,commit=false,blocker;
 const lifecycle={async acquire(target){events.push('acquire');a.equal(target,path.join(data,'.desktop-operation'));if(o.busy)return{duplicate:true};held=true;return{server:{close(){events.push('lease-server-close');}},release(){a.equal(closed||!child,true,'lease must survive child');held=false;events.push('release');}};},async status(target){events.push(target===data?'owner-status':'monitor-status');return{code:target===data?(o.ownerUnknown?11:0):(o.monitorUnknown?11:0)};}};
 class Manager{async perform(action){a.equal(action,'stop');events.push('stop');return{code:o.stopUnknown?11:0};}}
 const spawn=()=>{
  events.push('spawn');a.equal(held,true);child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{events.push('kill');setImmediate(()=>{a.equal(held,true,'timeout cannot release lease before close');end(1);});};
  const end=(code=0)=>{if(!closed){closed=true;events.push('child-close');child.emit('close',code);}};
  const send=s=>child.stdout.write(s);
  child.stdin=new Writable({write(chunk,enc,cb){const text=chunk.toString();events.push(text==='COMMIT\n'?'COMMIT':text==='CANCEL\n'?'CANCEL':'request');if(text==='COMMIT\n'){
   const probe=new DatabaseSync(db);try{probe.exec('BEGIN EXCLUSIVE; COMMIT;');events.push('sql-closed-before-commit-proven');}finally{probe.close();}
   commit=true;if(o.afterRenameCrash){fs.renameSync(marker,backup);queueMicrotask(()=>end(1));}
   else if(o.errorAfterDone){send('DONE\n');child.emit('error',Error('private child error'));queueMicrotask(()=>end());}
   else if(o.partialOutput){send('DONE\ntrailing');queueMicrotask(()=>end());}
   else if(o.commitRefusal){send(o.commitRefusal+'\n');queueMicrotask(()=>end(12));}
   else if(o.extraOutput){send('DONE\nUNTRUSTED\n');queueMicrotask(()=>end());}
   else {fs.renameSync(marker,backup);send('DONE\n');queueMicrotask(()=>end());}
  }else if(text==='CANCEL\n'){queueMicrotask(()=>end());}
  else{const fields=text.trimEnd().split('\n');a.equal(fields[1],db,'original launcher filters unknown DB setting, so runtime uses cwd default');if(o.busySQL){blocker=new DatabaseSync(db);blocker.exec('BEGIN EXCLUSIVE');}
   if(o.timeout){queueMicrotask(()=>timer());}
   else if(o.crash){queueMicrotask(()=>end(1));}
   else if(o.refusal){send((typeof o.refusal==='string'?o.refusal:'REFUSED')+'\n');}
   else{if(o.configChange)fs.appendFileSync(config,'# changed after pin\n');if(o.missingBinding)fs.unlinkSync(binding);let b=fs.existsSync(binding)?fs.readFileSync(binding):Buffer.alloc(0);if(o.malformedBinding)b=Buffer.from('{}');if(o.nodeMismatch)b=Buffer.from(JSON.stringify({format:1,nodeId:node+'x',storeFile:db}));send('HELD\t'+fs.readFileSync(marker).toString('hex')+'\t'+b.toString('hex')+'\n');if(o.crashAfterHeld)end(1);if(o.unsolicitedBeforeCommit)send('DONE\n');}
  }cb();}});
  child.stdin.on('finish',()=>{if(o.timeout){setImmediate(()=>{a.equal(held,true,'timeout cannot release lease before close');end(1);});}else if(!commit)queueMicrotask(()=>end());});
  return child;
 };
 const m={exports:{}},sandbox={module:m,exports:m.exports,Buffer,TextDecoder,console,process:{platform:'win32',env:{}},__dirname:path.dirname(source),setTimeout(fn){timer=fn;return{};},clearTimeout(){},require(name){if(name==='node:path')return{...path,win32:{...path.win32,isAbsolute:s=>path.isAbsolute(s)||path.win32.isAbsolute(s)}};if(name==='node:child_process')return{spawn};if(name==='./lifecycle.cjs')return lifecycle;if(name==='./ui-manager.cjs')return{Manager};if(name==='./ui-config.cjs')return realConfig;return require(name);}};
 vm.runInNewContext(fs.readFileSync(source,'utf8'),sandbox,{filename:source});const r=m.exports;
 if(o.closeFailure){ // Inject only at built-in SQLite boundary, not the orchestrator.
  sandbox.require=(old=>name=>{if(name==='node:sqlite')return{DatabaseSync:class{constructor(file,options){const d=new DatabaseSync(file,options);return new Proxy(d,{get(t,k){if(k==='close')return()=>{events.push('sql-close-failed');throw Error('private close failure');};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}}};return old(name);})(sandbox.require);
 }
 return{events,async run(input=r.CONFIRM){return r.run(input,{LOCALAPPDATA:dir},__dirname);},verifyUnchanged({allowConfig=false,renamed=false}={}){for(const [i,f] of [config,db,marker,binding].entries()){if(i===0&&allowConfig||i===3&&o.missingBinding)continue;a.deepEqual(fs.readFileSync(i===2&&renamed?backup:f),before[i],f);}a.equal(fs.existsSync(backup),renamed);},cleanup(){try{blocker?.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}}};
}
for(const [name,opts]of Object.entries({cancel:{cancel:true},busy:{busy:true},stopUnknown:{stopUnknown:true},ownerUnknown:{ownerUnknown:true},monitorUnknown:{monitorUnknown:true},missingBinding:{missingBinding:true},malformedBinding:{malformedBinding:true},nodeMismatch:{nodeMismatch:true},SQLbusy:{busySQL:true},SQLcloseFailure:{closeFailure:true},childRefusal:{refusal:true},childCrash:{crash:true},timeout:{timeout:true}}))test('isolated fake Windows port: '+name+' refuses without DB/config/binding/marker mutation',async()=>{const f=fixture(opts);try{const result=await f.run(opts.cancel?'':undefined);a.notEqual(result.code,0);a.equal(f.events.includes('COMMIT'),false);f.verifyUnchanged();}finally{f.cleanup();}});
test('isolated fake Windows port: changed config after HELD never reaches COMMIT',async()=>{const f=fixture({configChange:true});try{const result=await f.run();a.notEqual(result.code,0);a.equal(f.events.includes('COMMIT'),false);f.verifyUnchanged({allowConfig:true});}finally{f.cleanup();}});
test('isolated fake Windows port: unsolicited extra native output is not success',async()=>{const f=fixture({extraOutput:true});try{a.notEqual((await f.run()).code,0);}finally{f.cleanup();}});
test('isolated fake Windows port: exact success backs up once; no start/retry or DB/config/binding mutation',async()=>{const f=fixture();try{const r=await f.run();a.equal(r.code,0);a.equal(r.state,'repair-backed-up-no-workers-started');f.verifyUnchanged({renamed:true});a.equal(f.events.filter(x=>x==='COMMIT').length,1);a.ok(f.events.indexOf('child-close')<f.events.indexOf('release'));}finally{f.cleanup();}});
test('isolated fake Windows port: post-rename crash stays ambiguous; no restore/retry',async()=>{const f=fixture({afterRenameCrash:true});try{a.notEqual((await f.run()).code,0);f.verifyUnchanged({renamed:true});a.equal(f.events.filter(x=>x==='spawn').length,1);}finally{f.cleanup();}});
for(let n=1;n<=16;n++)test('native refusal fixed enum '+n+' is preserved without raw protocol',async()=>{const f=fixture({refusal:'REFUSED\t'+n});try{const r=await f.run();a.equal(r.code,12);a.equal(r.state,'repair-native-refused-'+n);f.verifyUnchanged();}finally{f.cleanup();}});
for(const suffix of ['0','17','01','-1','1\tprivate','private/path','1x'])test('native refusal rejects non-enum '+JSON.stringify(suffix),async()=>{const f=fixture({refusal:'REFUSED\t'+suffix});try{const r=await f.run();a.equal(r.code,12);a.equal(r.state,'repair-refused-or-unconfirmed-no-retry');f.verifyUnchanged();}finally{f.cleanup();}});
test('native refusal after COMMIT remains non-success with fixed cause',async()=>{const f=fixture({commitRefusal:'REFUSED\t16'});try{const r=await f.run();a.equal(r.code,12);a.equal(r.state,'repair-native-refused-16');f.verifyUnchanged();}finally{f.cleanup();}});
for(const flag of ['crashAfterHeld','unsolicitedBeforeCommit','errorAfterDone','partialOutput'])test('isolated fake Windows port: '+flag+' cannot report success',async()=>{const f=fixture({[flag]:true});try{a.notEqual((await f.run()).code,0);f.verifyUnchanged();if(['crashAfterHeld','unsolicitedBeforeCommit'].includes(flag))a.equal(f.events.includes('COMMIT'),false);}finally{f.cleanup();}});
test('cancellation never acquires lease, stops service, or spawns child',async()=>{const f=fixture();try{await f.run('');a.deepEqual(f.events,[]);f.verifyUnchanged();}finally{f.cleanup();}});
