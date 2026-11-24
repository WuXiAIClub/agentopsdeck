import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { asyncVolumeAdmission } from '../storage/async-volume-admission.js';
import type { DatabaseSync } from 'node:sqlite';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { configureOwnedWal, ownedStorageStats, checkpointOwnedWalAsync } from '../storage/owned-sqlite.js';
import { CommandReceipts } from '../commands/receipts.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { loadNodeIdentity } from './node-identity.js';
import { normalizeConnectorUserLabel } from './users-format.js';
import { ConnectorEventLog } from './event-log.js';
import { ExecutionGrants, type ExecutionAction } from './execution-grants.js';
import { OpenClawExecutions } from '../openclaw/executions.js';
import { CodexExecutions } from '../codex/executions.js';
import { CodexCreations } from '../codex/creations.js';
import { registerNativeResumeWriter } from '../codex/native-resume.js';
import { registerNativeHistoryWriter } from '../codex/native-history.js';
import { MirrorOutbox } from '../messages/mirror.js';
import { HermesJournal } from '../hermes/journal.js';
import { SdkExecutionJournal } from './sdk-execution-journal.js';
import { NativeTokenUsageStore } from './native-token-usage.js';
import { ClaudeTranscriptStore } from '../claude/transcript-store.js';
import { CopilotTranscriptStore } from '../copilot/transcript-store.js';
import { SdkAttachmentStore } from './sdk-attachment-store.js';
import { InteractionStore } from '../commands/interaction-store.js';
import { createCodexAutomation, type CodexAutomationRuntime } from './codex-automation.js';
import { AutomationStore } from '../commands/automation-store.js';
import { AutomationConfigurationStore } from '../commands/automation-configuration.js';
import type { AutomationTarget } from '../commands/automation-policy.js';
import { WorkspaceContentReplica } from './workspace-content-replica.js';
import { WorkspaceContentMetadata, type ContentReplicaStorageAdmission } from './workspace-content-metadata.js';
import type { WorkspaceFileCard } from '@agentopsdeck/shared';
import { WorkspaceFileMetadata } from './workspace-file-metadata.js';
import type { WorkspaceFileCodec } from './workspace-file-codec.js';

const INTERACTION_WRITER_FENCE = `CREATE TRIGGER connector_interaction_writer_compatibility
      BEFORE INSERT ON connector_users
      WHEN agentopsdeck_connector_interaction_writer_epoch() IS NOT 1
      BEGIN
        SELECT RAISE(ABORT, 'Incompatible interaction writer; upgrade the Connector before opening this state');
      END`;

const CONNECTOR_WRITER_FENCE = `CREATE TRIGGER connector_writer_compatibility
      BEFORE INSERT ON connector_users
      WHEN agentopsdeck_connector_writer_epoch() IS NOT 1
      BEGIN
        SELECT RAISE(ABORT, 'Incompatible Connector writer; use a compatible release without restoring stale data');
      END`;

// Installed only on the first SDK-runtime session, not by a disabled runtime
// opening an old database. Older Connector startup always inserts the default
// user: its connection lacks this SQL function and therefore fails closed even
// when the INSERT uses ON CONFLICT DO NOTHING. Preserve the existing fence.
const SDK_WRITER_FENCE = `CREATE TRIGGER connector_sdk_writer_compatibility
      BEFORE INSERT ON connector_users
      WHEN agentopsdeck_connector_sdk_writer_epoch() IS NOT 1
      BEGIN
        SELECT RAISE(ABORT, 'Incompatible SDK-runtime writer; upgrade the Connector before opening this state');
      END`;

// Lazy, additive fence: SDK-capable message-only releases must not recover or
// settle compact controls as ordinary messages. Never replace the prior fence.
const SDK_CONTROL_WRITER_FENCE = `CREATE TRIGGER connector_sdk_control_writer_compatibility
      BEFORE INSERT ON connector_users
      WHEN agentopsdeck_connector_sdk_control_writer_epoch() IS NOT 1
      BEGIN
        SELECT RAISE(ABORT, 'Incompatible SDK-control writer; upgrade the Connector before opening this state');
      END`;

export type ConnectorUser = {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
};

export class ConnectorUserStore {
  /** Worker-local persistence only. No native executor, scheduler or timer is
   * constructed, and the existing owner connection is never exposed over IPC. */
  createAutomationPersistence(authorized: (owner: string, target: AutomationTarget) => boolean) {
    if (!this.runtimeOwnerFile) throw new Error('Automation requires runtime ownership');
    return { store: new AutomationStore(this.db), config: new AutomationConfigurationStore(this.db, authorized) };
  }
  automationOwners(): string[] {
    if (!this.runtimeOwnerFile) throw new Error('Automation requires runtime ownership');
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='automation_rules'").get()) return [];
    const rows = this.db.prepare('SELECT DISTINCT owner FROM automation_rules WHERE revoked=0 ORDER BY owner LIMIT 129').all();
    if (rows.length > 128) throw new Error('Automation owner capacity exceeded');
    return rows.map(row => String(row.owner));
  }
  createCodexAutomation(codex: CodexAutomationRuntime, owner: string, connectionId: string,
    authorized: (target: AutomationTarget) => boolean) {
    if (!this.runtimeOwnerFile) throw new Error('Automation requires runtime ownership');
    return createCodexAutomation(this.db, this.turns, codex, { owner, connectionId, authorized,
      available: () => this.sdkCommandAdmissionOpen });
  }
  createFileBoards(root: string, authorized: (owner: string, sessionKey: string) => boolean) {
    return new ConnectorFileBoards(this.db, root, authorized);
  }
  createWorkspaceFileMetadata<T>(codec: WorkspaceFileCodec<T>, authorized: (owner: string, sessionKey: string) => boolean) {
    if (this.closed) throw new Error('Connector store is closed');
    return new WorkspaceFileMetadata(this.db, authorized, codec);
  }
  createFileCards(root: string, authorized: (owner: string, sessionKey: string) => boolean) {
    return new ConnectorWorkspaceFiles(this.db, root, authorized, cardFileCodec());
  }
  createContentReplicas(files: ConnectorWorkspaceFiles<WorkspaceFileCard>) {
    if (!this.runtimeOwnerFile) throw new Error('Content replicas require runtime ownership');
    return new WorkspaceContentReplica(this.db, files,this.file === ':memory:' ? undefined : this.admitContentReplica);
  }
  /** Same original admission for compatibility facade and fixed worker domain.
   * The worker passes its raw-authority recheck inside the synchronous write. */
  readonly admitContentReplica: ContentReplicaStorageAdmission = (bytes,write) => {
    if (this.closed) throw new Error('Connector store is closed');
    if (this.file === ':memory:') return write();
    return asyncVolumeAdmission.run(dirname(this.file),'durable',bytes,async () => {
      if (this.closed) throw new Error('Connector store is closed');
      return write();
    });
  };
  createWorkspaceContentMetadata(files: WorkspaceFileMetadata<WorkspaceFileCard>) {
    if (!this.runtimeOwnerFile || this.closed) throw new Error('Content replicas require runtime ownership');
    return new WorkspaceContentMetadata(this.db,{codec:files.codec,
      get:(owner,id) => files.owned(owner,id),guard:(owner,key) => files.guard(owner,key)});
  }
  readonly fileIndex: SessionFileIndex;
  readonly tokenUsage: NativeTokenUsageStore;
  readonly sdkAttachments: SdkAttachmentStore;
  readonly nodeId: string;
  readonly commands: CommandReceipts;
  readonly turns: TurnQueue;
  readonly events: ConnectorEventLog;
  readonly executionGrants: ExecutionGrants;
  readonly openClawExecutions: OpenClawExecutions;
  readonly codexExecutions: CodexExecutions;
  readonly codexCreations: CodexCreations;
  readonly hermesJournal: HermesJournal;
  readonly claudeJournal: SdkExecutionJournal;
  readonly claudeTranscript: ClaudeTranscriptStore;
  readonly copilotJournal: SdkExecutionJournal;
  readonly copilotTranscript: CopilotTranscriptStore;
  readonly mirrorOutbox: MirrorOutbox;
  readonly interactions: InteractionStore;
  private closed = false;
  close() { this.closed = true; this.stopTurnStarts(); this.db.close(); }
  storageRecovery() { return connectionRecoverySnapshot(this.db); }
  async storageStats() {
    return { ...await ownedStorageStats(this.file), connection: this.storageRecovery(), reads: { claude: this.claudeTranscript.readStats(), copilot: this.copilotTranscript.readStats() } };
  }
  checkpointStorage(check?: () => void) { return checkpointOwnedWalAsync(this.db, this.file, { available: () => !this.closed, check }); }
  private readonly db: DatabaseSync;
  private readonly ownsNativeRuntime: boolean;
  private turnStartsStopped = false;
  private turnStartsPause: (() => boolean) | undefined;

  /** Worker-internal maintenance boundary on the original connection. Nested
   * interaction retirement retains its original savepoint/participant guards.
   * Neither callbacks nor authority may cross an await inside this transaction. */
  maintenanceTransaction<T>(mutation: boolean, authorize: () => void,
    work: () => T extends PromiseLike<unknown> ? never : T): T {
    return observedTransaction<T>(this.db, 'connector-maintenance-change', (_commit, inspect) => {
      const current = () => {
        this.requireMaintenanceOwner(mutation);
        inspect(authorize());
      };
      current();
      const result = work();
      inspect(result);
      current();
      return result;
    });
  }

  /** Called inside an original domain transaction, never an async authority. */
  requireMaintenanceOwner(mutation = true): void {
    if (this.closed || this.turnStartsStopped || !this.ownsNativeRuntime || mutation && !this.turnStartsPause)
      throw new Error('Maintenance owner is fenced');
  }

  /** Fence-authorized maintenance uses the owning SQLite connection. Never
   * bypass its exclusive runtime lock or expose queued payloads to operators. */
  maintenanceQueueSha256() {
    if (!this.ownsNativeRuntime || !this.turnStartsPause || this.turnStartsStopped) {
      throw new Error('Queue preservation proof requires paused runtime ownership');
    }
    const hash = createHash('sha256');
    hash.update('[');
    let first = true;
    for (const row of this.db.prepare('SELECT * FROM connector_turns ORDER BY sequence').iterate()) {
      if (!first) hash.update(',');
      hash.update(JSON.stringify(row)); first = false;
    }
    return hash.update(']').digest('hex');
  }

  /** Internal runtime composition only. Management stores cannot launch SDK
   * workers; shutdown invalidates this capability before the DB is closed. */
  get runtimeOwnerFile(): string | undefined {
    return this.ownsNativeRuntime && !this.turnStartsStopped ? this.file : undefined;
  }

  /** New local SDK commands must respect the global maintenance barrier too,
   * not only the runtime driver's own pause. Existing ACK/settlement is separate. */
  get sdkCommandAdmissionOpen(): boolean {
    return !!this.runtimeOwnerFile && !this.turnStartsPause;
  }

  pauseTurnStarts() {
    if (this.turnStartsPause) return this.turnStartsPause;
    const resume = () => {
      if (this.turnStartsStopped || this.turnStartsPause !== resume) return false;
      this.turnStartsPause = undefined;
      return true;
    };
    this.turnStartsPause = resume;
    return resume;
  }

  // Shutdown-only latch on this runtime owner, not a persistent maintenance
  // mode. Keep admission and settlement available to already entered handlers.
  stopTurnStarts() { this.turnStartsStopped = true; }

  constructor(private readonly file: string, issuerAuthorized: (tokenId: string, action: ExecutionAction) => boolean = () => false,
    options: { runtimeOwner?: boolean } = {}) {
    this.ownsNativeRuntime = options.runtimeOwner === true;
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = startupDatabaseOwners.open(file);
    try {
      // Set permissions before the first SQL access writes data. Do not open/close
      // an extra filesystem fd: POSIX close can release another handle's locks.
      if (file !== ':memory:') chmodSync(file, 0o600);
      if (options.runtimeOwner) {
        // One runtime owns recovery and native dispatch until this connection
        // closes. No expiring lease: a paused process must not lose ownership.
        // Online readers use this connection through the Connector API.
        this.db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
      }
      this.db.function('agentopsdeck_connector_writer_epoch', { deterministic: true }, () => 1);
      this.db.function('agentopsdeck_connector_sdk_writer_epoch', { deterministic: true }, () => 1);
      this.db.function('agentopsdeck_connector_sdk_control_writer_epoch', { deterministic: true }, () => 1);
      this.db.function('agentopsdeck_connector_interaction_writer_epoch', { deterministic: true }, () => 1);
      registerNativeHistoryWriter(this.db);
      registerNativeResumeWriter(this.db);
      this.sdkAttachments = new SdkAttachmentStore(this.db);
      this.migrate();
      configureOwnedWal(this.db);
      this.nodeId = loadNodeIdentity(this.db);
      this.interactions = new InteractionStore(this.db, 2048, () => {
        if (!this.runtimeOwnerFile || this.turnStartsPause) throw new Error('Interaction admission requires an available runtime owner');
        this.requireInteractionWriter(true);
      }, () => {
        if (!this.runtimeOwnerFile) throw new Error('Interaction settlement requires runtime ownership');
        this.requireInteractionWriter(true);
      });
      this.commands = new CommandReceipts(this.db, undefined, undefined, (db, target) =>
        !this.turns.hasCommand(target.runtime, target.id) && this.mirrorOutbox.reclaimCompletedInTransaction(db, target),
        undefined,
        undefined, file === ':memory:' ? undefined : (bytes, write) => asyncVolumeAdmission.run(dirname(file), 'durable', bytes, async () => {
          if (this.closed) throw new Error('Connector store is closed');
          return write();
        }));
      this.events = new ConnectorEventLog(this.db);
      this.mirrorOutbox = new MirrorOutbox(this.db, undefined, undefined, this.commands, this.events);
      const sessionAvailable = (sessionKey: string) => !this.commands.sessionDeletion(sessionKey);
      const sessionStartAvailable = (sessionKey: string) => !this.turnStartsStopped && !this.turnStartsPause
        && sessionAvailable(sessionKey) && !this.commands.sessionSettingsPending(sessionKey)
        && !this.interactions.hasUnresolvedKey(sessionKey);
      this.turns = new TurnQueue(this.db, undefined, undefined, sessionAvailable, sessionStartAvailable,
        undefined,
        file === ':memory:' ? undefined : (bytes, write) => asyncVolumeAdmission.run(dirname(file), 'durable', bytes, async () => {
          if (this.closed) throw new Error('Connector store is closed');
          return write();
        }));
      this.executionGrants = new ExecutionGrants(this.db, issuerAuthorized);
      this.openClawExecutions = new OpenClawExecutions(this.db, undefined, undefined, undefined, this.events, sessionStartAvailable, this.mirrorOutbox, this.commands);
      this.codexExecutions = new CodexExecutions(this.db, this.events, undefined, undefined, sessionStartAvailable, this.commands,
        sessionKey => this.commands.sessionDeletion(sessionKey) === 'accepted');
      this.codexCreations = new CodexCreations(this.db, this.codexExecutions);
      this.hermesJournal = new HermesJournal(this.db);
      const compactPolicy = { available: () => this.sdkCommandAdmissionOpen,
        beforeBegin: () => this.requireSdkControlWriter(true) };
      this.tokenUsage = new NativeTokenUsageStore(this.db, Date.now,
        undefined,
        file === ':memory:' ? undefined : (bytes, write) => asyncVolumeAdmission.run(dirname(file), 'durable', bytes, async () => {
          if (this.closed) throw new Error('Connector store is closed');
          return write();
        }));
      this.claudeJournal = new SdkExecutionJournal(this.db, 'claude-code', undefined, () => this.requireSdkWriter(true), compactPolicy,
        key => !this.interactions.hasUnresolvedKey(key), this.tokenUsage);
      this.copilotJournal = new SdkExecutionJournal(this.db, 'ghcp', undefined, () => this.requireSdkWriter(true), compactPolicy,
        key => !this.interactions.hasUnresolvedKey(key), this.tokenUsage);
      this.fileIndex = new SessionFileIndex(this.db);
      this.claudeTranscript = new ClaudeTranscriptStore(this.db);
      this.copilotTranscript = new CopilotTranscriptStore(this.db);
      // Only the exclusive runtime owner may recover. Management-only store
      // opens must never freeze an execution owned by another live process.
      if (options.runtimeOwner) {
        this.commands.recoverSettingsPrewrites();
        this.interactions.recover(Date.now());
        this.claudeJournal.recover(this.turns);
        this.copilotJournal.recover(this.turns);
        this.reconcileEndedInteractions();
      }
    } catch (error) {
      this.closed = true;
      this.stopTurnStarts();
      startupDatabaseOwners.abandon(this.db);
      throw error;
    }
  }

  /** Restart alone is NOT termination evidence. Only a durable exact native
   * run with verified settlement may retire a stranded interaction gate. This
   * preserves unknown delivery/audit and never resumes a goal or sends input. */
  reconcileEndedInteractions(key?: string): string[] {
    if (!this.runtimeOwnerFile) return [];
    const changed = new Set<string>();
    for (const scope of this.interactions.unresolvedScopes(key)) {
      if (scope.nodeId !== this.nodeId) continue;
      let settled = false;
      if (scope.sessionKey.startsWith('codex:')) {
        const execution = this.codexExecutions.get(scope.sessionKey);
        settled = execution?.runId === scope.runId && this.codexExecutions.canStart(scope.sessionKey);
      } else {
        const journal = scope.sessionKey.startsWith('claude-code:') ? this.claudeJournal
          : scope.sessionKey.startsWith('ghcp:') ? this.copilotJournal : undefined;
        const execution = journal?.current(scope.sessionKey);
        settled = !!execution && execution.id === scope.runId
          && ['completed', 'failed', 'interrupted'].includes(execution.phase)
          && journal?.session(scope.sessionKey)?.nativeState === 'ready';
      }
      if (settled && this.interactions.retireRun(scope, Date.now())) changed.add(scope.sessionKey);
    }
    return [...changed];
  }

  // Called by receipt admission under this database's BEGIN IMMEDIATE.
  // Never silently discard queued/blocked messages or uncertain native work.
  canDeleteSession(sessionKey: string) {
    return !this.interactions.hasUnresolvedKey(sessionKey) && !this.commands.sessionSettingsPending(sessionKey)
      && !this.mirrorOutbox.hasUnresolved(sessionKey)
      && !this.turns.hasPending('openclaw', sessionKey) && !this.turns.hasPending('codex', sessionKey)
      && !this.turns.hasPending('hermes', sessionKey) && this.hermesJournal.canStart(sessionKey)
      && !this.turns.hasPending('claude-code', sessionKey) && !this.claudeJournal.hasUnresolved(sessionKey)
      && !this.turns.hasPending('ghcp', sessionKey) && !this.copilotJournal.hasUnresolved(sessionKey)
      && this.openClawExecutions.canDelete(sessionKey) && this.codexExecutions.canStart(sessionKey);
  }

  // Reciprocal admission with TurnQueue.start, under the same SQLite writer
  // transaction. Queue admission/edit/cancel remain available during settings.
  // This orders managed dispatch only; it does not prove native quiescence.
  canChangeSettings(sessionKey: string) {
    if (this.interactions.hasUnresolvedKey(sessionKey)) return false;
    if (sessionKey.startsWith('claude-code:') && this.turns.hasPending('claude-code', sessionKey)
      || sessionKey.startsWith('ghcp:') && this.turns.hasPending('ghcp', sessionKey)) return false;
    return !this.turns.hasDispatchPending('openclaw', sessionKey) && !this.turns.hasDispatchPending('codex', sessionKey)
      && !this.turns.hasDispatchPending('hermes', sessionKey) && this.hermesJournal.canStart(sessionKey)
      && !this.turns.hasDispatchPending('claude-code', sessionKey) && !this.claudeJournal.hasUnresolved(sessionKey)
      && !this.turns.hasDispatchPending('ghcp', sessionKey) && !this.copilotJournal.hasUnresolved(sessionKey)
      && this.openClawExecutions.canChangeSettings(sessionKey) && this.codexExecutions.canChangeSettings(sessionKey);
  }

  listUsers() {
    const rows = this.db.prepare(`
      SELECT id, label, created_at, updated_at
      FROM connector_users
      ORDER BY id = ? DESC, label COLLATE NOCASE ASC
    `).all(DEFAULT_CONNECTOR_USER_ID) as DbConnectorUserRow[];
    return rows.map(rowToConnectorUser);
  }

  getUser(id: string) {
    const row = this.db.prepare(`
      SELECT id, label, created_at, updated_at
      FROM connector_users
      WHERE id = ?
    `).get(id) as DbConnectorUserRow | undefined;
    return row ? rowToConnectorUser(row) : undefined;
  }

  createUser(label: string) {
    const now = Date.now();
    const user: ConnectorUser = {
      id: `conn_user_${randomUUID()}`,
      label: normalizeConnectorUserLabel(label),
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO connector_users (id, label, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(user.id, user.label, user.createdAt, user.updatedAt);
    return user;
  }

  updateUser(id: string, label: string) {
    const existing = this.getUser(id);
    if (!existing) return undefined;
    const normalizedLabel = normalizeConnectorUserLabel(label);
    const updatedAt = Date.now();
    this.db.prepare('UPDATE connector_users SET label = ?, updated_at = ? WHERE id = ?').run(normalizedLabel, updatedAt, id);
    return this.getUser(id) ?? { ...existing, label: normalizedLabel, updatedAt };
  }

  private migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS connector_users (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    const fence = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name = 'connector_writer_compatibility'`).get() as { sql: string } | undefined;
    if (fence && fence.sql.replace(/\s+/g, ' ').trim() !== CONNECTOR_WRITER_FENCE.replace(/\s+/g, ' ').trim()) {
      throw new Error('Invalid Connector writer compatibility fence');
    }
    if (!fence) this.db.exec(CONNECTOR_WRITER_FENCE);
    this.requireSdkWriter(false);
    this.requireSdkControlWriter(false);
    this.requireInteractionWriter(false);

    const now = Date.now();
    this.db.prepare(`
      INSERT INTO connector_users (id, label, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(DEFAULT_CONNECTOR_USER_ID, 'Default connector account', now, now);
  }

  private requireSdkWriter(install: boolean) {
    const fence = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name = 'connector_sdk_writer_compatibility'`).get() as { sql: string } | undefined;
    if (fence && fence.sql.replace(/\s+/g, ' ').trim() !== SDK_WRITER_FENCE.replace(/\s+/g, ' ').trim()) {
      throw new Error('Invalid SDK-runtime writer compatibility fence');
    }
    if (install && !fence) this.db.exec(SDK_WRITER_FENCE);
  }

  private requireInteractionWriter(install: boolean) {
    const fence = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name = 'connector_interaction_writer_compatibility'`).get() as { sql: string } | undefined;
    if (fence && fence.sql.replace(/\s+/g, ' ').trim() !== INTERACTION_WRITER_FENCE.replace(/\s+/g, ' ').trim()) {
      throw new Error('Invalid interaction writer compatibility fence');
    }
    if (install && !fence) this.db.exec(INTERACTION_WRITER_FENCE);
  }

  private requireSdkControlWriter(install: boolean) {
    const fence = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger'
      AND name = 'connector_sdk_control_writer_compatibility'`).get() as { sql: string } | undefined;
    if (fence && fence.sql.replace(/\s+/g, ' ').trim() !== SDK_CONTROL_WRITER_FENCE.replace(/\s+/g, ' ').trim()) {
      throw new Error('Invalid SDK-control writer compatibility fence');
    }
    if (install && !fence) this.db.exec(SDK_CONTROL_WRITER_FENCE);
  }
}

const DEFAULT_CONNECTOR_USER_ID = 'default';

type DbConnectorUserRow = {
  id: string;
  label: string;
  created_at: number;
  updated_at: number;
};

function rowToConnectorUser(row: DbConnectorUserRow): ConnectorUser {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

import { SessionFileIndex } from '../messages/session-file-index.js';
import { ConnectorFileBoards, ConnectorWorkspaceFiles } from './workspace-board-files.js';
import { cardFileCodec } from './workspace-file-card-format.js';
