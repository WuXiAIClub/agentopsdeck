import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {validBoardUuid} from '@agentopsdeck/shared';
import {observedTransaction} from '../storage/observed-transaction.js';
import {synchronousSqliteValue} from '../auth/synchronous-sqlite-value.js';
import {ContentProposalConflict,type ContentProposalStore} from './content-proposal-store.js';
import type {ContentBatch,ContentBatchStorageAdmission} from './workspace-content-batches.js';
import type {DelegationMember,DelegationSelection} from './workspace-delegation-preview.js';

export type ContentBatchSnapshot={epoch:string;revision:number;generation:number;preferencesRevision:number;
  members:DelegationMember[];fingerprint:string};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function contentBatchSelection(s:DelegationSelection):DelegationSelection {
  const text=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
  if(!s||Object.keys(s).some(k=>!['groupId','tags','tagMode'].includes(k))||!['all','any'].includes(s.tagMode)
    ||!Array.isArray(s.tags)||s.tags.length>8||new Set(s.tags).size!==s.tags.length||!s.tags.every(t=>text(t,32))
    ||s.groupId!==undefined&&!text(s.groupId,2048)||!s.groupId&&!s.tags.length)throw new ContentProposalConflict('selection');
  return {...s,tags:[...s.tags].sort()};
}
export function contentBatchSnapshot(head:{epoch:string;revision:number},catalog:{generation:number;preferencesRevision:number;members:DelegationMember[]},
  selection:DelegationSelection):ContentBatchSnapshot {
  const members=catalog.members.filter(m=>(!selection.groupId||m.groupId===selection.groupId)&&(!selection.tags.length||
    (selection.tagMode==='all'?selection.tags.every(t=>m.tags.includes(t)):selection.tags.some(t=>m.tags.includes(t)))));
  if(!members.length||members.length>32||members.some(m=>!['codex','claude-code','ghcp'].includes(m.runtime)))throw new ContentProposalConflict('batch-members');
  return {epoch:head.epoch,revision:head.revision,members,generation:catalog.generation,preferencesRevision:catalog.preferencesRevision,
    fingerprint:hash([head.epoch,head.revision,catalog.generation,catalog.preferencesRevision,members])};
}

/** SQL-only complete batch transactions on the ORIGINAL connection. No network,
 * native callback or transaction crosses an await. Caller evidence is rechecked
 * inside each root transaction, after physical-volume admission can wait. */
export class ContentBatchTransactions {
  constructor(private readonly db:DatabaseSync,private readonly content:ContentProposalStore,
    private readonly snapshotCheck:(owner:string,resource:string,snapshot:ContentBatchSnapshot)=>void,
    private readonly admission?:ContentBatchStorageAdmission,private readonly now=Date.now) {
    db.exec('CREATE TABLE IF NOT EXISTS hub_content_batches(owner TEXT,id TEXT,payload TEXT NOT NULL,PRIMARY KEY(owner,id))');
  }
  private check(check:()=>void){if(synchronousSqliteValue(this.db,check)!==undefined)throw new ContentProposalConflict('batch-authority');}
  get(owner:string,resource:string,id:string):ContentBatch|undefined {
    if(!validBoardUuid(id))throw new ContentProposalConflict('batch-id');
    const row=this.db.prepare('SELECT payload FROM hub_content_batches WHERE owner=? AND id=?').get(owner,id);
    if(!row)return;
    const batch=JSON.parse(String(row.payload)) as ContentBatch;
    if(batch.resource!==resource)throw new ContentProposalConflict('batch-resource');return batch;
  }
  required(owner:string,resource:string,id:string){const b=this.get(owner,resource,id);if(!b)throw new ContentProposalConflict('batch-missing');return b;}
  private save(owner:string,b:ContentBatch){this.db.prepare('UPDATE hub_content_batches SET payload=? WHERE owner=? AND id=?').run(JSON.stringify(b),owner,b.id);}
  private transaction<T>(check:()=>void,write:()=>T extends PromiseLike<unknown>?never:T):T {
    if(this.db.isTransaction)throw new ContentProposalConflict('outer-transaction');
    return observedTransaction(this.db,'content-batch-change',()=>{this.check(check);return write();});
  }
  async prepare(owner:string,resource:string,id:string,input:DelegationSelection,snapshot:ContentBatchSnapshot,check:()=>void) {
    const selection=contentBatchSelection(input);this.check(check);
    const insert=()=>this.transaction(check,()=>{
      const old=this.get(owner,resource,id);
      if(old){if(hash(old.selection)!==hash(selection))throw new ContentProposalConflict('batch-reused');return old;}
      this.check(()=>this.snapshotCheck(owner,resource,snapshot));
      if(Number(this.db.prepare('SELECT count(*) n FROM hub_content_batches').get()!.n)>=128)throw new ContentProposalConflict('batch-capacity');
      const batch:ContentBatch={id,resource,epoch:snapshot.epoch,revision:snapshot.revision,selection,fingerprint:snapshot.fingerprint,
        expiresAt:this.now()+300000,state:'prepared',members:snapshot.members.map(member=>({id:randomUUID(),member,state:'prepared'}))};
      this.db.prepare('INSERT INTO hub_content_batches VALUES(?,?,?)').run(owner,id,JSON.stringify(batch));return batch;
    });return this.admission?this.admission(4*1024*1024+65536,insert):insert();
  }
  async confirm(owner:string,resource:string,id:string,snapshot:ContentBatchSnapshot,check:()=>void) {
    this.check(check);
    const claim=()=>this.transaction(check,()=>{
      const batch=this.required(owner,resource,id);
      if(batch.state!=='prepared')return {batch,claimed:false};
      this.check(()=>this.snapshotCheck(owner,resource,snapshot));
      if(this.now()>=batch.expiresAt||snapshot.fingerprint!==batch.fingerprint)throw new ContentProposalConflict('preview-changed-or-expired');
      batch.state='confirmed';for(const member of batch.members)member.state='unknown';this.save(owner,batch);
      return {batch,claimed:true}; // COMMIT precedes the first install, including process death before dispatch.
    });return this.admission?this.admission(4*1024*1024+65536,claim):claim();
  }
  settle(owner:string,resource:string,id:string,memberId:string,check:()=>void) {
    return this.transaction(check,()=>{
      const batch=this.required(owner,resource,id),member=batch.members.find(m=>m.id===memberId);
      if(!member)throw new ContentProposalConflict('batch-member');
      const binding=this.content.bindingRecord(owner,resource,memberId);
      if(batch.state==='confirmed'&&member.state==='unknown'&&binding&&!binding.revoked&&binding.acknowledgedRevision>=0){
        member.state='installed';this.save(owner,batch);
      }
      return batch;
    });
  }
  cancel(owner:string,resource:string,id:string,check:()=>void) {
    this.check(check);let batch=this.required(owner,resource,id);
    this.content.revokeBindings(owner,resource,batch.members.map(m=>m.id),bindings=>{
      this.check(check);batch=this.required(owner,resource,id);batch.state='cancelled';
      for(const member of batch.members)if(member.state!=='cancelled')member.state=bindings.some(b=>b.id===member.id)?'cleanup_pending':'cancelled';
      this.save(owner,batch);
    });return batch;
  }
  cleanupSettled(owner:string,resource:string,id:string,memberId:string,check:()=>void) {
    return this.transaction(check,()=>{
      const batch=this.required(owner,resource,id),member=batch.members.find(m=>m.id===memberId),binding=this.content.bindingRecord(owner,resource,memberId);
      if(!member||batch.state!=='cancelled'||binding&&!binding.revoked)throw new ContentProposalConflict('batch-cleanup');
      if(member.state==='cleanup_pending'){member.state='cancelled';this.save(owner,batch);}return batch;
    });
  }
}
