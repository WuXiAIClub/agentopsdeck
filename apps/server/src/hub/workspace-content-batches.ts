import { synchronousSqliteValue } from '../auth/synchronous-sqlite-value.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ContentProposalConflict } from './content-proposal-store.js';
import type { WorkspaceContentCoordinator } from './workspace-content-coordinator.js';
import { readDelegationCatalog, type DelegationCatalogSource } from './workspace-delegation-catalog.js';
import type { DelegationMember, DelegationSelection } from './workspace-delegation-preview.js';
import {ContentBatchTransactions,contentBatchSelection,contentBatchSnapshot,type ContentBatchSnapshot} from './content-batch-transactions.js';

type Member={id:string;member:DelegationMember;state:'prepared'|'unknown'|'installed'|'cancelled'|'cleanup_pending'};
export type ContentBatch={id:string;resource:string;epoch:string;revision:number;selection:DelegationSelection;
  fingerprint:string;expiresAt:number;state:'prepared'|'confirmed'|'cancelled';members:Member[]};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Only physical-volume admission may wait. The original Hub transaction body
// remains synchronous on its single connection; this is not an async SQL port.
export type ContentBatchStorageAdmission = <T>(bytes:number,write:()=>T extends PromiseLike<unknown>?never:T)=>T|Promise<T>;
/** Full-card grants, not task-field capabilities. Durable before dispatch;
 * recovering confirmation only inspects original per-member binding IDs. */
export class WorkspaceContentBatches {
  private readonly transactions:ContentBatchTransactions;
  constructor(private readonly db:DatabaseSync,private readonly coordinator:WorkspaceContentCoordinator,
    private readonly source:DelegationCatalogSource,admission?:ContentBatchStorageAdmission,private readonly now=Date.now,
    private readonly transactionFence=(owner:string)=>source.fence(owner)){
    this.transactions=new ContentBatchTransactions(db,coordinator.store,(owner,resource,snapshot)=>this.currentSnapshot(owner,resource,snapshot),admission,now);
  }
  get(owner:string,resource:string,id:string):ContentBatch|undefined {
    return this.transactions.get(owner,resource,id);
  }
  private check(check:()=>void){
    if(synchronousSqliteValue(this.db,check)!==undefined)throw new ContentProposalConflict('batch-authority');
  }
  private async snapshot(owner:string,resource:string,selection:DelegationSelection){
    const catalog=await readDelegationCatalog(owner,this.source),head=this.coordinator.store.resource(owner,resource);
    if(!head)throw new ContentProposalConflict('shared-content-required');
    return contentBatchSnapshot(head,catalog,selection);
  }
  private currentSnapshot(owner:string,resource:string,snapshot:ContentBatchSnapshot){
    const head=this.coordinator.store.resource(owner,resource);
    const fence=synchronousSqliteValue(this.db,this.transactionFence,undefined,[owner]) as ReturnType<DelegationCatalogSource['fence']>|undefined;
    if(!head||head.epoch!==snapshot.epoch||head.revision!==snapshot.revision||!fence
      ||fence.generation!==snapshot.generation||fence.preferencesRevision!==snapshot.preferencesRevision
      ||snapshot.members.some(member=>synchronousSqliteValue(this.db,this.source.authorized,this.source,[owner,member])!==true))
      throw new ContentProposalConflict('preview-changed-or-expired');
  }
  async prepare(owner:string,resource:string,id:string,input:DelegationSelection,check=()=>{}){
    const selection=contentBatchSelection(input);this.check(check);
    const prior=this.get(owner,resource,id);
    if(prior){if(hash(prior.selection)!==hash(selection))throw new ContentProposalConflict('batch-reused');return prior;}
    const snapshot=await this.snapshot(owner,resource,selection);this.check(check);
    return this.transactions.prepare(owner,resource,id,selection,snapshot,check);
  }
  private required(owner:string,resource:string,id:string){const b=this.get(owner,resource,id);if(!b)throw new ContentProposalConflict('batch-missing');return b;}
  async confirm(owner:string,resource:string,id:string,check=()=>{}){
    let b=this.required(owner,resource,id);this.check(check);if(b.state!=='prepared')return this.inspect(owner,resource,id,check);
    const snap=await this.snapshot(owner,resource,b.selection);this.check(check);
    b=this.required(owner,resource,id);
    if(b.state!=='prepared')return this.inspect(owner,resource,id,check);
    if(this.now()>=b.expiresAt||snap.fingerprint!==b.fingerprint)throw new ContentProposalConflict('preview-changed-or-expired');
    const claim=await this.transactions.confirm(owner,resource,id,snap,check);b=claim.batch;
    if(!claim.claimed)return this.inspect(owner,resource,id,check);
    // No automatic retry, even if process death occurs before the first bind.
    const remaining=[...b.members];
    await Promise.all(Array.from({length:Math.min(4,remaining.length)},async()=>{
      for(let m=remaining.shift();m;m=remaining.shift()){
        const member=m;
        const fence=()=>{this.check(check);const current=this.required(owner,resource,id);
          if(current.state!=='confirmed'||this.now()>=current.expiresAt||!this.source.authorized(owner,member.member))throw new ContentProposalConflict('batch-revoked');};
        try{fence();await this.coordinator.bind(owner,resource,{id:member.id,sessionId:member.member.sessionId,epoch:b.epoch,revision:b.revision},fence);
          this.transactions.settle(owner,resource,id,member.id,check);
        }catch{/* original ID retained, no replacement dispatch */}
      }
    }));this.check(check);return this.required(owner,resource,id);
  }
  async inspect(owner:string,resource:string,id:string,check=()=>{}){
    const original=this.required(owner,resource,id);this.check(check);
    for(const m of original.members.filter(m=>m.state==='unknown')){
      try{await this.coordinator.inspect(owner,resource,m.id);this.check(check);
        this.transactions.settle(owner,resource,id,m.id,check);
      }catch{/* Missing is unknown, never install. */}
    }this.check(check);return this.required(owner,resource,id);
  }
  async cancel(owner:string,resource:string,id:string,check=()=>{}){
    this.check(check);
    // One durable transaction fences EVERY member and records cancellation
    // before the first network await; a partial local cancellation is impossible.
    const b=this.transactions.cancel(owner,resource,id,check);
    for(const m of b.members.filter(m=>m.state==='cleanup_pending')){
      try{this.check(check);const receipt=await this.coordinator.revoke(owner,resource,m.id);this.check(check);
        if(receipt.cleanup==='confirmed')this.transactions.cleanupSettled(owner,resource,id,m.id,check);
      }catch{/* Local authority is already revoked; cleanup remains explicit. */}
    }this.check(check);return this.required(owner,resource,id);
  }
}
