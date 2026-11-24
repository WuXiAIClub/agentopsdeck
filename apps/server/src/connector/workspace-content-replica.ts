import type { DatabaseSync } from 'node:sqlite';
import type { ContentProposal, ContentReceipt } from '../hub/content-proposal-store.js';
import type { ConnectorWorkspaceFiles, ConnectorFileBoardView, FileBoardWrite, FileBoardWriteReceipt, ConnectorFileBoardIntent } from './workspace-board-files.js';
import type { WorkspaceFileSnapshot } from './workspace-file-codec.js';
import { WorkspaceContentMetadata, ContentReplicaConflict, type WorkspaceContentMetadataPort,
  type ContentReplicaStorageAdmission, type ContentReplicaInstallation, type ContentReplicaResolution,
  type ContentReplicaSnapshot, type LocalContentProposal } from './workspace-content-metadata.js';
import type { ContentProjection } from '../hub/content-proposal-store.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
export { ContentReplicaConflict, CONTENT_REPLICA_BYTE_LIMIT, type ContentReplicaStorageAdmission,
  type LocalContentProposal } from './workspace-content-metadata.js';

export interface ContentProposalEndpoint {
  propose(resource: string, proposal: ContentProposal): Promise<ContentReceipt>;
  original(resource: string, proposal: ContentProposal): Promise<ContentReceipt | undefined>;
}
type Awaitable<R> = R | Promise<R>;
export type ContentReplicaFilePort<T,Actor> = {
  get(actor: Actor,id: string): Awaitable<ConnectorFileBoardView>;
  install(actor: Actor,input: ConnectorFileBoardIntent<T>): Promise<ConnectorFileBoardView>;
  snapshot(actor: Actor,id: string): Promise<WorkspaceFileSnapshot<T>>;
  write(actor: Actor,id: string,input: FileBoardWrite<T>): Promise<FileBoardWriteReceipt<T>>;
  receipt(actor: Actor,id: string,mutation: string): Awaitable<FileBoardWriteReceipt<T>>;
  revoke(actor: Actor,id: string): Promise<unknown>;
};
const snapshotProof = <T>(snapshot: WorkspaceFileSnapshot<T>): ContentReplicaSnapshot => snapshot.state === 'ready'
  ? {hash:snapshot.value.hash,content:JSON.stringify(snapshot.value.content)} : null;
const pending = (local: LocalContentProposal) => local.state !== 'committed' && !(local.state === 'conflict' && local.resolvedBy);

/** Original physical and transport executor, shared by the compatibility facade
 * and worker-backed composition. No SQL or database connection lives here. */
export class WorkspaceContentEffects<T,Actor> {
  private readonly active = new Set<string>();
  private readonly tasks = createTaskDrain();
  constructor(protected readonly metadata: WorkspaceContentMetadataPort<T,Actor>,
    private readonly files: ContentReplicaFilePort<T,Actor>) {}
  private async exclusive<R>(id: string,fn: () => Promise<R>) {
    // The drain counts accepted work before calling any metadata/physical port.
    // It never relies on a caller-visible (and mutable) Promise to track work.
    return this.tasks.run(async () => {
      if (this.active.has(id) || this.active.size >= 4) throw new ContentReplicaConflict('replica-busy');
      this.active.add(id);
      try { return await fn(); } finally { this.active.delete(id); }
    });
  }
  close(): Promise<void> { return this.tasks.close(); }
  install(owner: Actor,input: ContentReplicaInstallation) {
    owner = structuredClone(owner);
    input = structuredClone(input);
    return this.exclusive(input.id,async () => {
      const plan = await this.metadata.installation(owner,input);
      if (plan.prior?.state === 'ready') return structuredClone(plan.prior.initial);
      if (!plan.prior) await this.metadata.prepareInstallation(owner,input);
      await this.files.install(owner,{id:input.id,sessionKey:input.sessionKey,content:plan.content});
      const snapshot = await this.files.snapshot(owner,input.id);
      if (snapshot.state !== 'ready' || snapshot.value.hash !== input.base.hash) throw new ContentReplicaConflict('installation-dirty');
      return this.metadata.installed(owner,input.id,snapshot.value.hash);
    });
  }
  view(owner: Actor,id: string) {
    owner = structuredClone(owner);
    return this.exclusive(id,async () => {
      await this.metadata.owned(owner,id);
      const snapshot = await this.files.snapshot(owner,id), current = await this.metadata.owned(owner,id);
      return {resource:current.resource,generation:current.generation,sessionKey:current.sessionKey,
        initial:structuredClone(current.initial),base:structuredClone(current.base),
        actualHash:snapshot.state === 'ready' ? snapshot.value.hash : null,proposals:await this.metadata.proposals(owner,id)};
    });
  }
  claimPublish(owner: Actor,id: string,mutation: string) {
    owner = structuredClone(owner);
    return this.exclusive(id,async () => this.metadata.claim(owner,id,mutation));
  }
  settle(owner: Actor,id: string,mutation: string,receipt: ContentReceipt) {
    owner = structuredClone(owner);
    receipt = structuredClone(receipt);
    return this.exclusive(id,async () => this.metadata.settle(owner,id,mutation,receipt));
  }
  /** Explicit reconciliation retains original conflict, current local file and
   * authenticated new base. It creates a new CAS proposal, never file IO. */
  resolve(owner: Actor,id: string,input: ContentReplicaResolution): Promise<LocalContentProposal> {
    owner = structuredClone(owner);
    input = structuredClone(input);
    return this.exclusive(id,async () => {
      const plan = await this.metadata.resolution(owner,id,input);
      if (plan.prior) return plan.prior;
      const snapshot = await this.files.snapshot(owner,id); await this.metadata.owned(owner,id);
      return this.metadata.resolve(owner,id,input,plan.replica,plan.conflict,snapshotProof(snapshot));
    });
  }
  observe(owner: Actor,id: string): Promise<LocalContentProposal | undefined> {
    owner = structuredClone(owner);
    return this.exclusive(id,async () => {
      const replica = await this.metadata.owned(owner,id), original = (await this.metadata.proposals(owner,id)).find(pending);
      if (original) return original;
      const snapshot = await this.files.snapshot(owner,id); await this.metadata.owned(owner,id);
      return this.metadata.observe(owner,id,replica,snapshotProof(snapshot));
    });
  }
  publish(owner: Actor,id: string,mutation: string,endpoint: ContentProposalEndpoint) {
    owner = structuredClone(owner);
    return this.exclusive(id,async () => {
      const replica = await this.metadata.owned(owner,id), claimed = await this.metadata.claim(owner,id,mutation,replica);
      if (!claimed.claimed) return claimed.local;
      // UNKNOWN is durable before handing off to the original transport.
      try { return await this.metadata.settle(owner,id,mutation,await endpoint.propose(replica.resource,claimed.local.proposal)); }
      catch {
        await this.metadata.owned(owner,id);
        return (await this.metadata.proposals(owner,id)).find(p => p.proposal.mutationId === mutation)!;
      }
    });
  }
  recover(owner: Actor,id: string,mutation: string,endpoint: ContentProposalEndpoint) {
    owner = structuredClone(owner);
    return this.exclusive(id,async () => {
      const replica = await this.metadata.owned(owner,id), local = (await this.metadata.proposals(owner,id)).find(p => p.proposal.mutationId === mutation);
      if (!local) throw new ContentReplicaConflict('proposal-missing');
      if (local.state !== 'unknown') return local;
      const receipt = await endpoint.original(replica.resource,local.proposal); await this.metadata.owned(owner,id);
      return receipt ? this.metadata.settle(owner,id,mutation,receipt) : local;
    });
  }
  private async originalProjection(owner: Actor,id: string,job: ContentProjection,existing: boolean) {
    let state: 'saved'|'conflict'|'uncertain' = 'uncertain';
    if (existing) {
      try { state = (await this.files.receipt(owner,id,job.id)).state; }
      catch (e) { if (!(e instanceof Error && 'status' in e && e.status === 404)) throw e; }
    }
    return this.metadata.projected(owner,id,job,state);
  }
  project(owner: Actor,id: string,job: ContentProjection) {
    owner = structuredClone(owner);
    job = structuredClone(job);
    return this.exclusive(id,async () => {
      const plan = await this.metadata.projection(owner,id,job);
      if (plan.existing) return this.originalProjection(owner,id,job,true);
      const {content} = await this.metadata.prepareProjection(owner,id,job,plan.replica);
      const result = await this.files.write(owner,id,{mutationId:job.id,expectedHash:job.expectedHash!,content});
      return this.metadata.projected(owner,id,job,result.state);
    });
  }
  /** Inspection never invokes the file writer, even if no intent arrived. */
  projectionReceipt(owner: Actor,id: string,job: ContentProjection) {
    owner = structuredClone(owner);
    job = structuredClone(job);
    return this.exclusive(id,async () => {
      const plan = await this.metadata.projection(owner,id,job);
      return this.originalProjection(owner,id,job,plan.existing);
    });
  }
  revoke(owner: Actor,id: string) {
    owner = structuredClone(owner);
    // Revocation must still fence a binding with an in-flight publish/project;
    // it participates in shutdown, not in the binding's effect exclusion.
    return this.tasks.run(async () => {
      await this.metadata.revoke(owner,id); // Durable fence before async cleanup.
      await this.files.revoke(owner,id);
    });
  }
}

/** Compatibility facade: original constructor and synchronous proposal reads,
 * using the same sole journal implementation as the worker composition. */
export class WorkspaceContentReplica<T> extends WorkspaceContentEffects<T,string> {
  private readonly journal: WorkspaceContentMetadata<T>;
  constructor(db: DatabaseSync,files: ConnectorWorkspaceFiles<T>,admission?: ContentReplicaStorageAdmission) {
    const journal = new WorkspaceContentMetadata(db,files,admission);
    super(journal,files); this.journal = journal;
  }
  proposals(owner: string,id: string): LocalContentProposal[] { return this.journal.proposals(owner,id); }
}
