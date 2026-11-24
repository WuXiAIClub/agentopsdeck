import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {HubStore} from './hub-store.js';
import {AsyncHubMemberOwner} from './async-member-owner.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import {AsyncWeixinBackgroundAccess} from './async-weixin-background-access.js';
import {WeixinService} from './weixin-service.js';
import {weixinBridge, weixinRequestBinding} from './weixin-bridge.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {WEIXIN_ORIGIN, type WeixinTransport} from './weixin-transport.js';
import type {WeixinBackgroundResult} from './weixin-background-domain.js';
import type {HubPrincipal} from './identity.js';

const account = {botId:'test-bot',peerId:'test-peer',token:'PRIVATE_BACKGROUND_PROVIDER',baseUrl:WEIXIN_ORIGIN};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {let resolve!: () => void; const promise = new Promise<void>(r => {resolve=r;}); return {promise,resolve};}
function step(result: WeixinBackgroundResult) {
  assert.ok(!('error' in result) && result.action === 'step'); return result;
}
async function fixture(t: TestContext, mode: 'original' | 'worker', auditFailure = false, count = 1) {
  const root=mkdtempSync(join(tmpdir(),'weixin-background-')), file=join(root,'hub.sqlite');
  const seed=new HubStore(file,'fixture'), rows: import('./weixin-store.js').WeixinBinding[]=[];
  const key=seed.identities.issueKey('default');
  const administrator=seed.createUser('background administrator');
  seed.roles.setHubRole({userId:'default',admin:true},administrator.id,'admin',0);
  const admin=seed.identities.issueKey(administrator.id);
  for (let i=0;i<count;i++) {
    const user=i===0?'default':seed.createUser('binding '+i).id;
    const bindingKey=i===0?key:seed.identities.issueKey(user);
    const row=seed.weixin.create(user,bindingKey.id,randomUUID()).row;
    seed.weixin.bind(row,{...account,botId:'test-bot-'+i}); rows.push(seed.weixin.get(user)!);
  }
  if (auditFailure) (seed as unknown as {db:DatabaseSync}).db.exec(`CREATE TRIGGER fail_background_audit BEFORE INSERT ON hub_auth_audit
    WHEN json_extract(new.record,'$.reason')='weixin_send_accepted' BEGIN SELECT RAISE(ABORT,'PRIVATE_BACKGROUND_AUDIT'); END`);
  await seed.close();
  const original=mode==='original'?new HubStore(file,'fixture'):undefined;
  const logs:string[]=[], diagnostics=new PerformanceDiagnostics(line=>logs.push(line));
  const owner=original?new OriginalHubAdministrativeCommands(original,diagnostics):new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},diagnostics);
  const lane=owner.weixinBackground(), access=new AsyncWeixinBackgroundAccess(owner,lane,diagnostics);
  const behavior={receive:0,send:0,bridge:0,state:'accepted' as 'accepted'|'unknown',text:'help',
    receiveWait:undefined as undefined|((signal:AbortSignal)=>Promise<void>),sendWait:undefined as undefined|((signal:AbortSignal)=>Promise<void>)};
  const transport:WeixinTransport={
    qr:async()=>{throw Error('UNEXPECTED_QR');},pollQr:async()=>{throw Error('UNEXPECTED_POLL');},
    receive:async(_account,cursor,signal)=>{behavior.receive++;await behavior.receiveWait?.(signal);return {cursor:'next',messages:cursor?[]:[{
      id:'inbound-1',peerId:account.peerId,at:Date.now(),context:'PRIVATE_CONTEXT',text:behavior.text}]};},
    send:async(_account,context,message,clientId,signal)=>{behavior.send++;assert.equal(context,'PRIVATE_CONTEXT');assert.ok(message);assert.ok(clientId);
      await behavior.sendWait?.(signal);return behavior.state;},
  };
  const service=new WeixinService({mode:'async',transport,background:access,bridge:async()=>{behavior.bridge++;return {groups:[]};}});
  t.after(async()=>{try {await service.close();} finally {try {await owner.close();} finally {await original?.close();}}
    for(const secret of [account.token,key.token,'PRIVATE_CONTEXT','PRIVATE_BACKGROUND_AUDIT']) assert.equal(logs.join('').includes(secret),false);
    rmSync(root,{recursive:true,force:true});});
  // The worker owns the sole writer. Observations must not open a second
  // HubStore beside it; reopen only after its real close acknowledgement.
  const receipt=()=>{const db=new DatabaseSync(file,{readOnly:true});try {
    return (db.prepare('SELECT state FROM hub_weixin_receipts WHERE binding_id=?').get(rows[0]!.id) as {state:string}|undefined)?.state;
  } finally {db.close();}};
  const reopen=async<T>(run:(store:HubStore)=>T)=>{await service.close();await owner.close();await original?.close();
    const store=new HubStore(file,'fixture');try{return run(store);}finally{await store.close();}};
  const revoke=async()=>{const evidence={accessKey:admin.token},actor=await owner.command('memberSnapshot',evidence);assert.ok(actor);
    await owner.command('memberKeyRevoke',{evidence,expectedScope:actor.recoveryScope,userId:'default',keyId:key.id});};
  return {owner,lane,access,service,rows,key,file,behavior,receipt,reopen,revoke};
}

for(const mode of ['original','worker'] as const) {
  test(`${mode}: background receive/admission/send/settlement uses only fixed owner commands and survives reopen`,async t=>{
    const f=await fixture(t,mode);
    await f.service.tick(f.rows[0]!);
    assert.equal(f.behavior.receive,1);assert.equal(f.behavior.send,1);
    await f.service.tick(f.rows[0]!);
    assert.equal(f.behavior.receive,2);assert.equal(f.behavior.send,1);
    assert.equal(f.receipt(),'accepted');
    assert.equal(await f.reopen(s=>s.weixin.secrets(f.rows[0]!).cursor),'next');
  });
  test(`${mode}: unknown send is durable and the same inbound intent is never replayed`,async t=>{
    const f=await fixture(t,mode);f.behavior.state='unknown';await f.service.tick(f.rows[0]!);await f.service.tick(f.rows[0]!);
    assert.equal(f.behavior.send,1);assert.equal(f.receipt(),'unknown');
  });
  test(`${mode}: receive observation UUID is consumed once and stale begin cannot create authority`,async t=>{
    const f=await fixture(t,mode), row=f.rows[0]!;
    await assert.rejects(f.owner.command('weixinBackground',{action:'scan'}));
    assert.deepEqual(await f.lane.command({action:'begin',binding:{...row,keyId:randomUUID()}}),{error:'denied'});
    const first=step(await f.lane.command({action:'begin',binding:row}));assert.ok(first.work);
    const command={action:'observe' as const,reference:first.reference,effectId:first.work.effectId,
      observation:{kind:'receive' as const,batch:{cursor:'saved',messages:[]}}};
    assert.equal(step(await f.lane.command(command)).work,null);
    assert.deepEqual(await f.lane.command(command),{error:'denied'});
    assert.equal(await f.reopen(s=>s.weixin.secrets(row).cursor),'saved');
  });
  test(`${mode}: shutdown waits abort-ignoring send and original settlement, without following work`,async t=>{
    const f=await fixture(t,mode), entered=deferred(),release=deferred();let signal:AbortSignal|undefined;
    f.behavior.sendWait=async s=>{signal=s;entered.resolve();await release.promise;};
    const ticking=f.service.tick(f.rows[0]!);await entered.promise;
    let closed=false;const closing=f.service.close().then(()=>{closed=true;});
    assert.equal(signal?.aborted,true);await turn();assert.equal(closed,false);assert.equal(f.service.close(),f.service.close());
    release.resolve();await ticking;await closing;
    assert.equal(f.behavior.send,1);assert.equal(f.behavior.bridge,0);
    assert.equal(f.receipt(),'accepted');
  });
  test(`${mode}: revoked binding preserves the acknowledged original send but dispatches no next work`,async t=>{
    const f=await fixture(t,mode),entered=deferred(),release=deferred();
    f.behavior.sendWait=async()=>{entered.resolve();await release.promise;};
    const ticking=f.service.tick(f.rows[0]!);await entered.promise;
    try {await f.revoke();} finally {release.resolve();} await ticking;
    assert.equal(f.behavior.send,1);assert.equal(f.behavior.bridge,0);
    assert.equal(f.receipt(),'accepted');
  });
  test(`${mode}: audit failure rolls back original settlement and cursor dedupe prevents redispatch`,async t=>{
    const f=await fixture(t,mode,true);await assert.rejects(f.service.tick(f.rows[0]!));
    assert.equal(f.behavior.send,1);assert.equal(f.receipt(),'unknown');
    await f.service.tick(f.rows[0]!);assert.equal(f.behavior.send,1);
  });
  test(`${mode}: background and management effects share the four-original budget`,async t=>{
    const f=await fixture(t,mode,false,5),entered=deferred(),release=deferred();let count=0;
    f.behavior.receiveWait=async()=>{if(++count===4)entered.resolve();await release.promise;};
    const jobs=f.rows.slice(0,4).map(row=>f.service.tick(row));await entered.promise;
    await assert.rejects(f.service.runBindingEffect(f.rows[4]!.id,new AbortController().signal,async()=>{}));
    await assert.rejects(f.service.tick(f.rows[0]!));release.resolve();await Promise.all(jobs);assert.equal(f.behavior.receive,4);
  });
  test(`${mode}: asynchronous bridge preserves exact private Request identity and never reads captured HubStore`,async t=>{
    const f=await fixture(t,mode), app=new Hono(), internal=new WeakMap<Request,()=>HubPrincipal|undefined>();let original:Request|undefined;
    app.get('/api/hub/v1/sessions/state',c=>{original=c.req.raw;assert.equal(internal.get(original)?.()?.userId,'default');
      assert.equal(weixinRequestBinding(original)?.id,f.rows[0]!.id);assert.equal(weixinRequestBinding(new Request(original.url)),undefined);
      return c.json({groups:[]});});
    const bridge=weixinBridge(app,{mode:'async',internal,access:f.access});
    assert.deepEqual(await bridge(f.rows[0]!,'/api/hub/v1/sessions/state',new AbortController().signal),{groups:[]});
    assert.ok(original);assert.equal(internal.has(original),false);assert.equal(weixinRequestBinding(original),undefined);
    await assert.rejects(bridge(f.rows[0]!,'/api/hub/v1/keys',new AbortController().signal));
  });
}

test('scan singleflight retains original SQL ACK through close and cannot launch late provider work',async()=>{
  const entered=deferred(),release=deferred();let scans=0,closed=0;
  const background={command:async()=>{scans++;entered.resolve();await release.promise;return {action:'scan',bindings:[]};},close:async()=>{closed++;}} as unknown as AsyncWeixinBackgroundAccess;
  const poison=new Proxy({},{get(){throw Error('UNEXPECTED_SYNC_OR_PROVIDER');}});
  const service=new WeixinService(poison as HubStore['weixin'],poison as WeixinTransport,async()=>{throw Error('UNEXPECTED_BRIDGE');},()=>{},Date.now,background);
  const scan=service.scan();assert.equal(scan,service.scan());await entered.promise;
  let done=false;const closing=service.close().then(()=>{done=true;});await turn();assert.equal(done,false);
  release.resolve();await scan;await closing;await service.scan();assert.equal(scans,1);assert.equal(closed,1);
});
