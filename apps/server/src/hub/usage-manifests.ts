import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { tokenSnapshotRequestId, tokenUsageRange, validateNativeTokenSnapshot, type NativeTokenSnapshot } from '@agentopsdeck/shared';
import type { DelegationMember } from './workspace-delegation-preview.js';
import { aggregateTokenSnapshots, USAGE_AGGREGATION_LIMITS } from './token-usage-aggregation.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { synchronousSqliteValue } from '../auth/synchronous-sqlite-value.js';

export type UsageSelection = { requestId: string; from: number; to: number; bucketMs: number;
  groupId?: string; tags: string[]; tagMode: 'all'|'any'; connectionId?: string; runtime?: string; layoutId?: string };
export type UsageManifest = { owner: string; requestId: string; inputDigest: string; directoryRevision: string;
  selection: UsageSelection; createdAt: number; expiresAt: number; state: 'prepared'|'collecting'|'complete'|'cancelled';
  members: { member: DelegationMember; requestId: string; state: 'prepared'|'unknown'|'complete'; snapshot?: NativeTokenSnapshot }[] };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
export function usageSelection(raw: unknown): UsageSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('selection');
  const v = raw as Record<string, unknown>;
  if (![v.from,v.to,v.bucketMs].every(Number.isSafeInteger)) throw Error('range');
  if (Object.keys(v).some(k => !['requestId','from','to','bucketMs','groupId','tags','tagMode','connectionId','runtime','layoutId'].includes(k))) throw Error('selection');
  const requestId = tokenSnapshotRequestId(v.requestId), range = tokenUsageRange(v.from,v.to,v.bucketMs);
  if (!Array.isArray(v.tags) || v.tags.length > 8 || new Set(v.tags).size !== v.tags.length || !v.tags.every(t => text(t,32))
    || !['all','any'].includes(String(v.tagMode))) throw Error('tags');
  for (const key of ['groupId','connectionId','layoutId']) if (v[key] !== undefined && !text(v[key])) throw Error('selector');
  if (v.runtime !== undefined && !['codex','claude-code','ghcp'].includes(String(v.runtime))) throw Error('runtime');
  return { requestId,...range,tags:[...v.tags].sort() as string[],tagMode:v.tagMode as 'all'|'any',
    ...(v.groupId !== undefined ? {groupId:v.groupId as string}:{}),...(v.connectionId !== undefined ? {connectionId:v.connectionId as string}:{}),
    ...(v.runtime !== undefined ? {runtime:v.runtime as string}:{}),...(v.layoutId !== undefined ? {layoutId:v.layoutId as string}:{}) };
}

/** Immutable query-time members. The committed per-member UNKNOWN claim comes
 * before a snapshot POST. Recovery is GET-only, including after physical reopen.
 * Neither directory discovery nor snapshot collection starts a model turn. */
export class UsageManifests {
  constructor(private readonly db: DatabaseSync, private readonly authorized: (owner:string,m:DelegationMember)=>boolean, private readonly now=Date.now,
    private readonly storageAdmission?: <T>(bytes:number,write:()=>T extends PromiseLike<unknown> ? never : T)=>T,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly asyncStorageAdmission?: <T>(bytes:number,write:()=>Promise<T>)=>Promise<T>) {
    db.exec('CREATE TABLE IF NOT EXISTS hub_usage_manifests(owner TEXT,id TEXT,payload TEXT,PRIMARY KEY(owner,id))');
    db.exec('CREATE TABLE IF NOT EXISTS hub_usage_cancellations(owner TEXT,id TEXT,PRIMARY KEY(owner,id))');
  }
  private admit<T>(write:()=>T extends PromiseLike<unknown> ? never : T):T {
    // Reserve the bounded manifest plus SQLite page/WAL overhead before new
    // work. Original reads and settlement must remain available under pressure.
    if(!this.storageAdmission&&this.asyncStorageAdmission)throw Error('async-admission-required');
    return this.storageAdmission ? this.storageAdmission(USAGE_AGGREGATION_LIMITS.bytes + 65536, write) : write();
  }
  private permitted(owner:string,member:DelegationMember) {
    return synchronousSqliteValue(this.db,this.authorized,this,[owner,member])===true;
  }
  private checkRequest(check:()=>void) {
    if(synchronousSqliteValue(this.db,check)!==undefined)throw Error('request-authority');
  }
  private transaction<T>(fn:()=>T extends PromiseLike<unknown> ? never : T):T {
    requireConnectionReady(this.db);
    if(this.db.isTransaction)throw Error('outer-transaction');
    return observedTransaction(this.db, 'usage-manifest-change', fn, this.diagnostics);
  }
  read(owner:string,id:string):UsageManifest|undefined {
    if(!text(owner))throw Error('owner');tokenSnapshotRequestId(id);
    const row=this.db.prepare('SELECT payload FROM hub_usage_manifests WHERE owner=? AND id=?').get(owner,id);
    if(!row)return;const r=JSON.parse(String(row.payload)) as UsageManifest;
    if(r.members.some(m=>!this.permitted(owner,m.member)))throw Error('authority-changed');return r;
  }
  private write(r:UsageManifest) {
    if(r.members.some(m=>!this.permitted(r.owner,m.member)))throw Error('authority-changed');
    const payload=JSON.stringify(r),bytes=Buffer.byteLength(payload);
    if(bytes>USAGE_AGGREGATION_LIMITS.bytes)throw Error('manifest-capacity');
    const other=Number(this.db.prepare('SELECT coalesce(sum(length(cast(payload AS BLOB))),0) n FROM hub_usage_manifests WHERE NOT(owner=? AND id=?)').get(r.owner,r.requestId)!.n);
    if(other+bytes>128*1024**2)throw Error('store-capacity');
    this.db.prepare('INSERT INTO hub_usage_manifests VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET payload=excluded.payload').run(r.owner,r.requestId,payload);
  }
  prepare(owner:string,selection:UsageSelection,directoryRevision:string,members:DelegationMember[]) {
    selection=usageSelection(selection);
    const write=()=>this.prepareAdmitted(owner,selection,directoryRevision,members);
    // This is only a classification hint. The transaction rechecks identity,
    // cancellation and authority, including after asynchronous admission.
    return this.read(owner,selection.requestId) ? write() : this.admit(write);
  }
  async prepareAsync(owner:string,selection:UsageSelection,directoryRevision:string,members:DelegationMember[],check:()=>void=()=>{}) {
    this.checkRequest(check);requireConnectionReady(this.db);
    if(this.db.isTransaction)throw Error('outer-transaction');
    const snapshot=usageSelection(selection),memberSnapshot=structuredClone(members);
    return this.admitAsync(!this.read(owner,snapshot.requestId),committed=>this.prepareAdmitted(owner,snapshot,directoryRevision,memberSnapshot,committed,check),check,()=>{
      if(this.cancelled(owner,snapshot.requestId))throw Error('cancelled');
      const current=this.read(owner,snapshot.requestId);if(!current)throw Error('missing');return current;
    });
  }
  private prepareAdmitted(owner:string,selection:UsageSelection,directoryRevision:string,members:DelegationMember[],committed:()=>void=()=>{},check:()=>void=()=>{}) {
    let fresh=false;
    const result=this.transaction(()=>{
      this.checkRequest(check);
      if(this.cancelled(owner,selection.requestId))throw Error('cancelled');
      const old=this.read(owner,selection.requestId),inputDigest=digest(selection);
      if(old){if(old.inputDigest!==inputDigest)throw Error('request-reused');return old;}
      if(!text(directoryRevision)||members.length>128||new Set(members.map(m=>m.sessionId)).size!==members.length
        ||members.some(m=>m.owner!==owner||!this.permitted(owner,m)))throw Error('members');
      if(Number(this.db.prepare('SELECT count(*) n FROM hub_usage_manifests').get()!.n)>=256)throw Error('receipt-capacity');
      const r:UsageManifest={owner,requestId:selection.requestId,inputDigest,directoryRevision,selection,createdAt:this.now(),expiresAt:this.now()+300000,
        state:'prepared',members:members.map(member=>({member:structuredClone(member),requestId:randomUUID(),state:'prepared'}))};
      this.write(r);fresh=true;return r;
    });
    if(fresh)committed();return result;
  }
  confirm(owner:string,id:string,check:()=>void=()=>{}) {
    return this.transaction(()=>{
      this.checkRequest(check);
      const r=this.read(owner,id);if(!r)throw Error('missing');
      if(r.state!=='prepared')return {claimed:false,receipt:r};
      if(this.now()>=r.expiresAt||this.now()<r.createdAt)throw Error('preview-expired');
      r.state=r.members.length?'collecting':'complete';this.write(r);return {claimed:true,receipt:r};
    });
  }
  claim(owner:string,id:string,childId:string) {
    const write=()=>this.claimAdmitted(owner,id,childId);
    const r=this.read(owner,id),m=r?.members.find(m=>m.requestId===childId);
    return r?.state==='collecting'&&m?.state==='prepared' ? this.admit(write) : write();
  }
  async claimAsync(owner:string,id:string,childId:string,check:()=>void=()=>{}) {
    this.checkRequest(check);requireConnectionReady(this.db);
    if(this.db.isTransaction)throw Error('outer-transaction');
    const r=this.read(owner,id),m=r?.members.find(m=>m.requestId===childId);
    return this.admitAsync(r?.state==='collecting'&&m?.state==='prepared',committed=>{
      const result=this.claimAdmitted(owner,id,childId,check);if(result)committed();return result;
    },check,claimed=>{
      if(!claimed)return false;
      const current=this.read(owner,id),member=current?.members.find(m=>m.requestId===childId);
      // A concurrent original-only GET may already have completed this child
      // while the capacity owner acknowledges release. Do not POST it again.
      return current?.state==='collecting'&&member?.state==='unknown';
    });
  }
  private claimAdmitted(owner:string,id:string,childId:string,check:()=>void=()=>{}) {
    return this.transaction(()=>{
      this.checkRequest(check);
      const r=this.read(owner,id),m=r?.members.find(m=>m.requestId===childId);
      if(!r||r.state!=='collecting'||!m||m.state!=='prepared')return false;
      m.state='unknown';this.write(r);return true;
    });
  }
  /** Capacity IO may yield; shared-owner SQLite never does. A committed child
   * UNKNOWN claim is a no-replay fence even if the ledger release ACK is lost. */
  private async admitAsync<T>(needed:boolean|undefined,write:(committed:()=>void)=>T extends PromiseLike<unknown>?never:T,check:()=>void,current:(result:T)=>T):Promise<T> {
    const trace=this.diagnostics.start('usage-manifest-admission');
    let failed=true,changed=false,active=true,attempted=false,completed=false;
    let step=1;
    const warning=setTimeout(()=>trace.reportPending({pending:1,step,unknown:Number(changed)}),30000);
    warning.unref();
    let original:T;
    const guarded=()=>{
      if(!active)throw Error('Usage manifest admission ended');
      if(attempted)throw Error('Usage manifest admission writer already attempted');
      attempted=true;
      this.checkRequest(check);requireConnectionReady(this.db);
      step=2;
      const at=performance.now();
      try{const value=write(()=>{changed=true;trace.add('changed',1);});original=value;completed=true;return value;}
      finally{step=3;trace.add('bodyMs',performance.now()-at);}
    };
    try{
      let result:T;
      if(!needed)result=guarded();
      else if(!this.asyncStorageAdmission)result=this.admit(guarded);
      else{
        const at=performance.now();let entered=false,releaseAt:number|undefined;
        try{result=await this.asyncStorageAdmission(USAGE_AGGREGATION_LIMITS.bytes+65536,async()=>{
          entered=true;trace.add('queueMs',performance.now()-at);
          try{return guarded();}finally{releaseAt=performance.now();}
        });}finally{
          if(!entered)trace.add('queueMs',performance.now()-at);
          if(releaseAt!==undefined)trace.add('releaseMs',performance.now()-releaseAt);
        }
      }
      if(!completed)throw Error('Usage manifest admission writer was not committed');
      // Release acknowledgment may yield after a durable write. Returning a
      // permission from a closed or retired original owner is not recovery.
      this.checkRequest(check);requireConnectionReady(this.db);
      if(!this.db.isOpen)throw Error('Storage connection closed');
      result=current(original!);failed=false;return result;
    }catch(error){trace.add(changed?'unknown':'deferred',1);throw error;}
    finally{active=false;clearTimeout(warning);trace.finish(failed);}
  }
  record(owner:string,id:string,childId:string,raw:unknown,check:()=>void=()=>{}) {
    return this.transaction(()=>{
      this.checkRequest(check);
      const r=this.read(owner,id),m=r?.members.find(m=>m.requestId===childId);
      if(!r||!m||m.state==='prepared'||r.state==='cancelled')throw Error('unclaimed');
      const snapshot=validateNativeTokenSnapshot(raw),u=snapshot.data.usage,s=r.selection;
      if(snapshot.requestId!==childId||u.runtime!==m.member.runtime||u.from!==s.from||u.to!==s.to||u.bucketMs!==s.bucketMs)throw Error('snapshot-mismatch');
      if(m.snapshot){if(digest(m.snapshot)!==digest(snapshot))throw Error('immutable-snapshot');return;}
      m.snapshot=snapshot;m.state='complete';
      // Validate event/digest/precision and aggregate budget even before all
      // members return. Partial member collection is never exposed as a total.
      this.aggregate(r);
      if(r.members.every(m=>m.state==='complete'))r.state='complete';this.write(r);
    });
  }
  cancelled(owner:string,id:string) {
    if(!text(owner))throw Error('owner');tokenSnapshotRequestId(id);
    return !!this.db.prepare('SELECT 1 FROM hub_usage_cancellations WHERE owner=? AND id=?').get(owner,id);
  }
  cancel(owner:string,id:string,check:()=>void=()=>{}) {
    return this.transaction(()=>{
      this.checkRequest(check);
      if(this.cancelled(owner,id))return this.read(owner,id);
      const r=this.read(owner,id);if(r&&!['prepared','cancelled'].includes(r.state))throw Error('already-dispatched');
      if(Number(this.db.prepare('SELECT count(*) n FROM hub_usage_cancellations WHERE owner=?').get(owner)!.n)>=1024)throw Error('receipt-capacity');
      if(r){r.state='cancelled';this.write(r);}
      this.db.prepare('INSERT INTO hub_usage_cancellations VALUES(?,?)').run(owner,id);return r;
    });
  }
  private aggregate(r:UsageManifest) {
    return aggregateTokenSnapshots({owner:r.owner,directoryRevision:r.directoryRevision,complete:true,members:r.members.filter(m=>m.snapshot).map(m=>({
      target:m.member.sessionId,authorityEpoch:m.member.authorityEpoch,snapshot:m.snapshot!,groups:[
        ...(m.member.groupId?['group:'+m.member.groupId]:[]),...m.member.tags.map(t=>'tag:'+t),
        'environment:'+m.member.connectionId,'runtime:'+m.member.runtime,...(r.selection.layoutId?['layout:'+r.selection.layoutId]:[])]}))},
    (owner,target)=>{const m=r.members.find(m=>m.member.sessionId===target)?.member;return m&&this.permitted(owner,m)?m.authorityEpoch:undefined;});
  }
  view(r:UsageManifest) {
    if(r.members.some(m=>!this.permitted(r.owner,m.member)))throw Error('authority-changed');
    return {requestId:r.requestId,selection:r.selection,directoryRevision:r.directoryRevision,createdAt:r.createdAt,expiresAt:r.expiresAt,state:r.state,
      members:r.members.map(({member,requestId,state})=>({sessionId:member.sessionId,connectionId:member.connectionId,runtime:member.runtime,groupId:member.groupId,tags:member.tags,requestId,state})),
      result:r.state==='complete'?this.aggregate(r):null};
  }
}
