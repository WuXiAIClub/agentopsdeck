import { registerCacheCleaner } from './cache-cleaners.js';
import { validWorkspaceFileCard, validBoardUuid, type WorkspaceFileCard } from '@agentopsdeck/shared';
export type SharedHead={epoch:string;revision:number;hash:string;content:string};
export type SharedBinding={id:string;generation:string;revoked:boolean;acknowledgedRevision:number;target?:{sessionId:string}};
export type SharedSnapshot={enabled:boolean;head:SharedHead|null;native:(WorkspaceFileCard&{revision:number})|null;bindings:SharedBinding[];nativeView?:'hot'};
/** The shared-mode gate needs hot content and the aggregate revision, not the
 * archive. Archive editors already have a separate, lazy authorized route. */
export function sharedOverviewSuffix(resource:string):string {
  try{return JSON.parse(resource)[0]==='notebook'?'?view=hot':'';}catch{return '';}
}
export type SharedPending={id:string;kind:'migration'|'write'|'binding'|'resolution';original:string;epoch?:string;warningDismissed?:true};
export type SharedDraft={base:SharedHead;text:string};
/** Only an exact server-side fence proves that an absent migration cannot run
 * later. Null receipts, current native content and a hidden warning do not. */
export function validMigrationTermination(value:unknown,id:string,resource:string):boolean {
  try {
    const v=value as {mutationId:string;resource:string;state:string},ref=JSON.parse(resource);
    const canonical=ref[0]==='statuscard'?JSON.stringify(['taskboard',ref[1]]):resource;
    return !!v&&validBoardUuid(id)&&v.mutationId===id&&v.resource===canonical&&v.state==='not-executed';
  }catch{return false;}
}
export function validWriteTermination(value:unknown,intent:SharedPending,resource:string):boolean {
  return intent.kind==='write'&&validMigrationTermination(value,intent.id,resource)
    &&(value as {epoch?:unknown}).epoch===intent.original.split('/')[2];
}
/** A copy is independent of recovery and never a claim that a save succeeded.
 * Preserve even malformed/transient JSON drafts rather than losing local text. */
export function sharedRecoveryCopy(draft:SharedDraft|undefined,snapshot:SharedSnapshot|undefined):{text:string;filename:string}|undefined {
  const text=draft?.text??snapshot?.head?.content??(snapshot?.native&&snapshot.nativeView!=='hot'?JSON.stringify(snapshot.native):undefined);
  if(text===undefined)return;
  return {text,filename:draft?'agentopsdeck-local-draft.json':'agentopsdeck-read-copy.json'};
}
export function sharedCard(text:string):WorkspaceFileCard|undefined {try{const value:unknown=JSON.parse(text);return validWorkspaceFileCard(value)?value:undefined;}catch{return;}}
/** Permit transient empty titles while editing, but never use this for saving. */
export function editableSharedCard(text:string):WorkspaceFileCard|undefined {
  try {
    const value=JSON.parse(text),copy=structuredClone(value);
    if(!copy?.content||typeof copy.content.title!=='string')return;
    if(!copy.content.title.trim())copy.content.title='Draft';
    if(copy.kind==='taskboard'||copy.kind==='statuscard'){
      if(!Array.isArray(copy.content.tasks))return;
      for(const task of copy.content.tasks){if(!task||typeof task.title!=='string')return;if(!task.title.trim())task.title='Draft';}
    }
    return validWorkspaceFileCard(copy)?value:undefined;
  }catch{return;}
}
export function validSharedHead(value:unknown):value is SharedHead {
  const v=value as SharedHead;return !!v&&validBoardUuid(v.epoch)&&Number.isSafeInteger(v.revision)&&v.revision>=0
    &&typeof v.hash==='string'&&/^[a-f0-9]{64}$/.test(v.hash)&&typeof v.content==='string'&&!!sharedCard(v.content);
}
export function sharedDraft(value:string|null):SharedDraft|undefined {try{const v=JSON.parse(value??'null');return v&&validSharedHead(v.base)&&typeof v.text==='string'&&v.text.length<=2*1024*1024?{base:v.base,text:v.text}:undefined;}catch{return;}}
export function sharedPending(value:string|null):SharedPending|undefined {try{
  const v=JSON.parse(value??'null');if(!v||!validBoardUuid(v.id)||typeof v.original!=='string')return;
  const p=v.original.split('/');
  const valid=(v.kind==='migration'&&p.length===3&&p[1]==='migrations'&&p[2]===v.id)
    ||(v.kind==='binding'&&p.length===3&&p[1]==='bindings'&&p[2]===v.id)
    ||(v.kind==='write'&&p.length===4&&p[1]==='writes'&&validBoardUuid(p[2])&&p[3]===v.id)
    ||(v.kind==='resolution'&&p.length===5&&p[1]==='bindings'&&validBoardUuid(p[2])&&p[3]==='proposals'&&p[4]===v.id);
  if(v.warningDismissed!==undefined&&v.warningDismissed!==true)return;
  return valid&&p[0]===''?{id:v.id,kind:v.kind,original:v.original,...(v.warningDismissed===true?{warningDismissed:true as const}:{})}:undefined;
}catch{return;}}
/** Presentation only: retain the pending request and all write/reload guards. */
export function sharedPendingWarning(value:SharedPending,dismissed:boolean):SharedPending {
  const {warningDismissed:_,...intent}=value;
  return dismissed?{...intent,warningDismissed:true}:intent;
}
/** Pure editor update retains task IDs, metadata and all unedited fields. */
export function updateSharedTask(card:WorkspaceFileCard,id:string,patch:Record<string,unknown>):WorkspaceFileCard {
  if(card.kind!=='taskboard'&&card.kind!=='statuscard')throw Error('not-taskboard');
  if(Object.keys(patch).some(k=>!['title','detail','status','tags','priority','dueDate'].includes(k)))throw Error('task-field');
  return {...card,content:{...card.content,tasks:card.content.tasks.map(t=>t.id===id?{...t,...patch}:t)}};
}

const sharedSnapshotCache = new Map<string, SharedSnapshot>();
const MAX_SHARED_SNAPSHOT_CACHE_ENTRIES = 128;

function sharedSnapshotCacheKey(scope: string, resource: string) {
  return JSON.stringify(['shared-snapshot-v1', scope, resource]);
}

export function readCachedSharedSnapshot(scope: string, resource: string): SharedSnapshot | undefined {
  if (!scope || !resource) return undefined;
  const hit = sharedSnapshotCache.get(sharedSnapshotCacheKey(scope, resource));
  return hit ? structuredClone(hit) : undefined;
}

export function writeCachedSharedSnapshot(scope: string, resource: string, snapshot: SharedSnapshot | undefined): void {
  if (!scope || !resource) return;
  const key = sharedSnapshotCacheKey(scope, resource);
  if (!snapshot) {
    sharedSnapshotCache.delete(key);
    return;
  }
  sharedSnapshotCache.delete(key);
  sharedSnapshotCache.set(key, structuredClone(snapshot));
  while (sharedSnapshotCache.size > MAX_SHARED_SNAPSHOT_CACHE_ENTRIES) {
    const oldest = sharedSnapshotCache.keys().next().value;
    if (oldest === undefined) break;
    sharedSnapshotCache.delete(oldest);
  }
}

export function clearCachedSharedSnapshots(): void {
  sharedSnapshotCache.clear();
}
registerCacheCleaner(clearCachedSharedSnapshots);
