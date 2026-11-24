import { observedTransaction } from '../storage/observed-transaction.js';
import { observedParticipant } from '../storage/observed-participant.js';
import { synchronousSqliteValue } from '../auth/synchronous-sqlite-value.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { WORKSPACE_FILE_CARD_MAX_BYTES, workspaceFileCardContent } from '@agentopsdeck/shared';
import type { NativeWorkspaceCardFileProjection } from './workspace-card-file-projection.js';

export type ContentResource = { epoch: string; revision: number; hash: string; content: string };
export type ContentMigrationReceipt = { mutationId: string; resource: string; nativeRevision: number; result: ContentResource };
export type ContentMigrationTermination = { mutationId: string; resource: string; state: 'not-executed' };
export type ContentWriteTermination = ContentMigrationTermination & { epoch: string };
type Resource = ContentResource;
export type ContentBindingTarget = { sessionId: string; connectionId: string; sessionKey: string; authority: number };
export type ContentBinding = { id: string; generation: string; authorityEpoch: string; revoked: boolean; acknowledgedRevision: number; acknowledgedHash: string;
  target?: ContentBindingTarget; initial?: ContentResource };
type Binding = ContentBinding;
export type ContentProposal = { bindingId: string; generation: string; mutationId: string; modeEpoch: string; baseRevision: number; baseHash: string; content: string };
export type ContentReceipt = { mutationId: string; fingerprint: string; state: 'committed' | 'conflict'; revision: number; hash: string };
type Receipt = ContentReceipt;
export type ContentProjection = { id: string; bindingId: string; generation: string; revision: number; hash: string; content: string;
  state: 'pending' | 'unknown' | 'acknowledged'; expectedHash: string | null };
type Projection = ContentProjection;
export type ContentResolutionInput = { conflictId:string;mutationId:string;expectedHash:string;epoch:string;revision:number;hash:string };
export type ContentResolutionIntent = ContentResolutionInput & {state:'unknown'|'acknowledged'};
export class ContentProposalConflict extends Error {}
export type ContentStorageAdmission = <T>(bytes:number,write:()=>T extends PromiseLike<unknown>?never:T)=>T;
export type ContentAsyncStorageAdmission = <T>(bytes:number,write:()=>T extends PromiseLike<unknown>?never:T)=>T|Promise<T>;
export const CONTENT_PROPOSAL_BYTE_LIMIT = 64 * 1024 * 1024;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const identity = (v: string) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
const digest = (v: string) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const revision = (v: number) => Number.isSafeInteger(v) && v >= 0;

/** M1 isolated v2 transaction store. Not registered with legacy resource/file
 * stores: migrating a live resource still requires an exclusive migration fence.
 * The caller supplies a kind-specific canonical schema validator and current
 * authority check; neither card content nor a session supplies these functions. */
export class ContentProposalStore {
  private admittedWrite=false;
  private admissionCheck:(()=>void)|undefined;
  constructor(private readonly db: DatabaseSync, private readonly normalize: (content: string, resource: string) => string,
    private readonly authorized: (owner: string, resource: string, binding: Readonly<Binding>) => boolean,
    private readonly storageAdmission?:ContentStorageAdmission,
    private readonly asyncStorageAdmission?:ContentAsyncStorageAdmission) {}
  /** Only physical admission may wait. Each domain operation below still owns
   * its ORIGINAL synchronous transaction, CAS, receipt and native participant.
   * A production async owner refuses the old growing synchronous entry points. */
  private async admitted<T>(bytes:number,write:()=>T extends PromiseLike<unknown>?never:T,check:()=>void):Promise<T> {
    if(this.db.isTransaction||this.admittedWrite)throw new ContentProposalConflict('outer-transaction');
    const run=()=>{
      if(this.db.isTransaction||this.admittedWrite)throw new ContentProposalConflict('outer-transaction');
      this.admittedWrite=true;this.admissionCheck=check;
      try{return write();}finally{this.admittedWrite=false;this.admissionCheck=undefined;}
    };
    return bytes&&this.asyncStorageAdmission?await this.asyncStorageAdmission(bytes,run):run();
  }
  initializeAsync(owner:string,resource:string,epoch:string,content:string,check=()=>{}) {
    return this.admitted(8*1024*1024+65536,()=>this.initialize(owner,resource,epoch,content),check);
  }
  migrateNativeAsync(owner:string,resource:string,revision:number,projection:NativeWorkspaceCardFileProjection,check=()=>{}) {
    return this.admitted(16*1024*1024+65536,()=>this.migrateNative(owner,resource,revision,projection),check);
  }
  migrateNativeRequestAsync(owner:string,resource:string,revision:number,id:string,projection:NativeWorkspaceCardFileProjection,check=()=>{}) {
    const bytes=this.migration(owner,id)||this.migrationTermination(owner,id)?0:16*1024*1024+65536;
    return this.admitted(bytes,()=>this.migrateNativeRequest(owner,resource,revision,id,projection),check);
  }
  recoverMigrationAsync(owner:string,resource:string,id:string,check=()=>{}) {
    const bytes=this.migration(owner,id)||this.migrationTermination(owner,id)?0:65536;
    return this.admitted(bytes,()=>this.recoverMigration(owner,resource,id),check);
  }
  bindAsync(owner:string,resource:string,id:string,authorityEpoch:string,intent:Parameters<ContentProposalStore['bind']>[4],check=()=>{}) {
    return this.admitted(16*1024*1024+65536,()=>this.bind(owner,resource,id,authorityEpoch,intent),check);
  }
  proposeAsync(owner:string,resource:string,proposal:ContentProposal,check=()=>{}) {
    const bytes=this.receipt(owner,resource,proposal.bindingId,proposal.generation,proposal.mutationId)?0:2*CONTENT_PROPOSAL_BYTE_LIMIT+8*1024*1024;
    return this.admitted(bytes,()=>this.propose(owner,resource,proposal),check);
  }
  writeAsync(owner:string,resource:string,input:Omit<ContentProposal,'bindingId'|'generation'>,check=()=>{}) {
    const bytes=this.ownerReceipt(owner,resource,input.modeEpoch,input.mutationId)||this.writeTermination(owner,resource,input.modeEpoch,input.mutationId)?0:2*CONTENT_PROPOSAL_BYTE_LIMIT+8*1024*1024;
    return this.admitted(bytes,()=>this.write(owner,resource,input),check);
  }
  recoverWriteAsync(owner:string,resource:string,epoch:string,id:string,check=()=>{}) {
    const bytes=this.ownerReceipt(owner,resource,epoch,id)||this.writeTermination(owner,resource,epoch,id)?0:8192;
    return this.admitted(bytes,()=>this.recoverWrite(owner,resource,epoch,id),check);
  }
  claimProjectionAsync(owner:string,resource:string,id:string,actualHash:string,pending:boolean,check=()=>{}) {
    const bytes=this.projection(owner,resource,id).state==='pending'?8*1024*1024+65536:0;
    return this.admitted(bytes,()=>this.claimProjection(owner,resource,id,actualHash,pending),check);
  }
  claimResolutionAsync(owner:string,resource:string,id:string,generation:string,input:ContentResolutionInput,check=()=>{}) {
    const bytes=this.resolution(owner,resource,id,generation,input.conflictId)?0:65536;
    return this.admitted(bytes,()=>this.claimResolution(owner,resource,id,generation,input),check);
  }
  private scope(owner: string, resource: string) {
    if (!identity(owner) || !identity(resource)) throw new ContentProposalConflict('scope');
  }
  private canonical(content: string, resource: string) {
    // Bound serialization separately from content. The injected kind-specific
    // validator enforces text limits; JSON escaping/UTF-8 must not reduce them.
    if (typeof content !== 'string' || Buffer.byteLength(content) > WORKSPACE_FILE_CARD_MAX_BYTES) throw new ContentProposalConflict('content-capacity');
    const value = this.normalize(content, resource);
    if (typeof value !== 'string' || Buffer.byteLength(value) > WORKSPACE_FILE_CARD_MAX_BYTES) throw new ContentProposalConflict('content-capacity');
    return value;
  }
  private exists() { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_proposal_resources'").get(); }
  private capacity(extraBytes: number) {
    const used = ['v2_proposal_resources', 'v2_proposal_bindings', 'v2_content_proposals', 'v2_projection_outbox', 'v2_content_migrations', 'v2_content_migration_terminations', 'v2_content_write_terminations', 'v2_content_resolutions'].reduce((total, table) =>
      total + Number(this.db.prepare(`SELECT coalesce(sum(length(CAST(payload AS BLOB))${table === 'v2_content_proposals' ? '+length(CAST(content AS BLOB))' : ''}),0) n FROM ${table}`).get()!.n), 0);
    // Reserve settlement headroom. This is a logical journal ceiling, not a
    // promise of free physical volume space or permission to delete receipts.
    if (used + extraBytes > CONTENT_PROPOSAL_BYTE_LIMIT - 1024 * 1024) throw new ContentProposalConflict('journal-capacity');
  }
  private transaction<T>(fn: (checkParticipant: (value: unknown) => void) => T extends PromiseLike<unknown> ? never : T, reserveBytes=0): T {
    if (this.db.isTransaction) throw new ContentProposalConflict('outer-transaction');
    if(reserveBytes&&!this.admittedWrite&&this.asyncStorageAdmission)throw new ContentProposalConflict('async-admission-required');
    if(reserveBytes&&this.storageAdmission)return this.storageAdmission(reserveBytes,()=>this.transaction(fn) as T extends PromiseLike<unknown>?never:T);
    return observedTransaction(this.db, 'content-proposal-change', (_commit, checkParticipant) => {
      if(this.admissionCheck&&synchronousSqliteValue(this.db,this.admissionCheck)!==undefined)throw new ContentProposalConflict('content-authority');
      this.db.exec(`CREATE TABLE IF NOT EXISTS v2_proposal_resources(owner TEXT,resource TEXT,payload TEXT,PRIMARY KEY(owner,resource));
        CREATE TABLE IF NOT EXISTS v2_proposal_bindings(owner TEXT,resource TEXT,id TEXT,payload TEXT,PRIMARY KEY(owner,resource,id));
        CREATE TABLE IF NOT EXISTS v2_content_proposals(owner TEXT,resource TEXT,binding TEXT,generation TEXT,mutation TEXT,content TEXT,payload TEXT,PRIMARY KEY(owner,resource,binding,generation,mutation));
        CREATE TABLE IF NOT EXISTS v2_projection_outbox(owner TEXT,resource TEXT,id TEXT,payload TEXT,PRIMARY KEY(owner,resource,id));
        CREATE TABLE IF NOT EXISTS v2_content_migrations(owner TEXT,mutation TEXT,payload TEXT,PRIMARY KEY(owner,mutation));
        CREATE TABLE IF NOT EXISTS v2_content_migration_terminations(owner TEXT,mutation TEXT,payload TEXT,PRIMARY KEY(owner,mutation));
        CREATE TABLE IF NOT EXISTS v2_content_write_terminations(owner TEXT,resource TEXT,epoch TEXT,mutation TEXT,payload TEXT,PRIMARY KEY(owner,resource,epoch,mutation));
        CREATE TABLE IF NOT EXISTS v2_content_resolutions(owner TEXT,resource TEXT,binding TEXT,generation TEXT,conflict TEXT,mutation TEXT,payload TEXT,
          PRIMARY KEY(owner,resource,binding,generation,conflict),UNIQUE(owner,resource,binding,generation,mutation));`);
      return fn(checkParticipant);
    });
  }
  resource(owner: string, resource: string): Resource | undefined {
    this.scope(owner, resource); if (!this.exists()) return undefined;
    const row = this.db.prepare('SELECT payload FROM v2_proposal_resources WHERE owner=? AND resource=?').get(owner, resource);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  /** Internal same-view overview reader. Never retain 32 content bodies in a
   * metadata RPC or keep the SQL iterator open across an await. Tombstones and
   * initial snapshots are part of the pre-existing owner overview contract. */
  *overviewBindings(owner:string,resource:string):Generator<ContentBinding> {
    this.scope(owner,resource);if(!this.exists())return;
    for(const row of this.db.prepare('SELECT payload FROM v2_proposal_bindings WHERE owner=? AND resource=?').iterate(owner,resource))
      yield JSON.parse(String(row.payload)) as ContentBinding;
  }
  originalBindingSnapshot(owner:string,resource:string,id:string,generation:string):Resource|undefined {
    this.scope(owner,resource);if(!this.exists())return;
    const row=this.db.prepare('SELECT payload FROM v2_proposal_bindings WHERE owner=? AND resource=? AND id=?').get(owner,resource,id);
    const binding:ContentBinding|undefined=row?JSON.parse(String(row.payload)):undefined;
    // Exact owner view, including revoked initial snapshots, just as the
    // original overview. This is NOT a live replica or effect authorization.
    return binding?.generation===generation?binding.initial:undefined;
  }
  exactSnapshot(owner:string,resource:string,ref:Pick<Resource,'epoch'|'revision'|'hash'>):Resource|undefined {
    const current=this.resource(owner,resource);
    // Historical proposal receipts omit epoch. They are meaningful ONLY in
    // this unchanged resource epoch; never relabel an old body with a new one.
    if(!current||current.epoch!==ref.epoch)return;
    const snapshot=this.snapshot(owner,resource,ref.revision,ref.hash);
    return snapshot?.epoch===ref.epoch?snapshot:undefined;
  }
  /** Bounded round-robin scan; authority is rechecked by the coordinator. */
  syncPage(after:number) {
    if(!this.exists())return [];
    return this.db.prepare("SELECT rowid AS cursor,owner,resource,id FROM v2_proposal_bindings WHERE rowid>? AND json_extract(payload,'$.revoked')=0 ORDER BY rowid LIMIT 4")
      .all(after) as {cursor:number;owner:string;resource:string;id:string}[];
  }
  /** Historical conflict proof from immutable receipts, never a caller's head. */
  snapshot(owner:string,resource:string,atRevision:number,atHash:string):Resource|undefined {
    const current=this.resource(owner,resource);
    if(!current||!revision(atRevision)||!digest(atHash))return;
    if(current.revision===atRevision&&current.hash===atHash)return current;
    for(const row of this.db.prepare('SELECT content,payload FROM v2_content_proposals WHERE owner=? AND resource=?').all(owner,resource)){
      const receipt=JSON.parse(String(row.payload)) as Receipt;
      if(receipt.state==='committed'&&receipt.revision===atRevision&&receipt.hash===atHash)
        return {epoch:current.epoch,revision:atRevision,hash:atHash,content:String(row.content)};
    }
    for(const row of this.db.prepare('SELECT payload FROM v2_content_migrations WHERE owner=?').all(owner)){
      const receipt=JSON.parse(String(row.payload)) as ContentMigrationReceipt;
      if(receipt.resource===resource&&receipt.result.revision===atRevision&&receipt.result.hash===atHash)return receipt.result;
    }
  }
  /** Bootstrap only a new isolated v2 resource, never migrate an existing file. */
  initialize(owner: string, resource: string, epoch: string, content: string) {
    this.scope(owner, resource); if (!identity(epoch)) throw new ContentProposalConflict('epoch');
    const value = this.canonical(content, resource);
    return this.transaction(() => {
      if (this.resource(owner, resource)) throw new ContentProposalConflict('resource-exists');
      if (Number(this.db.prepare('SELECT count(*) n FROM v2_proposal_resources WHERE owner=?').get(owner)!.n) >= 128) throw new ContentProposalConflict('resource-capacity');
      const result: Resource = { epoch, revision: 0, hash: hash(value), content: value };
      this.capacity(Buffer.byteLength(JSON.stringify(result)));
      this.db.prepare('INSERT INTO v2_proposal_resources VALUES(?,?,?)').run(owner, resource, JSON.stringify(result)); return result;
    },8*1024*1024+65536);
  }
  /** Exclusive native -> v2 cutover. Native CAS advancement, writer fence and
   * authoritative content commit together. No legacy file is adopted and no
   * caller-provided content replaces the current native snapshot. Repeating a
   * migration is rejected; recovery reads the existing resource authority. */
  migrateNative(owner: string, resource: string, expectedRevision: number, projection: NativeWorkspaceCardFileProjection) {
    this.scope(owner, resource);
    if (!revision(expectedRevision)) throw new ContentProposalConflict('native-revision');
    return this.transaction(() => this.migrateNativeInTransaction(owner, resource, expectedRevision, projection),16*1024*1024+65536);
  }
  /** Original-only recovery. Absence never authorizes a retry or another writer. */
  migration(owner: string, mutationId: string): ContentMigrationReceipt | undefined {
    this.scope(owner, mutationId);
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_content_migrations'").get()) return undefined;
    const row = this.db.prepare('SELECT payload FROM v2_content_migrations WHERE owner=? AND mutation=?').get(owner, mutationId);
    return row ? JSON.parse(String(row.payload)) as ContentMigrationReceipt : undefined;
  }
  migrationTermination(owner: string, mutationId: string): ContentMigrationTermination | undefined {
    this.scope(owner, mutationId);
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_content_migration_terminations'").get()) return undefined;
    const row = this.db.prepare('SELECT payload FROM v2_content_migration_terminations WHERE owner=? AND mutation=?').get(owner, mutationId);
    return row ? JSON.parse(String(row.payload)) as ContentMigrationTermination : undefined;
  }
  /** Serialize with migration's SAME SQLite transaction. Either recover the
   * immutable committed receipt or fence this exact absent request forever.
   * A delayed POST can never cross this tombstone. No native content is touched. */
  recoverMigration(owner: string, resource: string, mutationId: string) {
    this.scope(owner, resource); this.scope(owner, mutationId);
    return this.transaction(() => {
      const receipt = this.migration(owner, mutationId), termination = this.migrationTermination(owner, mutationId);
      if ((receipt && receipt.resource !== resource) || (termination && termination.resource !== resource))
        throw new ContentProposalConflict('migration-reused');
      if (receipt) return { receipt, termination: null };
      if (termination) return { receipt: null, termination };
      if (Number(this.db.prepare('SELECT count(*) n FROM v2_content_migration_terminations WHERE owner=?').get(owner)!.n) >= 128)
        throw new ContentProposalConflict('migration-recovery-capacity');
      const proof: ContentMigrationTermination = { mutationId, resource, state: 'not-executed' };
      const payload = JSON.stringify(proof); this.capacity(Buffer.byteLength(payload));
      this.db.prepare('INSERT INTO v2_content_migration_terminations VALUES(?,?,?)').run(owner, mutationId, payload);
      return { receipt: null, termination: proof };
    }, this.migration(owner, mutationId) || this.migrationTermination(owner, mutationId) ? 0 : 65536);
  }
  /** Cutover and immutable request receipt share the SAME transaction. A lost
   * response can be inspected without re-reading a now-changed native snapshot. */
  migrateNativeRequest(owner: string, resource: string, expectedRevision: number, mutationId: string,
    projection: NativeWorkspaceCardFileProjection): ContentMigrationReceipt {
    this.scope(owner, resource); this.scope(owner, mutationId);
    if (!revision(expectedRevision)) throw new ContentProposalConflict('native-revision');
    return this.transaction(() => {
      if (this.migrationTermination(owner, mutationId)) throw new ContentProposalConflict('migration-terminated');
      const old = this.migration(owner, mutationId);
      if (old) {
        if (old.resource !== resource || old.nativeRevision !== expectedRevision) throw new ContentProposalConflict('migration-reused');
        return old;
      }
      if (Number(this.db.prepare('SELECT count(*) n FROM v2_content_migrations WHERE owner=?').get(owner)!.n) >= 128) throw new ContentProposalConflict('migration-capacity');
      const result = this.migrateNativeInTransaction(owner, resource, expectedRevision, projection);
      const receipt: ContentMigrationReceipt = { mutationId, resource, nativeRevision: expectedRevision, result };
      const payload = JSON.stringify(receipt); this.capacity(Buffer.byteLength(payload));
      this.db.prepare('INSERT INTO v2_content_migrations VALUES(?,?,?)').run(owner, mutationId, payload);
      return receipt;
    },this.migration(owner,mutationId)?0:16*1024*1024+65536);
  }
  private migrateNativeInTransaction(owner: string, resource: string, expectedRevision: number, projection: NativeWorkspaceCardFileProjection) {
      if (this.resource(owner, resource)) throw new ContentProposalConflict('resource-exists');
      if (Number(this.db.prepare('SELECT count(*) n FROM v2_proposal_resources WHERE owner=?').get(owner)!.n) >= 128) throw new ContentProposalConflict('resource-capacity');
      const epoch = randomUUID();
      const native = projection.claimMigration(this.db, owner, resource, epoch, expectedRevision);
      const content = this.canonical(JSON.stringify(workspaceFileCardContent(native)), resource);
      const result: Resource = { epoch, revision: 0, hash: hash(content), content };
      this.capacity(Buffer.byteLength(JSON.stringify(result)));
      this.db.prepare('INSERT INTO v2_proposal_resources VALUES(?,?,?)').run(owner, resource, JSON.stringify(result));
      return result;
  }
  private bindings(owner: string, resource: string): Binding[] {
    return this.db.prepare('SELECT payload FROM v2_proposal_bindings WHERE owner=? AND resource=?').all(owner, resource).map(r => JSON.parse(String(r.payload)));
  }
  private permits(owner: string, resource: string, binding: Readonly<Binding>): boolean {
    return observedParticipant(this.db, 'content-authority-check', () => this.authorized(owner, resource, binding)) === true;
  }
  private binding(owner: string, resource: string, id: string, generation: string) {
    const binding = this.bindings(owner, resource).find(b => b.id === id);
    if (!binding || binding.generation !== generation || binding.revoked || !this.permits(owner, resource, binding)) throw new ContentProposalConflict('forbidden');
    return binding;
  }
  private writeBinding(owner: string, resource: string, binding: Binding) {
    this.db.prepare('UPDATE v2_proposal_bindings SET payload=? WHERE owner=? AND resource=? AND id=?').run(JSON.stringify(binding), owner, resource, binding.id);
  }
  bindingRecord(owner: string, resource: string, id: string): Binding | undefined {
    this.scope(owner, resource); if (!this.exists()) return undefined;
    const binding = this.bindings(owner, resource).find(b => b.id === id);
    if (binding && !this.permits(owner, resource, binding)) throw new ContentProposalConflict('forbidden');
    return binding;
  }
  bind(owner: string, resource: string, id: string, authorityEpoch: string,
    intent?: { target: ContentBindingTarget; epoch: string; revision: number }) {
    this.scope(owner, resource); if (!identity(id) || !identity(authorityEpoch)) throw new ContentProposalConflict('binding');
    return this.transaction(() => {
      const current = this.resource(owner, resource); if (!current) throw new ContentProposalConflict('missing');
      if (intent && (intent.epoch !== current.epoch || intent.revision !== current.revision
        || ![intent.target.sessionId,intent.target.connectionId,intent.target.sessionKey].every(identity)
        || !revision(intent.target.authority))) throw new ContentProposalConflict('binding-target');
      const existing = this.bindings(owner, resource);
      // IDs include tombstones; re-grants must use a fresh ID/generation.
      if (existing.some(b => b.id === id) || existing.length >= 32) throw new ContentProposalConflict('binding-capacity-or-reused');
      const binding: Binding = { id, generation: randomUUID(), authorityEpoch, revoked: false, acknowledgedRevision: -1, acknowledgedHash: '',
        ...(intent ? {target: structuredClone(intent.target), initial: structuredClone(current)} : {}) };
      if (!this.permits(owner, resource, binding)) throw new ContentProposalConflict('forbidden');
      this.capacity(Buffer.byteLength(JSON.stringify(binding)));
      this.db.prepare('INSERT INTO v2_proposal_bindings VALUES(?,?,?,?)').run(owner, resource, id, JSON.stringify(binding)); return binding;
    },16*1024*1024+65536);
  }
  /** Called only after the Connector's original installation receipt and file
   * snapshot have been verified. An HTTP client's asserted hash is not proof.
   * No automatic adoption of a dirty file or movement to a newer Hub revision. */
  acknowledgeInstallation(owner: string, resource: string, id: string, generation: string,
    observed: { epoch: string; revision: number; hash: string }) {
    this.scope(owner, resource);
    return this.transaction(() => {
      const binding = this.binding(owner, resource, id, generation), current = this.resource(owner, resource);
      if (!current || observed.epoch !== current.epoch || !revision(observed.revision) || !digest(observed.hash)) throw new ContentProposalConflict('installation-proof');
      if (binding.acknowledgedRevision >= 0) {
        if (binding.acknowledgedRevision !== observed.revision || binding.acknowledgedHash !== observed.hash) throw new ContentProposalConflict('installation-reused');
        return binding;
      }
      // A pinned installation may finish after another session advances the
      // head. Its immutable initial receipt proves ONLY that older revision;
      // the outbox must still project every subsequent committed change.
      const installed = binding.initial ?? current;
      if (installed.epoch !== current.epoch || installed.revision > current.revision
        || observed.revision !== installed.revision || observed.hash !== installed.hash) throw new ContentProposalConflict('installation-stale');
      binding.acknowledgedRevision = observed.revision; binding.acknowledgedHash = observed.hash;
      this.writeBinding(owner, resource, binding); return binding;
    });
  }
  receipt(owner: string, resource: string, bindingId: string, generation: string, mutationId: string): Receipt | undefined {
    this.scope(owner, resource); if (!this.exists()) return undefined;
    this.binding(owner, resource, bindingId, generation);
    const row = this.db.prepare('SELECT payload FROM v2_content_proposals WHERE owner=? AND resource=? AND binding=? AND generation=? AND mutation=?').get(owner, resource, bindingId, generation, mutationId);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  resolution(owner:string,resource:string,id:string,generation:string,conflictId:string):ContentResolutionIntent|undefined {
    this.scope(owner,resource);
    // Old databases acquire the additive table only inside the first write's
    // original transaction. A read does not perform a migration or write.
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_content_resolutions'").get())return;
    const row=this.db.prepare('SELECT payload FROM v2_content_resolutions WHERE owner=? AND resource=? AND binding=? AND generation=? AND conflict=?')
      .get(owner,resource,id,generation,conflictId);
    return row?JSON.parse(String(row.payload)):undefined;
  }
  private checkedResolution(owner:string,resource:string,id:string,generation:string,input:ContentResolutionInput) {
    if(!identity(input.conflictId)||!identity(input.mutationId)||input.conflictId===input.mutationId||!identity(input.epoch)
      ||!revision(input.revision)||!digest(input.hash)||!digest(input.expectedHash))throw new ContentProposalConflict('resolution-input');
    this.binding(owner,resource,id,generation);
    const receipt=this.receipt(owner,resource,id,generation,input.conflictId);
    if(!receipt||receipt.state!=='conflict'||receipt.revision!==input.revision||receipt.hash!==input.hash
      ||!this.exactSnapshot(owner,resource,{epoch:input.epoch,revision:input.revision,hash:input.hash}))throw new ContentProposalConflict('conflict-proof');
    const prior=this.resolution(owner,resource,id,generation,input.conflictId);
    if(prior&&(['conflictId','mutationId','expectedHash','epoch','revision','hash'] as const).some(k=>prior[k]!==input[k]))
      throw new ContentProposalConflict('resolution-reused');
    return prior;
  }
  private claimResolution(owner:string,resource:string,id:string,generation:string,input:ContentResolutionInput) {
    return this.transaction(()=>{
      const prior=this.checkedResolution(owner,resource,id,generation,input);
      if(prior)return {intent:prior,claimed:false};
      if(this.db.prepare('SELECT 1 FROM v2_content_resolutions WHERE owner=? AND resource=? AND binding=? AND generation=? AND mutation=?')
        .get(owner,resource,id,generation,input.mutationId))throw new ContentProposalConflict('resolution-reused');
      const intent:ContentResolutionIntent={...input,state:'unknown'},payload=JSON.stringify(intent);this.capacity(Buffer.byteLength(payload));
      this.db.prepare('INSERT INTO v2_content_resolutions VALUES (?,?,?,?,?,?,?)').run(owner,resource,id,generation,input.conflictId,input.mutationId,payload);
      return {intent,claimed:true};
    },65536);
  }
  acknowledgeResolution(owner:string,resource:string,id:string,generation:string,input:ContentResolutionInput):ContentResolutionIntent {
    return this.transaction(()=>{
      const prior=this.checkedResolution(owner,resource,id,generation,input);if(!prior)throw new ContentProposalConflict('resolution-missing');
      if(prior.state==='acknowledged')return prior;
      const intent:ContentResolutionIntent={...input,state:'acknowledged'};
      this.db.prepare('UPDATE v2_content_resolutions SET payload=? WHERE owner=? AND resource=? AND binding=? AND generation=? AND conflict=?')
        .run(JSON.stringify(intent),owner,resource,id,generation,input.conflictId);
      return intent;
    });
  }
  /** A local proposal already wrote the originating file. Confirm that exact
   * original result without projecting it back over the author's next edit.
   * The coordinator must obtain observedHash from the authorized Connector. */
  acknowledgeProposal(owner: string, resource: string, bindingId: string, generation: string, mutationId: string, observedHash: string) {
    this.scope(owner, resource);
    return this.transaction(() => {
      const binding = this.binding(owner, resource, bindingId, generation);
      const receipt = this.receipt(owner, resource, bindingId, generation, mutationId);
      if (!receipt || receipt.state !== 'committed' || !digest(observedHash) || receipt.hash !== observedHash) throw new ContentProposalConflict('unproven-proposal');
      if (binding.acknowledgedRevision > receipt.revision) throw new ContentProposalConflict('stale-proposal');
      if (binding.acknowledgedRevision === receipt.revision && binding.acknowledgedHash !== observedHash) throw new ContentProposalConflict('unproven-proposal');
      binding.acknowledgedRevision = receipt.revision; binding.acknowledgedHash = observedHash;
      this.writeBinding(owner, resource, binding);
      for (const job of this.projections(owner, resource, bindingId, generation)) {
        if (job.revision === receipt.revision && job.hash === observedHash) {
          job.state = 'acknowledged'; this.writeProjection(owner, resource, job);
        }
      }
      return binding;
    });
  }
  propose(owner: string, resource: string, proposal: ContentProposal) {
    return this.commitProposal(owner,resource,proposal,false);
  }
  ownerReceipt(owner:string,resource:string,epoch:string,mutationId:string):Receipt|undefined {
    this.scope(owner,resource);if(!this.exists())return;
    const row=this.db.prepare('SELECT payload FROM v2_content_proposals WHERE owner=? AND resource=? AND binding=? AND generation=? AND mutation=?')
      .get(owner,resource,'$owner',epoch,mutationId);
    return row?JSON.parse(String(row.payload)) as Receipt:undefined;
  }
  writeTermination(owner:string,resource:string,epoch:string,mutationId:string):ContentWriteTermination|undefined {
    this.scope(owner,resource);this.scope(epoch,mutationId);
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_content_write_terminations'").get())return;
    const row=this.db.prepare('SELECT payload FROM v2_content_write_terminations WHERE owner=? AND resource=? AND epoch=? AND mutation=?').get(owner,resource,epoch,mutationId);
    return row?JSON.parse(String(row.payload)) as ContentWriteTermination:undefined;
  }
  /** Serialize with owner writes: preserve an existing immutable receipt, or
   * permanently prevent exactly this absent write. Never roll back remote data. */
  recoverWrite(owner:string,resource:string,epoch:string,mutationId:string) {
    this.scope(owner,resource);this.scope(epoch,mutationId);
    return this.transaction(()=>{
      const current=this.resource(owner,resource);
      if(!current)throw new ContentProposalConflict('resource-missing');
      const receipt=this.ownerReceipt(owner,resource,epoch,mutationId),termination=this.writeTermination(owner,resource,epoch,mutationId);
      if(receipt)return {receipt,termination:null};
      if(termination)return {receipt:null,termination};
      if(current.epoch!==epoch)throw new ContentProposalConflict('mode-epoch');
      if(Number(this.db.prepare('SELECT count(*) n FROM v2_content_write_terminations WHERE owner=?').get(owner)!.n)>=128)throw new ContentProposalConflict('write-recovery-capacity');
      const proof:ContentWriteTermination={mutationId,resource,epoch,state:'not-executed'},payload=JSON.stringify(proof);this.capacity(Buffer.byteLength(payload));
      this.db.prepare('INSERT INTO v2_content_write_terminations VALUES(?,?,?,?,?)').run(owner,resource,epoch,mutationId,payload);
      return {receipt:null,termination:proof};
    },this.ownerReceipt(owner,resource,epoch,mutationId)||this.writeTermination(owner,resource,epoch,mutationId)?0:8192);
  }
  /** Authenticated owner editor, separate from any session/file capability. */
  write(owner:string,resource:string,input:Omit<ContentProposal,'bindingId'|'generation'>) {
    return this.commitProposal(owner,resource,{...input,bindingId:'$owner',generation:input.modeEpoch},true);
  }
  listBindings(owner:string,resource:string):ContentBinding[] {
    this.scope(owner,resource);return this.exists()?this.bindings(owner,resource):[];
  }
  private commitProposal(owner: string, resource: string, proposal: ContentProposal, ownerWrite:boolean) {
    this.scope(owner, resource);
    if (![proposal.bindingId, proposal.generation, proposal.mutationId, proposal.modeEpoch].every(identity)
      || !revision(proposal.baseRevision) || !digest(proposal.baseHash)) throw new ContentProposalConflict('proposal');
    const content = this.canonical(proposal.content, resource);
    const fingerprint = hash(JSON.stringify([proposal.modeEpoch, proposal.baseRevision, proposal.baseHash, content]));
    return this.transaction(() => {
      if(ownerWrite&&this.writeTermination(owner,resource,proposal.modeEpoch,proposal.mutationId))throw new ContentProposalConflict('write-terminated');
      if (!ownerWrite&&this.binding(owner, resource, proposal.bindingId, proposal.generation).acknowledgedRevision < 0) throw new ContentProposalConflict('installation-unconfirmed');
      const old = ownerWrite?this.ownerReceipt(owner,resource,proposal.modeEpoch,proposal.mutationId):this.receipt(owner, resource, proposal.bindingId, proposal.generation, proposal.mutationId);
      if (old) { if (old.fingerprint !== fingerprint) throw new ContentProposalConflict('mutation-reused'); return old; }
      const current = this.resource(owner, resource); if (!current || current.epoch !== proposal.modeEpoch) throw new ContentProposalConflict('mode-epoch');
      if (Number(this.db.prepare('SELECT count(*) n FROM v2_content_proposals WHERE owner=? AND resource=?').get(owner, resource)!.n) >= 128) throw new ContentProposalConflict('proposal-capacity');
      const matches = proposal.baseRevision === current.revision && proposal.baseHash === current.hash;
      const next = matches ? { ...current, revision: current.revision + 1, hash: hash(content), content } : current;
      if (!revision(next.revision)) throw new ContentProposalConflict('revision-capacity');
      const receipt: Receipt = { mutationId: proposal.mutationId, fingerprint, state: matches ? 'committed' : 'conflict', revision: next.revision, hash: next.hash };
      const recipients = matches ? this.bindings(owner, resource).filter(b => !b.revoked && this.permits(owner, resource, b)) : [];
      this.capacity((Buffer.byteLength(JSON.stringify(content)) + 2048) * (recipients.length + 2));
      this.db.prepare('INSERT INTO v2_content_proposals VALUES(?,?,?,?,?,?,?)').run(owner, resource, proposal.bindingId, proposal.generation, proposal.mutationId, content, JSON.stringify(receipt));
      if (matches) {
        const count = Number(this.db.prepare('SELECT count(*) n FROM v2_projection_outbox WHERE owner=? AND resource=?').get(owner, resource)!.n);
        if (count + recipients.length > 512) throw new ContentProposalConflict('outbox-capacity');
        this.db.prepare('UPDATE v2_proposal_resources SET payload=? WHERE owner=? AND resource=?').run(JSON.stringify(next), owner, resource);
        for (const b of recipients) {
          const job: Projection = { id: randomUUID(), bindingId: b.id, generation: b.generation, revision: next.revision, hash: next.hash, content,
            state: 'pending', expectedHash: null };
          this.db.prepare('INSERT INTO v2_projection_outbox VALUES(?,?,?,?)').run(owner, resource, job.id, JSON.stringify(job));
        }
      }
      if(!ownerWrite)this.binding(owner, resource, proposal.bindingId, proposal.generation);
      return receipt;
    },(ownerWrite?(this.ownerReceipt(owner,resource,proposal.modeEpoch,proposal.mutationId)||this.writeTermination(owner,resource,proposal.modeEpoch,proposal.mutationId)):
      this.receipt(owner,resource,proposal.bindingId,proposal.generation,proposal.mutationId))?0:2*CONTENT_PROPOSAL_BYTE_LIMIT+8*1024*1024);
  }
  projections(owner: string, resource: string, bindingId: string, generation: string): Projection[] {
    this.scope(owner, resource); if (!this.exists()) return [];
    this.binding(owner, resource, bindingId, generation);
    return this.db.prepare('SELECT payload FROM v2_projection_outbox WHERE owner=? AND resource=?').all(owner, resource)
      .map(r => JSON.parse(String(r.payload)) as Projection).filter(j => j.bindingId === bindingId && j.generation === generation);
  }
  /** Same original outbox order, but only one body crosses the owner boundary.
   * Exclusions are bounded by the four-job coordinator iteration limit. */
  nextProjection(owner:string,resource:string,bindingId:string,generation:string,excluded:string[]):Projection|undefined {
    this.scope(owner,resource);const binding=this.binding(owner,resource,bindingId,generation);
    if(excluded.length>4||new Set(excluded).size!==excluded.length)throw new ContentProposalConflict('projection-page');
    const row=this.db.prepare(`SELECT payload FROM v2_projection_outbox WHERE owner=? AND resource=?
      AND json_extract(payload,'$.bindingId')=? AND json_extract(payload,'$.generation')=?
      AND json_extract(payload,'$.state')!='acknowledged' AND json_extract(payload,'$.revision')>?
      AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT 1`)
      .get(owner,resource,bindingId,generation,binding.acknowledgedRevision,JSON.stringify(excluded));
    return row?JSON.parse(String(row.payload)) as Projection:undefined;
  }
  originalProjection(owner:string,resource:string,bindingId:string,generation:string,id:string):Projection {
    this.scope(owner,resource);this.binding(owner,resource,bindingId,generation);
    const job=this.projection(owner,resource,id);
    if(job.bindingId!==bindingId||job.generation!==generation)throw new ContentProposalConflict('projection-scope');
    return job;
  }
  private projection(owner: string, resource: string, id: string): Projection {
    const row = this.db.prepare('SELECT payload FROM v2_projection_outbox WHERE owner=? AND resource=? AND id=?').get(owner, resource, id);
    if (!row) throw new ContentProposalConflict('missing');
    const job: Projection = JSON.parse(String(row.payload)); this.binding(owner, resource, job.bindingId, job.generation); return job;
  }
  private writeProjection(owner: string, resource: string, job: Projection) {
    this.db.prepare('UPDATE v2_projection_outbox SET payload=? WHERE owner=? AND resource=? AND id=?').run(JSON.stringify(job), owner, resource, job.id);
  }
  /** Connector still needs its own atomic local dirty-check/write/receipt fence. */
  claimProjection(owner: string, resource: string, id: string, actualHash: string, pendingLocalProposal: boolean) {
    this.scope(owner, resource);
    return this.transaction(() => {
      const job = this.projection(owner, resource, id), binding = this.binding(owner, resource, job.bindingId, job.generation);
      if (job.state !== 'pending') return { claimed: false, job };
      if (binding.acknowledgedRevision < 0 || !digest(actualHash)) throw new ContentProposalConflict('installation-unconfirmed');
      if (pendingLocalProposal || actualHash !== binding.acknowledgedHash) throw new ContentProposalConflict('dirty-projection');
      if (job.revision <= binding.acknowledgedRevision) throw new ContentProposalConflict('stale-projection');
      if (this.projections(owner, resource, binding.id, binding.generation).some(j => j.state === 'unknown')) throw new ContentProposalConflict('unresolved-projection');
      job.expectedHash = actualHash; job.state = 'unknown'; this.writeProjection(owner, resource, job); return { claimed: true, job };
    },this.projection(owner,resource,id).state==='pending'?8*1024*1024+65536:0);
  }
  acknowledgeProjection(owner: string, resource: string, id: string, observedHash: string) {
    this.scope(owner, resource);
    return this.transaction(() => {
      const job = this.projection(owner, resource, id), binding = this.binding(owner, resource, job.bindingId, job.generation);
      if (job.state === 'pending' || observedHash !== job.hash) throw new ContentProposalConflict('unproven-projection');
      if (job.state === 'acknowledged') return job;
      if (job.revision <= binding.acknowledgedRevision) throw new ContentProposalConflict('stale-projection');
      binding.acknowledgedRevision = job.revision; binding.acknowledgedHash = job.hash; this.writeBinding(owner, resource, binding);
      job.state = 'acknowledged'; this.writeProjection(owner, resource, job); return job;
    });
  }
  revoke(owner: string, resource: string, bindingId: string) {
    this.scope(owner, resource);
    return this.transaction(() => {
      const binding = this.bindings(owner, resource).find(b => b.id === bindingId); if (!binding) throw new ContentProposalConflict('missing');
      binding.revoked = true; this.writeBinding(owner, resource, binding);
      return binding;
    });
  }
  /** Batch fence and its receipt commit together, even if the process exits
   * before remote cleanup. Settlement does not require new-work admission. */
  revokeBindings(owner: string, resource: string, ids: string[], settle: (bindings: ContentBinding[]) => void) {
    this.scope(owner, resource);
    if(ids.length>32||new Set(ids).size!==ids.length||!ids.every(identity))throw new ContentProposalConflict('bindings');
    return this.transaction(checkParticipant => {
      const selected=this.bindings(owner,resource).filter(b=>ids.includes(b.id));
      for(const b of selected){b.revoked=true;this.writeBinding(owner,resource,b);}
      checkParticipant(settle(selected));
      return selected;
    });
  }
}
