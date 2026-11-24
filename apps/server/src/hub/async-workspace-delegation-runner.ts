import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import { HubMemberRequestError } from './async-member-request.js';
import type { DelegationBatch, DelegationIntent } from './workspace-delegation-store.js';
import { delegationRemoteLane, readDelegationRemote, validDelegationRemote, type DelegationScope,
  type DelegationRemote } from './async-workspace-delegation-directory.js';

/** Explicit HTTP-owned coordinator, never startup recovery. Durable first-claim
 * is the only PUT admission. Reconciliation/repeated confirm cannot replay it. */
export class AsyncDelegationRunner {
  constructor(private readonly scope: DelegationScope, private readonly request: Request, private readonly boardId: string,
    private readonly clients?: AsyncConnectorClientResolver, private readonly endpoint?: string) {}
  private async bounded<T>(items:T[], effect:(item:T)=>Promise<void>) {
    let next = 0, stopped = false;
    const results = await Promise.allSettled(Array.from({length:Math.min(items.length,4)},async () => {
      try { while (!stopped && next < items.length) await effect(items[next++]!); }
      catch (error) { stopped = true; throw error; }
    }));
    const failed = results.filter((r):r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(r => r.reason),'Delegation operation incomplete');
  }
  private async read(batchId:string) {
    const result = await this.scope.command({action:'read',boardId:this.boardId,batchId});
    if (!result.batch) throw new HubMemberRequestError(404); return result.batch;
  }
  private intent(batch:DelegationBatch, member:DelegationBatch['members'][number]): DelegationIntent {
    return {owner:batch.owner,batchId:batch.batchId,boardId:this.boardId,boardRevision:batch.preview.resource.revision,
      requestId:member.requestId,member:member.member,grant:{taskIds:batch.preview.resource.tasks.map(t => t.id),
        fields:batch.preview.resource.fields,expiresAt:batch.grantExpiresAt}};
  }
  private signal() { return AbortSignal.any([this.request.signal,AbortSignal.timeout(5000)]); }
  async run(batchId:string) {
    const batch = await this.read(batchId);
    if (!this.endpoint) throw new HubMemberRequestError(503);
    await this.bounded(batch.members,async member => {
      // Fixed stages only: 11 claim, 12 discovery, 13 preflight, 14 fence,
      // 15 original PUT, 16 original SQL settlement. Never include business IDs.
      const trace = this.scope.effect(11); let failed = true;
      let stage = 11;
      const at = (next:number) => { trace.add('step',next-stage); stage = next; };
      try {
      const claimed = await this.scope.command({action:'claim',boardId:this.boardId,batchId,requestId:member.requestId,endpoint:this.endpoint!});
      if (!claimed.claimed) { trace.add('admitted',0); failed = false; return; }
      trace.add('admitted',1);
      if (!claimed.intent || !claimed.credential) throw new HubMemberRequestError(503);
      const intent = claimed.intent, credential = claimed.credential;
      let state: 'installed'|'unknown' = 'unknown';
      try {
        at(12);
        const signal = this.signal(), lane = await delegationRemoteLane(this.scope,this.request,intent.member,this.clients);
        at(13);
        const before = await readDelegationRemote(lane,intent.member,signal);
        // All discovery/preflight waits precede the transaction-local final fence.
        at(14);
        const check = await this.scope.command({action:'write-check',boardId:this.boardId,batchId,requestId:intent.requestId});
        if (check.ok && before.ready && before.binding?.state !== 'installed') {
          at(15);
          const result = await lane.client.jsonOriginal<{binding:DelegationRemote['binding']}>(lane.path,
            {method:'PUT',body:JSON.stringify({id:intent.requestId,credential}),signal});
          if (validDelegationRemote({...before,binding:result?.binding},intent.member) && result.binding?.id === intent.requestId
            && result.binding.state === 'installed' && result.binding.expiresAt === intent.grant.expiresAt) state = 'installed';
        }
      } catch { /* No resend or raw error. */ }
      trace.add('unknown',state === 'unknown' ? 1 : 0); trace.reportPending();
      at(16);
      await this.scope.command({action:'settle',boardId:this.boardId,batchId,requestId:intent.requestId,state,source:'put'});
      trace.add('settled',1); failed = state === 'unknown';
      } finally { trace.finish(failed); }
    });
    return this.read(batchId);
  }
  async reconcile(batchId:string) {
    const batch = await this.read(batchId);
    await this.bounded(batch.members.filter(m => m.state === 'dispatching' || m.state === 'unknown'),async member => {
      const trace = this.scope.effect(21); let failed = true;
      try {
        const intent = this.intent(batch,member), lane = await delegationRemoteLane(this.scope,this.request,intent.member,this.clients);
        trace.add('step',1);
        const remote = await readDelegationRemote(lane,intent.member,this.signal());
        const installed = remote.binding?.id === intent.requestId && remote.binding.state === 'installed' && remote.binding.expiresAt === intent.grant.expiresAt;
        trace.add('unknown',installed ? 0 : 1); trace.add('step',1);
        await this.scope.command({action:'settle',boardId:this.boardId,batchId,requestId:intent.requestId,state:installed ? 'installed' : 'unknown',source:'query'});
        trace.add('settled',1); failed = !installed;
      } catch { trace.add('unknown',1); /* Read-only recovery never PUTs. */ }
      finally { trace.finish(failed); }
    });
    return this.read(batchId);
  }
  async cancel(batchId:string) {
    // Root commit includes batch fence and EVERY existing local capability.
    const {batch} = await this.scope.command({action:'cancel',boardId:this.boardId,batchId});
    if (!batch) return null;
    await this.bounded(batch.members.filter(m => m.state === 'cleanup_pending'),async member => {
      const trace = this.scope.effect(31); let failed = true;
      try {
        const lane = await delegationRemoteLane(this.scope,this.request,member.member,this.clients);
        trace.add('step',1);
        const result = await lane.client.jsonOriginal<{id:string;state:string}>(`${lane.path}/${encodeURIComponent(member.requestId)}`,
          {method:'DELETE',signal:this.signal()});
        if (result?.id === member.requestId && result.state === 'removed') {
          trace.add('step',1);
          await this.scope.command({action:'cleanup-settle',boardId:this.boardId,batchId,requestId:member.requestId});
          trace.add('settled',1); failed = false;
        }
      } catch { /* Durable revocation is not proof of remote cleanup. */ }
      finally { trace.add('unknown',failed ? 1 : 0); trace.finish(failed); }
    });
    return this.read(batchId);
  }
}
