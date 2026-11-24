import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { executeHubMemberCommand, type HubMemberEvidence } from './member-owner-domain.js';
import { createAccessKeyGuard } from '../auth/access-key.js';
import { keyIdentityHash } from '../auth/security.js';
import { openSqliteAuth } from '../auth/sqlite-store.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';

const administratorKey='isolated-legacy-command-authority';
const token='a'.repeat(43);
async function fixture(work: (f: {
  hub: HubStore; auth: ReturnType<typeof openSqliteAuth>; scope: string; db: DatabaseSync;
}) => void | Promise<void>) {
  const root=mkdtempSync(join(tmpdir(),'legacy-command-authority-'));
  const auth=openSqliteAuth(join(root,'auth.sqlite'),[],()=>keyIdentityHash(administratorKey));
  let hub: HubStore | undefined;
  try {
    hub=new HubStore(join(root,'hub.sqlite'),'isolated-authority-secret',[],administratorKey,
      createAccessKeyGuard(administratorKey,auth.sessions));
    await work({hub,auth,scope:hub.identities.recoveryScope(LEGACY_HUB_PRINCIPAL),
      db:(hub as unknown as {db:DatabaseSync}).db});
  } finally {
    try { await hub?.close(); } finally { await auth.close(); rmSync(root,{recursive:true,force:true}); }
  }
}
function snapshot(hub:HubStore,evidence:HubMemberEvidence) {
  return executeHubMemberCommand(hub,'memberSnapshot',evidence);
}
function save(hub:HubStore,scope:string,evidence:HubMemberEvidence,revision=0) {
  return executeHubMemberCommand(hub,'workspaceSave',{evidence,expectedScope:scope,
    document:{revision,groups:[],sessions:{},ungroupedCollapsed:true}});
}

test('typed Hub commands resolve the original administrator key inside the same savepoint',()=>fixture(f=>{
  assert.deepEqual(snapshot(f.hub,{accessKey:administratorKey}),{principal:LEGACY_HUB_PRINCIPAL,recoveryScope:f.scope});
  assert.equal(snapshot(f.hub,{accessKey:'incorrect'}),null);
  assert.equal(save(f.hub,f.scope,{accessKey:'incorrect'}),null);
  assert.equal(f.hub.workspace.get('default').revision,0);
  assert.deepEqual(save(f.hub,f.scope,{accessKey:administratorKey}),{
    document:{revision:1,groups:[],sessions:{},ungroupedCollapsed:true}});
  assert.equal(save(f.hub,'0'.repeat(64),{accessKey:administratorKey},1),null);
  assert.equal(f.hub.workspace.get('default').revision,1);
}));

test('existing key-login cookie remains valid; original deletion immediately denies the next command',()=>fixture(f=>{
  f.auth.sessions.add(token);
  const evidence={sessionToken:token};
  assert.deepEqual(snapshot(f.hub,evidence),{principal:LEGACY_HUB_PRINCIPAL,recoveryScope:f.scope});
  // General legacy guard historically checks the cookie BEFORE a supplied
  // non-member key; this is not Weixin explicit-key-precedence authority.
  assert.deepEqual(snapshot(f.hub,{...evidence,accessKey:'wrong-key'}),snapshot(f.hub,evidence));
  assert.ok(save(f.hub,f.scope,evidence));
  f.auth.sessions.delete(token);
  assert.equal(snapshot(f.hub,evidence),null);
  assert.equal(save(f.hub,f.scope,evidence,1),null);
  assert.equal(f.hub.workspace.get('default').revision,1);
}));

test('explicit invalid or revoked member credentials never inherit legacy administrator authority',()=>fixture(f=>{
  f.auth.sessions.add(token);
  const user=f.hub.createUser('isolated member');
  const key=f.hub.identities.issueKey(user.id);
  const memberToken=f.hub.identities.createSession(key.token)!;
  const memberScope=f.hub.identities.recoveryScope({userId:user.id,admin:false});
  assert.deepEqual(snapshot(f.hub,{accessKey:key.token,sessionToken:token}),{
    principal:{userId:user.id,admin:false},recoveryScope:memberScope});
  f.hub.identities.revokeKey(user.id,key.id);
  assert.equal(snapshot(f.hub,{accessKey:key.token,sessionToken:token}),null);
  assert.equal(snapshot(f.hub,{accessKey:administratorKey,sessionToken:memberToken}),null);
  assert.equal(save(f.hub,f.scope,{accessKey:key.token,sessionToken:token}),null);
  assert.equal(f.hub.workspace.get('default').revision,0);
}));

test('no fallback is enabled merely by supplying the configured administrator key to a member-only owner',async()=>{
  const hub=new HubStore(':memory:','isolated-member-only',[],administratorKey);
  try {
    assert.equal(snapshot(hub,{accessKey:administratorKey}),null);
    assert.equal(snapshot(hub,{}),null);
  } finally {await hub.close();}
});

test('explicit anonymous legacy compatibility is bound by trusted construction, never by a command field',async()=>{
  const hub=new HubStore(':memory:','isolated-anonymous',[],undefined,createAccessKeyGuard(undefined));
  try {
    const scope=hub.identities.recoveryScope(LEGACY_HUB_PRINCIPAL);
    assert.deepEqual(snapshot(hub,{}),{principal:LEGACY_HUB_PRINCIPAL,recoveryScope:scope});
    assert.ok(save(hub,scope,{}));
    assert.equal(snapshot(hub,{accessKey:'hub_key_'+ 'x'.repeat(43)}),null);
  } finally {await hub.close();}
});

test('an asynchronous original authority cannot become a truthy grant and its same-connection write rolls back',async()=>{
  const root=mkdtempSync(join(tmpdir(),'legacy-command-retirement-'));
  const file=join(root,'hub.sqlite');
  let db:DatabaseSync;
  const invalid=(()=>{
    db.prepare('UPDATE users SET label = ? WHERE id = ?').run('must roll back','default');
    return Promise.resolve(true);
  }) as unknown as (request:Request)=>boolean;
  const hub=new HubStore(file,'isolated-invalid-authority',[],administratorKey,invalid);
  db=(hub as unknown as {db:DatabaseSync}).db;
  let reopened:HubStore|undefined;
  try {
    const before=hub.getUser('default');
    assert.throws(()=>snapshot(hub,{accessKey:administratorKey}));
    // A detected async participant poisons the original lifetime. Do not
    // bypass retirement to inspect data through that same live connection.
    assert.equal(connectionRecoverySnapshot(db).state,'close-required');
    assert.throws(()=>hub.getUser('default'));
    await hub.close();
    reopened=new HubStore(file,'isolated-invalid-authority',[],administratorKey);
    assert.deepEqual(reopened.getUser('default'),before);
    assert.equal(reopened.workspace.get('default').revision,0);
  } finally {
    try {await reopened?.close();await hub.close();}
    finally {rmSync(root,{recursive:true,force:true});}
  }
});

test('original Hub SQL failure rolls back the command without invalidating the original auth session',()=>fixture(f=>{
  f.auth.sessions.add(token);
  f.db.exec("CREATE TRIGGER reject_authority_workspace BEFORE INSERT ON hub_workspace_preferences BEGIN SELECT RAISE(ABORT,'isolated_failure'); END");
  assert.throws(()=>save(f.hub,f.scope,{sessionToken:token}));
  assert.equal(f.auth.sessions.has(token),true);
  assert.equal(f.hub.workspace.get('default').revision,0);
  f.db.exec('DROP TRIGGER reject_authority_workspace');
  assert.ok(save(f.hub,f.scope,{sessionToken:token}));
}));

async function signedLogin(auth:ReturnType<typeof openSqliteAuth>) {
  const origin='https://hub.example';
  const request=new Request(origin,{headers:{origin}});
  const key=keyIdentityHash(administratorKey);
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const jwk=publicKey.export({format:'jwk'});
  const cose=Buffer.concat([Buffer.from('a5010203262001215820','hex'),Buffer.from(jwk.x!,'base64url'),
    Buffer.from('225820','hex'),Buffer.from(jwk.y!,'base64url')]);
  const id=Buffer.from('legacy-hub-authority-fixture').toString('base64url');
  auth.passkeys.importLegacy([{id,publicKey:cose.toString('base64url'),counter:0,rpId:'hub.example',
    keyIdentityHash:key,createdAt:1,label:'isolated'}],true);
  const options=await auth.passkeys.authenticationOptions(request,key);
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.challenge,origin}));
  const data=Buffer.alloc(37);
  createHash('sha256').update('hub.example').digest().copy(data);data[32]=5;data.writeUInt32BE(1,33);
  const response:AuthenticationResponseJSON={id,rawId:id,type:'public-key',clientExtensionResults:{},response:{
    clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),
    signature:sign('sha256',Buffer.concat([data,createHash('sha256').update(client).digest()]),privateKey).toString('base64url'),
  }};
  const login=await auth.passkeys.verifyAuthentication(request,response,key);
  assert.equal(login.verified,true);
  if(!login.verified)throw Error('isolated_login_rejected');
  return {key,request,response,sessionToken:login.sessionToken,credentialId:auth.passkeys.list(key)[0]!.id};
}

test('a real signed original passkey cookie authorizes Hub commands until credential revocation',()=>fixture(async f=>{
  const login=await signedLogin(f.auth);
  const evidence={sessionToken:login.sessionToken};
  // Passkeys are accepted by the original general guard, but do not turn into
  // administrator-key sessions for the separate Weixin policy.
  assert.equal(f.auth.sessions.isAccessKeySession(login.sessionToken),false);
  assert.deepEqual(snapshot(f.hub,evidence),{principal:LEGACY_HUB_PRINCIPAL,recoveryScope:f.scope});
  assert.ok(save(f.hub,f.scope,evidence));
  f.auth.passkeys.revoke(login.key,login.credentialId);
  assert.equal(snapshot(f.hub,evidence),null);
  assert.equal(save(f.hub,f.scope,evidence,1),null);
  assert.equal(f.hub.workspace.get('default').revision,1);
}));

test('replaying a consumed signed assertion creates no new authority and logout denies the original cookie',()=>fixture(async f=>{
  const login=await signedLogin(f.auth);
  const evidence={sessionToken:login.sessionToken};
  assert.equal((await f.auth.passkeys.verifyAuthentication(login.request,login.response,login.key)).verified,false);
  assert.ok(snapshot(f.hub,evidence));
  f.auth.sessions.delete(login.sessionToken);
  assert.equal(snapshot(f.hub,evidence),null);
  assert.equal(save(f.hub,f.scope,evidence),null);
  assert.equal(f.hub.workspace.get('default').revision,0);
}));
