import { executeHubFileBinding, type HubFileBindingCommand, type HubFileBindingResult } from './member-file-binding-domain.js';
import { publicFileBoardBinding, type WorkspaceBoardFiles } from './workspace-board-files.js';
import { executeHubNativeFile, type HubNativeFileCommand } from './member-native-file-domain.js';
import { executeHubNotebookMachine, type HubNotebookMachineCommand } from './member-notebook-machine-domain.js';
import { executeHubWeixin, weixinBindingCheckpoint, type HubWeixinCommand, type HubWeixinResult, type WeixinAuthority } from './member-weixin-domain.js';
import { WeixinError } from './weixin-transport.js';
import { weixinBackgroundStop } from './weixin-background-domain.js';
import { executionCommandAccess, executeHubExecutionCommand, type HubExecutionCommand } from './member-execution-command-domain.js';
import { executeHubLifecycleCommand, type HubLifecycleCommand } from './member-lifecycle-domain.js';
import { executeHubMaintenanceCommand, type HubMaintenanceCommand } from './member-maintenance-domain.js';
import { readHubUsageCatalog } from './member-usage-manifest-domain.js';
import { executeHubBoardBinding, type HubBoardBindingCommand } from './member-board-binding-domain.js';
import { executeHubTaskSession, type HubTaskSessionCommand } from './member-task-session-domain.js';
import { executeHubDelegation, type HubDelegationCommand } from './member-delegation-domain.js';
import { executeHubContentDocument, type HubContentDocumentCommand } from './member-content-document-domain.js';
import type { UsageSelection } from './usage-manifests.js';
import { readHubEventReplay, type HubEventReplayCommand } from './member-event-replay-domain.js';
import { executeHubSharedRead, type HubSharedReadCommand } from './member-shared-read-domain.js';
import { executeHubSharedCreation, type HubSharedCreationCommand } from './member-shared-creation-domain.js';
import { executeHubIssuerManagement, type HubIssuerManagementCommand } from './member-issuer-management-domain.js';
import { type HubNotebookCommand, type HubNotebookResult } from './member-notebook-domain.js';
import { readNotebookSnapshotInTransaction } from './notebook-snapshot-read.js';
import { sessionNotebookAuthorityCurrent, selectSessionNotebookAuthority } from './member-session-notebook-authority.js';
import { executeHubNotebookControl, type HubNotebookControlCommand, type HubNotebookControlResult } from './member-notebook-control-domain.js';
import type { NotebookCapabilities } from './notebook-capabilities.js';
import { SessionNotebooks } from './session-notebooks.js';
import { NotebookMoveConflict } from './notebook-operations.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { executeHubQuickChatCleanupCommand, type HubQuickChatCleanupCommand } from './member-quick-chat-cleanup-domain.js';
import { executeHubGuidanceCommand, type HubGuidanceCommand } from './member-guidance-domain.js';
import { executeHubQuickChatStateCommand, type HubQuickChatStateCommand } from './member-quick-chat-state-domain.js';
import { executeHubQuickChatExecutionCommand, type HubQuickChatExecutionCommand } from './member-quick-chat-execution-domain.js';
import { executeHubCreationDiscoveryCommand, type HubCreationDiscoveryCommand } from './member-creation-discovery-domain.js';
import { executeHubSharedDirectoryCommand, type HubSharedDirectoryCommand } from './member-shared-directory-domain.js';
import { executeHubSessionCollaboratorCommand, type HubSessionCollaboratorCommand } from './member-session-collaborators-domain.js';
import { executeHubSessionSharingCommand, type HubSessionSharingCommand } from './member-session-sharing-domain.js';
import { executeHubOwnedSessionSharingCommand, type HubOwnedSessionSharingCommand } from './member-owned-session-sharing-domain.js';
import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { accessKeyFromRequest } from '../auth/access-key.js';
import type { WeixinStore } from './weixin-store.js';
import type { WeixinRequestBinding } from './weixin-bridge.js';
import { sessionTokenFromRequest } from '../auth/passkeys.js';
import { synchronousAuthorizationCall } from '../auth/synchronous-authorization.js';
import { AuthAuditLog, type AuthRequestFingerprint } from '../auth/security.js';
import type { WorkspacePreferencesStore } from './workspace-preferences.js';
import type { WorkspaceBoards } from './workspace-boards.js';
import type { WorkspaceCards } from './workspace-cards.js';
import type { WorkspaceDrawings } from './workspace-drawings.js';
import type { WorkspaceNativeDrawio } from './workspace-native-drawio.js';
import { executeHubReport, type HubReportCommand, type HubReportResult } from './member-report-domain.js';
import { executeHubProjection, type HubProjectionCommand, type HubProjectionResult } from './member-projection-domain.js';
import type { WorkspaceCardFileProjection } from './workspace-card-files.js';
import { executeHubConfiguration, type HubConfigurationCommand, type HubConfigurationResult } from './member-configuration-domain.js';
import type { WorkspaceCardConfigurations } from './workspace-card-configurations.js';
import { executeHubVisual, type HubVisualCommand, type HubVisualResult } from './member-visual-domain.js';
import type { HubBoardCommand, HubBoardResult } from './member-board-domain.js';
import type { HubBoardCapabilityCommand, HubBoardCapabilityResult, HubBoardCapabilityEvent } from './member-board-capability-domain.js';
import type { WorkspaceBoardCapabilities } from './workspace-board-capabilities.js';
import type { HubBoardMachineCommand, HubBoardMachineResult } from './member-board-machine-domain.js';
import type { WorkspacePreferences } from '@agentopsdeck/shared';
import type { HubAuditOptions } from './member-audit-domain.js';
import type { WorkspaceLayouts, LayoutKind, LayoutDocument } from './workspace-layouts.js';
import type { HubStore } from './hub-store.js';
import type { HubSessionPreferenceChange } from './member-session-preference-domain.js';
import { decodeHubSessionId } from './session-id.js';
import { readHubSessionState, type HubSessionStateCommand } from './session-state-domain.js';
import { readHubConnectionDirectory, type HubConnectionDirectoryCommand } from './member-connection-directory-domain.js';
import { readHubUserDirectory } from './member-user-directory-domain.js';
import { readHubConnectionSnapshot } from './member-connection-domain.js';
import type { HubUserChange } from './member-user-domain.js';
import { initializeHubUserAccess, hubUserEnabled, readHubUserAccess, type HubUserAccessCommand } from './user-access.js';
import { executeHubRoleCommand, type HubRoleCommand } from './member-role-domain.js';
import { readHubAccessDirectory } from './member-access-directory-domain.js';
import { executeHubMembershipCommand, type HubMembershipCommand } from './member-membership-domain.js';
import { executeHubGrantCommand, type HubGrantCommand } from './member-grant-domain.js';
import { executeHubReceivedGrantCommand, type HubReceivedGrantCommand } from './member-received-grants-domain.js';
import { readHubConnectionTarget, executeHubConnectionChange, type HubConnectionChange } from './member-connection-change-domain.js';
import { readHubConnectorAccess, type HubConnectorAccessCommand } from './member-connector-access-domain.js';
import { executeHubOwnerControl, type HubOwnerControlCommand } from './member-owner-control-domain.js';

export type HubPrincipal = { userId: string; admin: boolean };
/** Fixed in-owner operations. Request credentials and expected scope are
 * rechecked in the original SQL savepoint; target IDs are not grants. */
export type HubAdministratorKeyAction =
  | { action: 'list'; userId: string }
  | { action: 'issue'; userId: string; fingerprint?: Partial<AuthRequestFingerprint> }
  | { action: 'revoke'; userId: string; keyId: string; fingerprint?: Partial<AuthRequestFingerprint> };
declare module 'hono' {
  interface ContextVariableMap { hubPrincipal: HubPrincipal; hubAuthorize: () => HubPrincipal }
}
export const LEGACY_HUB_PRINCIPAL: HubPrincipal = { userId: 'default', admin: true };
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Human login credentials are separate from node credentials. Only their
// hashes enter SQLite; revoking a key invalidates every session derived from it.
export class HubIdentities {
  readonly audit: AuthAuditLog;
  private readonly namespace: string;
  private readonly weixinRequests = new WeakMap<Request, { store: WeixinStore; binding: Readonly<WeixinRequestBinding> }>();
  constructor(private readonly db: DatabaseSync, private readonly memberLoginsConfigured = false,
    private readonly legacyCommandAuthority: (request: Request) => boolean = () => false) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_roles (user_id TEXT PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('member', 'admin')), version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_login_keys (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        secret_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_login_sessions (
        secret_hash TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES hub_login_keys(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_key_usage (
        key_id TEXT PRIMARY KEY REFERENCES hub_login_keys(id) ON DELETE CASCADE,
        last_login_at INTEGER, last_used_at INTEGER, last_active_at INTEGER, login_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS hub_user_usage (
        user_id TEXT PRIMARY KEY REFERENCES users(id), last_login_at INTEGER, last_active_at INTEGER
      );
    `);
    initializeHubUserAccess(db);
    // Persisted insert/update fences also protect older writers after migration.
    db.exec(`CREATE TRIGGER IF NOT EXISTS hub_disabled_user_key_insert BEFORE INSERT ON hub_login_keys
      WHEN EXISTS(SELECT 1 FROM hub_user_access WHERE user_id = NEW.user_id AND status = 'disabled')
      BEGIN SELECT RAISE(ABORT, 'User disabled'); END;
      CREATE TRIGGER IF NOT EXISTS hub_disabled_user_key_update BEFORE UPDATE ON hub_login_keys
      WHEN EXISTS(SELECT 1 FROM hub_user_access WHERE user_id = NEW.user_id AND status = 'disabled')
      BEGIN SELECT RAISE(ABORT, 'User disabled'); END;`);
    this.audit = new AuthAuditLog(10_000, db);
    db.prepare('INSERT OR IGNORE INTO hub_identity VALUES (1, ?)').run(randomUUID());
    this.namespace = (db.prepare('SELECT id FROM hub_identity WHERE singleton = 1').get() as { id: string }).id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(this.namespace)) throw new Error('Invalid Hub identity');
  }

  // Public correlation namespace, not a credential or authorization grant.
  get hubId() { return this.namespace; }

  // Include the installation so replacing a Hub does not reuse browser records.
  recoveryScope(principal: HubPrincipal) {
    const version = (this.db.prepare('SELECT version FROM hub_user_access WHERE user_id = ?').get(principal.userId) as { version: number } | undefined)?.version ?? 0;
    // Keep untouched legacy scopes stable, but never reuse one after disable/enable.
    return hash(JSON.stringify([this.namespace, principal.userId, principal.admin, ...(version ? [version] : [])]));
  }

  issueKey(userId: string, context: Partial<AuthRequestFingerprint> & { actorUserId?: string } = {}) {
    if (!this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) throw new Error('User not found');
    if (!hubUserEnabled(this.db, userId)) throw new Error('User disabled');
    if ((this.db.prepare('SELECT count(*) AS n FROM hub_login_keys WHERE user_id = ?').get(userId) as { n: number }).n >= 64) throw new Error('Login key limit reached');
    const token = `hub_key_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    this.atomic(() => {
      this.db.prepare('INSERT INTO hub_login_keys VALUES (?, ?, ?, ?)').run(id, userId, hash(token), Date.now());
      this.audit.append({ ...context, event: 'member_key_issued', outcome: 'success', userId, keyId: id });
    });
    return { id, token };
  }

  hasKeys() { return Boolean(this.db.prepare('SELECT 1 FROM hub_login_keys LIMIT 1').get()); }

  listKeys(userId: string) {
    return this.db.prepare(`SELECT keys.id, keys.created_at AS createdAt, usage.last_login_at AS lastLoginAt,
      usage.last_used_at AS lastUsedAt, usage.last_active_at AS lastActiveAt, COALESCE(usage.login_count, 0) AS loginCount
      FROM hub_login_keys keys LEFT JOIN hub_key_usage usage ON usage.key_id = keys.id WHERE keys.user_id = ? ORDER BY keys.created_at`).all(userId);
  }

  revokeKey(userId: string, id: string, context: Partial<AuthRequestFingerprint> & { actorUserId?: string } = {}) {
    return this.atomic(() => {
      const removed = this.db.prepare('DELETE FROM hub_login_keys WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
      if (removed) this.audit.append({ ...context, event: 'member_key_revoked', outcome: 'success', userId, keyId: id });
      return removed;
    });
  }

  administratorKeyCommand(request: Request, expectedScope: string, command: HubAdministratorKeyAction) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      // No callback or observed grant crosses the worker boundary. Recheck
      // original member or trusted owner-bound legacy authority in this savepoint.
      const principal = this.commandPrincipal(request);
      if (!principal?.admin || this.recoveryScope(principal) !== expectedScope) return null;
      if (command.action === 'list') return { keys: this.listKeys(command.userId) };
      const context = { ...command.fingerprint, actorUserId: principal.userId };
      if (command.action === 'issue') {
        if (!this.memberLoginsConfigured) return { error: 'configuration_required' as const };
        // Original predictable route refusals retain their public HTTP shape.
        // Storage/audit failures still escape: uncertain effects are not retried.
        if (!this.db.prepare('SELECT id FROM users WHERE id = ?').get(command.userId) || !hubUserEnabled(this.db, command.userId)
          || (this.db.prepare('SELECT count(*) AS n FROM hub_login_keys WHERE user_id = ?').get(command.userId) as { n: number }).n >= 64)
          return { error: 'cannot_issue' as const };
        return this.issueKey(command.userId, context);
      }
      return { ok: this.revokeKey(command.userId, command.keyId, context) };
      // Self-revocation still commits exactly as before. Response delivery must
      // perform a fresh async request check; denial never undoes/replays a write.
    });
  }

  /** Audit reads prune. Persisted authority and retention therefore belong to
   * one original savepoint. Never prune first then deny delivery afterwards. */
  administratorAuditCommand(request: Request, expectedScope: string,
    command: { action: 'page'; options: HubAuditOptions } | { action: 'list'; limit: number }) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal?.admin || this.recoveryScope(principal) !== expectedScope) return null;
      return command.action === 'page' ? this.audit.page(command.options) : this.audit.list(command.limit);
    });
  }

  /** Credentials, role, scope and bounded display reads share the original
   * connection/savepoint. Never a supplied account ID or wire-supplied grant. */
  memberSessionStateCommand(request: Request, expectedScope: string, command: HubSessionStateCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return readHubSessionState(this.db, principal, command);
    });
  }
  memberUsageManifestAuthority(request: Request, expectedScope: string, owner: HubStore, selection?: UsageSelection) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const actor = this.commandPrincipal(request);
      if (!actor || this.recoveryScope(actor) !== expectedScope) return null;
      return { actor, facts: selection ? readHubUsageCatalog(owner, this.db, actor, selection) : undefined };
    });
  }
  memberContentDocumentCommand(request: Request, expectedScope: string, owner: HubStore, command: HubContentDocumentCommand) {
    const fresh = () => {
      const actor = this.commandPrincipal(request);
      return actor && this.recoveryScope(actor) === expectedScope ? actor : undefined;
    };
    const actor = fresh();
    return actor ? executeHubContentDocument(owner,actor,fresh,command) : null;
  }
  memberDelegationCommand(request: Request, expectedScope: string, owner: HubStore, command: HubDelegationCommand) {
    const fresh = () => {
      const actor = this.commandPrincipal(request);
      return actor && this.recoveryScope(actor) === expectedScope ? actor : undefined;
    };
    const actor = fresh();
    return actor ? executeHubDelegation(this.db,owner,actor,fresh,command) : null;
  }
  memberBoardBindingCommand(request: Request, expectedScope: string, owner: HubStore, command: HubBoardBindingCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const actor = this.commandPrincipal(request);
      if (!actor || this.recoveryScope(actor) !== expectedScope) return null;
      return executeHubBoardBinding(owner,actor,command);
    });
  }
  memberTaskSessionCommand(request: Request, expectedScope: string, owner: HubStore, command: HubTaskSessionCommand) {
    const fresh = () => {
      const actor = this.commandPrincipal(request);
      return actor && this.recoveryScope(actor) === expectedScope ? actor : undefined;
    };
    const actor = fresh();
    // The workflow owns the real transaction and rechecks this exact proof
    // inside it. An outer identity savepoint would invalidate dispatch safety.
    return actor ? executeHubTaskSession(owner,actor,fresh,command) : null;
  }
  memberNativeFileCommand(request: Request, expectedScope: string, owner: HubStore, command: HubNativeFileCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const actor = this.commandPrincipal(request);
      if (!actor || this.recoveryScope(actor) !== expectedScope) return null;
      return executeHubNativeFile(owner, actor, command);
    });
  }
  notebookMachineCommand(owner: HubStore, command: HubNotebookMachineCommand) {
    return observedSavepoint(this.db, 'hub-notebook-machine', () => executeHubNotebookMachine(owner, command));
  }
  memberWeixinCommand(request: Request, expectedScope: string, owner: HubStore, command: HubWeixinCommand): HubWeixinResult {
    const fresh = (): WeixinAuthority | undefined => {
      const actor = this.commandPrincipal(request);
      if (!actor || this.recoveryScope(actor) !== expectedScope) return;
      const key = this.requestIdentity(request), personalKey = key?.userId === actor.userId;
      const administrator = actor.userId === 'default' && actor.admin
        && synchronousAuthorizationCall(owner.weixinAdministratorAuthority, [request])
        ? owner.weixinAdministratorKeyId : undefined;
      const row = owner.weixin.get(actor.userId);
      if (row && owner.weixin.principal(row)?.admin && !actor.admin) return;
      const keyId = personalKey ? key.keyId : administrator;
      return { user: actor.userId, personalKey, administratorKey: !!administrator, ...(keyId === undefined ? {} : {keyId}) };
    };
    const rollback = weixinBindingCheckpoint(owner);
    try { return observedSavepoint(this.db, 'hub-identity-check', () => executeHubWeixin(owner, fresh, command)); }
    catch (error) {
      rollback();
      if (error instanceof WeixinError) return { error: error.code };
      throw error;
    }
  }
  memberConnectionDirectoryCommand(request: Request, expectedScope: string, command: HubConnectionDirectoryCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return readHubConnectionDirectory(this.db, principal, command);
    });
  }
  memberUserDirectoryCommand(request: Request, expectedScope: string) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return readHubUserDirectory(this.db, principal);
    });
  }
  memberConnectionSnapshotCommand(request: Request, expectedScope: string) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return readHubConnectionSnapshot(this.db, principal);
    });
  }

  /** Owner-scoped member policy, not the administrator-only /users policy.
   * Fresh credentials, scope, durable target version and all nested encrypted
   * credential/audit effects remain inside the same original savepoint. */
  memberConnectionTargetCommand(request: Request, expectedScope: string, owner: HubStore, id: string) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return readHubConnectionTarget(owner, principal.userId, id);
    });
  }
  memberConnectorAccessCommand(request: Request, expectedScope: string, owner: HubStore, command: HubConnectorAccessCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return readHubConnectorAccess(owner, principal, command);
    });
  }
  memberSharedDirectoryCommand(request: Request, expectedScope: string, owner: HubStore, command: HubSharedDirectoryCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubSharedDirectoryCommand(this.db, owner, principal, command);
    });
  }
  memberOwnerControlCommand(request: Request, expectedScope: string, owner: HubStore,
    command: Exclude<HubOwnerControlCommand, { action: 'claim' | 'claimDigest' }>) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      if (!this.weixinOwnerControlAllowed(request, owner, command)) return {error:403 as const};
      return executeHubOwnerControl(owner, principal, command);
    });
  }
  weixinOwnerControlAllowed(request: Request, owner: HubStore, command: HubOwnerControlCommand) {
    const reference = this.weixinRequests.get(request);
    return !reference || weixinBackgroundStop(owner, reference.binding, command.target.connectionId, command);
  }
  memberExecutionCommandAccess(request: Request, expectedScope: string, owner: HubStore, command: HubExecutionCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executionCommandAccess(owner, principal, command);
    });
  }
  memberExecutionCommand(request: Request, expectedScope: string, owner: HubStore,
    command: Exclude<HubExecutionCommand, { action: 'claim' | 'queueClaim' }>) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubExecutionCommand(owner, principal, command);
    });
  }
  memberMaintenanceCommand(request: Request, expectedScope: string, owner: HubStore,
    command: Exclude<HubMaintenanceCommand, { action: 'claim' }>) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubMaintenanceCommand(owner, principal, command);
    });
  }
  memberIssuerManagementCommand(request: Request, expectedScope: string, owner: HubStore, command: HubIssuerManagementCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubIssuerManagement(owner, principal, command);
    });
  }
  memberSharedCreationCommand(request: Request, expectedScope: string, owner: HubStore,
    command: Exclude<HubSharedCreationCommand, { action: 'claim' }>) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubSharedCreation(owner, principal, command);
    });
  }
  memberLifecycleCommand(request: Request, expectedScope: string, owner: HubStore,
    command: Exclude<HubLifecycleCommand, { action: 'claim' }>) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubLifecycleCommand(owner, principal, command);
    });
  }
  memberConnectionChangeCommand(request: Request, expectedScope: string, owner: HubStore, change: HubConnectionChange) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubConnectionChange(owner, principal.userId, change);
    });
  }

  memberAccessDirectoryCommand(request: Request, expectedScope: string, owner: HubStore) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return readHubAccessDirectory(this.db, owner, principal, expectedScope);
    });
  }

  memberMembershipCommand(request: Request, expectedScope: string, owner: HubStore, command: HubMembershipCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubMembershipCommand(this.db, owner, principal, command);
    });
  }

  memberOwnedSessionSharingCommand(request: Request, expectedScope: string, owner: HubStore, command: HubOwnedSessionSharingCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubOwnedSessionSharingCommand(this.db, owner, principal, command);
    });
  }

  memberSessionSharingCommand(request: Request, expectedScope: string, owner: HubStore, command: HubSessionSharingCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubSessionSharingCommand(this.db, owner, principal, command);
    });
  }

  memberSessionCollaboratorCommand(request: Request, expectedScope: string, owner: HubStore, command: HubSessionCollaboratorCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubSessionCollaboratorCommand(this.db, owner, principal, command);
    });
  }

  memberCreationDiscoveryCommand(request: Request, expectedScope: string, owner: HubStore, command: HubCreationDiscoveryCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubCreationDiscoveryCommand(this.db,owner,principal,command);
    });
  }

  memberReceivedGrantCommand(request: Request, expectedScope: string, owner: HubStore, command: HubReceivedGrantCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubReceivedGrantCommand(this.db, owner, principal, command);
    });
  }

  memberGrantCommand(request: Request, expectedScope: string, owner: HubStore, command: HubGrantCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubGrantCommand(this.db, owner, principal, command);
    });
  }

  /** Original role, grant invalidation and audit share fresh administrator
   * authority on the complete owner's connection. No transported admin bit. */
  administratorRoleCommand(request: Request, expectedScope: string, owner: HubStore, command: HubRoleCommand) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal?.admin || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubRoleCommand(owner, principal, command);
    });
  }

  /** Existing /users mutation policy requires administrator authority. Legacy
   * callback authority stays with the legacy caller, never an RPC bit. */
  administratorUserCommand(request: Request, expectedScope: string, owner: HubStore, change: HubUserChange) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal?.admin || this.recoveryScope(principal) !== expectedScope) return null;
      if (change.action === 'accessRead' || change.action === 'accessChange') return this.userAccessCommand(principal, change);
      const user = change.action === 'create' ? owner.createUser(change.label) : owner.updateUser(change.userId, change.label);
      return user ? { user } : { error: 'missing' as const };
    });
  }

  /** Only called inside the original administrator savepoint. Disabling the
   * human does not disable their Connector or claim to stop downstream tools. */
  private userAccessCommand(principal: HubPrincipal, change: HubUserAccessCommand) {
    const current = readHubUserAccess(this.db, change.userId);
    if (!current) return { error: 'missing' as const };
    if (change.action === 'accessRead') return { access: current };
    if (current.version !== change.expectedVersion) return { error: 'conflict' as const };
    if (change.userId === 'default' || change.userId === principal.userId) return { error: 'protected' as const };
    if (current.status === change.status) return { access: current };
    // A legacy administrator cannot remove the last keyed human administrator.
    if (change.status === 'disabled' && this.isAdministrator(change.userId)
      && !this.db.prepare(`SELECT 1 FROM hub_roles r JOIN hub_login_keys k ON k.user_id = r.user_id
        WHERE r.role = 'admin' AND r.user_id != ? AND NOT EXISTS(
          SELECT 1 FROM hub_user_access a WHERE a.user_id = r.user_id AND a.status = 'disabled') LIMIT 1`).get(change.userId)) {
      return { error: 'protected' as const };
    }
    const version = current.version + 1;
    this.db.prepare(`INSERT INTO hub_user_access VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, version = excluded.version`)
      .run(change.userId, change.status, version);
    if (change.status === 'disabled') {
      // FK cascade removes every Cookie derived from any of the user's Keys.
      this.db.prepare('DELETE FROM hub_login_keys WHERE user_id = ?').run(change.userId);
      // Existing dependency triggers revoke descendants (including shares the
      // user's derived creation grant supports). Tombstones are not resurrected.
      this.db.prepare('UPDATE node_grants SET revoked = 1, version = version + 1 WHERE user_id = ? AND revoked = 0').run(change.userId);
    }
    this.audit.append({ event: 'user_access_changed', outcome: 'success', actorUserId: principal.userId,
      userId: change.userId, reason: `${change.status}:${current.version}:${version}` });
    return { access: { userId: change.userId, status: change.status, version } };
  }

  /** Original credential/role/scope and workspace CAS use the SAME original
   * connection/savepoint. The user ID is derived here, never an RPC claim.
   * No callback crosses the worker boundary and conflicts are not replayed. */
  memberWorkspaceCommand(request: Request, expectedScope: string, workspace: WorkspacePreferencesStore,
    command: { action: 'get' } | { action: 'save'; document: WorkspacePreferences }) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      if (command.action === 'get') return { document: workspace.get(principal.userId) };
      const document = workspace.save(principal.userId, command.document);
      return document ? { document } : { conflict: true as const };
    });
  }

  /** Original personal identity/scope, hot/cold CAS and immutable move receipt
   * stay on one owner connection. Bound native-file writes are never bypassed. */
  memberNotebookControlCommand(request: Request, expectedScope: string, notebooks: SessionNotebooks,
    capabilities: NotebookCapabilities, command: HubNotebookControlCommand, owner?: HubStore): HubNotebookControlResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      const authority = command.authority;
      if (authority && (!owner || !sessionNotebookAuthorityCurrent(owner, principal, authority, command.resourceId)
        || authority.kind === 'shared' && command.action !== 'move' && command.action !== 'receipt')) {
        return { action: 'denied', resourceId: command.resourceId, operation: command.action };
      }
      const decoded = authority?.kind === 'owner' ? decodeHubSessionId(authority.sessionId) : undefined;
      return executeHubNotebookControl(principal.userId, notebooks, capabilities, command,
        decoded && authority?.kind === 'owner' ? { connectionId: decoded.connectionId, version: authority.connectionVersion } : null);
    });
  }

  memberNotebookCommand(request: Request, expectedScope: string, notebooks: SessionNotebooks,
    command: HubNotebookCommand, owner?: HubStore): HubNotebookResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      const user = principal.userId;
      switch (command.action) {
        case 'resolveSession': {
          const selected = owner ? selectSessionNotebookAuthority(owner, principal, command.target) : null;
          return {action: 'resolveSession', target: command.target, authority: selected?.authority ?? null,
            resourceId: selected?.resourceId ?? null};
        }
        case 'snapshotPrivate': return {action: 'snapshotPrivate', read: command.read,
          snapshot: readNotebookSnapshotInTransaction(this.db, {...command.read, owner: user})};
        case 'snapshotSession': {
          const selected = owner ? selectSessionNotebookAuthority(owner, principal, command.read) : null;
          return {action: 'snapshotSession', read: command.read, authority: selected?.authority ?? null,
            resourceId: selected?.resourceId ?? null, snapshot: selected ? readNotebookSnapshotInTransaction(this.db,
              {owner: user, resourceId: selected.resourceId, after: null, mode: command.read.mode,
                query: command.read.query, includeArchive: command.read.includeArchive}) : null};
        }
        case 'checkSession': return {action: 'checkSession', authority: command.authority, resourceId: command.resourceId,
          current: !!owner && sessionNotebookAuthorityCurrent(owner, principal, command.authority, command.resourceId)};
        case 'get': return { action: 'get', document: notebooks.get(user, command.resourceId) };
        case 'archive': return { action: 'archive', document: notebooks.getArchive(user, command.resourceId) };
        case 'save': return { action: 'save', document: notebooks.save(user, command.document) ?? null };
        case 'saveArchive': return { action: 'saveArchive', document: notebooks.saveArchive(user, command.document) ?? null };
        case 'savePrivate':
        case 'saveSession': {
          if (command.action === 'saveSession' && (!owner
            || !sessionNotebookAuthorityCurrent(owner, principal, command.authority, command.document.resourceId))) {
            return { action: 'saveSession', status: 'denied', document: null };
          }
          // Check the original stored text inside the SAME identity/CAS
          // savepoint. A pre-await route check cannot protect a stale tab.
          if (command.area !== 'layout' && !command.styled) {
            const current = command.area === 'cold' ? notebooks.getArchive(user, command.document.resourceId)
              : notebooks.get(user, command.document.resourceId);
            if (/data-agentopsdeck-note\s*=/.test(command.document.text) || /data-agentopsdeck-note\s*=/.test(current.text)) {
              return { action: command.action, status: 'format', document: null };
            }
          }
          // Original stores recheck native binding and pending move locks.
          // They do not admit a second local copy of a file-managed notebook.
          const document = command.area === 'cold' ? notebooks.saveArchive(user, command.document)
            : notebooks.save(user, command.document);
          return { action: command.action, status: document ? 'saved' : 'conflict', document: document ?? null };
        }
        case 'search': return { action: 'search', resourceId: command.resourceId, result: notebooks.searchAreas(user, command.resourceId, command.query, command.area) };
        case 'receipt': return { action: 'receipt', resourceId: command.resourceId, requestId: command.requestId,
          result: notebooks.moveReceipt(user, command.resourceId, command.requestId) ?? null };
        case 'move': {
          const reply = { action: 'move' as const, resourceId: command.resourceId, requestId: command.input.requestId };
          try { return { ...reply, result: notebooks.move(user, command.resourceId, command.input) }; }
          catch (error) { if (error instanceof NotebookMoveConflict) return { ...reply, result: null }; throw error; }
        }
      }
    });
  }

  /** Machine capability/binding projection is one original SQL snapshot;
   * update retains its nested CAS/receipt/audit savepoint. No human fallback. */
  boardMachineCommand(capabilities: WorkspaceBoardCapabilities, command: HubBoardMachineCommand): HubBoardMachineResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      switch (command.action) {
        case 'authorized': return { action: 'authorized', authorized: capabilities.authorized(command.token) };
        case 'read': return { action: 'read', snapshot: capabilities.read(command.token, command.query) ?? null };
        case 'update': return { action: 'update', result: capabilities.update(command.token, command.document) };
      }
    });
  }

  /** Management remains inside the original SQL identity/scope proof. */
  memberBoardCapabilityCommand(request: Request, expectedScope: string,
    capabilities: WorkspaceBoardCapabilities,
    command: HubBoardCapabilityCommand): HubBoardCapabilityResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      switch (command.action) {
        case 'list': return { action: 'list', capabilities: capabilities.list(principal.userId, command.resourceId) };
        case 'issue': return { action: 'issue', issued: capabilities.issue(principal.userId, command.resourceId, command.input) ?? null };
        case 'revoke': return { action: 'revoke', revoked: capabilities.revoke(principal.userId, command.resourceId, command.capabilityId) };
        case 'events': return { action: 'events', events: capabilities.events(principal.userId, command.resourceId, command.before) as HubBoardCapabilityEvent[] };
      }
    });
  }

  /** Credential/scope, file-managed exclusion, CAS and receipt stay in the
   * original connection/savepoint. The command never supplies a user ID. */
  memberConfigurationCommand(request: Request, expectedScope: string, configurations: WorkspaceCardConfigurations, command: HubConfigurationCommand): HubConfigurationResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubConfiguration(configurations, principal.userId, command);
    });
  }

  memberFileBindingCommand(request: Request, expectedScope: string, store: Pick<HubStore, 'boardFiles' | 'cardFiles'>, command: HubFileBindingCommand): HubFileBindingResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubFileBinding(store, principal.userId, command);
    });
  }

  memberReportCommand(request: Request, expectedScope: string, store: Pick<HubStore, 'cardFiles' | 'cardFileProjection'>, command: HubReportCommand): HubReportResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubReport(store, principal.userId, command);
    });
  }

  memberProjectionCommand(request: Request, expectedScope: string, projection: WorkspaceCardFileProjection, command: HubProjectionCommand): HubProjectionResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubProjection(projection, principal.userId, command);
    });
  }

  memberVisualCommand(request: Request, expectedScope: string, cards: WorkspaceCards, drawings: WorkspaceDrawings, native: WorkspaceNativeDrawio, command: HubVisualCommand): HubVisualResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      return executeHubVisual(cards, drawings, native, principal.userId, command);
    });
  }

  memberBoardCommand(request: Request, expectedScope: string, boards: WorkspaceBoards, command: HubBoardCommand,
    boardFiles?: WorkspaceBoardFiles): HubBoardResult {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      switch (command.action) {
        case 'list': return { action: 'list', summaries: boards.list(principal.userId) };
        case 'get': return { action: 'get', document: boards.get(principal.userId, command.resourceId) };
        case 'snapshot': {
          if (!boardFiles) throw new Error('board_snapshot_owner_unavailable');
          const document = boards.get(principal.userId, command.resourceId);
          const binding = boardFiles.current(principal.userId, command.resourceId);
          return { action: 'snapshot', document, binding: binding ? publicFileBoardBinding(binding) : null };
        }
        case 'summary': return { action: 'summary', summary: boards.summary(principal.userId, command.resourceId) };
        case 'save': return { action: 'save', result: boards.save(principal.userId, command.resourceId, command.document) };
      }
    });
  }

  /** Authority and original lost-reply/CAS behavior stay in one savepoint.
   * Never promote the RPC user ID or infer permissions from layout content. */
  memberLayoutCommand(request: Request, expectedScope: string, layouts: WorkspaceLayouts,
    command: { action: 'get'; kind: LayoutKind } | { action: 'save'; kind: LayoutKind; document: LayoutDocument }) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      if (command.action === 'get') return { document: layouts.get(principal.userId, command.kind) };
      const document = layouts.save(principal.userId, command.kind, command.document);
      return document ? { document } : { conflict: true as const };
    });
  }

  /** Permission, connection grant and preference write share the original
   * savepoint. Callback-free RPC never accepts caller user IDs as authority. */
  memberSessionPreferenceCommand(request: Request, expectedScope: string,
    owner: Pick<HubStore, 'getConnection' | 'setSessionPreference'>, change: HubSessionPreferenceChange) {
    return observedSavepoint(this.db, 'hub-identity-check', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      const decoded = decodeHubSessionId(change.sessionKey);
      const connection = decoded && owner.getConnection(decoded.connectionId, principal.userId);
      if (!connection || connection.status === 'disabled') return { error: 'missing' as const };
      owner.setSessionPreference(change.sessionKey, change.field, change.value, principal.userId);
      return { ok: true as const };
    });
  }

  memberQuickChatExecutionCommand(request: Request, expectedScope: string, owner: HubStore, command: HubQuickChatExecutionCommand) {
    const fresh = () => {
      const principal = this.commandPrincipal(request);
      return principal && this.recoveryScope(principal) === expectedScope ? principal : undefined;
    };
    const principal = fresh();
    return principal ? executeHubQuickChatExecutionCommand(owner, principal, fresh, command) : null;
  }

  memberQuickChatCleanupCommand(request: Request, expectedScope: string, owner: HubStore, command: HubQuickChatCleanupCommand) {
    const fresh = () => {
      const principal = this.commandPrincipal(request);
      return principal && this.recoveryScope(principal) === expectedScope ? principal : undefined;
    };
    const principal = fresh();
    return principal ? executeHubQuickChatCleanupCommand(owner, principal, fresh, command) : null;
  }

  memberQuickChatStateCommand(request: Request, expectedScope: string, owner: HubStore, command: HubQuickChatStateCommand) {
    const fresh = () => {
      const principal = this.commandPrincipal(request);
      return principal && this.recoveryScope(principal) === expectedScope ? principal : undefined;
    };
    const principal = fresh();
    return principal ? executeHubQuickChatStateCommand(owner, principal, fresh, command) : null;
  }

  memberGuidanceCommand(request: Request, expectedScope: string, owner: HubStore, command: HubGuidanceCommand) {
    const fresh = () => {
      const principal = this.commandPrincipal(request);
      return principal && this.recoveryScope(principal) === expectedScope ? principal : undefined;
    };
    const principal = fresh();
    return principal ? executeHubGuidanceCommand(this.db, owner, principal, fresh, command) : null;
  }

  memberSharedReadCommand(request: Request, expectedScope: string, owner: HubStore, command: HubSharedReadCommand) {
    return this.atomic(() => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      const result = executeHubSharedRead(owner, principal, command);
      const current = this.commandPrincipal(request);
      return current && this.recoveryScope(current) === expectedScope ? result : null;
    });
  }

  memberEventReplayCommand(request: Request, expectedScope: string, owner: HubStore, command: HubEventReplayCommand) {
    return this.atomic(() => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      const result = readHubEventReplay(owner, principal, command);
      const current = this.commandPrincipal(request);
      return current && this.recoveryScope(current) === expectedScope ? result : null;
    });
  }

  private atomic<Result>(operation: () => Result extends PromiseLike<unknown> ? never : Result): Result {
    return observedSavepoint(this.db, 'hub-identity-change', operation);
  }

  keyIdentity(token: string | undefined) {
    if (!token?.startsWith('hub_key_')) return undefined;
    const row = this.db.prepare('SELECT id AS keyId, user_id AS userId FROM hub_login_keys WHERE secret_hash = ?')
      .get(hash(token)) as { keyId: string; userId: string } | undefined;
    return row && hubUserEnabled(this.db, row.userId) ? row : undefined;
  }

  requestIdentity(request: Request) {
    const key = accessKeyFromRequest(request);
    if (key?.startsWith('hub_key_')) return this.keyIdentity(key);
    const session = sessionTokenFromRequest(request);
    if (!session?.startsWith('hub_session_')) return undefined;
    const row = this.db.prepare(`SELECT keys.id AS keyId, keys.user_id AS userId FROM hub_login_sessions sessions
      JOIN hub_login_keys keys ON keys.id = sessions.key_id WHERE sessions.secret_hash = ? AND sessions.expires_at > ?`)
      .get(hash(session), Date.now()) as { keyId: string; userId: string } | undefined;
    return row && hubUserEnabled(this.db, row.userId) ? row : undefined;
  }

  userUsage(userId: string) {
    return this.db.prepare('SELECT last_login_at AS lastLoginAt, last_active_at AS lastActiveAt FROM hub_user_usage WHERE user_id = ?').get(userId)
      ?? { lastLoginAt: null, lastActiveAt: null };
  }

  recordActivity(request: Request) {
    // The two usage rows describe one observation. Keep both changes on the
    // original connection, including nested callers and rollback recovery.
    return observedSavepoint(this.db, 'hub-identity-change', () => this.recordActivityInSavepoint(request));
  }

  memberActivityCommand(request: Request, expectedScope: string) {
    return observedSavepoint(this.db, 'hub-identity-change', () => {
      const principal = this.commandPrincipal(request);
      if (!principal || this.recoveryScope(principal) !== expectedScope) return null;
      this.recordActivityInSavepoint(request);
      return { ok: true as const };
    });
  }

  private recordActivityInSavepoint(request: Request) {
    const identity = this.requestIdentity(request);
    if (!identity) return;
    const now = Date.now();
    const directKey = accessKeyFromRequest(request)?.startsWith('hub_key_');
    this.db.prepare(`INSERT INTO hub_key_usage (key_id, last_used_at, last_active_at) VALUES (?, ?, ?)
      ON CONFLICT(key_id) DO UPDATE SET last_active_at = excluded.last_active_at,
      last_used_at = COALESCE(excluded.last_used_at, hub_key_usage.last_used_at)
      WHERE hub_key_usage.last_active_at IS NULL OR hub_key_usage.last_active_at <= ?
      OR (excluded.last_used_at IS NOT NULL AND (hub_key_usage.last_used_at IS NULL OR hub_key_usage.last_used_at <= ?))`)
      .run(identity.keyId, directKey ? now : null, now, now - 60_000, now - 60_000);
    this.db.prepare(`INSERT INTO hub_user_usage (user_id, last_active_at) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_active_at = excluded.last_active_at
      WHERE hub_user_usage.last_active_at IS NULL OR hub_user_usage.last_active_at <= ?`).run(identity.userId, now, now - 60_000);
  }

  keyPrincipal(token: string | undefined): HubPrincipal | undefined {
    const row = this.keyIdentity(token);
    return row ? { userId: row.userId, admin: this.isAdministrator(row.userId) } : undefined;
  }

  isAdministrator(userId: string) {
    return !!this.db.prepare("SELECT 1 FROM hub_roles WHERE user_id = ? AND role = 'admin'").get(userId);
  }

  /** Resolves a linked credential ID without storing/reconstructing its secret.
   * Every channel read rechecks this ID; Key revocation also revokes the link. */
  linkedKeyPrincipal(keyId: string): HubPrincipal | undefined {
    const row = this.db.prepare('SELECT user_id FROM hub_login_keys WHERE id=?').get(keyId) as { user_id: string } | undefined;
    return row && hubUserEnabled(this.db, row.user_id) ? { userId: row.user_id, admin: this.isAdministrator(row.user_id) } : undefined;
  }

  createSession(key: string) {
    return this.atomic(() => this.createMemberSession(key));
  }

  private createMemberSession(key: string) {
    const row = this.db.prepare('SELECT id, user_id FROM hub_login_keys WHERE secret_hash = ?').get(hash(key)) as { id: string; user_id: string } | undefined;
    if (!row || !hubUserEnabled(this.db, row.user_id)) return undefined;
    const now = Date.now();
    this.db.prepare('DELETE FROM hub_login_sessions WHERE expires_at <= ?').run(now);
    this.db.prepare(`DELETE FROM hub_login_sessions WHERE secret_hash IN (
      SELECT secret_hash FROM hub_login_sessions WHERE key_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 63
    )`).run(row.id);
    const token = `hub_session_${randomBytes(32).toString('base64url')}`;
    this.db.prepare('INSERT INTO hub_login_sessions VALUES (?, ?, ?, ?)').run(hash(token), row.id, now + SESSION_TTL, now);
    this.db.prepare(`INSERT INTO hub_key_usage (key_id, last_login_at, last_used_at, last_active_at, login_count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(key_id) DO UPDATE SET last_login_at = excluded.last_login_at, last_used_at = excluded.last_used_at,
      last_active_at = excluded.last_active_at, login_count = hub_key_usage.login_count + 1`).run(row.id, now, now, now);
    this.db.prepare(`INSERT INTO hub_user_usage (user_id, last_login_at, last_active_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_login_at = excluded.last_login_at, last_active_at = excluded.last_active_at`).run(row.user_id, now, now);
    return token;
  }

  revokeSession(token: string) {
    this.db.prepare('DELETE FROM hub_login_sessions WHERE secret_hash = ?').run(hash(token));
  }

  /** A typed command carries credentials, never a previously observed grant.
   * Re-enter the bound ORIGINAL authority inside each command savepoint. The
   * default is member-only; supplying a fallback is trusted owner construction,
   * not a runtime request or a serialized callback. No Set/boolean cache. */
  commandPrincipal(request: Request): HubPrincipal | undefined {
    const reference = this.weixinRequests.get(request);
    if (reference) {
      const row = reference.store.get(reference.binding.user);
      return row?.phase === 'bound' && row.id === reference.binding.id && row.keyId === reference.binding.keyId
        ? reference.store.principal(row) : undefined;
    }
    return this.requestPrincipal(request, this.legacyCommandAuthority);
  }

  /** Private owner reconstruction only. Each command/savepoint rechecks the
   * persisted binding, expiry, current Key and role; no HTTP credential or
   * captured principal is manufactured, and denial never falls through. */
  weixinCommandRequest(store: WeixinStore, binding: Readonly<WeixinRequestBinding>): Request {
    const request = new Request('http://weixin.owner/');
    this.weixinRequests.set(request, { store, binding: Object.freeze({ ...binding }) });
    return request;
  }

  requestPrincipal(request: Request, legacy: (request: Request) => boolean): HubPrincipal | undefined {
    const key = accessKeyFromRequest(request);
    const session = sessionTokenFromRequest(request);
    // Explicit member credentials never fall through to a shared-key or
    // anonymous compatibility principal when invalid or revoked.
    if (key?.startsWith('hub_key_')) return this.keyPrincipal(key);
    if (session?.startsWith('hub_session_')) {
      const row = this.requestIdentity(request);
      return row ? { userId: row.userId, admin: this.isAdministrator(row.userId) } : undefined;
    }
    // Inspect the original result before converting it to denial. A callback
    // which writes then returns a Promise must roll back on this connection;
    // the enclosing owner, if any, retains sticky retirement authority.
    return observedSavepoint(this.db, 'hub-identity-check', checkParticipant =>
      synchronousAuthorizationCall(legacy, [request], checkParticipant))
      ? LEGACY_HUB_PRINCIPAL : undefined;
  }
}
