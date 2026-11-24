import type { DelegationCatalog, DelegationMember } from './workspace-delegation-preview.js';
import { DELEGATION_PREVIEW_LIMITS } from './workspace-delegation-preview.js';

type Fence = { generation:number; preferencesRevision:number };
export interface DelegationCatalogSource {
  /** Trusted server directory only, not an HTTP request body. All changes to
   * membership/authority increment generation; group/tag changes increment prefs. */
  fence(owner:string):Fence;
  enumerate(owner:string,limit:number,signal:AbortSignal):Promise<{complete:boolean;members:DelegationMember[]}>;
  authorized(owner:string,member:Readonly<DelegationMember>):boolean;
}
const text=(v:string)=>typeof v==='string'&&v.length>0&&v.length<=2048&&v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v);
const integer=(v:number)=>Number.isSafeInteger(v)&&v>=0;
const memberKey=(m:DelegationMember)=>JSON.stringify([m.owner,m.nodeId,m.connectionId,m.runtime,m.sessionId]);
const fenceValid=(v:Fence)=>v&&integer(v.generation)&&integer(v.preferencesRevision);

/** A bounded, fail-closed server-catalog assembly step. No API registration,
 * grants, session creation or provider calls. Incomplete/offline enumeration is
 * unavailable, never an empty successful selection. Confirmation still rechecks
 * the retained preview and every member through DelegationStore/Runner. */
export async function readDelegationCatalog(owner:string,source:DelegationCatalogSource,timeoutMs=5000):Promise<DelegationCatalog> {
  if(!text(owner)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw Error('catalog-input');
  const before={...source.fence(owner)};if(!fenceValid(before))throw Error('catalog-unavailable');
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const data=await Promise.race([
      source.enumerate(owner,DELEGATION_PREVIEW_LIMITS.catalogMembers,abort.signal),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('catalog-timeout'));},timeoutMs);}),
    ]);
    if(data.complete!==true||!Array.isArray(data.members)||data.members.length>DELEGATION_PREVIEW_LIMITS.catalogMembers)throw Error('catalog-incomplete');
    const members:DelegationMember[]=[],seen=new Set<string>();
    for(const m of data.members){
      if(m.owner!==owner||![m.nodeId,m.connectionId,m.runtime,m.sessionId].every(text)||!integer(m.authorityEpoch)
        ||(m.groupId!==null&&!text(m.groupId))||!Array.isArray(m.tags)||m.tags.length>8||new Set(m.tags).size!==m.tags.length
        ||!m.tags.every(t=>text(t)&&t.length<=32)||!['supported','unsupported','unknown'].includes(m.taskBinding))throw Error('catalog-invalid-member');
      const key=memberKey(m);if(seen.has(key))throw Error('catalog-duplicate');seen.add(key);
      // Pick fields explicitly; do not retain transport credentials/history.
      const copy:DelegationMember={owner,nodeId:m.nodeId,connectionId:m.connectionId,runtime:m.runtime,sessionId:m.sessionId,
        authorityEpoch:m.authorityEpoch,groupId:m.groupId,tags:[...m.tags].sort(),taskBinding:m.taskBinding};
      Object.freeze(copy.tags);Object.freeze(copy);
      if(!source.authorized(owner,copy))throw Error('catalog-forbidden');members.push(copy);
    }
    const after=source.fence(owner);
    if(!fenceValid(after)||after.generation!==before.generation||after.preferencesRevision!==before.preferencesRevision)throw Error('catalog-changed');
    members.sort((a,b)=>memberKey(a)<memberKey(b)?-1:memberKey(a)>memberKey(b)?1:0);
    Object.freeze(members);return Object.freeze({owner,...before,complete:true,members});
  }finally{if(timer!==undefined)clearTimeout(timer);abort.abort();}
}
