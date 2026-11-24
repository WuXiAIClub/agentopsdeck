'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {pathToFileURL}=require('node:url');const {spawn}=require('node:child_process');const lifecycle=require('./lifecycle.cjs');
function validateWorkspace(root,data,workspace){
 const inside=(p,c)=>{const rel=path.relative(fs.realpathSync(p),fs.realpathSync(c));return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
 if(!path.isAbsolute(workspace)||!fs.statSync(workspace).isDirectory()||inside(data,workspace)||inside(root,workspace)||inside(workspace,data)||inside(workspace,root))throw Error('Choose an existing workspace outside program and state');return fs.realpathSync(workspace);
}
function operatingEnvironment(ambient){
 return Object.fromEntries(Object.entries(ambient).filter(([name])=>/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|LOCALAPPDATA|APPDATA|ProgramFiles|ProgramFiles\(x86\)|ProgramData|ALLUSERSPROFILE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|OS|LANG|LC_ALL)$/i.test(name)));
}
function privateDirectory(directory){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});const metadata=fs.lstatSync(directory);if(!metadata.isDirectory()||metadata.isSymbolicLink())throw Error('Desktop runtime directory must not be a link');
}
function prepare(root,ambient,options={}){
 if(!ambient.LOCALAPPDATA||!path.isAbsolute(ambient.LOCALAPPDATA))throw Error('LOCALAPPDATA must be absolute');
 const data=path.join(ambient.LOCALAPPDATA,'AgentOpsDeck'),cwd=path.join(data,'state');privateDirectory(data);privateDirectory(cwd);const keyFile=path.join(data,'local-access-key.txt');let key;
 try{const metadata=fs.lstatSync(keyFile);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>128)throw Error('Desktop access key file must be a bounded regular file');}catch(error){if(error.code!=='ENOENT')throw error;}
 try{key=fs.readFileSync(keyFile,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;key=crypto.randomBytes(32).toString('hex');try{fs.writeFileSync(keyFile,key+'\n',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;key=fs.readFileSync(keyFile,'utf8').trim();}}
 if(!/^[a-f0-9]{64}$/.test(key))throw Error('Existing local access key invalid; not replaced');
 const env=operatingEnvironment(ambient),home=path.join(data,'native-home'),temporary=path.join(data,'tmp'),configFile=path.join(cwd,'desktop-server.env');
 for(const directory of [home,temporary])privateDirectory(directory);
 try{fs.writeFileSync(configFile,'',{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;const metadata=fs.lstatSync(configFile);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size!==0)throw Error('Desktop runtime config must be an owned empty file');}
 Object.assign(env,{PORT:'8790',AOD_PORT:'8790',AOD_DATA_DIR:cwd,AOD_CONFIG_FILE:configFile,HOME:home,USERPROFILE:home,TMP:temporary,TEMP:temporary,TMPDIR:temporary,XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_DATA_HOME:path.join(home,'data'),AOD_SERVER_ROLE:'all',AOD_LISTEN_HOST:'127.0.0.1',AOD_ACCESS_KEY:key,AOD_LOCAL_OPENCLAW_CLI:'false',AOD_CONNECTOR_UPDATE_ENABLED:'false',AOD_CODEX_ENABLED:'false',AOD_CLAUDE_ENABLED:'false',AOD_HERMES_ENABLED:'false',AOD_COPILOT_ENABLED:'false',AOD_HUB_LOCAL_EXECUTION_SETUP:'true',AOD_CONNECTOR_ENV_LABEL:'Local Windows Connector'});
 const saved=require('./ui-config.cjs').load(path.join(cwd,'.env'),{home:ambient.HOME,userProfile:ambient.USERPROFILE}).values;Object.assign(env,saved);
 let settings={};try{settings=JSON.parse(fs.readFileSync(path.join(data,'desktop-settings.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Desktop settings invalid; not replaced');}
 env.AOD_PORT=saved.AOD_PORT||saved.PORT||'8790';env.PORT=env.AOD_PORT;
 const workspace=Object.hasOwn(saved,'AOD_CODEX_DEFAULT_CWD')?saved.AOD_CODEX_DEFAULT_CWD:settings.workspace;
 if(workspace){env.AOD_CODEX_DEFAULT_CWD=validateWorkspace(root,data,workspace);env.AOD_CODEX_ENABLED='true';const select=options.selectCodex||((program,ambientEnvironment,discoveryOptions)=>require('./codex-discovery.cjs').select(program,ambientEnvironment,discoveryOptions));const command=select(root,operatingEnvironment(ambient),options);if(command){if((options.platform||process.platform)==='win32')env.AOD_CODEX_RESOLVED_EXECUTABLE=command;env.AOD_CODEX_COMMAND=command;}}
 return {root,cwd,data,keyFile,env};
}
function saveWorkspace(root,ambient,workspace){const data=path.join(ambient.LOCALAPPDATA,'AgentOpsDeck');fs.mkdirSync(data,{recursive:true,mode:0o700});const chosen=validateWorkspace(root,data,workspace);const temp=path.join(data,'desktop-settings-'+crypto.randomUUID()+'.json');fs.writeFileSync(temp,JSON.stringify({version:1,workspace:chosen}),{flag:'wx',mode:0o600});fs.renameSync(temp,path.join(data,'desktop-settings.json'));}
function openUI(){if(process.platform==='win32'){const child=spawn(path.join(__dirname,'AgentOpsDeck.exe'),['--open'],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();}}
function report(stage){console.info(JSON.stringify({component:'agentopsdeck-desktop-startup',stage}));}
async function start(plan){
 let ready=false;report('acquire');const lease=await lifecycle.acquire(plan.data,{canStop:()=>ready,open:()=>{if(ready)openUI();},stop:()=>{if(ready)process.emit('SIGTERM');}});if(lease.duplicate){report('duplicate');return lease;}
 try{for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,plan.env);process.chdir(plan.cwd);
 report('import');await import(pathToFileURL(path.join(plan.root,'apps/server/dist/index.js')).href);ready=true;report('imported');return lease;}catch(e){lease.server.close();lease.release();throw e;}
}
if(require.main===module){(async()=>{report('guard');if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows x64 required');if(process.argv[2]==='--workspace'){saveWorkspace(__dirname,process.env,process.argv[3]);return;}report('prepare');await start(prepare(__dirname,process.env));})().catch(()=>{report('failed');process.exitCode=12;});}
module.exports={prepare,saveWorkspace,validateWorkspace,start,operatingEnvironment};
