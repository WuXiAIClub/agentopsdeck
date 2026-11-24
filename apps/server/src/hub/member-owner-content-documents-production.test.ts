import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {HubStore} from './hub-store.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import {AsyncHubMemberOwner} from './async-member-owner.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {hubMemberEvidence} from './member-owner-domain.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {loadConfig} from '../config.js';
import {registerHubRoutes} from '../routes/hub.js';
import type {ContentMigrationReceipt,ContentReceipt,ContentMigrationTermination,ContentWriteTermination} from './content-proposal-store.js';

const resource=JSON.stringify(['taskboard','default']),statusResource=JSON.stringify(['statuscard','default']);
const base=(id=resource)=>'/api/hub/v1/workspace/shared-content/'+encodeURIComponent(id);
const document=(title:string)=>JSON.stringify({kind:'taskboard',content:{title,tasks:[]}});
type Reply={receipt:ContentMigrationReceipt|ContentReceipt|null;termination?:ContentMigrationTermination|ContentWriteTermination|null};
async function fixture(t:TestContext,mode:'original'|'worker') {
  const root=mkdtempSync(join(tmpdir(),'content-document-production-')),file=join(root,'hub.sqlite');
  const seed=new HubStore(file,'fixture'),user=seed.createUser('Member'),key=seed.identities.issueKey(user.id);
  (seed as unknown as {db:DatabaseSync}).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const adminKey=seed.identities.issueKey('default');
  const cookie=seed.identities.createSession(key.token)!;
  seed.boards.save(user.id,'default',{title:'PRIVATE_NATIVE_BOARD',tasks:[],revision:0,mutationId:randomUUID()});
  await seed.close();
  const logs:string[]=[],diagnostics=new PerformanceDiagnostics(line=>logs.push(line));let sync=0;
  const config={...loadConfig({HOME:root,AOD_SERVER_ROLE:'hub'}),boardFilesEnabled:false};
  const mount=()=>{
    const metadata=new HubStore(mode==='original'?file:join(root,'composition.sqlite'),'fixture');
    const owner=mode==='original'?new OriginalHubAdministrativeCommands(metadata,diagnostics):new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},diagnostics);
    const group=createHubAdministrativeServices(owner,diagnostics);let guard=false;
    const store=new Proxy(metadata,{get(target,p,receiver){if(guard){sync++;throw Error('SYNC_CONTENT_STORE');}return Reflect.get(target,p,receiver);}});
    config.boardFilesEnabled=false;
    const app=new Hono(),routes=registerHubRoutes(app,{config,hubStore:store,administrative:group,
      principal:()=>{sync++;throw Error('SYNC_CONTENT_PRINCIPAL');},connectorClient:()=>{sync++;throw Error('SYNC_CONTENT_CLIENT');},
      fileCardClient:()=>{sync++;throw Error('UNEXPECTED_CONTENT_EFFECT');},normalizeError:()=> 'safe'});
    assert.ok(routes);guard=true;config.boardFilesEnabled=true;
    return {app,owner,metadata,dispose:async()=>{guard=false;await routes.close();await group.close();await owner.close();await metadata.close();}};
  };
  let current=mount();
  t.after(async()=>{await current.dispose();assert.equal(sync,0);
    for(const secret of [key.token,adminKey.token,cookie,'PRIVATE_NATIVE_BOARD'])assert.equal(logs.join('').includes(secret),false);
    rmSync(root,{recursive:true,force:true});});
  const request=(method:string,suffix:string,body?:unknown,headers:Record<string,string>={'x-agentopsdeck-key':key.token},id=resource)=>
    current.app.fetch(new Request('http://hub.invalid'+base(id)+suffix,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const read=async(response:Response,status=200)=>{assert.equal(response.status,status,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');return response.json() as Promise<Reply>;};
  const proof=async(token:string)=>{const evidence=hubMemberEvidence(new Request('http://hub.invalid',{headers:{'x-agentopsdeck-key':token}}));
    const snapshot=await current.owner.command('memberSnapshot',evidence);assert.ok(snapshot);return {evidence,expectedScope:snapshot.recoveryScope};};
  const migrate=async()=>{const requestId=randomUUID(),reply=await read(await request('POST','/migrate',{requestId,revision:1}));
    assert.ok(reply.receipt&&'result'in reply.receipt);return {requestId,receipt:reply.receipt};};
  return {request,read,migrate,key,cookie,config,current:()=>current,
    revoke:async()=>current.owner.command('memberKeyRevoke',{...await proof(adminKey.token),userId:user.id,keyId:key.id}),
    reopen:async()=>{await current.dispose();current=mount();}};
}
for(const mode of ['original','worker'] as const){
  test(`${mode}: six production entries retain wire formats, original receipts and canonical statuscard head`,async t=>{
    const f=await fixture(t,mode),migration=await f.migrate(),head=migration.receipt.result;
    for(const headers of [{'x-agentopsdeck-key':f.key.token},{authorization:'Bearer '+f.key.token},{cookie:'agentopsdeck_session='+f.cookie}]){
      const value=await f.read(await f.request('GET','/migrations/'+migration.requestId,undefined,headers,statusResource));
      assert.deepEqual(value,{receipt:migration.receipt,termination:null});
    }
    const recovered=await f.read(await f.request('POST',`/migrations/${migration.requestId}/recover`,{}));assert.deepEqual(recovered.receipt,migration.receipt);
    const input={mutationId:randomUUID(),modeEpoch:head.epoch,baseRevision:head.revision,baseHash:head.hash,content:document('Shared')};
    const write=await f.read(await f.request('PUT','/document',input,undefined,statusResource));
    assert.ok(write.receipt&&'state'in write.receipt);assert.equal(write.receipt.state,'committed');
    assert.deepEqual(await f.read(await f.request('PUT','/document',input)),write);
    await f.read(await f.request('PUT','/document',{...input,content:document('Different')}),409);
    const suffix=`/writes/${head.epoch}/${input.mutationId}`;
    assert.deepEqual(await f.read(await f.request('GET',suffix)),{receipt:write.receipt,termination:null});
    assert.deepEqual(await f.read(await f.request('POST',suffix+'/recover',{})),{receipt:write.receipt,termination:null});
    const conflict=await f.read(await f.request('PUT','/document',{...input,mutationId:randomUUID(),content:document('Stale')}));
    assert.ok(conflict.receipt&&'state'in conflict.receipt);assert.equal(conflict.receipt.state,'conflict');
    await f.reopen();assert.deepEqual(await f.read(await f.request('GET',suffix)),{receipt:write.receipt,termination:null});
    const evidence=hubMemberEvidence(new Request('http://hub.invalid',{headers:{'x-agentopsdeck-key':f.key.token}}));
    const snapshot=await f.current().owner.command('memberSnapshot',evidence);assert.ok(snapshot);
    const native=await f.current().owner.command('workspaceBoard',{evidence,expectedScope:snapshot.recoveryScope,
      command:{action:'save',resourceId:'default',document:{title:'Must remain frozen',tasks:[],revision:2,mutationId:randomUUID()}}});
    assert.ok(native?.action==='save');assert.equal(native.result.status,'file-managed');
  });
  test(`${mode}: recovery first durably fences late migration and owner writes without replay`,async t=>{
    const f=await fixture(t,mode),absent=randomUUID();
    const terminated=await f.read(await f.request('POST',`/migrations/${absent}/recover`,{}));
    assert.equal(terminated.receipt,null);assert.equal(terminated.termination?.state,'not-executed');
    await f.read(await f.request('POST','/migrate',{revision:1,requestId:absent}),409);
    const migration=await f.migrate(),head=migration.receipt.result,id=randomUUID(),suffix=`/writes/${head.epoch}/${id}`;
    const fence=await f.read(await f.request('POST',suffix+'/recover',{}));assert.equal(fence.termination?.state,'not-executed');
    await f.read(await f.request('PUT','/document',{mutationId:id,modeEpoch:head.epoch,baseRevision:head.revision,baseHash:head.hash,content:document('Never commit')}),409);
    await f.reopen();assert.deepEqual(await f.read(await f.request('GET',suffix)),fence);
    await f.read(await f.request('GET',`/migrations/${migration.requestId}`,undefined,undefined,JSON.stringify(['taskboard','other'])),404);
  });
  test(`${mode}: disabled writes retain reads, reject extra authority and stale or revoked credentials`,async t=>{
    const f=await fixture(t,mode),migration=await f.migrate();f.config.boardFilesEnabled=false;
    await f.read(await f.request('POST','/migrate',{requestId:randomUUID(),revision:1}),503);
    await f.read(await f.request('POST',`/migrations/${migration.requestId}/recover`,{}),503);
    assert.deepEqual((await f.read(await f.request('GET','/migrations/'+migration.requestId))).receipt,migration.receipt);
    f.config.boardFilesEnabled=true;
    await f.read(await f.request('POST','/migrate',{requestId:randomUUID(),revision:1,owner:'injected'}),400);
    await f.read(await f.request('GET','/migrations/'+migration.requestId,undefined,{'x-agentopsdeck-key':f.key.token,'x-agentopsdeck-recovery-scope':'0'.repeat(64)}),409);
    await f.revoke();await f.read(await f.request('GET','/migrations/'+migration.requestId),401);
  });
}
