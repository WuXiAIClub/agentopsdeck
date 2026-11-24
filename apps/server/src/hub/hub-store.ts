import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createAdministratorKeyGuard } from '../auth/access-key.js';
import { readHubConnectionControl, settleHubConnectionControl, type ConnectionControlSettlement, type HubConnectionControlCommand } from './member-connection-control-domain.js';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { migrateSessionPreferenceVersions } from './session-preference-version.js';
import { migrateConnectionDisplayVersions, CONNECTION_DISPLAY_VERSION_SQL, ConnectionDirectoryChanged } from './connection-display-version.js';
import {ContentBatchTransactions,type ContentBatchSnapshot} from './content-batch-transactions.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';
import { createStorageOwnerClose, type StorageOwnerClose } from '../storage/owner-close.js';
import { asyncVolumeAdmission } from '../storage/async-volume-admission.js';
import { WorkspaceContentBatches } from './workspace-content-batches.js';
import type { DelegationCatalogSource } from './workspace-delegation-catalog.js';
import { WorkspaceContentCoordinator, normalizeSharedContent, type SharedContentTarget } from './workspace-content-coordinator.js';
import { ContentProposalStore } from './content-proposal-store.js';
import { UsageManifests } from './usage-manifests.js';
import { SessionGuidanceStore } from './session-guidance-store.js';
import { QuickChatStore } from './quick-chat-store.js';
import { configureOwnedWal, ownedStorageStats, checkpointOwnedWalAsync } from '../storage/owned-sqlite.js';
import { decodeHubSessionId, encodeHubSessionId } from './session-id.js';
import { HubIdentities, LEGACY_HUB_PRINCIPAL } from './identity.js';
import { WeixinStore } from './weixin-store.js';
import { PersistentLoginAttemptLimiter } from '../auth/persistent-login-limiter.js';
import type { LoginAttemptLimiterOptions } from '../auth/security.js';
import { CommandReceipts } from '../commands/receipts.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import {executeNativeFileBackground, nativeFileBackgroundCheckpoint, type NativeFileBackgroundCommand} from './native-file-background-domain.js';
import { executeWeixinBindingEffect, weixinBindingCheckpoint, type WeixinBindingEffectCommand, type WeixinBindingEffectResult } from './member-weixin-domain.js';
import { WeixinError } from './weixin-transport.js';
import { executeWeixinBackground, weixinBackgroundCheckpoint, type WeixinBackgroundCommand, type WeixinBackgroundResult } from './weixin-background-domain.js';
import { NodeGrants } from './node-grants.js';
import { RoleAccess } from './role-access.js';
import { HubExecutionLeases } from './execution-leases.js';
import { observeHubExecutionLeaseCommand, type HubExecutionLeaseCommand } from './member-execution-lease-domain.js';
import { HubExecutionIssuers } from './execution-issuers.js';
import { HubExecutionCommands } from './execution-commands.js';
import { HubMaintenanceCommands } from './maintenance-commands.js';
import { HubLifecycleCommands } from './lifecycle-commands.js';
import type { LifecycleEndpoint } from './lifecycle-client.js';
import { WorkspacePreferencesStore } from './workspace-preferences.js';
import { readWorkspacePreferences } from './workspace-preference-read.js';
import { readWorkspaceLayout } from './workspace-layout-read.js';
import { readWorkspaceBoard, validWorkspaceBoardRead, validWorkspaceBoardResult,
  type WorkspaceBoardRead, type WorkspaceBoardReadResult } from './workspace-board-snapshot-read.js';
import { readCompletionSummary, validCompletionSummaryRead } from './completion-summary-read.js';
import type { LayoutKind } from './workspace-layouts.js';
import { WorkspaceLayouts } from './workspace-layouts.js';
import { SessionNotebooks } from './session-notebooks.js';
import { NotebookCapabilities } from './notebook-capabilities.js';
import { CompletionUnreadStore, connectionCompletionTarget } from './completion-unread-store.js';
import { WorkspaceBoards } from './workspace-boards.js';
import { WorkspaceBoardFiles } from './workspace-board-files.js';
import { WorkspaceCardFiles } from './workspace-card-files.js';
import { WorkspaceCardConfigurations } from './workspace-card-configurations.js';
import { NativeWorkspaceCardFileProjection } from './workspace-card-file-projection.js';
import { WorkspaceCards } from './workspace-cards.js';
import { WorkspaceDrawings } from './workspace-drawings.js';
import { WorkspaceNativeDrawio } from './workspace-native-drawio.js';
import { WorkspaceBoardCapabilities } from './workspace-board-capabilities.js';
import { HubBoardBindings } from './workspace-board-bindings.js';
import { DelegationStore } from './workspace-delegation-store.js';
import { TaskSessionWorkflow } from './task-session-workflow.js';
import { isNodeId } from '../connector/node-identity.js';
import type { SessionRef } from '@agentopsdeck/shared';
import { sessionRef, legacySessionKey } from './session-ref.js';
import { AsyncHubDeliveryReader } from './async-delivery-reader.js';
import { readNotebookSnapshot, notebookSnapshotVersions, validNotebookSnapshotRead, validNotebookSnapshot,
  type NotebookSnapshotRead, type NotebookSnapshot } from './notebook-snapshot-read.js';
import { readDeliveryPage } from './delivery-page.js';
import { readSessionPreferences } from './preference-read.js';
import { readWorkspaceRevisions } from './workspace-revision-read.js';
import { validWorkspaceRevisionRead, WORKSPACE_REVISION_TYPES, type WorkspaceRevisions } from './delivery-reader-protocol.js';
import { readUsers } from './user-read.js';
import { readConnections } from './connection-read.js';
import { executeHubEventFeed, type HubEventFeedInput } from './event-feed-domain.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';
import { deliveryReadUnavailable, DeliverySnapshotReadRejected, type DeliveryReaderConfig } from './delivery-reader-protocol.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

export type SessionPreferences = Partial<Record<'hidden' | 'archived' | 'pinned', boolean>>;

export type HubDeliveryEvent = {
  sessionRef?: SessionRef | undefined;
  id: string;
  envConnectionId: string;
  envConnectionLabel?: string | undefined;
  hubSessionId?: string | undefined;
  sessionKey?: string | undefined;
  remoteSessionKey?: string | undefined;
  remoteEventId?: string | undefined;
  type: string;
  ts: number;
  payload: unknown;
  agentId?: string | undefined;
};

export type HubConnectionStatus = 'enabled' | 'disabled' | 'degraded';
export type HubConnectionKind = 'local' | 'remote';

export type HubConnection = {
  nodeId?: string | undefined;
  id: string;
  ownerUserId: string;
  kind: HubConnectionKind;
  label: string;
  connectorUrl: string;
  status: HubConnectionStatus;
  environmentId?: string | undefined;
  environmentLabel?: string | undefined;
  capabilities: string[];
  hasCredential: boolean;
  createdAt: number;
  updatedAt: number;
};

export type HubUser = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
};

export type HubConnectionInput = {
  id?: string | undefined;
  ownerUserId?: string | undefined;
  kind?: HubConnectionKind | undefined;
  label: string;
  connectorUrl: string;
  status?: HubConnectionStatus | undefined;
  environmentId?: string | undefined;
  environmentLabel?: string | undefined;
  capabilities?: string[] | undefined;
  credentialToken?: string | undefined;
};

export type HubAuditAction = 'connection.created' | 'connection.updated' | 'connection.deleted' | 'credential.updated' | 'maintenance_credential.updated' | 'connector.capabilities.checked' | 'gateway.model_set.reconciled' | 'connector.update.checked' | 'connector.update.requested' | 'connector.update.rolled_back';

const DEFAULT_USER_ID = 'default';

export class HubStore {
  readonly identities: HubIdentities;
  readonly commands: CommandReceipts;
  readonly grants: NodeGrants;
  readonly roles: RoleAccess;
  readonly executionLeases: HubExecutionLeases;
  readonly executionIssuers: HubExecutionIssuers;
  readonly executionCommands: HubExecutionCommands;
  readonly maintenanceCommands: HubMaintenanceCommands;
  readonly lifecycleCommands: HubLifecycleCommands;
  readonly workspace: WorkspacePreferencesStore;
  readonly layouts: WorkspaceLayouts;
  readonly notebooks: SessionNotebooks;
  readonly notebookCapabilities: NotebookCapabilities;
  readonly completions: CompletionUnreadStore;
  readonly boards: WorkspaceBoards;
  readonly boardFiles: WorkspaceBoardFiles;
  readonly cardFiles: WorkspaceCardFiles;
  readonly cardConfigurations: WorkspaceCardConfigurations;
  readonly cardFileProjection: NativeWorkspaceCardFileProjection;
  connectionControlSettlement(command: ConnectionControlSettlement) {
    return observedSavepoint(this.db, 'hub-connection-change', () => settleHubConnectionControl(this, command));
  }
  connectionControlReceipt(request: Request, scope: string, command: Extract<HubConnectionControlCommand, {action: 'receipt'}>) {
    return observedSavepoint(this.db, 'hub-identity-check', () => readHubConnectionControl(this, request, scope, command));
  }
  /** Private fixed service commands share the original connection/transaction. */
  nativeFileBackgroundCommand(command: NativeFileBackgroundCommand) {
    const rollback = nativeFileBackgroundCheckpoint(this);
    try {return observedSavepoint(this.db, 'hub-identity-check', () => executeNativeFileBackground(this, command));}
    catch (error) {rollback(); throw error;}
  }
  weixinBindingEffectCommand(command: WeixinBindingEffectCommand): WeixinBindingEffectResult {
    const rollback = weixinBindingCheckpoint(this);
    try { return observedSavepoint(this.db, 'hub-identity-check', () => executeWeixinBindingEffect(this, command)); }
    catch (error) {
      rollback();
      if (error instanceof WeixinError) return { error: error.code };
      throw error;
    }
  }
  weixinBackgroundCommand(command: WeixinBackgroundCommand): WeixinBackgroundResult {
    const rollback = weixinBackgroundCheckpoint(this);
    try { return observedSavepoint(this.db, 'hub-identity-check', () => executeWeixinBackground(this, command)); }
    catch (error) {
      rollback();
      if (error instanceof WeixinError) return {error:error.code};
      throw error;
    }
  }
  /** Same database owner, no transport or caller-supplied authorization. */
  readContentView<T>(read:(store:ContentProposalStore)=>T extends PromiseLike<unknown>?never:T):T {
    return observedSavepoint(this.db,'hub-identity-check',()=>read(this.createContentDocumentStore()));
  }
  createContentDocumentStore() {
    return new ContentProposalStore(this.db,normalizeSharedContent,(user,_resource,binding)=>{
      const target=binding.target,decoded=target&&decodeHubSessionId(target.sessionId);
      if(!target||!decoded||!/^(codex|claude-code|ghcp):/.test(decoded.remoteSessionKey))return false;
      const connection=this.getConnection(decoded.connectionId,user),authority=this.connectionAuthority(decoded.connectionId,user);
      return !!connection?.nodeId&&connection.status!=='disabled'&&authority!==undefined
        &&target.connectionId===decoded.connectionId&&target.sessionKey===decoded.remoteSessionKey
        &&target.authority===authority&&binding.authorityEpoch===JSON.stringify([decoded.connectionId,authority]);
    },undefined,this.file===':memory:'?undefined:(bytes,write)=>asyncVolumeAdmission.run(dirname(this.file),'durable',bytes,async()=>{
      if(this.closed)throw new Error('Hub store is closed');return write();
    }));
  }
  createContentCoordinator(resolve:(owner:string,sessionId:string)=>SharedContentTarget) {
    return new WorkspaceContentCoordinator(this.db,this.cardFileProjection,resolve,
      this.file===':memory:'?undefined:(bytes,write)=>asyncVolumeAdmission.run(dirname(this.file),'durable',bytes,async()=>{
        if(this.closed)throw new Error('Hub store is closed');
        return write();
      }));
  }
  createContentBatches(coordinator:WorkspaceContentCoordinator,source:DelegationCatalogSource){
    return new WorkspaceContentBatches(this.db,coordinator,source,
      this.file===':memory:'?undefined:(bytes,write)=>asyncVolumeAdmission.run(dirname(this.file),'durable',bytes,async()=>{
        if(this.closed)throw new Error('Hub store is closed');
        return write();
      }),Date.now,owner=>this.contentBatchFence(owner));
  }
  /** Worker-local version read, including inside the original batch transaction.
   * Preserve the old batch fingerprint's display generation; member authority
   * is checked separately, never inferred from this display version. */
  contentBatchFence(user:string) {
    const row=this.db.prepare(CONNECTION_DISPLAY_VERSION_SQL).get(user),generation=Number(row?.version??0);
    if(!Number.isSafeInteger(generation)||generation<0||row&&generation===0)throw Error('content_batch_unavailable');
    return {generation,preferencesRevision:this.workspace.get(user).revision};
  }
  createContentBatchTransactions(check:(owner:string,resource:string,snapshot:ContentBatchSnapshot)=>void) {
    return new ContentBatchTransactions(this.db,this.createContentDocumentStore(),check,
      this.file===':memory:'?undefined:(bytes,write)=>asyncVolumeAdmission.run(dirname(this.file),'durable',bytes,async()=>{
        if(this.closed)throw new Error('Hub store is closed');return write();
      }));
  }
  readonly cards: WorkspaceCards;
  readonly drawings: WorkspaceDrawings;
  readonly nativeDrawio: WorkspaceNativeDrawio;
  readonly boardCapabilities: WorkspaceBoardCapabilities;
  readonly boardBindings: HubBoardBindings;
  readonly delegations: DelegationStore;
  readonly taskSessions: TaskSessionWorkflow;
  readonly usageManifests: UsageManifests;
  readonly sessionGuidance: SessionGuidanceStore;
  readonly quickChat: QuickChatStore;
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private deliveryConfig?: DeliveryReaderConfig;
  private deliveryReader: AsyncHubDeliveryReader | undefined;
  private failedDeliveryReader?: AsyncHubDeliveryReader;
  private deliveryRetryAt = 0;
  private readonly workspaceRevisionReads = new Map<string, Promise<WorkspaceRevisions>>();
  private workspaceRevisionWaiters = 0;
  readonly weixin: WeixinStore;
  readonly weixinAdministratorKeyId: string | undefined;
  readonly weixinAdministratorAuthority: (request: Request) => boolean;

  constructor(private readonly file: string, encryptionSecret: string | undefined, lifecycleEndpoints: readonly LifecycleEndpoint[] = [], administratorKey?: string,
    legacyCommandAuthority?: (request: Request) => boolean, localMaintenanceConnectionId?: string,
    weixinAdministratorAuthority?: (request: Request) => boolean) {
    this.weixinAdministratorAuthority = weixinAdministratorAuthority ?? createAdministratorKeyGuard(administratorKey);
    mkdirSync(dirname(file), { recursive: true });
    // Bind an existing file before opening the writer, not at the first replay.
    // A replacement during open cannot authorize a reader of another database.
    const beforeOpen = file !== ':memory:' && existsSync(file) ? (() => {
      const absolute = realpathSync(file), stat = statSync(absolute);
      return { file: absolute, dev: stat.dev, ino: stat.ino };
    })() : undefined;
    this.db = startupDatabaseOwners.open(file);
    try {
    if (file !== ':memory:') {
      const absolute = realpathSync(file), stat = statSync(absolute);
      if (beforeOpen && (absolute !== beforeOpen.file || stat.dev !== beforeOpen.dev || stat.ino !== beforeOpen.ino)) {
        throw deliveryReadUnavailable();
      }
      this.deliveryConfig = { file: absolute, dev: stat.dev, ino: stat.ino };
    }
    let provisionedVaultKey = false;
    if (encryptionSecret !== undefined) {
      this.key = deriveKey(encryptionSecret);
    } else if (file === ':memory:') {
      this.key = randomBytes(32);
    } else {
      const resolved = loadOrProvisionVaultKey(`${this.deliveryConfig!.file}.vault-key`);
      this.key = resolved.key;
      provisionedVaultKey = resolved.provisioned;
    }
    this.migrate();
    if (provisionedVaultKey) {
      this.migrateLegacyDefaultVaultCredentials();
    }
    configureOwnedWal(this.db);
    this.workspace = new WorkspacePreferencesStore(this.db);
    this.sessionGuidance = new SessionGuidanceStore(this.db);
    this.quickChat = new QuickChatStore(this.db, Date.now, createHash('sha256').update(this.key).update('quick-chat-results-v1').digest());
    this.delegations = new DelegationStore(this.db);
    this.usageManifests = new UsageManifests(this.db, (owner, m) => {
      const connection = this.getConnection(m.connectionId, owner);
      return m.owner === owner && !!connection?.nodeId && connection.status !== 'disabled' && connection.nodeId === m.nodeId
        && this.connectionAuthority(m.connectionId, owner) === m.authorityEpoch;
    }, Date.now, undefined,
    undefined, file === ':memory:' ? undefined : (bytes, write) => asyncVolumeAdmission.run(dirname(file), 'durable', bytes, async () => {
      if (this.closed) throw new Error('Hub store is closed');
      return write();
    }));
    this.taskSessions = new TaskSessionWorkflow(this.db, i => {
      const connection = this.getConnection(i.connectionId, i.owner);
      return !!connection && connection.status !== 'disabled' && connection.nodeId === i.nodeId
        && this.connectionAuthority(i.connectionId, i.owner) === i.authorityEpoch;
    });
    this.layouts = new WorkspaceLayouts(this.db);
    this.notebooks = new SessionNotebooks(this.db);
    this.notebookCapabilities = new NotebookCapabilities(this.db, this.notebooks, (owner, proof) => {
      if (!proof) return true;
      const connection = this.getConnection(proof.connectionId, owner);
      return !!connection && connection.status !== 'disabled' && this.connectionAuthority(proof.connectionId, owner) === proof.version;
    });
    this.completions = new CompletionUnreadStore(this.db);
    this.completions.markGap();
    this.boards = new WorkspaceBoards(this.db);
    this.boardFiles = new WorkspaceBoardFiles(this.db, this.boards, binding => {
      const session = decodeHubSessionId(binding.sessionId), connection = this.getConnection(binding.connectionId, binding.userId);
      return !!session && session.connectionId === binding.connectionId && !!connection?.nodeId && connection.status !== 'disabled'
        && this.connectionAuthority(binding.connectionId, binding.userId) === binding.authority;
    });
    this.cards = new WorkspaceCards(this.db);
    this.drawings = new WorkspaceDrawings(this.db);
    this.nativeDrawio = new WorkspaceNativeDrawio(this.db);
    this.cardConfigurations = new WorkspaceCardConfigurations(this.db);
    this.cardFileProjection = new NativeWorkspaceCardFileProjection(this.db, {
      boards: this.boards, cards: this.cards, drawings: this.drawings, nativeDrawio: this.nativeDrawio,
      notebooks: this.notebooks, configurations: this.cardConfigurations,
      sessionNotebook: (user, id) => {
        let ref: ReturnType<HubStore['sessionReference']>;
        try { ref = this.sessionReference(id, user); } catch { return; }
        if (!ref) return;
        const textId = JSON.stringify([user, ref.nodeId, ref.runtimeId, ref.nativeSessionKey]);
        return { textId, layoutId: JSON.stringify(['session-notebook-file-title', 1, textId]), fallbackTitle: 'Notebook' };
      },
    });
    this.cardFiles = new WorkspaceCardFiles(this.db, this.cardFileProjection, binding => {
      const session = decodeHubSessionId(binding.sessionId), connection = this.getConnection(binding.connectionId, binding.userId);
      return !!session && session.connectionId === binding.connectionId && !!connection?.nodeId && connection.status !== 'disabled'
        && this.connectionAuthority(binding.connectionId, binding.userId) === binding.authority;
    });
    this.boardCapabilities = new WorkspaceBoardCapabilities(this.db, this.boards, Date.now, id => this.boardBindings.authorized(id));
    this.boardBindings = new HubBoardBindings(this.db, this.boardCapabilities, {
      read: id => this.getCredentialTokenByKey(id, '\0board-binding'),
      write: (id, token) => this.storeCredential(id, '\0board-binding', token),
      remove: id => { this.db.prepare('DELETE FROM env_credentials WHERE connection_id = ? AND owner_user_id = ?').run(id, '\0board-binding'); },
    }, !!encryptionSecret, (connection, owner) => {
      const value = this.getConnection(connection, owner);
      return value && value.status !== 'disabled' && value.nodeId ? this.connectionAuthority(connection, owner) : undefined;
    });
    this.identities = new HubIdentities(this.db, !!administratorKey, legacyCommandAuthority);
    // Private, domain/Hub-scoped reference only. Never create a login Key or
    // persist the administrator secret; rotation invalidates previous bindings.
    this.weixinAdministratorKeyId = administratorKey ? `weixin-admin:${createHash('sha256')
      .update(JSON.stringify(['agentopsdeck-weixin-admin-v1', this.identities.hubId, administratorKey])).digest('hex')}` : undefined;
    this.weixin = new WeixinStore(this.db, {
      read: id => this.getCredentialTokenByKey(id, '\0weixin'),
      write: (id, secret) => this.storeCredential(id, '\0weixin', secret),
      remove: id => { this.db.prepare('DELETE FROM env_credentials WHERE connection_id=? AND owner_user_id=?').run(id, '\0weixin'); },
    }, !!encryptionSecret, keyId => keyId === this.weixinAdministratorKeyId ? LEGACY_HUB_PRINCIPAL : this.identities.linkedKeyPrincipal(keyId));
    this.commands = new CommandReceipts(this.db, undefined, undefined, undefined,
      undefined,
      undefined, file === ':memory:' ? undefined : (bytes, write) => asyncVolumeAdmission.run(dirname(file), 'durable', bytes, async () => {
        if (this.closed) throw new Error('Hub store is closed');
        return write();
      }));
    this.grants = new NodeGrants(this.db);
    this.roles = new RoleAccess(this.db, this);
    this.executionLeases = new HubExecutionLeases(this.db, this.grants, undefined, undefined, undefined,
      file === ':memory:' ? undefined : (bytes, write) => asyncVolumeAdmission.run(dirname(file), 'durable', bytes, async () => {
        if (this.closed) throw new Error('Hub store closed');
        return write();
      }));
    // Separate vault namespace, never addressable by an ordinary connection ID.
    this.executionIssuers = new HubExecutionIssuers(this.db, this.identities.hubId, {
      read: id => this.getCredentialTokenByKey(id, '\0execution-issuer', true),
      write: (id, token) => this.storeCredential(id, '\0execution-issuer', token),
    });
    this.executionCommands = new HubExecutionCommands(this.commands, this.executionLeases, this.executionIssuers);
    this.maintenanceCommands = new HubMaintenanceCommands(this.db, this.commands, {
      current: (id, owner) => this.getMaintenanceCredentialToken(id, owner),
      read: id => this.getCredentialTokenByKey(id, '\0maintenance-command'),
      write: (id, token) => this.storeCredential(id, '\0maintenance-command', token),
    }, 32, localMaintenanceConnectionId);
    this.lifecycleCommands = new HubLifecycleCommands(this.db, this.commands, {
      current: (id, owner) => this.getMaintenanceCredentialToken(id, owner),
      read: id => this.getCredentialTokenByKey(id, '\0maintenance-command'),
      write: (id, token) => this.storeCredential(id, '\0maintenance-command', token),
    }, lifecycleEndpoints);
    // Retention follows the existing receipt, including transactional deletes;
    // no orphaned historical vault rows or separate cleanup timer.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS maintenance_command_vault_cleanup AFTER DELETE ON command_receipts BEGIN
      DELETE FROM env_credentials WHERE connection_id = old.id AND owner_user_id = char(0) || 'maintenance-command'; END`);
    } catch (error) {
      this.closed = true;
      startupDatabaseOwners.abandon(this.db);
      throw error;
    }
  }

  createLoginLimiter(options: LoginAttemptLimiterOptions) { return new PersistentLoginAttemptLimiter(this.db, options); }

  private closed = false;
  private closeOwner?: StorageOwnerClose;
  close(): void | Promise<void> {
    this.closed = true;
    this.closeOwner ??= createStorageOwnerClose([
      () => this.executionCommands.stopAndDrain(),
      () => this.maintenanceCommands.stopAndDrain(),
      () => this.lifecycleCommands.stopAndDrain(),
      () => this.executionIssuers.stopAndDrain(),
      () => this.deliveryReader?.close(),
    ], () => this.db.close());
    return this.closeOwner();
  }
  storageRecovery() {
    return { ...connectionRecoverySnapshot(this.db),
      ...(this.closeOwner ? { ownerClose: this.closeOwner.snapshot() } : {}) };
  }
  async storageStats() { return { ...await ownedStorageStats(this.file), connection: this.storageRecovery() }; }
  checkpointStorage(check?: () => void) { return checkpointOwnedWalAsync(this.db, this.file, { available: () => !this.closed, check }); }

  // Existing owner-scoped, tombstoned connection pins are the alias registry.
  // No new per-session rows and no change to old receipt/preference keys.
  sessionReference(alias: string, ownerUserId = DEFAULT_USER_ID): SessionRef | undefined {
    const decoded = decodeHubSessionId(alias);
    if (!decoded) return undefined;
    const connection = this.getConnection(decoded.connectionId, ownerUserId);
    if (!connection || connection.status === 'disabled') return undefined;
    return sessionRef(connection.nodeId, decoded.remoteSessionKey);
  }

  // Resolve only within the actor's current directory. Multiple eligible
  // aliases may be cloned installs or alternate transports: never guess.
  resolveSessionReference(ref: SessionRef, ownerUserId = DEFAULT_USER_ID) {
    const remoteSessionKey = legacySessionKey(ref);
    const candidates = this.db.prepare(`SELECT id FROM env_connections
      WHERE owner_user_id = ? AND node_id = ? AND deleted_at IS NULL AND status <> 'disabled' LIMIT 2`)
      .all(ownerUserId, ref.nodeId) as Array<{ id: string }>;
    if (candidates.length !== 1) return undefined;
    return { connectionId: candidates[0]!.id, remoteSessionKey };
  }

  ensureLocalConnection(params: {
    id: string;
    label: string;
    connectorUrl: string;
    environmentId: string;
    environmentLabel: string;
    status: HubConnectionStatus;
  }) {
    const existing = this.getConnection(params.id, DEFAULT_USER_ID);
    if (existing) {
      this.upsertConnection({
        id: params.id,
        ownerUserId: DEFAULT_USER_ID,
        kind: 'local',
        label: existing.label || params.label,
        connectorUrl: params.connectorUrl,
        environmentId: existing.environmentId || params.environmentId,
        environmentLabel: existing.environmentLabel || params.environmentLabel,
        status: existing.status === 'disabled' ? 'disabled' : params.status,
        capabilities: ['sessions', 'messages', 'events', 'media'],
      }, { preserveCredential: true, audit: false, skipUnchanged: true });
      return;
    }
    this.upsertConnection({
      id: params.id,
      ownerUserId: DEFAULT_USER_ID,
      kind: 'local',
      label: params.label,
      connectorUrl: params.connectorUrl,
      environmentId: params.environmentId,
      environmentLabel: params.environmentLabel,
      status: params.status,
      capabilities: ['sessions', 'messages', 'events', 'media'],
    }, { audit: false });
  }

  listUsers() {
    const rows = this.db.prepare(`
      SELECT id, label, created_at, updated_at
      FROM users
      ORDER BY id = ? DESC, label COLLATE NOCASE ASC
    `).all(DEFAULT_USER_ID) as DbUserRow[];
    return rows.map(rowToUser);
  }

  /** Display only; original identities/transactions remain authoritative. */
  listUsersAsync(owner: string, admin: boolean) {
    const read = { owner, admin };
    return this.readBrowserState(reader => reader.users(read), () => readUsers(this.db, read), 'hub-users-read');
  }

  private preferenceVersion = Symbol();
  get sessionPreferenceVersion() { return this.preferenceVersion; }
  sessionPreferences(userId = DEFAULT_USER_ID): Map<string, SessionPreferences> {
    return new Map(readSessionPreferences(this.db, userId));
  }

  async sessionPreferencesAsync(userId = DEFAULT_USER_ID): Promise<Map<string, SessionPreferences>> {
    const version = this.preferenceVersion;
    const rows = await this.readBrowserState(reader => reader.preferences(userId),
      () => [...this.sessionPreferences(userId)], 'hub-preference-read');
    if (version !== this.preferenceVersion) {
      const trace = performanceDiagnostics.start('hub-preference-read'); trace.add('step', 2); trace.add('changed', 1); trace.finish(true);
      throw deliveryReadUnavailable();
    }
    return new Map(rows);
  }

  setSessionPreference(sessionId: string, field: keyof SessionPreferences, value: boolean, userId = DEFAULT_USER_ID) {
    if (!['hidden', 'archived', 'pinned'].includes(field)) throw new Error('Invalid preference');
    const decoded = decodeHubSessionId(sessionId);
    if (!decoded || encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) !== sessionId) throw new Error('Invalid Hub session ID');
    this.db.prepare(`INSERT INTO session_preferences (user_id, session_id, ${field}) VALUES (?, ?, ?)
      ON CONFLICT(user_id, session_id) DO UPDATE SET ${field} = excluded.${field}`).run(userId, sessionId, Number(value));
    this.preferenceVersion = Symbol();
  }

  /** Reconciles owner workspace file/board bindings stranded when same-node
   * execution issuer rotations incremented env_connections.authority_version
   * without connection/credential replacement. Never runs in constructor. */
  reconcileStrandedOwnerFileBindings(): number {
    const candidates = this.db.prepare(`
      SELECT user_id AS ownerId, connection_id AS connectionId, authority AS fromAuthority, MIN(created_at) AS minCreatedAt
      FROM (
        SELECT user_id, connection_id, authority, created_at FROM hub_workspace_board_file_bindings WHERE state != 'revoked'
        UNION ALL
        SELECT user_id, connection_id, authority, created_at FROM hub_workspace_card_file_bindings WHERE state != 'revoked'
        UNION ALL
        SELECT owner AS user_id, connection_id, authority, created_at FROM hub_board_bindings WHERE state != 'revoked'
      )
      GROUP BY user_id, connection_id, authority
    `).all() as Array<{ ownerId: string; connectionId: string; fromAuthority: number; minCreatedAt: number }>;
    if (!candidates.length) return 0;

    const eligible: Array<{ ownerId: string; connectionId: string; fromAuthority: number; toAuthority: number }> = [];
    for (const candidate of candidates) {
      const conn = this.db.prepare(`
        SELECT node_id AS nodeId, authority_version AS authorityVersion, connector_url AS connectorUrl, kind
        FROM env_connections
        WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL AND status <> 'disabled' AND node_id IS NOT NULL
      `).get(candidate.ownerId, candidate.connectionId) as {
        nodeId: string; authorityVersion: number; connectorUrl: string; kind: 'local' | 'remote';
      } | undefined;
      if (!conn || conn.authorityVersion <= candidate.fromAuthority) continue;

      const issuers = this.db.prepare(`
        SELECT node_id AS nodeId, authority_version AS authorityVersion, connector_url AS connectorUrl, kind, retired
        FROM hub_execution_issuers
        WHERE owner_id = ? AND connection_id = ? AND authority_version BETWEEN ? AND ?
        ORDER BY authority_version ASC
      `).all(candidate.ownerId, candidate.connectionId, candidate.fromAuthority, conn.authorityVersion) as Array<{
        nodeId: string; authorityVersion: number; connectorUrl: string; kind: 'local' | 'remote'; retired: number;
      }>;
      if (issuers.length < 2) continue;
      if (issuers[0]!.authorityVersion !== candidate.fromAuthority) continue;
      const latest = issuers.at(-1)!;
      if (latest.authorityVersion !== conn.authorityVersion || latest.retired !== 0) continue;
      if (issuers.some(row => row.nodeId !== conn.nodeId || row.connectorUrl !== conn.connectorUrl || row.kind !== conn.kind)) continue;
      let unbroken = true;
      for (let i = 1; i < issuers.length; i++) {
        const delta = issuers[i]!.authorityVersion - issuers[i - 1]!.authorityVersion;
        if (delta < 1 || delta > 2) { unbroken = false; break; }
      }
      if (!unbroken) continue;

      const mutatingAudit = this.db.prepare(`
        SELECT 1 FROM audit_logs
        WHERE owner_user_id = ? AND connection_id = ? AND created_at >= ?
          AND action IN ('connection.created', 'connection.updated', 'connection.deleted', 'credential.updated', 'maintenance_credential.updated')
        LIMIT 1
      `).get(candidate.ownerId, candidate.connectionId, candidate.minCreatedAt);
      if (mutatingAudit) continue;

      eligible.push({
        ownerId: candidate.ownerId,
        connectionId: candidate.connectionId,
        fromAuthority: candidate.fromAuthority,
        toAuthority: conn.authorityVersion,
      });
    }
    if (!eligible.length) return 0;

    let repaired = 0;
    let boardChanged = false;
    let cardChanged = false;
    observedTransaction(this.db, 'hub-preference-migration', () => {
      const bumpBoard = this.db.prepare(`INSERT INTO hub_workspace_board_file_versions VALUES (?, ?, 1)
        ON CONFLICT(user_id, resource_id) DO UPDATE SET revision = revision + 1`);
      const bumpCard = this.db.prepare(`INSERT INTO hub_workspace_card_file_versions VALUES (?, ?, 1)
        ON CONFLICT(user_id, resource_id) DO UPDATE SET revision = revision + 1`);
      for (const item of eligible) {
        const currentConn = this.db.prepare(`
          SELECT authority_version AS authorityVersion FROM env_connections
          WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL AND status <> 'disabled' AND node_id IS NOT NULL
        `).get(item.ownerId, item.connectionId) as { authorityVersion: number } | undefined;
        if (currentConn?.authorityVersion !== item.toAuthority) continue;

        const boardResources = this.db.prepare(`
          SELECT DISTINCT resource_id AS resourceId FROM hub_workspace_board_file_bindings
          WHERE user_id = ? AND connection_id = ? AND authority = ? AND state != 'revoked'
        `).all(item.ownerId, item.connectionId, item.fromAuthority) as Array<{ resourceId: string }>;
        if (boardResources.length) {
          repaired += Number(this.db.prepare(`
            UPDATE hub_workspace_board_file_bindings SET authority = ?
            WHERE user_id = ? AND connection_id = ? AND authority = ? AND state != 'revoked'
          `).run(item.toAuthority, item.ownerId, item.connectionId, item.fromAuthority).changes);
          for (const row of boardResources) bumpBoard.run(item.ownerId, row.resourceId);
          boardChanged = true;
        }

        const cardResources = this.db.prepare(`
          SELECT DISTINCT resource_id AS resourceId FROM hub_workspace_card_file_bindings
          WHERE user_id = ? AND connection_id = ? AND authority = ? AND state != 'revoked'
        `).all(item.ownerId, item.connectionId, item.fromAuthority) as Array<{ resourceId: string }>;
        if (cardResources.length) {
          repaired += Number(this.db.prepare(`
            UPDATE hub_workspace_card_file_bindings SET authority = ?
            WHERE user_id = ? AND connection_id = ? AND authority = ? AND state != 'revoked'
          `).run(item.toAuthority, item.ownerId, item.connectionId, item.fromAuthority).changes);
          for (const row of cardResources) bumpCard.run(item.ownerId, row.resourceId);
          cardChanged = true;
        }

        repaired += Number(this.db.prepare(`
          UPDATE hub_board_bindings SET authority = ?
          WHERE owner = ? AND connection_id = ? AND authority = ? AND state != 'revoked'
        `).run(item.toAuthority, item.ownerId, item.connectionId, item.fromAuthority).changes);
      }
    });
    if (boardChanged) this.boardFiles.changes.notify();
    if (cardChanged) this.cardFiles.changes.notify();
    return repaired;
  }

  removeSessionPreferences(sessionId: string, userId = DEFAULT_USER_ID) {
    this.db.prepare('DELETE FROM session_preferences WHERE user_id = ? AND session_id = ?').run(userId, sessionId);
    this.preferenceVersion = Symbol();
  }

  importLegacySessionPreferences(files: Record<keyof SessionPreferences, string>, ownerUserId?: string) {
    const migration = 'hub-session-preferences-v1';
    if (this.db.prepare('SELECT name FROM hub_migrations WHERE name = ?').get(migration)) return;
    // Validate all files before the transaction; never treat corrupt input as empty.
    const entries = Object.entries(files).flatMap(([field, file]) => {
      if (!existsSync(file)) return [];
      if (statSync(file).size > 8 * 1024 * 1024) throw new Error('Legacy preference file exceeds size limit');
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
      catch { throw new Error(`Invalid legacy ${field} preferences`); }
      if (!parsed || typeof parsed !== 'object') throw new Error(`Invalid legacy ${field} preferences`);
      const values = Array.isArray(parsed) ? parsed : Object.keys(parsed);
      if (values.some((value) => typeof value !== 'string')) throw new Error(`Invalid legacy ${field} preferences`);
      return (values as string[]).flatMap((value) => {
        const id = value.trim(); const decoded = decodeHubSessionId(id);
        return decoded && encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) === id ? [{ field: field as keyof SessionPreferences, id }] : [];
      });
    });
    observedTransaction(this.db, 'hub-preference-migration', () => {
      // Legacy files have no actor identity. Multiple users make the default
      // ambiguous; only an explicit operator choice can assign this source.
      const owner = ownerUserId ?? DEFAULT_USER_ID;
      if (entries.length && (!this.getUser(owner)
        || (ownerUserId === undefined && this.db.prepare('SELECT id FROM users LIMIT 2').all().length > 1))) {
        throw new Error('Legacy preferences owner is ambiguous or unknown; set AOD_HUB_LEGACY_PREFERENCES_OWNER to the original existing user ID');
      }
      for (const { field, id } of entries) {
        this.db.prepare(`INSERT INTO session_preferences (user_id, session_id, ${field}) VALUES (?, ?, 1)
          ON CONFLICT(user_id, session_id) DO UPDATE SET ${field} = COALESCE(session_preferences.${field}, 1)`).run(owner, id);
      }
      this.db.prepare('INSERT INTO hub_migrations (name, applied_at) VALUES (?, ?)').run(migration, Date.now());
    });
    this.preferenceVersion = Symbol();
  }

  getUser(id: string) {
    const row = this.db.prepare(`
      SELECT id, label, created_at, updated_at
      FROM users
      WHERE id = ?
    `).get(id) as DbUserRow | undefined;
    return row ? rowToUser(row) : undefined;
  }

  createUser(label: string) {
    const normalizedLabel = normalizeUserLabel(label);
    const now = Date.now();
    const user: HubUser = {
      id: `user_${randomUUID()}`,
      label: normalizedLabel,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO users (id, label, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(user.id, user.label, user.createdAt, user.updatedAt);
    return user;
  }

  updateUser(id: string, label: string) {
    const existing = this.getUser(id);
    if (!existing) return undefined;
    const normalizedLabel = normalizeUserLabel(label);
    const updatedAt = Date.now();
    this.db.prepare('UPDATE users SET label = ?, updated_at = ? WHERE id = ?').run(normalizedLabel, updatedAt, id);
    return this.getUser(id) ?? { ...existing, label: normalizedLabel, updatedAt };
  }

  listConnections(ownerUserId = DEFAULT_USER_ID) {
    const rows = this.db.prepare(`
      SELECT c.*, ec.id AS credential_id
      FROM env_connections c
      LEFT JOIN env_credentials ec ON ec.connection_id = c.id AND ec.owner_user_id = c.owner_user_id
      WHERE c.owner_user_id = ? AND c.deleted_at IS NULL
      ORDER BY c.kind = 'local' DESC, c.label COLLATE NOCASE ASC
    `).all(ownerUserId) as DbConnectionRow[];
    return rows.map(rowToConnection);
  }

  /** Display only. Indexed owner-scoped generations are maintained by the
   * original transaction, including other-handle/older-binary mutations.
   * No cached authorization or main-thread scan fallback.
   * Existing command/session fan-in authority still uses listConnections. */
  async listConnectionsAsync(ownerUserId = DEFAULT_USER_ID): Promise<HubConnection[]> {
    const before = this.connectionDirectoryVersion(ownerUserId);
    const rows = await this.readBrowserState(reader => reader.connections(ownerUserId),
      () => readConnections(this.db, ownerUserId), 'hub-connections-read');
    const after = this.connectionDirectoryVersion(ownerUserId);
    if (before !== after) {
      const trace = guardedTrace(performanceDiagnostics, 'hub-connections-read'); trace.add('step', 2);
      trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
      throw new ConnectionDirectoryChanged();
    }
    return rows;
  }

  /** Constant-size display fence, NOT a Connector credential or execution
   * grant. Compare around asynchronous aggregation; keep the original node
   * authority checks for each contribution. Trigger-owned generations detect
   * other-handle writes and deletion/recreation without scanning the directory.
   * Refuse an open transaction instead of certifying uncommitted facts. */
  connectionDirectoryVersion(ownerUserId = DEFAULT_USER_ID): number {
    try {
      if (this.closed) throw new DeliverySnapshotReadRejected();
      requireConnectionReady(this.db);
      if (this.db.isTransaction) throw new DeliverySnapshotReadRejected();
      const row = this.db.prepare(CONNECTION_DISPLAY_VERSION_SQL).get(ownerUserId) as { version: number } | undefined;
      const value = row?.version ?? 0;
      if (!Number.isSafeInteger(value) || value < 0 || (row && value === 0))
        throw new DeliverySnapshotReadRejected();
      return value;
    } catch (error) { reportHubReadFailure('hub-connections-read', error); throw error; }
  }

  /** Indexed revision only; no document parsing in the main-thread fence.
   * Keep original node/role authorization at each actual delivery/mutation. */
  workspacePreferencesRevision(ownerUserId = DEFAULT_USER_ID): number {
    try {
      if (this.closed) throw new DeliverySnapshotReadRejected();
      requireConnectionReady(this.db);
      if (this.db.isTransaction) throw new DeliverySnapshotReadRejected();
      const row = this.db.prepare('SELECT revision FROM hub_workspace_preferences WHERE user_id=?').get(ownerUserId) as
        { revision: number } | undefined;
      const revision = row?.revision ?? 0;
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER || (row && revision === 0))
        throw new DeliverySnapshotReadRejected();
      return revision;
    } catch (error) { reportHubReadFailure('hub-workspace-preferences-read', error); throw error; }
  }

  /** Actual production read, using the existing readonly owner. No second
   * writer, cache, synchronous file-backed fallback or change to save CAS. */
  async workspacePreferencesAsync(ownerUserId = DEFAULT_USER_ID) {
    const before = this.workspacePreferencesRevision(ownerUserId);
    const value = await this.readBrowserState(reader => reader.workspace(ownerUserId),
      () => readWorkspacePreferences(this.db, ownerUserId), 'hub-workspace-preferences-read');
    if (before !== value.revision || before !== this.workspacePreferencesRevision(ownerUserId)) {
      const trace = guardedTrace(performanceDiagnostics, 'hub-workspace-preferences-read');
      trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
      throw new DeliverySnapshotReadRejected();
    }
    return value;
  }

  /** Constant-size writer fence only. Layout content remains on the original
   * readonly owner; a display revision is never a permission or commit proof. */
  workspaceLayoutRevision(ownerUserId: string, kind: LayoutKind): number {
    try {
      if (this.closed || (kind !== 'current' && kind !== 'saved')) throw new DeliverySnapshotReadRejected();
      requireConnectionReady(this.db);
      if (this.db.isTransaction) throw new DeliverySnapshotReadRejected();
      const row = this.db.prepare('SELECT revision FROM hub_workspace_layouts WHERE user_id=? AND kind=?').get(ownerUserId, kind) as
        { revision: number } | undefined;
      const revision = row?.revision ?? 0;
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER || (row && revision === 0))
        throw new DeliverySnapshotReadRejected();
      return revision;
    } catch (error) { reportHubReadFailure('hub-workspace-layout-read', error); throw error; }
  }

  async workspaceLayoutAsync(ownerUserId: string, kind: LayoutKind) {
    const before = this.workspaceLayoutRevision(ownerUserId, kind);
    const value = await this.readBrowserState(reader => reader.layout(ownerUserId, kind),
      () => readWorkspaceLayout(this.db, ownerUserId, kind), 'hub-workspace-layout-read');
    if (before !== value.revision || before !== this.workspaceLayoutRevision(ownerUserId, kind)) {
      const trace = guardedTrace(performanceDiagnostics, 'hub-workspace-layout-read');
      trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
      throw new DeliverySnapshotReadRejected();
    }
    return value;
  }

  getConnection(id: string, ownerUserId = DEFAULT_USER_ID) {
    const row = this.db.prepare(`
      SELECT c.*, ec.id AS credential_id
      FROM env_connections c
      LEFT JOIN env_credentials ec ON ec.connection_id = c.id AND ec.owner_user_id = c.owner_user_id
      WHERE c.id = ? AND c.owner_user_id = ? AND c.deleted_at IS NULL
    `).get(id, ownerUserId) as DbConnectionRow | undefined;
    return row ? rowToConnection(row) : undefined;
  }

  // Durable generation, not wall clock time: disabling and re-enabling a node
  // must never resurrect a client or event cursor from the previous authority.
  connectionAuthority(id: string, ownerUserId = DEFAULT_USER_ID) {
    return (this.db.prepare('SELECT authority_version AS version FROM env_connections WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL')
      .get(id, ownerUserId) as { version: number } | undefined)?.version;
  }

  // Initial trust is established by an authenticated Connector handshake, not
  // by a browser-provided ID. A pin is never silently replaced, even on alias
  // deletion/recreation: old receipts/preferences must not target a new node.
  pinConnectionNode(id: string, ownerUserId: string, expectedVersion: number, nodeId: string) {
    if (!isNodeId(nodeId)) throw new Error('Invalid Connector identity');
    const result = this.db.prepare(`UPDATE env_connections SET node_id = ?,
      authority_version = authority_version + CASE WHEN node_id IS NULL THEN 1 ELSE 0 END
      WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL AND status <> 'disabled'
        AND authority_version = ? AND (node_id IS NULL OR node_id = ?)`)
      .run(nodeId, id, ownerUserId, expectedVersion, nodeId);
    if (!result.changes) throw new Error('Connector identity or authorization changed');
    return this.getConnection(id, ownerUserId)!;
  }

  upsertConnection(input: HubConnectionInput, options: { preserveCredential?: boolean; audit?: boolean; skipUnchanged?: boolean } = {}) {
    return observedSavepoint(this.db, 'hub-connection-change', checkParticipant =>
      this.writeConnection(input, options, checkParticipant));
  }

  // Configuration, authority, encrypted credential and audit share the original
  // owner. A later write failure must not leave a partially revoked connection.
  private writeConnection(input: HubConnectionInput,
    options: { preserveCredential?: boolean; audit?: boolean; skipUnchanged?: boolean },
    checkParticipant: (value: unknown) => void) {
    const now = Date.now();
    const ownerUserId = input.ownerUserId ?? DEFAULT_USER_ID;
    const id = normalizeId(input.id) ?? `conn_${randomUUID()}`;
    const existing = this.getConnection(id, ownerUserId);
    const connection: HubConnection = {
      id,
      ownerUserId,
      kind: input.kind ?? existing?.kind ?? 'remote',
      label: input.label.trim() || existing?.label || 'Connector',
      connectorUrl: normalizeConnectorUrl(input.connectorUrl) ?? existing?.connectorUrl ?? '',
      status: input.status ?? existing?.status ?? 'enabled',
      environmentId: emptyToUndefined(input.environmentId) ?? existing?.environmentId,
      environmentLabel: emptyToUndefined(input.environmentLabel) ?? existing?.environmentLabel,
      capabilities: input.capabilities ?? existing?.capabilities ?? [],
      hasCredential: Boolean(input.credentialToken || existing?.hasCredential),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!connection.connectorUrl) throw new Error('connectorUrl is required');
    if (options.skipUnchanged && existing
      && (['kind', 'label', 'connectorUrl', 'status', 'environmentId', 'environmentLabel', 'hasCredential'] as const)
        .every(field => connection[field] === existing[field])
      && JSON.stringify(connection.capabilities) === JSON.stringify(existing.capabilities)
      && (!input.credentialToken || input.credentialToken === this.getCredentialToken(id, ownerUserId))) return existing;

    this.db.prepare(`
      INSERT INTO env_connections (id, owner_user_id, kind, label, connector_url, status, environment_id, environment_label, capabilities_json, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id, owner_user_id) DO UPDATE SET
        authority_version = env_connections.authority_version + 1,
        kind = excluded.kind,
        label = excluded.label,
        connector_url = excluded.connector_url,
        status = excluded.status,
        environment_id = excluded.environment_id,
        environment_label = excluded.environment_label,
        capabilities_json = excluded.capabilities_json,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `).run(
      connection.id,
      connection.ownerUserId,
      connection.kind,
      connection.label,
      connection.connectorUrl,
      connection.status,
      connection.environmentId ?? null,
      connection.environmentLabel ?? null,
      JSON.stringify(connection.capabilities),
      connection.createdAt,
      connection.updatedAt,
    );

    if (input.credentialToken) {
      checkParticipant(this.storeCredential(connection.id, ownerUserId, input.credentialToken));
      checkParticipant(this.appendAudit('credential.updated', ownerUserId, connection.id, { hasCredential: true }));
    } else if (!options.preserveCredential && !existing?.hasCredential) {
      // Nothing to persist; keep the connection explicitly credential-less.
    }

    if (options.audit !== false) checkParticipant(this.appendAudit(existing ? 'connection.updated' : 'connection.created', ownerUserId, connection.id, safeConnectionDetail(connection)));
    return this.getConnection(connection.id, ownerUserId) ?? connection;
  }

  // Display-only edits must not revoke active execution leases or streams.
  // Identity, destination, enabled state and credential edits still use upsert.
  renameConnection(id: string, labels: { label: string; environmentLabel?: string | undefined }, ownerUserId = DEFAULT_USER_ID) {
    return observedSavepoint(this.db, 'hub-connection-change', checkParticipant => {
      const label = labels.label.trim();
      if (!label) throw new Error('connection label is required');
      const changed = this.db.prepare(`UPDATE env_connections SET label = ?,
        environment_label = COALESCE(?, environment_label), updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`).run(
        label, labels.environmentLabel?.trim() || null, Date.now(), id, ownerUserId);
      if (!changed.changes) return undefined;
      const connection = this.getConnection(id, ownerUserId)!;
      checkParticipant(this.appendAudit('connection.updated', ownerUserId, id, safeConnectionDetail(connection)));
      return connection;
    });
  }

  deleteConnection(id: string, ownerUserId = DEFAULT_USER_ID) {
    return observedSavepoint(this.db, 'hub-connection-change', checkParticipant => {
      const connection = this.getConnection(id, ownerUserId);
      if (!connection || connection.kind === 'local') return false;
      const now = Date.now();
      this.db.prepare('UPDATE env_connections SET deleted_at = ?, updated_at = ?, authority_version = authority_version + 1 WHERE id = ? AND owner_user_id = ?').run(now, now, id, ownerUserId);
      this.db.prepare('DELETE FROM env_credentials WHERE connection_id IN (?, ?) AND owner_user_id = ?').run(id, maintenanceCredentialKey(id), ownerUserId);
      checkParticipant(this.appendAudit('connection.deleted', ownerUserId, id, safeConnectionDetail(connection)));
      return true;
    });
  }

  getCredentialToken(connectionId: string, ownerUserId = DEFAULT_USER_ID) {
    return this.getCredentialTokenByKey(connectionId, ownerUserId);
  }

  getMaintenanceCredentialToken(connectionId: string, ownerUserId = DEFAULT_USER_ID) {
    return this.getCredentialTokenByKey(maintenanceCredentialKey(connectionId), ownerUserId);
  }

  updateMaintenanceCredential(connectionId: string, token: string, ownerUserId = DEFAULT_USER_ID) {
    return observedSavepoint(this.db, 'hub-connection-change', checkParticipant => {
      if (!this.getConnection(connectionId, ownerUserId)) throw new Error('Connection not found');
      this.db.prepare('UPDATE env_connections SET authority_version = authority_version + 1 WHERE id = ? AND owner_user_id = ?').run(connectionId, ownerUserId);
      checkParticipant(this.storeCredential(maintenanceCredentialKey(connectionId), ownerUserId, token));
      checkParticipant(this.appendAudit('maintenance_credential.updated', ownerUserId, connectionId, { hasMaintenanceCredential: true }));
    });
  }

  audit(action: HubAuditAction, connectionId: string | undefined, detail: unknown, ownerUserId = DEFAULT_USER_ID) {
    this.appendAudit(action, ownerUserId, connectionId, detail);
  }

  /** Fixed internal owner operation; no second connection or generic SQL RPC. */
  executionLeaseCommand(command: HubExecutionLeaseCommand) {
    if (this.closed) return Promise.reject(new Error('Hub store closed'));
    return observeHubExecutionLeaseCommand(this.db,this.executionLeases,command);
  }

  upstreamCursor(connectionId: string, domain: string, ownerUserId = DEFAULT_USER_ID) {
    const row = this.db.prepare('SELECT last_event_id FROM remote_event_cursors WHERE connection_id = ? AND owner_user_id = ? AND stream_domain = ?').get(connectionId, ownerUserId, domain) as { last_event_id: string | null } | undefined;
    return row?.last_event_id ?? undefined;
  }

  /** Private service domain; public member dispatch cannot mint this authority. */
  eventFeedCommand(input: HubEventFeedInput) { return executeHubEventFeed(this.db, this, input); }

  latestDeliveryCursor(ownerUserId = DEFAULT_USER_ID) {
    return (this.db.prepare('SELECT id FROM hub_events WHERE owner_user_id = ? ORDER BY rowid DESC LIMIT 1').get(ownerUserId) as { id: string } | undefined)?.id;
  }

  /** Fixed event replay command, inside the original identity snapshot. */
  eventWorkspaceRevisions(ownerUserId: string) { return readWorkspaceRevisions(this.db, ownerUserId); }

  // Atomic admission + upstream acknowledgement; a browser never owns node cursors.
  appendDelivery(event: Omit<HubDeliveryEvent, 'id'>, domain: string, cursor?: string, ownerUserId = DEFAULT_USER_ID, liveSince?: number,
    authorize?: () => void) {
    const id = `hub:${randomUUID()}`;
    const body = JSON.stringify({ ...event, id });
    if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Hub event exceeds size limit');
    return observedTransaction(this.db, 'hub-delivery-append', (commit, checkParticipant) => {
      checkParticipant(authorize?.());
      const duplicate = cursor ? this.db.prepare('SELECT id FROM hub_events WHERE owner_user_id = ? AND connection_id = ? AND stream_domain = ? AND remote_event_id = ?').get(ownerUserId, event.envConnectionId, domain, cursor) : undefined;
      if (!duplicate) this.db.prepare('INSERT INTO hub_events (id, owner_user_id, connection_id, remote_event_id, event_type, payload_json, created_at, stream_domain) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, ownerUserId, event.envConnectionId, cursor ?? null, event.type, body, Date.now(), domain);
      if (!duplicate && liveSince !== undefined && ['session.updated', 'run.updated', 'run.completed'].includes(event.type) && event.remoteSessionKey) {
        const connection = this.getConnection(event.envConnectionId, ownerUserId), authority = this.connectionAuthority(event.envConnectionId, ownerUserId);
        if (connection?.nodeId && connection.status !== 'disabled' && authority !== undefined) {
          this.completions.ingest(ownerUserId, connectionCompletionTarget(connection.nodeId, connection.id, authority, event.remoteSessionKey),
            createHash('sha256').update(domain).digest('hex'), event.payload, liveSince, event.ts);
        }
      }
      if (cursor) this.db.prepare(`INSERT INTO remote_event_cursors (connection_id, owner_user_id, last_event_id, updated_at, stream_domain) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, owner_user_id) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = excluded.updated_at, stream_domain = excluded.stream_domain`).run(event.envConnectionId, ownerUserId, cursor, Date.now(), domain);
      // Bound retained bytes as well as count. Read indexed byte lengths, not
      // up to 8 MiB of retained JSON on every incoming event. INDEXED BY is a
      // regression guard: an unrelated lookup index must not bring body scans
      // back into this synchronous transaction. The bounded integer sort stays.
      this.db.prepare(`DELETE FROM hub_events WHERE owner_user_id = ? AND rowid IN (
        SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (ORDER BY rowid DESC) AS n,
          SUM(length(CAST(payload_json AS BLOB))) OVER (ORDER BY rowid DESC) AS bytes
          FROM hub_events INDEXED BY hub_event_retention_bytes WHERE owner_user_id = ?) WHERE n > 2048 OR bytes > 8388608
      )`).run(ownerUserId, ownerUserId);
      checkParticipant(authorize?.());
      commit();
      return !duplicate;
    });
  }

  deliveryPage(cursor: string | undefined, domains: ReadonlyMap<string, string>, ownerUserId = DEFAULT_USER_ID) {
    return readDeliveryPage(this.db, { cursor, domains: [...domains], owner: ownerUserId });
  }

  async deliveryPageAsync(cursor: string | undefined, domains: ReadonlyMap<string, string>, ownerUserId = DEFAULT_USER_ID) {
    const read = { owner: ownerUserId, cursor, domains: [...domains] };
    return this.readBrowserState(reader => reader.read(read), () => this.deliveryPage(cursor, domains, ownerUserId), 'hub-delivery-read');
  }

  /** Level-triggered display versions; never a permission or commit proof. */
  workspaceRevisionsAsync(ownerUserId = DEFAULT_USER_ID) {
    if (!validWorkspaceRevisionRead({ owner: ownerUserId }) || this.closed || this.workspaceRevisionWaiters >= 256) {
      const trace = performanceDiagnostics.start('hub-workspace-revisions-read'); trace.add('deferred', 1); trace.finish(true);
      return Promise.reject(deliveryReadUnavailable());
    }
    // Multiple tabs for one owner join ONE original read, not a persistent
    // version cache. Cross-owner reads remain isolated and bounded by the
    // existing snapshot admission. Publish before any diagnostic/SQL callback.
    let original = this.workspaceRevisionReads.get(ownerUserId);
    if (!original) {
      original = Promise.resolve().then(() => this.readBrowserState(reader => reader.revisions(ownerUserId),
        () => readWorkspaceRevisions(this.db, ownerUserId), 'hub-workspace-revisions-read')).then(rows => {
          // Shared display results cannot be mutated by another subscriber.
          for (const type of WORKSPACE_REVISION_TYPES) {
            for (const row of rows[type]) Object.freeze(row);
            Object.freeze(rows[type]);
          }
          return Object.freeze(rows);
        });
      this.workspaceRevisionReads.set(ownerUserId, original);
      const captured = original;
      const release = () => { if (this.workspaceRevisionReads.get(ownerUserId) === captured) this.workspaceRevisionReads.delete(ownerUserId); };
      void original.then(release, release);
    }
    this.workspaceRevisionWaiters++;
    return original.then(rows => {
      if (this.closed) throw deliveryReadUnavailable();
      requireConnectionReady(this.db);
      return rows;
    }).finally(() => { this.workspaceRevisionWaiters--; });
  }

  async completionSummaryAsync(owner: string, targets: string[]) {
    // Display only. Original observe/markRead/ingest transactions remain on
    // the shared writer. Route authority is separately rechecked after await.
    // Recovery may await the previous physical owner exit before dispatch.
    // Own the complete bounded request before that first await as well.
    const length = targets.length;
    if (!Array.isArray(targets) || !Number.isSafeInteger(length) || length < 0 || length > 256) throw deliveryReadUnavailable();
    const owned: string[] = [];
    for (let i = 0; i < length; i++) owned.push(targets[i]!);
    const read = { owner, targets: owned };
    if (!validCompletionSummaryRead(read)) throw deliveryReadUnavailable();
    const version = this.connectionDirectoryVersion(owner);
    const rows = await this.readBrowserState(reader => reader.completions(owner, owned),
      () => readCompletionSummary(this.db, read), 'hub-completion-summary-read');
    if (version !== this.connectionDirectoryVersion(owner)) {
      const trace = guardedTrace(performanceDiagnostics, 'hub-completion-summary-read'); trace.add('step', 2);
      trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
      throw deliveryReadUnavailable();
    }
    return rows;
  }

  /** Bounded indexed metadata only; never parse task bodies in this fence. */
  workspaceBoardReadVersion(read: WorkspaceBoardRead): string {
    try {
      if (this.closed || !validWorkspaceBoardRead(read) || this.db.isTransaction) throw new DeliverySnapshotReadRejected();
      requireConnectionReady(this.db);
      const scope = read.mode === 'list' ? '' : ' AND resource_id=?';
      const rows = this.db.prepare(`SELECT CASE WHEN typeof(resource_id)='text' AND length(CAST(resource_id AS BLOB))<=36
        THEN resource_id ELSE NULL END AS resourceId,
        CASE WHEN typeof(revision)='integer' THEN revision ELSE NULL END AS revision,
        CASE WHEN typeof(updated_at)='integer' THEN updated_at ELSE NULL END AS updatedAt
        FROM hub_workspace_boards WHERE user_id=?${scope} ORDER BY updated_at DESC,resource_id LIMIT ${read.mode === 'list' ? 65 : 2}`)
        .all(...(read.mode === 'list' ? [read.owner] : [read.owner, read.resourceId!])) as
        { resourceId: string; revision: number; updatedAt: number | null }[];
      const seen = new Set<string>();
      if (rows.length > (read.mode === 'list' ? 64 : 1)) throw new DeliverySnapshotReadRejected();
      for (const row of rows) {
        if (!validWorkspaceBoardRead({ owner: read.owner, mode: 'document', resourceId: row.resourceId })
          || seen.has(row.resourceId) || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision >= Number.MAX_SAFE_INTEGER
          || !Number.isSafeInteger(row.updatedAt) || row.updatedAt! < 0) throw new DeliverySnapshotReadRejected();
        seen.add(row.resourceId);
      }
      if (!rows.length && read.mode !== 'list') rows.push({ resourceId: read.resourceId!, revision: 0, updatedAt: null });
      if (read.mode === 'list' && !seen.has('default')) rows.unshift({ resourceId: 'default', revision: 0, updatedAt: null });
      return JSON.stringify(rows);
    } catch (error) { reportHubReadFailure('hub-workspace-board-read', error); throw error; }
  }

  async workspaceBoardAsync(read: WorkspaceBoardRead): Promise<WorkspaceBoardReadResult> {
    // Own the exact scope before recovery can await the previous reader exit.
    if (!validWorkspaceBoardRead(read)) throw deliveryReadUnavailable();
    const request = { owner: read.owner, mode: read.mode, resourceId: read.resourceId };
    if (!validWorkspaceBoardRead(request)) throw deliveryReadUnavailable();
    const before = this.workspaceBoardReadVersion(request);
    const value = await this.readBrowserState(reader => reader.boards(request),
      () => readWorkspaceBoard(this.db, request), 'hub-workspace-board-read');
    const versions = validWorkspaceBoardResult(value, request)
      ? (Array.isArray(value) ? value : [value]).map(({ resourceId, revision, updatedAt }) => ({ resourceId, revision, updatedAt })) : null;
    if (!versions || before !== JSON.stringify(versions) || before !== this.workspaceBoardReadVersion(request)) {
      const trace = guardedTrace(performanceDiagnostics, 'hub-workspace-board-read'); trace.add('step', 2);
      trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
      throw new DeliverySnapshotReadRejected();
    }
    return value;
  }

  async notebookSnapshotAsync(read: NotebookSnapshotRead): Promise<NotebookSnapshot> {
    if (!validNotebookSnapshotRead(read)) throw deliveryReadUnavailable();
    const request: NotebookSnapshotRead = { owner: read.owner, mode: read.mode, resourceId: read.resourceId,
      after: read.after, query: read.query, includeArchive: read.includeArchive };
    if (!validNotebookSnapshotRead(request)) throw deliveryReadUnavailable();
    const versions = () => { try { return JSON.stringify(notebookSnapshotVersions(this.db, request)); }
      catch (error) { reportHubReadFailure('hub-notebook-snapshot-read', error); throw error; } };
    const before = versions();
    const value = await this.readBrowserState(reader => reader.notebooks(request), () => readNotebookSnapshot(this.db, request), 'hub-notebook-snapshot-read');
    if (!validNotebookSnapshot(value, request) || before !== JSON.stringify(value.versions) || before !== versions()) {
      const trace = guardedTrace(performanceDiagnostics, 'hub-notebook-snapshot-read'); trace.add('step', 2);
      trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
      throw new DeliverySnapshotReadRejected();
    }
    return value;
  }

  private async readBrowserState<T>(read: (reader: AsyncHubDeliveryReader) => Promise<T>, memory: () => T,
    operation: 'hub-delivery-read' | 'hub-preference-read' | 'hub-users-read' | 'hub-connections-read' | 'hub-workspace-revisions-read' | 'hub-workspace-preferences-read' | 'hub-workspace-layout-read' | 'hub-workspace-board-read' | 'hub-notebook-snapshot-read' | 'hub-completion-summary-read'): Promise<T> {
    const guard = () => { if (this.closed) throw deliveryReadUnavailable(); requireConnectionReady(this.db); };
    const observeFailure = () => {
      if (this.deliveryReader?.recoveryState.unavailable && this.failedDeliveryReader !== this.deliveryReader) {
        this.failedDeliveryReader = this.deliveryReader; this.deliveryRetryAt = performance.now() + 1000;
      }
    };
    try {
      guard();
      // Only synthetic in-memory databases lack a file a worker can open.
      // Production file-backed replay never falls back to main-thread SQL.
      if (!this.deliveryConfig) return memory();
      let recovered = false;
      observeFailure();
      if (this.deliveryReader?.recoveryState.unavailable) {
        if (!this.deliveryReader.recoveryState.exitConfirmed || performance.now() < this.deliveryRetryAt) throw deliveryReadUnavailable();
        const previous = this.deliveryReader; await previous.close(); guard();
        if (this.deliveryReader === previous) { this.deliveryReader = undefined; recovered = true; }
      }
      this.deliveryReader ??= new AsyncHubDeliveryReader(this.deliveryConfig);
      const page = await read(this.deliveryReader); guard();
      if (recovered) {
        const trace = performanceDiagnostics.start(operation); trace.add('step', 4); trace.add('recovered', 1); trace.finish();
      }
      return page;
    } catch {
      observeFailure();
      const trace = performanceDiagnostics.start(operation); trace.add('deferred', 1); trace.finish(true);
      throw deliveryReadUnavailable();
    }
  }

  private getCredentialTokenByKey(connectionId: string, ownerUserId: string, boundedExecutionIssuer = false) {
    // Only the fixed execution-issuer namespace opts in; legacy credentials
    // retain their existing contract. Reject before allocating/decrypting a
    // corrupted value, without truncation, mutation or alternate credentials.
    if (boundedExecutionIssuer) {
      const size = this.db.prepare(`SELECT length(CAST(encrypted_token AS BLOB)) AS token,
        length(CAST(nonce AS BLOB)) AS nonce, length(CAST(auth_tag AS BLOB)) AS tag
        FROM env_credentials WHERE connection_id=? AND owner_user_id=?`)
        .get(connectionId, ownerUserId);
      if (!size) return undefined;
      if (typeof size.token !== 'number' || !Number.isSafeInteger(size.token) || size.token < 1 || size.token > 8192
        || size.nonce !== 16 || size.tag !== 22) throw new Error('Execution issuer credential unavailable');
    }
    const row = this.db.prepare(`
      SELECT encrypted_token, nonce, auth_tag
      FROM env_credentials
      WHERE connection_id = ? AND owner_user_id = ?
    `).get(connectionId, ownerUserId) as DbCredentialRow | undefined;
    if (!row) return undefined;
    return decryptToken(row, this.key);
  }

  private storeCredential(connectionId: string, ownerUserId: string, token: string) {
    const now = Date.now();
    const encrypted = encryptToken(token, this.key);
    this.db.prepare(`
      INSERT INTO env_credentials (id, connection_id, owner_user_id, encrypted_token, nonce, auth_tag, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, owner_user_id) DO UPDATE SET
        encrypted_token = excluded.encrypted_token,
        nonce = excluded.nonce,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `).run(`cred_${randomUUID()}`, connectionId, ownerUserId, encrypted.encryptedToken, encrypted.nonce, encrypted.authTag, now, now);
  }

  private appendAudit(action: HubAuditAction, ownerUserId: string, connectionId: string | undefined, detail: unknown) {
    this.db.prepare(`
      INSERT INTO audit_logs (id, owner_user_id, action, connection_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(`audit_${randomUUID()}`, ownerUserId, action, connectionId ?? null, JSON.stringify(detail ?? {}), Date.now());
  }

  private migrateLegacyDefaultVaultCredentials() {
    const legacyKey = deriveKey(LEGACY_DEFAULT_VAULT_SECRET);
    observedTransaction(this.db, 'hub-preference-migration', () => {
      const rows = this.db.prepare(`
        SELECT id, encrypted_token, nonce, auth_tag
        FROM env_credentials
      `).all() as Array<DbCredentialRow & { id: string }>;
      if (!rows.length) return;
      const now = Date.now();
      const update = this.db.prepare(`
        UPDATE env_credentials
        SET encrypted_token = ?, nonce = ?, auth_tag = ?, updated_at = ?
        WHERE id = ?
      `);
      for (const row of rows) {
        try {
          decryptToken(row, this.key);
          continue;
        } catch { /* Not encrypted under the newly provisioned key; try legacy fallback key. */ }
        let plaintext: string;
        try {
          plaintext = decryptToken(row, legacyKey);
        } catch {
          throw new Error('Existing Hub credentials require the original AOD_HUB_VAULT_SECRET');
        }
        const reencrypted = encryptToken(plaintext, this.key);
        update.run(reencrypted.encryptedToken, reencrypted.nonce, reencrypted.authTag, now, row.id);
      }
    });
  }

  private migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS hub_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_preferences (
        user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL,
        hidden INTEGER CHECK(hidden IN (0, 1)), archived INTEGER CHECK(archived IN (0, 1)), pinned INTEGER CHECK(pinned IN (0, 1)),
        PRIMARY KEY(user_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS env_connections (
        id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('local', 'remote')),
        label TEXT NOT NULL,
        connector_url TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('enabled', 'disabled', 'degraded')),
        environment_id TEXT,
        environment_label TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        PRIMARY KEY (id, owner_user_id)
      );

      CREATE TABLE IF NOT EXISTS env_credentials (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        encrypted_token TEXT NOT NULL,
        nonce TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(connection_id, owner_user_id)
      );

      CREATE TABLE IF NOT EXISTS remote_event_cursors (
        connection_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        last_event_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (connection_id, owner_user_id)
      );

      CREATE TABLE IF NOT EXISTS hub_events (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        remote_event_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        connection_id TEXT,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    const connectionColumns = this.db.prepare('PRAGMA table_info(env_connections)').all() as Array<{ name: string }>;
    if (!connectionColumns.some((column) => column.name === 'authority_version')) this.db.exec('ALTER TABLE env_connections ADD COLUMN authority_version INTEGER NOT NULL DEFAULT 1');
    if (!connectionColumns.some((column) => column.name === 'node_id')) this.db.exec('ALTER TABLE env_connections ADD COLUMN node_id TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS connection_node_lookup ON env_connections(owner_user_id, node_id) WHERE deleted_at IS NULL');
    migrateConnectionDisplayVersions(this.db);
    migrateSessionPreferenceVersions(this.db);
    for (const table of ['remote_event_cursors', 'hub_events']) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'stream_domain')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN stream_domain TEXT NOT NULL DEFAULT ''`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS hub_event_identity ON hub_events (owner_user_id, connection_id, stream_domain, remote_event_id)');
    // A rebuildable expression index, not a second event/receipt store. SQLite
    // maintains the UTF-8 byte length transactionally with inserts/deletes.
    // Existing journals are scanned once when the index is first installed.
    this.db.exec('CREATE INDEX IF NOT EXISTS hub_event_retention_bytes ON hub_events (owner_user_id, length(CAST(payload_json AS BLOB)))');

    const now = Date.now();
    this.db.prepare(`
      INSERT INTO users (id, label, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(DEFAULT_USER_ID, 'Default local user', now, now);
  }
}

function maintenanceCredentialKey(connectionId: string) {
  return `${connectionId}:maintenance`;
}

type DbConnectionRow = {
  node_id: string | null;
  id: string;
  owner_user_id: string;
  kind: HubConnectionKind;
  label: string;
  connector_url: string;
  status: HubConnectionStatus;
  environment_id: string | null;
  environment_label: string | null;
  capabilities_json: string;
  created_at: number;
  updated_at: number;
  credential_id?: string | null;
};

type DbUserRow = {
  id: string;
  label: string;
  created_at: number;
  updated_at: number;
};

type DbCredentialRow = {
  encrypted_token: string;
  nonce: string;
  auth_tag: string;
};

function rowToConnection(row: DbConnectionRow): HubConnection {
  return {
    nodeId: row.node_id ?? undefined,
    id: row.id,
    ownerUserId: row.owner_user_id,
    kind: row.kind,
    label: row.label,
    connectorUrl: row.connector_url,
    status: row.status,
    environmentId: row.environment_id ?? undefined,
    environmentLabel: row.environment_label ?? undefined,
    capabilities: parseCapabilities(row.capabilities_json),
    hasCredential: Boolean(row.credential_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUser(row: DbUserRow): HubUser {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseCapabilities(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function safeConnectionDetail(connection: HubConnection) {
  return {
    id: connection.id,
    kind: connection.kind,
    label: connection.label,
    connectorUrl: connection.connectorUrl,
    status: connection.status,
    environmentId: connection.environmentId,
    environmentLabel: connection.environmentLabel,
    capabilities: connection.capabilities,
    hasCredential: connection.hasCredential,
  };
}

function normalizeId(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || undefined;
}

function normalizeUserLabel(value: string) {
  const label = value.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!label) throw new Error('label is required');
  return label;
}

export function normalizeConnectorUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'local://aod-connector') return trimmed;
  if (/^(reverse|tunnel):\/\/[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function emptyToUndefined(value: string | undefined) {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

const LEGACY_DEFAULT_VAULT_SECRET = 'agentopsdeck-local-development-vault-key';

function readValidatedVaultKey(vaultKeyPath: string): Buffer {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(vaultKeyPath, constants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32
      || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Hub vault key file failed owner-private safety checks');
    }
    const key = Buffer.alloc(32);
    let offset = 0;
    while (offset < 32) {
      const bytes = readSync(fd, key, offset, 32 - offset, offset);
      if (bytes <= 0) throw new Error('Hub vault key file could not be read completely');
      offset += bytes;
    }
    return key;
  } finally {
    closeSync(fd);
  }
}

function loadOrProvisionVaultKey(vaultKeyPath: string): { key: Buffer; provisioned: boolean } {
  const parentStat = lstatSync(dirname(vaultKeyPath));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Hub vault key parent directory must be a non-symlink directory');
  }
  try {
    return { key: readValidatedVaultKey(vaultKeyPath), provisioned: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const tempPath = `${vaultKeyPath}.tmp.${process.pid}.${randomUUID()}`;
  const generated = randomBytes(32);
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < generated.length) {
      offset += writeSync(fd, generated, offset, generated.length - offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(tempPath, vaultKeyPath);
      try { unlinkSync(tempPath); } catch { /* Best-effort cleanup before link-count validation. */ }
      return { key: readValidatedVaultKey(vaultKeyPath), provisioned: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { unlinkSync(tempPath); } catch { /* Best-effort cleanup when peer won atomic link. */ }
      return { key: readValidatedVaultKey(vaultKeyPath), provisioned: false };
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Preserve original provisioning failure. */ }
    }
    try { unlinkSync(tempPath); } catch { /* Temporary link target may already be removed or never created. */ }
  }
}

function deriveKey(secret: string) {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encryptToken(token: string, key: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encryptedToken = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedToken: encryptedToken.toString('base64url'),
    nonce: nonce.toString('base64url'),
    authTag: authTag.toString('base64url'),
  };
}

function decryptToken(row: DbCredentialRow, key: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_token, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
