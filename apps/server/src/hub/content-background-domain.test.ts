import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { executeContentBackground, validContentBackgroundCommand, validContentBackgroundResult, matchesContentBackgroundReply } from './content-background-domain.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncContentBackgroundAccess } from './async-content-background-access.js';
import { encodeHubSessionId } from './session-id.js';
import { AsyncContentBackground } from './async-content-background.js';

const resource = JSON.stringify(['taskboard','default']);
async function fixture(t: TestContext, count = 6) {
  const owner = new HubStore(':memory:','fixture'); t.after(() => owner.close());
  owner.upsertConnection({ id: 'local',kind: 'local',label: 'Local',connectorUrl: 'local://aod-connector' });
  owner.pinConnectionNode('local','default',owner.connectionAuthority('local','default')!,'node_' + randomUUID());
  const authority = owner.connectionAuthority('local','default')!;
  const store = owner.createContentDocumentStore();
  const head = await store.initializeAsync('default',resource,randomUUID(),JSON.stringify({kind:'taskboard',content:{title:'Private',tasks:[]}}));
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const id = randomUUID(); ids.push(id);
    await store.bindAsync('default',resource,id,JSON.stringify(['local',authority]),{
      target: { sessionId: encodeHubSessionId('local','codex:fixture-'+n),connectionId: 'local',sessionKey: 'codex:fixture-'+n,authority },
      epoch: head.epoch,revision: head.revision });
  }
  return { owner,store,ids,head,db: (owner as unknown as {db: DatabaseSync}).db,
    command: (command: Parameters<typeof executeContentBackground>[1]) => executeContentBackground(owner,command) };
}
test('private background scans four original bindings, requires releases, advances and wraps cursor',async t => {
  const f = await fixture(t),first = await f.command({action:'scan',after:0});
  assert.equal(first.action,'scan'); if (first.action !== 'scan') return;
  assert.equal(first.work.length,4); assert.ok(validContentBackgroundResult(first));
  await assert.rejects(f.command({action:'scan',after:first.cursor}));
  for (const w of first.work) {
    const binding = await f.command({action:'current',reference:w.reference});
    assert.equal(binding.action,'current');
    if (binding.action === 'current') { assert.equal(binding.binding.id,w.id);assert.equal(binding.binding.generation,w.generation); }
    const access = await f.command({action:'access',reference:w.reference});
    assert.ok(validContentBackgroundResult(access));assert.equal(access.action,'access');
    if (access.action === 'access') { assert.equal(access.token,null);assert.equal(access.connection.id,'local'); }
    await f.command({action:'release',reference:w.reference});await f.command({action:'release',reference:w.reference});
    await assert.rejects(f.command({action:'current',reference:w.reference}));
  }
  const second = await f.command({action:'scan',after:first.cursor});assert.equal(second.action,'scan');if(second.action!=='scan')return;
  assert.equal(second.work.length,2);assert.ok(second.cursor>first.cursor);
  for(const w of second.work)await f.command({action:'release',reference:w.reference});
  const third = await f.command({action:'scan',after:second.cursor});assert.equal(third.action,'scan');if(third.action!=='scan')return;
  assert.equal(third.work.length,4);assert.equal(third.cursor,first.cursor);
  assert.deepEqual(third.work.map(w=>w.id),first.work.map(w=>w.id));
  assert.notEqual(third.work[0]?.reference,first.work[0]?.reference);
});
test('private background rechecks original owner existence and preserves release after owner deletion',async t => {
  const f=await fixture(t,1),page=await f.command({action:'scan',after:0});assert.equal(page.action,'scan');if(page.action!=='scan')return;
  const reference=page.work[0]!.reference;
  f.db.prepare("DELETE FROM users WHERE id='default'").run();
  await assert.rejects(f.command({action:'current',reference}));await assert.rejects(f.command({action:'access',reference}));
  await f.command({action:'release',reference});
  const next=await f.command({action:'scan',after:0});assert.equal(next.action,'scan');if(next.action==='scan')assert.equal(next.work.length,0);
});
test('private background cannot cross resource, generation or binding scope and refuses tombstones',async t => {
  const f=await fixture(t,2),page=await f.command({action:'scan',after:0});assert.equal(page.action,'scan');if(page.action!=='scan')return;
  const work=page.work[0]!;
  await assert.rejects(f.command({action:'sync',reference:work.reference,command:{action:'sync-projection-next',id:f.ids[1]!,generation:work.generation,excluded:[]}}));
  await assert.rejects(f.command({action:'sync',reference:work.reference,command:{action:'sync-projection-next',id:work.id,generation:randomUUID(),excluded:[]}}));
  f.store.revoke('default',resource,work.id);
  await assert.rejects(f.command({action:'current',reference:work.reference}));
  await f.command({action:'release',reference:work.reference});
});
test('private background rejects a recreated owner and changed original node but can release its page',async t=>{
  const f=await fixture(t,1),page=await f.command({action:'scan',after:0});assert.equal(page.action,'scan');if(page.action!=='scan')return;
  const reference=page.work[0]!.reference;
  f.db.prepare("UPDATE users SET created_at=created_at+1 WHERE id='default'").run();
  await assert.rejects(f.command({action:'current',reference}));await f.command({action:'release',reference});
  const next=await f.command({action:'scan',after:0});assert.equal(next.action,'scan');if(next.action!=='scan')return;
  f.db.prepare("UPDATE env_connections SET node_id=? WHERE id='local'").run('node_'+randomUUID());
  await assert.rejects(f.command({action:'access',reference:next.work[0]!.reference}));
  await f.command({action:'release',reference:next.work[0]!.reference});
});
test('private background serializes immutable commands, bounds its queue and drains original ACKs on close',async()=>{
  let finish!:()=>void,started!:()=>void;const held=new Promise<void>(r=>{finish=r;}),entered=new Promise<void>(r=>{started=r;});
  const seen:string[]=[];
  const access=new AsyncContentBackgroundAccess({command:async command=>{
    assert.equal(command.action,'release');if(command.action!=='release')throw Error('unexpected');
    seen.push(command.reference);if(seen.length===1){started();await held;}
    return {action:'release',reference:command.reference};
  }});
  const first=access.command({action:'release',reference:randomUUID()});await entered;
  const input={action:'release' as const,reference:randomUUID()},original=input.reference,second=access.command(input);input.reference=randomUUID();
  const rest=Array.from({length:14},()=>access.command({action:'release',reference:randomUUID()}));
  await assert.rejects(access.command({action:'release',reference:randomUUID()}));
  let closed=false;const close=access.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  await assert.rejects(access.command({action:'release',reference:randomUUID()}));
  finish();await Promise.all([first,second,...rest,close]);assert.equal(seen[1],original);assert.equal(seen.length,16);
});
test('lost release ACK is retried idempotently before scanning and is never an excuse to replay an effect',async()=>{
  const reference=randomUUID(),work={reference,id:randomUUID(),generation:randomUUID(),resource};let scans=0,releases=0,effects=0;
  const access=new AsyncContentBackgroundAccess({command:async command=>{
    if(command.action==='scan')return {action:'scan',cursor:++scans,work:scans===1?[work]:[]};
    if(command.action==='release'){if(++releases===1)throw Error('lost_release_ack');return {action:'release',reference:command.reference};}
    throw Error('stale_original_binding');
  }});
  const background=new AsyncContentBackground(access,async()=>{effects++;throw Error('must_not_execute');},()=>true);
  await background.syncTick();assert.equal(scans,1);assert.equal(releases,1);
  await background.syncTick();assert.equal(scans,2);assert.equal(releases,2);assert.equal(effects,0);await background.close();
});
test('generic administrative commands cannot acquire trusted background authority',async t=>{
  const f=await fixture(t,1),owner=new OriginalHubAdministrativeCommands(f.owner);t.after(()=>owner.close());
  await assert.rejects(owner.command('contentBackground',{action:'scan',after:0}));
  const privateAccess=new AsyncContentBackgroundAccess(owner.contentBackground());
  const page=await privateAccess.command({action:'scan',after:0});assert.equal(page.action,'scan');
  await assert.rejects(privateAccess.command({action:'current',reference:randomUUID()}));
  if(page.action==='scan')for(const w of page.work)await privateAccess.command({action:'release',reference:w.reference});
  await privateAccess.close();await assert.rejects(privateAccess.command({action:'scan',after:0}));
});
test('private fixed DTOs reject supplied owner, HTTP proof, arbitrary command and mismatched replies',()=>{
  const reference=randomUUID(),id=randomUUID(),generation=randomUUID();
  for(const command of [
    {action:'scan',after:-1},{action:'scan',after:0,owner:'default'},
    {action:'scan',after:0,evidence:{accessKey:'PRIVATE'}},{action:'access',reference,administrator:true},
    {action:'sync',reference,command:{action:'write',resourceId:resource}},
    {action:'sync',reference,command:{action:'sync-projection-next',resourceId:resource,id,generation,excluded:[]}},
    ...(['sync-resolution-claim','sync-resolution-ack'] as const).map(action=>({action:'sync',reference,command:{action,id,generation,
      intent:{conflictId:randomUUID(),mutationId:randomUUID(),expectedHash:'a'.repeat(64),epoch:randomUUID(),revision:1,hash:'b'.repeat(64)}}})),
  ])assert.equal(validContentBackgroundCommand(command),false);
  assert.equal(validContentBackgroundCommand({action:'sync',reference,command:{action:'sync-projection-next',id,generation,excluded:[]}}),true);
  assert.equal(matchesContentBackgroundReply({action:'release',reference},{action:'release',reference:randomUUID()}),false);
  assert.equal(validContentBackgroundResult({action:'scan',cursor:0,work:Array.from({length:5},()=>({reference:randomUUID(),id,generation,resource}))}),false);
});
