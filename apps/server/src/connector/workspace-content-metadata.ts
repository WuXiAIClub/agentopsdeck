import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validBoardUuid } from '@agentopsdeck/shared';
import { observedTransaction } from '../storage/observed-transaction.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import type { ContentResource, ContentProposal, ContentReceipt, ContentProjection } from '../hub/content-proposal-store.js';
import type { WorkspaceFileCodec } from './workspace-file-codec.js';

export type ContentReplicaRecord = { owner: string; id: string; resource: string; generation: string; sessionKey: string;
  base: ContentResource; initial: ContentResource; state: 'installing' | 'ready' | 'revoked' };
export type LocalContentProposal = { proposal: ContentProposal; baseContent: string;
  state: 'prepared' | 'unknown' | 'committed' | 'conflict'; receipt?: ContentReceipt; resolvedBy?: string };
export class ContentReplicaConflict extends Error {}
/** Physical admission may wait; the original owner's SQL callback never may. */
export type ContentReplicaStorageAdmission = <R>(bytes: number,
  write: () => R extends PromiseLike<unknown> ? never : R) => R | Promise<R>;
export const CONTENT_REPLICA_BYTE_LIMIT = 64 * 1024 * 1024;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const identity = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
export type ContentReplicaInstallation = {id: string;resource: string;generation: string;sessionKey: string;base: ContentResource};
export type ContentReplicaResolution = {conflictId: string;mutationId: string;expectedHash: string;base: ContentResource};
export type ContentReplicaSnapshot = {hash: string;content: string} | null;
type BindingAuthority<T> = {codec: WorkspaceFileCodec<T>;get(owner: string,id: string): {state: string};
  guard?(owner: string,sessionKey: string): void};

/** Sole SQL implementation of the original replica journal. No physical file
 * reads, network effects, async authorization callbacks or second connection. */
export class WorkspaceContentMetadata<T> {
  constructor(private readonly db: DatabaseSync, private readonly files: BindingAuthority<T>,
    private readonly admission?: ContentReplicaStorageAdmission) {
    db.exec(`CREATE TABLE IF NOT EXISTS connector_content_replicas(owner TEXT,id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_local_proposals(owner TEXT,binding TEXT,mutation TEXT,payload TEXT NOT NULL,
        PRIMARY KEY(owner,binding,mutation));
      CREATE TABLE IF NOT EXISTS connector_content_projections(owner TEXT,binding TEXT,id TEXT,fingerprint TEXT NOT NULL,
        PRIMARY KEY(owner,binding,id));`);
  }
  private transaction<R>(fn: () => R extends PromiseLike<unknown> ? never : R): R {
    requireConnectionReady(this.db);
    if (this.db.isTransaction) throw new ContentReplicaConflict('outer-transaction');
    return observedTransaction(this.db,'content-replica-change',fn);
  }
  private admitted<R>(bytes: number,fn: () => R extends PromiseLike<unknown> ? never : R): R | Promise<R> {
    requireConnectionReady(this.db);
    if (this.db.isTransaction) throw new ContentReplicaConflict('outer-transaction');
    return this.admission ? this.admission(bytes,() => this.transaction(fn) as R extends PromiseLike<unknown> ? never : R)
      : this.transaction(fn);
  }
  private raw(owner: string,id: string): ContentReplicaRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM connector_content_replicas WHERE owner=? AND id=?').get(owner,id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  private capacity(extra: string) {
    const tables = ['connector_content_replicas','connector_local_proposals','connector_content_projections'];
    const used = tables.reduce((sum,table) => sum + Number(this.db.prepare(
      `SELECT coalesce(sum(length(CAST(${table === 'connector_content_projections' ? 'fingerprint' : 'payload'} AS BLOB))),0) n FROM ${table}`).get()!.n),0);
    if (used + Buffer.byteLength(extra) > CONTENT_REPLICA_BYTE_LIMIT - 1024*1024) throw new ContentReplicaConflict('journal-capacity');
  }
  owned(owner: string,id: string) {
    const replica = this.raw(owner,id);
    if (!replica || replica.state !== 'ready' || this.files.get(owner,id).state !== 'installed') throw new ContentReplicaConflict('replica-unavailable');
    return replica;
  }
  private unchanged(owner: string,id: string,expected: ContentReplicaRecord) {
    const current = this.owned(owner,id);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new ContentReplicaConflict('replica-changed');
    return current;
  }
  private save(replica: ContentReplicaRecord) {
    this.db.prepare('UPDATE connector_content_replicas SET payload=? WHERE owner=? AND id=?').run(JSON.stringify(replica),replica.owner,replica.id);
  }
  private content(text: string) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > this.files.codec.maxBytes) throw new ContentReplicaConflict('content-capacity');
    const value: unknown = JSON.parse(text);
    if (!this.files.codec.valid(value)) throw new ContentReplicaConflict('content-schema');
    const parsed = this.files.codec.parse(Buffer.from(this.files.codec.serialize(value)));
    if (!parsed || JSON.stringify(parsed.content) !== text || parsed.hash !== digest(text)) throw new ContentReplicaConflict('content-canonical');
    return parsed.content;
  }
  private fresh(owner: string,id: string) {
    try { this.files.get(owner,id); throw new ContentReplicaConflict('legacy-binding'); }
    catch (e) { if (!(e instanceof Error && 'status' in e && e.status === 404)) throw e; }
  }
  installation(owner: string,input: ContentReplicaInstallation) {
    this.files.guard?.(owner,input.sessionKey);
    if (!identity(owner) || !validBoardUuid(input.id) || !identity(input.resource) || !identity(input.generation)
      || !identity(input.base.epoch) || !Number.isSafeInteger(input.base.revision) || input.base.revision < 0
      || !validHash(input.base.hash) || digest(input.base.content) !== input.base.hash) throw new ContentReplicaConflict('installation-input');
    const content = this.content(input.base.content), prior = this.raw(owner,input.id);
    if (prior) {
      if (prior.state === 'revoked' || prior.resource !== input.resource || prior.generation !== input.generation
        || prior.sessionKey !== input.sessionKey || ['epoch','revision','hash','content'].some(key =>
          prior.initial[key as keyof ContentResource] !== input.base[key as keyof ContentResource])) throw new ContentReplicaConflict('installation-reused');
      if (prior.state === 'ready') this.owned(owner,input.id);
    } else this.fresh(owner,input.id);
    return {prior,content};
  }
  prepareInstallation(owner: string,input: ContentReplicaInstallation) {
    // The pre-admission inspection never grants permission after an await.
    this.installation(owner,input);
    return this.admitted(16*1024*1024+65536,() => {
      this.files.guard?.(owner,input.sessionKey);
      if (this.raw(owner,input.id)) throw new ContentReplicaConflict('installation-reused');
      this.fresh(owner,input.id);
      if (Number(this.db.prepare('SELECT count(*) n FROM connector_content_replicas WHERE owner=?').get(owner)!.n) >= 128) throw new ContentReplicaConflict('replica-capacity');
      const intended: ContentReplicaRecord = {owner,id:input.id,resource:input.resource,generation:input.generation,
        sessionKey:input.sessionKey,base:structuredClone(input.base),initial:structuredClone(input.base),state:'installing'};
      this.capacity(JSON.stringify(intended));
      this.db.prepare('INSERT INTO connector_content_replicas VALUES(?,?,?)').run(owner,input.id,JSON.stringify(intended));
    });
  }
  installed(owner: string,id: string,hash: string) {
    const prior = this.raw(owner,id);
    if (!prior || prior.state === 'revoked' || this.files.get(owner,id).state !== 'installed') throw new ContentReplicaConflict('replica-unavailable');
    if (hash !== prior.initial.hash) throw new ContentReplicaConflict('installation-dirty');
    prior.state = 'ready'; this.save(prior); return structuredClone(prior.base);
  }
  proposals(owner: string,id: string): LocalContentProposal[] {
    this.owned(owner,id);
    return this.db.prepare('SELECT payload FROM connector_local_proposals WHERE owner=? AND binding=? ORDER BY rowid').all(owner,id)
      .map(row => JSON.parse(String(row.payload)) as LocalContentProposal);
  }
  private writeProposal(owner: string,id: string,proposal: LocalContentProposal) {
    this.db.prepare('INSERT INTO connector_local_proposals VALUES(?,?,?,?) ON CONFLICT(owner,binding,mutation) DO UPDATE SET payload=excluded.payload')
      .run(owner,id,proposal.proposal.mutationId,JSON.stringify(proposal));
  }
  private pending(local: LocalContentProposal) { return local.state !== 'committed' && !(local.state === 'conflict' && local.resolvedBy); }
  claim(owner: string,id: string,mutation: string,expected?: ContentReplicaRecord) {
    this.owned(owner,id);
    const original = this.proposals(owner,id).find(p => p.proposal.mutationId === mutation);
    if (!original) throw new ContentReplicaConflict('proposal-missing');
    if (original.state !== 'prepared') return {claimed:false,local:original};
    return this.admitted(8*1024*1024+65536,() => {
      if (expected) this.unchanged(owner,id,expected); else this.owned(owner,id);
      const local = this.proposals(owner,id).find(p => p.proposal.mutationId === mutation);
      if (!local) throw new ContentReplicaConflict('proposal-missing');
      if (local.state !== 'prepared') return {claimed:false,local};
      local.state = 'unknown'; this.writeProposal(owner,id,local); return {claimed:true,local};
    });
  }
  settle(owner: string,id: string,mutation: string,receipt: ContentReceipt) {
    if (!receipt) throw new ContentReplicaConflict('receipt-proof');
    return this.transaction(() => {
      const replica = this.owned(owner,id), local = this.proposals(owner,id).find(p => p.proposal.mutationId === mutation);
      if (!local || local.state === 'prepared') throw new ContentReplicaConflict('unclaimed-proposal');
      if (local.receipt) {
        if (['mutationId','fingerprint','state','revision','hash'].some(k => local.receipt![k as keyof ContentReceipt] !== receipt[k as keyof ContentReceipt])) throw new ContentReplicaConflict('immutable-receipt');
        return local;
      }
      const p = local.proposal, expected = digest(JSON.stringify([p.modeEpoch,p.baseRevision,p.baseHash,p.content]));
      if (!receipt || receipt.mutationId !== p.mutationId || receipt.fingerprint !== expected || !validHash(receipt.hash)
        || !Number.isSafeInteger(receipt.revision) || receipt.revision < p.baseRevision || !['committed','conflict'].includes(receipt.state)
        || receipt.state === 'committed' && (receipt.revision !== p.baseRevision+1 || receipt.hash !== digest(p.content))) throw new ContentReplicaConflict('receipt-proof');
      local.receipt = receipt; local.state = receipt.state; this.writeProposal(owner,id,local);
      if (receipt.state === 'committed') {
        if (replica.base.revision > receipt.revision) throw new ContentReplicaConflict('stale-receipt');
        replica.base = {epoch:p.modeEpoch,revision:receipt.revision,hash:receipt.hash,content:p.content}; this.save(replica);
      }
      return local;
    });
  }
  resolution(owner: string,id: string,input: ContentReplicaResolution) {
    const replica = this.owned(owner,id);
    if (!validBoardUuid(input.mutationId) || !validBoardUuid(input.conflictId) || input.mutationId === input.conflictId
      || !validHash(input.expectedHash)) throw new ContentReplicaConflict('resolution-input');
    const proposals = this.proposals(owner,id), conflict = proposals.find(p => p.proposal.mutationId === input.conflictId), base = input.base;
    if (!conflict || conflict.state !== 'conflict' || !conflict.receipt || conflict.receipt.state !== 'conflict'
      || !base || base.epoch !== replica.base.epoch || base.epoch !== conflict.proposal.modeEpoch
      || base.revision !== conflict.receipt.revision || base.hash !== conflict.receipt.hash || digest(base.content) !== base.hash) throw new ContentReplicaConflict('resolution-proof');
    this.content(base.content);
    const prior = proposals.find(p => p.proposal.mutationId === input.mutationId);
    if (prior) {
      if (conflict.resolvedBy !== input.mutationId || prior.baseContent !== base.content || prior.proposal.baseRevision !== base.revision
        || prior.proposal.baseHash !== base.hash || digest(prior.proposal.content) !== input.expectedHash) throw new ContentReplicaConflict('resolution-reused');
    } else if (conflict.resolvedBy || proposals.some(p => this.pending(p) && p !== conflict)) throw new ContentReplicaConflict('pending-proposal');
    return {replica,conflict,prior};
  }
  resolve(owner: string,id: string,input: ContentReplicaResolution,expected: ContentReplicaRecord,conflict: LocalContentProposal,snapshot: ContentReplicaSnapshot) {
    if (!snapshot || snapshot.hash !== input.expectedHash || digest(snapshot.content) !== snapshot.hash) throw new ContentReplicaConflict('resolution-dirty');
    this.content(snapshot.content);
    return this.admitted(32*1024*1024+65536,() => {
      this.unchanged(owner,id,expected);
      this.resolution(owner,id,input);
      const current = this.proposals(owner,id), original = current.find(p => p.proposal.mutationId === input.conflictId);
      if (!original || JSON.stringify(original) !== JSON.stringify(conflict) || current.some(p => this.pending(p) && p.proposal.mutationId !== input.conflictId)
        || current.some(p => p.proposal.mutationId === input.mutationId)) throw new ContentReplicaConflict('pending-proposal');
      if (current.length >= 128) throw new ContentReplicaConflict('proposal-capacity');
      const replacement: LocalContentProposal = {state:'prepared',baseContent:input.base.content,proposal:{bindingId:id,generation:expected.generation,
        mutationId:input.mutationId,modeEpoch:input.base.epoch,baseRevision:input.base.revision,baseHash:input.base.hash,content:snapshot.content}};
      this.capacity(JSON.stringify(replacement)+input.mutationId); original.resolvedBy = input.mutationId;
      this.writeProposal(owner,id,original); this.writeProposal(owner,id,replacement); return replacement;
    });
  }
  observe(owner: string,id: string,expected: ContentReplicaRecord,snapshot: ContentReplicaSnapshot) {
    this.owned(owner,id);
    if (!snapshot) throw new ContentReplicaConflict('source-unavailable');
    if (snapshot.hash === expected.base.hash) return;
    if (digest(snapshot.content) !== snapshot.hash) throw new ContentReplicaConflict('content-canonical');
    this.content(snapshot.content);
    return this.admitted(16*1024*1024+65536,() => {
      this.unchanged(owner,id,expected);
      const pending = this.proposals(owner,id).find(p => this.pending(p)); if (pending) return pending;
      if (this.proposals(owner,id).length >= 128) throw new ContentReplicaConflict('proposal-capacity');
      const local: LocalContentProposal = {proposal:{bindingId:id,generation:expected.generation,mutationId:randomUUID(),modeEpoch:expected.base.epoch,
        baseRevision:expected.base.revision,baseHash:expected.base.hash,content:snapshot.content},baseContent:expected.base.content,state:'prepared'};
      this.capacity(JSON.stringify(local)); this.writeProposal(owner,id,local); return local;
    });
  }
  projection(owner: string,id: string,job: ContentProjection) {
    const replica = this.owned(owner,id);
    if (job.bindingId !== id || job.generation !== replica.generation || job.state !== 'unknown' || !validBoardUuid(job.id)
      || !validHash(job.hash) || job.hash !== digest(job.content) || !Number.isSafeInteger(job.revision)
      || !job.expectedHash || !validHash(job.expectedHash)) throw new ContentReplicaConflict('projection-proof');
    const fingerprint = digest(JSON.stringify([job.bindingId,job.generation,job.revision,job.hash,job.expectedHash]));
    const prior = this.db.prepare('SELECT fingerprint FROM connector_content_projections WHERE owner=? AND binding=? AND id=?').get(owner,id,job.id);
    if (prior && prior.fingerprint !== fingerprint) throw new ContentReplicaConflict('projection-reused');
    return {replica,fingerprint,existing:!!prior};
  }
  prepareProjection(owner: string,id: string,job: ContentProjection,expected: ContentReplicaRecord) {
    const plan = this.projection(owner,id,job);
    if (plan.existing || job.revision <= expected.base.revision || job.expectedHash !== expected.base.hash) throw new ContentReplicaConflict('projection-proof');
    if (this.proposals(owner,id).some(p => this.pending(p))) throw new ContentReplicaConflict('pending-proposal');
    const content = this.content(job.content);
    const reserved = this.admitted(65536,() => {
      this.unchanged(owner,id,expected);
      if (this.proposals(owner,id).some(p => this.pending(p))) throw new ContentReplicaConflict('pending-proposal');
      if (this.projection(owner,id,job).existing) throw new ContentReplicaConflict('projection-reused');
      if (Number(this.db.prepare('SELECT count(*) n FROM connector_content_projections WHERE owner=? AND binding=?').get(owner,id)!.n) >= 512) throw new ContentReplicaConflict('projection-capacity');
      this.capacity(plan.fingerprint);
      this.db.prepare('INSERT INTO connector_content_projections VALUES(?,?,?,?)').run(owner,id,job.id,plan.fingerprint);
      return {content};
    });
    return reserved;
  }
  projected(owner: string,id: string,job: ContentProjection,state: 'saved'|'conflict'|'uncertain') {
    const plan = this.projection(owner,id,job);
    if (!plan.existing && state !== 'uncertain') throw new ContentReplicaConflict('projection-proof');
    if (state === 'saved' && plan.replica.base.revision < job.revision) {
      plan.replica.base = {...plan.replica.base,revision:job.revision,hash:job.hash,content:job.content}; this.save(plan.replica);
    }
    return {id:job.id,state,hash:state === 'saved' ? job.hash : null};
  }
  revoke(owner: string,id: string) {
    const replica = this.raw(owner,id); if (!replica) throw new ContentReplicaConflict('replica-unavailable');
    this.files.guard?.(owner,replica.sessionKey);
    replica.state = 'revoked'; this.save(replica);
  }
}

/** Same complete command boundaries for a local synchronous owner or the
 * fixed worker domain. No executable callbacks cross this port. */
export type WorkspaceContentMetadataPort<T,Actor> = {
  [K in keyof WorkspaceContentMetadata<T>]: WorkspaceContentMetadata<T>[K] extends (owner: string,...args: infer A) => infer R
    ? (actor: Actor,...args: A) => Awaited<R> | Promise<Awaited<R>> : never;
};
