import type { DatabaseSync } from 'node:sqlite';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { boundReceivedGrantRows } from './member-received-grants-domain.js';
export type HubCreationDiscoveryCommand = { userId:string; after:string };
export type HubCreationEnvironment = { ownerUserId:string; connectionId:string; label:string; kind:'local'|'remote'; status:'enabled'|'disabled'|'degraded' };
export type HubCreationDiscoveryResult = null | HubCreationDiscoveryCommand & { page:{environments:HubCreationEnvironment[];nextCursor:string|null} };
export const HUB_CREATION_DISCOVERY_RESULT_BYTES=2*1024*1024;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,fields:string[])=>Object.keys(v).length===fields.length&&Object.keys(v).every(k=>fields.includes(k));
const text=(v:unknown):v is string=>typeof v==='string'&&Buffer.byteLength(v)<=65536;
const id=(v:unknown):v is string=>text(v)&&v.length>0&&Buffer.byteLength(v)<=16384;
const cursor=(v:unknown):v is string=>typeof v==='string'&&(v===''||/^[0-9a-f-]{36}$/.test(v));
export function validHubCreationDiscoveryCommand(v:unknown):v is HubCreationDiscoveryCommand {
  return object(v)&&keys(v,['userId','after'])&&id(v.userId)&&cursor(v.after);
}
export function validHubCreationDiscoveryResult(v:unknown):v is HubCreationDiscoveryResult {
  if(v===null)return true;
  if(!object(v)||!keys(v,['userId','after','page'])||!validHubCreationDiscoveryCommand({userId:v.userId,after:v.after})
    ||!object(v.page)||!keys(v.page,['environments','nextCursor'])||!Array.isArray(v.page.environments)||v.page.environments.length>50
    ||!(v.page.nextCursor===null||cursor(v.page.nextCursor)&&v.page.nextCursor>(v.after as string)))return false;
  const seen=new Set<string>();
  return v.page.environments.every(e=>{
    if(!object(e)||!keys(e,['ownerUserId','connectionId','label','kind','status'])||!id(e.ownerUserId)||!id(e.connectionId)||!text(e.label)
      ||!['local','remote'].includes(e.kind as string)||!['enabled','disabled','degraded'].includes(e.status as string))return false;
    const key=JSON.stringify([e.ownerUserId,e.connectionId]);if(seen.has(key))return false;seen.add(key);return true;
  });
}
export function validHubCreationDiscoveryReply(command:HubCreationDiscoveryCommand,v:unknown):v is HubCreationDiscoveryResult {
  return validHubCreationDiscoveryResult(v)&&(v===null||v.userId===command.userId&&v.after===command.after);
}
/** Discovery ONLY: original grant/role/issuer checks on the same connection.
 * Never calls Connector, provisions credentials, creates a session, claims a
 * receipt/lease, or treats this projection as later execution authority. */
export function executeHubCreationDiscoveryCommand(db:DatabaseSync,store:HubStore,actor:HubPrincipal,command:HubCreationDiscoveryCommand):HubCreationDiscoveryResult {
  if(!validHubCreationDiscoveryCommand(command))throw Error('hub_creation_discovery_unavailable');
  if(actor.userId!==command.userId)return null;
  boundReceivedGrantRows(db);
  const page=store.grants.received(actor.userId,command.after,50),seen=new Set<string>();
  const environments=page.grants.flatMap(grant=>{
    const key=JSON.stringify([grant.ownerUserId,grant.connectionId]);
    if(seen.has(key)||!store.grants.authorize({userId:actor.userId,ownerUserId:grant.ownerUserId,connectionId:grant.connectionId},'sessions:create',{runtime:'codex'}))return [];
    const connection=store.getConnection(grant.connectionId,grant.ownerUserId),issuer=store.executionIssuers.current(grant.ownerUserId,grant.connectionId);
    if(!connection||!issuer?.creationAllowed||issuer.nodeId!==connection.nodeId)return [];
    seen.add(key);return [{ownerUserId:grant.ownerUserId,connectionId:connection.id,label:connection.environmentLabel??connection.label,kind:connection.kind,status:connection.status}];
  });
  return {...command,page:{environments,nextCursor:page.nextCursor}};
}
