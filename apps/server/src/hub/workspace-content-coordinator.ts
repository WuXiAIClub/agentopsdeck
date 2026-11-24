import type { DatabaseSync } from 'node:sqlite';
import { synchronousSqliteValue } from '../auth/synchronous-sqlite-value.js';
import { isDeepStrictEqual } from 'node:util';
import { parseWorkspaceFileCardResource, validBoardUuid } from '@agentopsdeck/shared';
import { cardFileCodec } from '../connector/workspace-file-card-format.js';
import type { LocalContentProposal, WorkspaceContentReplica } from '../connector/workspace-content-replica.js';
import { ContentProposalStore, ContentProposalConflict, type ContentBinding, type ContentBindingTarget,
  type ContentProjection, type ContentResource, type ContentReceipt, type ContentAsyncStorageAdmission } from './content-proposal-store.js';
import type { NativeWorkspaceCardFileProjection } from './workspace-card-file-projection.js';

export type ContentReplicaView = Awaited<ReturnType<WorkspaceContentReplica<unknown>['view']>>;
export interface ContentReplicaTransport {
  capability(): Promise<{ protocol: number; available: boolean }>;
  install(input: { id: string; resource: string; generation: string; sessionKey: string; base: ContentResource }): Promise<ContentResource>;
  view(id: string): Promise<ContentReplicaView>;
  observe(id: string): Promise<LocalContentProposal | undefined>;
  claim(id: string, mutation: string): Promise<{ claimed: boolean; local: LocalContentProposal }>;
  settle(id: string, mutation: string, receipt: ContentReceipt): Promise<LocalContentProposal>;
  resolve(id: string, input: Parameters<WorkspaceContentReplica<unknown>['resolve']>[2]): Promise<LocalContentProposal>;
  project(id: string, job: ContentProjection): Promise<{ id: string; state: string; hash: string | null }>;
  projectionReceipt(id: string, job: ContentProjection): Promise<{ id: string; state: string; hash: string | null }>;
  revoke(id: string): Promise<void>;
}
export type SharedContentTarget = ContentBindingTarget & { valid(): void; transport: ContentReplicaTransport };
const sameTarget = (a: ContentBindingTarget, b: ContentBindingTarget) =>
  a.connectionId===b.connectionId&&a.sessionId===b.sessionId&&a.sessionKey===b.sessionKey&&a.authority===b.authority;
const epoch = (t: ContentBindingTarget) => JSON.stringify([t.connectionId,t.authority]);

/** Shared by the legacy effect coordinator and the SQL-owner document domain. */
export function normalizeSharedContent(text:string,resource:string) {
  const ref=parseWorkspaceFileCardResource(resource);if(!ref)throw new ContentProposalConflict('resource');
  const codec=cardFileCodec(ref.kind),value:unknown=JSON.parse(text);
  if(!codec.valid(value))throw new ContentProposalConflict('card-kind-or-schema');
  const parsed=codec.parse(Buffer.from(codec.serialize(value)));
  if(!parsed)throw new ContentProposalConflict('card-schema');
  return JSON.stringify(parsed.content);
}
export function sharedContentResourceId(resource:string) {
  const ref=parseWorkspaceFileCardResource(resource);if(!ref)throw new ContentProposalConflict('resource');
  return ref.kind==='statuscard'?JSON.stringify(['taskboard',ref.id]):resource;
}

/** Owner-side composition of native migration, proposal CAS and pull replicas.
 * No model turn, native command or legacy file adoption. The host must
 * supply its existing runtime-owned transport and current authorization resolver.
 * Every uncertain install/proposal/projection recovers by ORIGINAL reads only. */
export class WorkspaceContentCoordinator {
  readonly store: ContentProposalStore;
  private readonly active = new Set<string>();
  private stopping=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private background:Promise<void>|undefined;
  private cursor=0;
  start(enabled:()=>boolean,intervalMs=10_000) {
    if(this.timer||this.background||this.stopping)return;
    const tick=()=>{
      this.timer=undefined;if(this.stopping)return;
      void this.syncTick(enabled).catch(()=>{/* Retry read-only discovery on a later tick, never replay unknown writes. */}).finally(()=>{if(!this.stopping){this.timer=setTimeout(tick,intervalMs);this.timer.unref();}});
    };
    this.timer=setTimeout(tick,intervalMs);this.timer.unref();
  }
  syncTick(enabled:()=>boolean):Promise<void> {
    if(this.stopping)return Promise.resolve();
    if(this.background)return this.background;
    const work=this.scan(enabled);this.background=work;
    const clear=()=>{if(this.background===work)this.background=undefined;};
    void work.then(clear,clear);return work;
  }
  private async scan(enabled:()=>boolean) {
    if(this.stopping||!enabled())return;
    let page=this.store.syncPage(this.cursor);
    if(!page.length){this.cursor=0;page=this.store.syncPage(0);}
    if(page.length)this.cursor=page[page.length-1]!.cursor;
    await Promise.all(page.map(async b=>{if(this.stopping||!enabled())return;try{await this.synchronize(b.owner,b.resource,b.id,()=>{
      if(!enabled())throw new ContentProposalConflict('coordinator-paused');
    });}catch{/* original unknown intents remain durable */}}));
  }
  async close(){this.stopping=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;await this.background;}
  constructor(private readonly db: DatabaseSync, private readonly native: NativeWorkspaceCardFileProjection,
    private readonly resolve: (owner: string, sessionId: string) => SharedContentTarget, admission?:ContentAsyncStorageAdmission) {
    this.store = new ContentProposalStore(db, normalizeSharedContent, (owner, _resource, binding) => {
      if(!binding.target)return false;
      try{const current=this.resolve(owner,binding.target.sessionId);this.validateTarget(current);
        return sameTarget(current,binding.target)&&binding.authorityEpoch===epoch(current);
      }catch{return false;}
    },undefined,admission);
  }
  resourceId(resource:string) {
    // Status panes and taskboards edit the SAME native board, never two v2 heads.
    return sharedContentResourceId(resource);
  }
  migrate(owner:string,resource:string,revision:number,requestId:string) {
    if(!validBoardUuid(requestId))throw new ContentProposalConflict('request');
    return this.store.migrateNativeRequest(owner,this.resourceId(resource),revision,requestId,this.native);
  }
  migrateAsync(owner:string,resource:string,revision:number,requestId:string,beforeWrite=()=>{}) {
    if(!validBoardUuid(requestId))throw new ContentProposalConflict('request');
    return this.store.migrateNativeRequestAsync(owner,this.resourceId(resource),revision,requestId,this.native,()=>{
      this.checkBeforeWrite(beforeWrite);if(this.stopping)throw new ContentProposalConflict('coordinator-stopping');
    });
  }
  private checkBeforeWrite(check:()=>void) {
    if(synchronousSqliteValue(this.db,check)!==undefined)throw new ContentProposalConflict('content-authority');
  }
  private validateTarget(target:SharedContentTarget) {
    if(synchronousSqliteValue(this.db,target.valid,target)!==undefined)throw new ContentProposalConflict('content-authority');
  }
  private current(owner:string,resource:string,id:string) {
    const binding=this.store.bindingRecord(owner,resource,id);
    if(!binding||binding.revoked||!binding.target||!binding.initial)throw new ContentProposalConflict('binding-unavailable');
    const target=this.resolve(owner,binding.target.sessionId);this.validateTarget(target);
    if(!sameTarget(target,binding.target)||epoch(target)!==binding.authorityEpoch)throw new ContentProposalConflict('forbidden');
    return {binding,target};
  }
  private async exclusive<T>(owner:string,resource:string,id:string,work:()=>Promise<T>) {
    const key=JSON.stringify([owner,resource,id]);
    if(this.active.has(key)||this.active.size>=4)throw new ContentProposalConflict('coordinator-busy');
    this.active.add(key);try{return await work();}finally{this.active.delete(key);}
  }
  private async call<T>(owner:string,resource:string,id:string,work:(transport:ContentReplicaTransport)=>Promise<T>) {
    if(this.stopping)throw new ContentProposalConflict('coordinator-stopping');
    const before=this.current(owner,resource,id);
    const result=await work(before.target.transport);
    const after=this.current(owner,resource,id);
    if(after.binding.generation!==before.binding.generation)throw new ContentProposalConflict('binding-generation');
    return result;
  }
  async bind(owner:string,resource:string,input:{id:string;sessionId:string;epoch:string;revision:number},beforeWrite=()=>{}) {
    if(this.stopping)throw new ContentProposalConflict('coordinator-stopping');
    resource=this.resourceId(resource);
    if(!validBoardUuid(input.id))throw new ContentProposalConflict('binding');
    return this.exclusive(owner,resource,input.id,async()=>{
      this.checkBeforeWrite(beforeWrite);
      const old=this.store.bindingRecord(owner,resource,input.id);
      if(old){
        if(old.target?.sessionId!==input.sessionId||old.initial?.epoch!==input.epoch||old.initial.revision!==input.revision)
          throw new ContentProposalConflict('binding-reused');
        return this.inspect(owner,resource,input.id); // NEVER repeats installation.
      }
      const target=this.resolve(owner,input.sessionId);this.validateTarget(target);
      const capability=await target.transport.capability();this.validateTarget(target);
      const now=this.resolve(owner,input.sessionId);this.validateTarget(now);
      if(!sameTarget(target,now)||capability.protocol!==1||capability.available!==true)throw new ContentProposalConflict('capability-or-authority');
      this.checkBeforeWrite(beforeWrite);
      if(this.stopping)throw new ContentProposalConflict('coordinator-stopping');
      const binding=await this.store.bindAsync(owner,resource,input.id,epoch(target),{epoch:input.epoch,revision:input.revision,
        target:{sessionId:input.sessionId,connectionId:target.connectionId,sessionKey:target.sessionKey,authority:target.authority}},()=>{
          this.checkBeforeWrite(beforeWrite);if(this.stopping)throw new ContentProposalConflict('coordinator-stopping');
          this.validateTarget(target);const current=this.resolve(owner,input.sessionId);this.validateTarget(current);
          if(!sameTarget(target,current))throw new ContentProposalConflict('forbidden');
        });
      try {
        const proof=await this.call(owner,resource,input.id,t=>t.install({id:binding.id,resource,generation:binding.generation,
          sessionKey:target.sessionKey,base:binding.initial!}));
        this.store.acknowledgeInstallation(owner,resource,binding.id,binding.generation,proof);
      }catch{
        // Persisted unconfirmed installation occupies its original binding.
        // 404/timeout is not evidence of nonexecution and grants no new PUT.
        this.current(owner,resource,input.id);
      }
      return this.current(owner,resource,input.id).binding;
    });
  }
  private validateView(binding:ContentBinding,resource:string,view:ContentReplicaView) {
    if(view.resource!==resource||view.generation!==binding.generation||view.sessionKey!==binding.target?.sessionKey
      ||!isDeepStrictEqual(view.initial,binding.initial)||!Array.isArray(view.proposals)||view.proposals.length>128)
      throw new ContentProposalConflict('replica-proof');
  }
  async inspect(owner:string,resource:string,id:string) {
    resource=this.resourceId(resource);
    const {binding}=this.current(owner,resource,id);
    const view=await this.call(owner,resource,id,t=>t.view(id));this.validateView(binding,resource,view);
    if(binding.acknowledgedRevision<0)this.store.acknowledgeInstallation(owner,resource,id,binding.generation,view.initial);
    return this.current(owner,resource,id).binding;
  }
  async synchronize(owner:string,resource:string,id:string,beforeWrite=()=>{}) {
    this.checkBeforeWrite(beforeWrite);
    resource=this.resourceId(resource);
    return this.exclusive(owner,resource,id,async()=>{
      const binding=await this.inspect(owner,resource,id);
      await this.call(owner,resource,id,t=>t.observe(id));
      let view=await this.call(owner,resource,id,t=>t.view(id));this.validateView(binding,resource,view);
      for(const local of view.proposals.filter(p=>p.state!=='committed'&&p.state!=='conflict').slice(0,4)){
        if(local.state==='conflict')continue;
        const p=local.proposal;
        if(p.bindingId!==id||p.generation!==binding.generation)throw new ContentProposalConflict('proposal-scope');
        let receipt:ContentReceipt|undefined;
        if(local.state==='prepared'){
          this.checkBeforeWrite(beforeWrite);
          const claim=await this.call(owner,resource,id,t=>t.claim(id,p.mutationId));
          if(claim.claimed){
            if(claim.local.state!=='unknown'||!isDeepStrictEqual(claim.local.proposal,p))throw new ContentProposalConflict('claim-proof');
            receipt=await this.store.proposeAsync(owner,resource,p,()=>{
              this.checkBeforeWrite(beforeWrite);
              if(this.stopping)throw new ContentProposalConflict('coordinator-stopping');
              const current=this.current(owner,resource,id);
              if(current.binding.generation!==binding.generation)throw new ContentProposalConflict('binding-generation');
            });
          }
        }
        // Unknown includes a lost claim response. No receipt => remain unknown,
        // even if we can prove this process has not yet submitted the proposal.
        receipt??=this.store.receipt(owner,resource,id,binding.generation,p.mutationId);
        if(!receipt)continue;
        if(local.state!=='committed')await this.call(owner,resource,id,t=>t.settle(id,p.mutationId,receipt!));
      }
      view=await this.call(owner,resource,id,t=>t.view(id));this.validateView(binding,resource,view);
      for(const local of view.proposals){
        if(local.state==='committed'&&local.receipt?.hash===view.actualHash
          &&local.receipt.revision>=this.current(owner,resource,id).binding.acknowledgedRevision)
          this.store.acknowledgeProposal(owner,resource,id,binding.generation,local.proposal.mutationId,view.actualHash!);
      }
      const pending=view.proposals.some(p=>p.state==='prepared'||p.state==='unknown'||p.state==='conflict'&&!p.resolvedBy);
      for(const job of this.store.projections(owner,resource,id,binding.generation).filter(j=>j.state!=='acknowledged'&&j.revision>binding.acknowledgedRevision).slice(0,4)){
        if(job.state==='acknowledged')continue;
        const current=this.current(owner,resource,id).binding;
        if(job.revision<=current.acknowledgedRevision)continue;
        let result:{id:string;state:string;hash:string|null};
        if(job.state==='unknown'){
          result=await this.call(owner,resource,id,t=>t.projectionReceipt(id,job));
        }else{
          if(pending||!view.actualHash)return this.current(owner,resource,id).binding;
          const claimed=await this.store.claimProjectionAsync(owner,resource,job.id,view.actualHash,false,()=>{
            this.checkBeforeWrite(beforeWrite);
            if(this.stopping)throw new ContentProposalConflict('coordinator-stopping');
            const current=this.current(owner,resource,id);
            if(current.binding.generation!==binding.generation)throw new ContentProposalConflict('binding-generation');
          });
          if(!claimed.claimed)continue;
          result=await this.call(owner,resource,id,t=>t.project(id,claimed.job));
        }
        if(result.id!==job.id)throw new ContentProposalConflict('projection-receipt');
        if(result.state==='saved'&&result.hash===job.hash){
          this.store.acknowledgeProjection(owner,resource,job.id,result.hash);
          view=await this.call(owner,resource,id,t=>t.view(id));this.validateView(binding,resource,view);
        }else break;
      }
      return this.current(owner,resource,id).binding;
    });
  }
  async conflicts(owner:string,resource:string,id:string) {
    resource=this.resourceId(resource);
    const {binding}=this.current(owner,resource,id);
    const view=await this.call(owner,resource,id,t=>t.view(id));this.validateView(binding,resource,view);
    return view.proposals.filter(p=>p.state==='conflict'&&!p.resolvedBy).map(local=>{
      const receipt=this.store.receipt(owner,resource,id,binding.generation,local.proposal.mutationId);
      if(!receipt||receipt.state!=='conflict'||!isDeepStrictEqual(receipt,local.receipt))throw new ContentProposalConflict('conflict-proof');
      const remote=this.store.snapshot(owner,resource,receipt.revision,receipt.hash);
      if(!remote)throw new ContentProposalConflict('conflict-snapshot');
      return {local,remote,actualHash:view.actualHash};
    });
  }
  async originalProposal(owner:string,resource:string,id:string,mutationId:string){
    resource=this.resourceId(resource);const {binding}=this.current(owner,resource,id);
    const view=await this.call(owner,resource,id,t=>t.view(id));this.validateView(binding,resource,view);
    return view.proposals.find(p=>p.proposal.mutationId===mutationId);
  }
  /** Explicit reconciliation creates a new CAS from the preserved conflict
   * snapshot. It neither edits the local file nor resends an unknown proposal. */
  async resolveConflict(owner:string,resource:string,id:string,input:{conflictId:string;mutationId:string;expectedHash:string}) {
    resource=this.resourceId(resource);
    return this.exclusive(owner,resource,id,async()=>{
      const {binding}=this.current(owner,resource,id);
      const receipt=this.store.receipt(owner,resource,id,binding.generation,input.conflictId);
      if(!receipt||receipt.state!=='conflict')throw new ContentProposalConflict('conflict-proof');
      const base=this.store.snapshot(owner,resource,receipt.revision,receipt.hash);
      if(!base)throw new ContentProposalConflict('conflict-snapshot');
      return this.call(owner,resource,id,t=>t.resolve(id,{...input,base}));
    });
  }
  async revoke(owner:string,resource:string,id:string) {
    resource=this.resourceId(resource);
    // Owner-authorized revocation must also work when the target is offline or
    // its permissions were already removed. Cleanup never targets a new lease.
    const binding=this.store.revoke(owner,resource,id);
    if(!binding.target)return {revoked:true,cleanup:'unavailable' as const};
    let target:SharedContentTarget;
    try{
      target=this.resolve(owner,binding.target.sessionId);this.validateTarget(target);
      if(!sameTarget(target,binding.target))return {revoked:true,cleanup:'unavailable' as const};
    }catch{return {revoked:true,cleanup:'unavailable' as const};}
    await target.transport.revoke(id);
    this.validateTarget(target);
    const after=this.resolve(owner,binding.target.sessionId);this.validateTarget(after);
    return {revoked:true,cleanup:sameTarget(after,binding.target)?'confirmed' as const:'unavailable' as const};
  }
}
