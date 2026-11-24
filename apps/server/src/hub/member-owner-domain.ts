import { HUB_SHARED_CREATION_BYTES, claimHubSharedCreation, validHubSharedCreationCommand, validHubSharedCreationResult, type HubSharedCreationCommand, type HubSharedCreationResult } from './member-shared-creation-domain.js';
import { executeStorageMaintenance, validStorageMaintenanceCommand, validStorageMaintenanceResult, type StorageMaintenanceCommand, type StorageMaintenanceResult } from './member-storage-maintenance-domain.js';
import { WORKSPACE_FILE_CARD_MAX_BYTES } from '@agentopsdeck/shared';
import { HUB_WEIXIN_BYTES, validHubWeixinCommand, validHubWeixinResult, validWeixinBindingEffectCommand, validWeixinBindingEffectResult,
  type HubWeixinCommand, type HubWeixinResult, type WeixinBindingEffectCommand, type WeixinBindingEffectResult } from './member-weixin-domain.js';
import { HUB_NATIVE_FILE_BYTES, validHubNativeFileCommand, validHubNativeFileResult,
  type HubNativeFileCommand, type HubNativeFileResult } from './member-native-file-domain.js';
import { HUB_NOTEBOOK_MACHINE_BYTES, validHubNotebookMachineCommand, validHubNotebookMachineResult,
  type HubNotebookMachineCommand, type HubNotebookMachineResult } from './member-notebook-machine-domain.js';
import { HUB_ISSUER_MANAGEMENT_BYTES, validHubIssuerManagementCommand, validHubIssuerManagementResult, type HubIssuerManagementCommand, type HubIssuerManagementResult } from './member-issuer-management-domain.js';
import { HUB_USER_DIRECTORY_BYTES, validHubUserDirectoryResult, type HubUserDirectoryResult } from './member-user-directory-domain.js';
import { HUB_DELEGATION_BYTES, HUB_DELEGATION_NODES, validHubDelegationCommand, validHubDelegationResult,
  type HubDelegationCommand, type HubDelegationResult } from './member-delegation-domain.js';
import { HUB_CONTENT_DOCUMENT_BYTES, HUB_CONTENT_DOCUMENT_RESULT_BYTES, validHubContentDocumentCommand,
  validHubContentDocumentResult, type HubContentDocumentCommand, type HubContentDocumentResult } from './member-content-document-domain.js';
import { HUB_SHARED_READ_BYTES, HUB_SHARED_READ_RESULT_BYTES, validHubSharedReadCommand,
  validHubSharedReadResult, type HubSharedReadCommand, type HubSharedReadResult } from './member-shared-read-domain.js';
import { HUB_EVENT_REPLAY_COMMAND_BYTES, hubEventReplayResultBytes, validHubEventReplayCommand,
  validHubEventReplayResult, type HubEventReplayCommand, type HubEventReplayResult } from './member-event-replay-domain.js';
import { HUB_EVENT_FEED_COMMAND_BYTES, HUB_EVENT_FEED_RESULT_BYTES, validHubEventFeedInput,
  validHubEventFeedResult, type HubEventFeedInput, type HubEventFeedResult } from './event-feed-domain.js';
import { HUB_MAINTENANCE_BYTES, validHubMaintenanceCommand, validHubMaintenanceResult, claimHubMaintenanceCommand,
  type HubMaintenanceCommand, type HubMaintenanceResult } from './member-maintenance-domain.js';
import { HUB_USAGE_MANIFEST_BYTES, HUB_USAGE_MANIFEST_NODES, executeHubUsageManifest, validHubUsageManifestCommand,
  validHubUsageManifestResult, type HubUsageManifestCommand, type HubUsageManifestResult } from './member-usage-manifest-domain.js';
import { HUB_BOARD_BINDING_RESULT_BYTES, validHubBoardBindingCommand, validHubBoardBindingResult,
  type HubBoardBindingCommand, type HubBoardBindingResult } from './member-board-binding-domain.js';
import { HUB_TASK_SESSION_BYTES, validHubTaskSessionCommand, validHubTaskSessionResult,
  type HubTaskSessionCommand, type HubTaskSessionResult } from './member-task-session-domain.js';
import { HUB_LIFECYCLE_BYTES, validHubLifecycleCommand, validHubLifecycleResult, claimHubLifecycleCommand,
  type HubLifecycleCommand, type HubLifecycleResult } from './member-lifecycle-domain.js';
import { HUB_EXECUTION_COMMAND_BYTES, HUB_EXECUTION_COMMAND_RESULT_BYTES, validHubExecutionCommand, validHubExecutionCommandResult,
  claimHubExecutionCommand, type HubExecutionCommand, type HubExecutionCommandResult } from './member-execution-command-domain.js';
import { HUB_FILE_BINDING_RPC_BYTES, validHubFileBindingCommand, validHubFileBindingResult, type HubFileBindingCommand, type HubFileBindingResult } from './member-file-binding-domain.js';
import { SQLITE_AUTH_COMMAND_BYTES, SQLITE_AUTH_RESULT_BYTES, type SqliteAuthKind,
  type SqliteAuthCommands, sqliteAuthRefusalError, sqliteAuthRefusal } from '../auth/sqlite-owner-domain.js';
import { validHubLegacyAuthCommand, validHubLegacyAuthResult, type HubLegacyAuthCommand,
  type HubLegacyAuthResult } from './legacy-auth-domain.js';
import { HUB_NOTEBOOK_RPC_BYTES, validHubNotebookCommand, validHubNotebookResult, type HubNotebookCommand, type HubNotebookResult } from './member-notebook-domain.js';
import { NOTEBOOK_SNAPSHOT_RESULT_BYTES } from './notebook-snapshot-read.js';
import { HUB_NOTEBOOK_CONTROL_COMMAND_BYTES, HUB_NOTEBOOK_CONTROL_RESULT_BYTES, validHubNotebookControlCommand, validHubNotebookControlResult,
  type HubNotebookControlCommand, type HubNotebookControlResult } from './member-notebook-control-domain.js';
import { executeContentBackground, validContentBackgroundCommand, validContentBackgroundResult,
  type ContentBackgroundCommand, type ContentBackgroundResult } from './content-background-domain.js';
import {validNativeFileBackgroundCommand, validNativeFileBackgroundResult,
  type NativeFileBackgroundCommand, type NativeFileBackgroundResult} from './native-file-background-domain.js';
import { claimHubConnectionControl, validHubConnectionControlCommand, validHubConnectionControlResult,
  validConnectionControlSettlement, validConnectionControlSettlementResult,
  type HubConnectionControlCommand, type HubConnectionControlResult, type ConnectionControlSettlement,
  type ConnectionControlSettlementResult } from './member-connection-control-domain.js';
import { accessKeyFromRequest } from '../auth/access-key.js';
import { weixinRequestBinding, type WeixinRequestBinding } from './weixin-bridge.js';
import { HUB_SHARED_DIRECTORY_BYTES, validHubSharedDirectoryCommand, validHubSharedDirectoryResult,
  type HubSharedDirectoryCommand, type HubSharedDirectoryResult } from './member-shared-directory-domain.js';
import { HUB_REPORT_RPC_BYTES, validHubReportCommand, validHubReportResult, type HubReportCommand, type HubReportResult } from './member-report-domain.js';
import { HUB_PROJECTION_RESULT_BYTES, validHubProjectionCommand, validHubProjectionResult, type HubProjectionCommand, type HubProjectionResult } from './member-projection-domain.js';
import { HUB_CONFIGURATION_RPC_BYTES, validHubConfigurationCommand, validHubConfigurationResult, type HubConfigurationCommand, type HubConfigurationResult } from './member-configuration-domain.js';
import { HUB_VISUAL_RPC_BYTES, HUB_VISUAL_RPC_NODES, validHubVisualCommand, validHubVisualResult, type HubVisualCommand, type HubVisualResult } from './member-visual-domain.js';
import { HUB_BOARD_MACHINE_RPC_BYTES, validHubBoardMachineCommand, validHubBoardMachineResult,
  type HubBoardMachineCommand, type HubBoardMachineResult } from './member-board-machine-domain.js';
import { HUB_BOARD_CAPABILITY_RESULT_BYTES, validHubBoardCapabilityCommand, validHubBoardCapabilityResult,
  type HubBoardCapabilityCommand, type HubBoardCapabilityResult } from './member-board-capability-domain.js';
import { validHubBoardCommand, validHubBoardResult, HUB_BOARD_RPC_BYTES, HUB_BOARD_RPC_NODES,
  type HubBoardCommand, type HubBoardResult } from './member-board-domain.js';
import { validHubExecutionIssuerCommand, validHubExecutionIssuerResult, executeHubExecutionIssuerCommand,
  type HubExecutionIssuerCommand, type HubExecutionIssuerResult } from './member-execution-issuer-domain.js';
import { validHubOwnerControlCommand, validHubOwnerControlResult, claimHubOwnerControl, HUB_OWNER_CONTROL_COMMAND_BYTES, HUB_OWNER_CONTROL_RESULT_BYTES,
  type HubOwnerControlCommand, type HubOwnerControlResult } from './member-owner-control-domain.js';
import { validHubConnectorAccessCommand, validHubConnectorAccessResult,
  type HubConnectorAccessCommand, type HubConnectorAccessResult } from './member-connector-access-domain.js';
import { validHubExecutionLeaseCommand, validHubExecutionLeaseResult, HUB_EXECUTION_LEASE_COMMAND_BYTES,
  HUB_EXECUTION_LEASE_RESULT_BYTES, type HubExecutionLeaseCommand, type HubExecutionLeaseResult } from './member-execution-lease-domain.js';
import { HUB_EVENT_RPC_BYTES, HUB_EVENT_RPC_NODES, validHubEventCommand, validHubEventResult, executeHubEventCommand,
  type HubEventProof, type HubEventResult } from './member-event-domain.js';
import { validHubQuickChatCleanupCommand, validHubQuickChatCleanupResult,
  type HubQuickChatCleanupCommand, type HubQuickChatCleanupResult } from './member-quick-chat-cleanup-domain.js';
import { HUB_QUICK_CHAT_EXECUTION_BYTES, validHubQuickChatExecutionCommand, validHubQuickChatExecutionResult,
  validHubQuickChatEffectCommand, validHubQuickChatEffectResult, executeHubQuickChatEffectCommand,
  type HubQuickChatExecutionCommand, type HubQuickChatExecutionResult,
  type HubQuickChatEffectCommand, type HubQuickChatEffectResult } from './member-quick-chat-execution-domain.js';
import { validHubQuickChatStateCommand, validHubQuickChatStateResult, HUB_QUICK_CHAT_STATE_COMMAND_BYTES, HUB_QUICK_CHAT_STATE_RESULT_BYTES,
  type HubQuickChatStateCommand, type HubQuickChatStateResult } from './member-quick-chat-state-domain.js';
import { validHubGuidanceCommand, validHubGuidanceResult, HUB_GUIDANCE_COMMAND_BYTES, HUB_GUIDANCE_RESULT_BYTES,
  type HubGuidanceCommand, type HubGuidanceResult } from './member-guidance-domain.js';
import { validHubOwnedSessionSharingCommand, validHubOwnedSessionSharingResult, HUB_OWNED_SESSION_SHARING_BYTES,
  type HubOwnedSessionSharingCommand, type HubOwnedSessionSharingResult } from './member-owned-session-sharing-domain.js';
import { validHubSessionSharingCommand, validHubSessionSharingResult, type HubSessionSharingCommand, type HubSessionSharingResult } from './member-session-sharing-domain.js';
import { validHubSessionCollaboratorCommand, validHubSessionCollaboratorResult, HUB_SESSION_COLLABORATOR_BYTES,
  type HubSessionCollaboratorCommand, type HubSessionCollaboratorResult } from './member-session-collaborators-domain.js';
import { validHubCreationDiscoveryCommand, validHubCreationDiscoveryResult, HUB_CREATION_DISCOVERY_RESULT_BYTES,
  type HubCreationDiscoveryCommand, type HubCreationDiscoveryResult } from './member-creation-discovery-domain.js';
import { validHubReceivedGrantCommand, validHubReceivedGrantResult, HUB_RECEIVED_GRANT_RESULT_BYTES,
  type HubReceivedGrantCommand, type HubReceivedGrantResult } from './member-received-grants-domain.js';
import { validHubMembershipCommand, validHubMembershipResult, type HubMembershipCommand, type HubMembershipResult } from './member-membership-domain.js';
import { validHubGrantCommand, validHubGrantResult, HUB_GRANT_RESULT_BYTES, type HubGrantCommand, type HubGrantResult } from './member-grant-domain.js';
import { HUB_ACCESS_DIRECTORY_BYTES, validHubAccessDirectoryResult, type HubAccessDirectoryResult } from './member-access-directory-domain.js';
import { validHubRoleCommand, validHubRoleResult, type HubRoleCommand, type HubRoleResult } from './member-role-domain.js';
import { HUB_CONNECTION_CHANGE_BYTES, validHubConnectionChange, validHubConnectionTarget, validHubConnectionChangeResult,
  type HubConnectionChange, type HubConnectionTarget, type HubConnectionChangeResult } from './member-connection-change-domain.js';
import { validHubUserChange, validHubUserChangeResult, type HubUserChange, type HubUserChangeResult } from './member-user-domain.js';
import { HUB_SESSION_STATE_RPC_BYTES, validHubSessionStateCommand, validHubSessionStateResult, type HubSessionStateCommand, type HubSessionStateResult } from './session-state-domain.js';
import { HUB_CONNECTION_DIRECTORY_RPC_BYTES, validHubConnectionDirectoryCommand, validHubConnectionDirectoryResult, type HubConnectionDirectoryCommand, type HubConnectionDirectoryResult } from './member-connection-directory-domain.js';
import { HUB_CONNECTION_RPC_BYTES, validHubConnectionSnapshot, type HubConnectionSnapshot } from './member-connection-domain.js';
import { HUB_SESSION_PREFERENCE_RPC_BYTES, validHubSessionPreferenceChange, validHubSessionPreferenceResult,
  type HubSessionPreferenceChange, type HubSessionPreferenceResult } from './member-session-preference-domain.js';
import { types } from 'node:util';
import { WEIXIN_BACKGROUND_BYTES, validWeixinBackgroundCommand, validWeixinBackgroundResult, weixinBackgroundStop,
  type WeixinBackgroundCommand, type WeixinBackgroundResult } from './weixin-background-domain.js';
import { parseHubMemberBootstrap, type HubMemberBootstrap } from './member-owner-bootstrap.js';
import { HUB_COMPLETION_RPC_BYTES, validHubCompletionAction, validHubCompletionResult, hubCompletionAuthority,
  type HubCompletionProof, type HubCompletionResult } from './member-completion-domain.js';
import { sessionTokenFromRequest } from '../auth/passkeys.js';
import type { HubStore } from './hub-store.js';
import { parseLifecycleEndpoints, type LifecycleEndpoint } from './lifecycle-client.js';
import type { HubPrincipal } from './identity.js';
import type { LoginAttemptDecision, LoginAttemptLimiterOptions } from '../auth/security.js';
import type { PersistentLoginAttemptLimiter } from '../auth/persistent-login-limiter.js';
import { copyLoginAttemptDecision } from '../auth/login-attempt-decision.js';
import { HUB_LAYOUT_RPC_BYTES, validHubLayoutDocument, validHubLayoutKind, validHubLayoutResult, type HubLayoutResult } from './member-layout-domain.js';
import type { LayoutDocument, LayoutKind } from './workspace-layouts.js';
import { validHubAuditRecord, validHubAuditOptions, validHubAuditList, validHubAuditPage,
  type HubAuditAppend, type HubAuditPage, type HubAuditOptions } from './member-audit-domain.js';
import type { AuthAuditRecord } from '../auth/security.js';
import type { WorkspacePreferences } from '@agentopsdeck/shared';
import { HUB_WORKSPACE_BYTES, HUB_WORKSPACE_NODES, validHubWorkspaceDocument,
  validHubWorkspaceResult, type HubWorkspaceResult } from './member-workspace-domain.js';

export class HubMemberOwnerUnavailable extends Error {
  constructor() { super('hub_member_storage_unavailable'); }
}
/** Trusted request credential extraction only. Never an authorized boolean,
 * user ID, recovery scope, callback, SQL or browser-provided proof DTO. */
export type HubMemberEvidence = { accessKey?: string; sessionToken?: string; weixinBinding?: Readonly<WeixinRequestBinding> };
export function hubMemberEvidence(request: Request): HubMemberEvidence {
  const binding = weixinRequestBinding(request);
  if (binding) return { weixinBinding: { ...binding } };
  const accessKey = accessKeyFromRequest(request), sessionToken = sessionTokenFromRequest(request);
  return { ...(accessKey === undefined ? {} : { accessKey }),
    // The original cookie reader returns an empty string for an empty cookie.
    // It cannot name a session; do not turn an anonymous request/logout into
    // a worker protocol failure. Explicit access-key precedence is unchanged.
    ...(sessionToken === undefined || sessionToken === '' ? {} : { sessionToken }) };
}
export type HubMemberSnapshot = { principal: HubPrincipal; recoveryScope: string } | null;
export type HubMemberKeyEvidence = { evidence: HubMemberEvidence; expectedScope: string; userId: string };
type MemberKeyRow = { id: string; createdAt: number; lastLoginAt: number | null; lastUsedAt: number | null;
  lastActiveAt: number | null; loginCount: number };
type Fingerprint = { ipHash?: string; userAgentHash?: string };
export type HubMemberCommands = {
  storageMaintenance: { input: { evidence: HubMemberEvidence; expectedScope: string; command: StorageMaintenanceCommand }; output: StorageMaintenanceResult };
  weixin: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubWeixinCommand }; output: HubWeixinResult };
  weixinBindingEffect: { input: WeixinBindingEffectCommand; output: WeixinBindingEffectResult };
  connectionControl: { input: {evidence: HubMemberEvidence; expectedScope: string; command: HubConnectionControlCommand}; output: HubConnectionControlResult };
  connectionControlSettlement: { input: ConnectionControlSettlement; output: ConnectionControlSettlementResult };
  nativeFile: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubNativeFileCommand }; output: HubNativeFileResult };
  nativeFileBackground: { input: NativeFileBackgroundCommand; output: NativeFileBackgroundResult };
  contentBackground: { input: ContentBackgroundCommand; output: ContentBackgroundResult };
  weixinBackground: { input: WeixinBackgroundCommand; output: WeixinBackgroundResult };
  legacyAuth: { input: HubLegacyAuthCommand; output: HubLegacyAuthResult };
  sharedDirectory: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubSharedDirectoryCommand }; output: HubSharedDirectoryResult };
  personalNotebook: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubNotebookCommand }; output: HubNotebookResult };
  notebookControl: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubNotebookControlCommand }; output: HubNotebookControlResult };
  boardMachine: { input: HubBoardMachineCommand; output: HubBoardMachineResult };
  notebookMachine: { input: HubNotebookMachineCommand; output: HubNotebookMachineResult };
  workspaceBoard: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubBoardCommand }; output: HubBoardResult };
  fileBindingRead: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubFileBindingCommand }; output: HubFileBindingResult };
  workspaceReport: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubReportCommand }; output: HubReportResult };
  workspaceProjection: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubProjectionCommand }; output: HubProjectionResult };
  workspaceConfiguration: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubConfigurationCommand }; output: HubConfigurationResult };
  workspaceVisual: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubVisualCommand }; output: HubVisualResult };
  boardCapability: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubBoardCapabilityCommand }; output: HubBoardCapabilityResult };
  executionIssuer: { input: HubExecutionIssuerCommand; output: HubExecutionIssuerResult };
  executionCommand: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubExecutionCommand }; output: HubExecutionCommandResult };
  sharedCreation: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubSharedCreationCommand }; output: HubSharedCreationResult };
  issuerManagement: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubIssuerManagementCommand }; output: HubIssuerManagementResult };
  maintenanceCommand: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubMaintenanceCommand }; output: HubMaintenanceResult };
  usageManifest: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubUsageManifestCommand }; output: HubUsageManifestResult };
  boardBinding: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubBoardBindingCommand }; output: HubBoardBindingResult };
  taskSession: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubTaskSessionCommand }; output: HubTaskSessionResult };
  delegation: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubDelegationCommand }; output: HubDelegationResult };
  contentDocument: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubContentDocumentCommand }; output: HubContentDocumentResult };
  eventReplay: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubEventReplayCommand }; output: HubEventReplayResult };
  eventFeed: { input: HubEventFeedInput; output: HubEventFeedResult };
  sharedRead: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubSharedReadCommand }; output: HubSharedReadResult };
  lifecycleCommand: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubLifecycleCommand }; output: HubLifecycleResult };
  ownerControl: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubOwnerControlCommand }; output: HubOwnerControlResult };
  connectorAccess: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubConnectorAccessCommand }; output: HubConnectorAccessResult };
  executionLease: { input: HubExecutionLeaseCommand; output: HubExecutionLeaseResult };
  eventAppend: { input: HubEventProof; output: HubEventResult };
  quickChatExecution: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubQuickChatExecutionCommand }; output: HubQuickChatExecutionResult };
  quickChatEffect: { input: HubQuickChatEffectCommand; output: HubQuickChatEffectResult };
  quickChatCleanup: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubQuickChatCleanupCommand }; output: HubQuickChatCleanupResult };
  quickChatState: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubQuickChatStateCommand }; output: HubQuickChatStateResult };
  sessionGuidance: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubGuidanceCommand }; output: HubGuidanceResult };
  ownedSessionSharing: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubOwnedSessionSharingCommand }; output: HubOwnedSessionSharingResult };
  sessionSharing: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubSessionSharingCommand }; output: HubSessionSharingResult };
  sessionCollaborators: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubSessionCollaboratorCommand }; output: HubSessionCollaboratorResult };
  creationEnvironments: { input: { evidence: HubMemberEvidence; expectedScope:string; command:HubCreationDiscoveryCommand }; output:HubCreationDiscoveryResult };
  receivedGrants: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubReceivedGrantCommand }; output: HubReceivedGrantResult };
  grantRead: { input: { evidence: HubMemberEvidence; expectedScope: string; command: Extract<HubGrantCommand, { action: 'authorize' | 'list' | 'get' }> }; output: HubGrantResult };
  grantChange: { input: { evidence: HubMemberEvidence; expectedScope: string; command: Extract<HubGrantCommand, { action: 'create' | 'replace' | 'revoke' }> }; output: HubGrantResult };
  membershipRead: { input: { evidence: HubMemberEvidence; expectedScope: string; command: Extract<HubMembershipCommand, { action: 'authorize' | 'read' }> }; output: HubMembershipResult };
  membershipSet: { input: { evidence: HubMemberEvidence; expectedScope: string; command: Extract<HubMembershipCommand, { action: 'set' }> }; output: HubMembershipResult };
  accessDirectory: { input: { evidence: HubMemberEvidence; expectedScope: string }; output: HubAccessDirectoryResult };
  roleRead: { input: { evidence: HubMemberEvidence; expectedScope: string; command: Extract<HubRoleCommand, { action: 'read' }> }; output: HubRoleResult };
  roleSet: { input: { evidence: HubMemberEvidence; expectedScope: string; command: Extract<HubRoleCommand, { action: 'set' }> }; output: HubRoleResult };
  connectionTarget: { input: { evidence: HubMemberEvidence; expectedScope: string; id: string }; output: HubConnectionTarget };
  connectionChange: { input: { evidence: HubMemberEvidence; expectedScope: string; change: HubConnectionChange }; output: HubConnectionChangeResult };
  userChange: { input: { evidence: HubMemberEvidence; expectedScope: string; change: HubUserChange }; output: HubUserChangeResult };
  sessionStateSnapshot: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubSessionStateCommand }; output: HubSessionStateResult };
  sessionStateCheck: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubSessionStateCommand }; output: HubSessionStateResult };
  connectionDirectory: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubConnectionDirectoryCommand }; output: HubConnectionDirectoryResult };
  connectionDirectoryCheck: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubConnectionDirectoryCommand }; output: HubConnectionDirectoryResult };
  connectionDirectoryVersion: { input: { evidence: HubMemberEvidence; expectedScope: string; command: HubConnectionDirectoryCommand }; output: HubConnectionDirectoryResult };
  userDirectory: { input: { evidence: HubMemberEvidence; expectedScope: string }; output: HubUserDirectoryResult };
  connectionSnapshot: { input: { evidence: HubMemberEvidence; expectedScope: string }; output: HubConnectionSnapshot };
  memberActivity: { input: { evidence: HubMemberEvidence; expectedScope: string }; output: { ok: true } | null };
  sessionPreferenceSet: { input: { evidence: HubMemberEvidence; expectedScope: string; change: HubSessionPreferenceChange }; output: HubSessionPreferenceResult };
  memberIdentity: { input: { action: 'request'; evidence: HubMemberEvidence } | { action: 'key'; key?: string };
    output: { userId: string; keyId: string } | null };
  memberSnapshot: { input: HubMemberEvidence; output: HubMemberSnapshot };
  memberSessionCreate: { input: { key: string }; output: { token: string } | null };
  memberSessionDelete: { input: { token: string }; output: null };
  memberKeysRead: { input: HubMemberKeyEvidence; output: { keys: MemberKeyRow[] } | null };
  memberKeyIssue: { input: HubMemberKeyEvidence & { fingerprint?: Fingerprint }; output: { id: string; token: string }
    | { error: 'configuration_required' | 'cannot_issue' } | null };
  memberKeyRevoke: { input: HubMemberKeyEvidence & { keyId: string; fingerprint?: Fingerprint }; output: { ok: boolean } | null };
  loginLimiterCheck: { input: { subject: string }; output: LoginAttemptDecision };
  loginLimiterFailure: { input: { subject: string }; output: LoginAttemptDecision };
  loginLimiterSuccess: { input: { subject: string }; output: null };
  auditAppend: { input: { record: HubAuditAppend }; output: AuthAuditRecord };
  auditPage: { input: { evidence: HubMemberEvidence; expectedScope: string; options: HubAuditOptions }; output: HubAuditPage | null };
  auditList: { input: { evidence: HubMemberEvidence; expectedScope: string; limit: number }; output: AuthAuditRecord[] | null };
  workspaceGet: { input: { evidence: HubMemberEvidence; expectedScope: string }; output: HubWorkspaceResult };
  workspaceSave: { input: { evidence: HubMemberEvidence; expectedScope: string; document: WorkspacePreferences }; output: HubWorkspaceResult };
  layoutGet: { input: { evidence: HubMemberEvidence; expectedScope: string; layoutKind: LayoutKind }; output: HubLayoutResult };
  layoutSave: { input: { evidence: HubMemberEvidence; expectedScope: string; layoutKind: LayoutKind; document: LayoutDocument }; output: HubLayoutResult };
  completionSummary: { input: HubCompletionProof; output: HubCompletionResult };
  completionObserve: { input: HubCompletionProof; output: HubCompletionResult };
  completionRead: { input: HubCompletionProof; output: HubCompletionResult };
};
export type HubMemberKind = keyof HubMemberCommands;
export const hubMemberKinds: readonly HubMemberKind[] = ['fileBindingRead', 'workspaceReport', 'workspaceProjection', 'workspaceConfiguration', 'workspaceVisual', 'notebookControl', 'legacyAuth', 'memberIdentity', 'sharedDirectory', 'personalNotebook', 'boardMachine', 'boardCapability', 'workspaceBoard', 'memberSnapshot', 'memberSessionCreate', 'memberSessionDelete',
  'weixin', 'weixinBindingEffect', 'weixinBackground', 'storageMaintenance', 'notebookMachine', 'taskSession',
  'quickChatExecution', 'quickChatEffect', 'connectionDirectoryVersion', 'usageManifest', 'boardBinding', 'delegation', 'contentDocument', 'contentBackground', 'nativeFile', 'nativeFileBackground', 'connectionControl', 'connectionControlSettlement',
  'memberKeysRead', 'memberKeyIssue', 'memberKeyRevoke', 'loginLimiterCheck', 'loginLimiterFailure', 'loginLimiterSuccess',
  'auditAppend', 'auditPage', 'auditList', 'workspaceGet', 'workspaceSave', 'layoutGet', 'layoutSave',
  'completionSummary', 'completionObserve', 'completionRead', 'sessionPreferenceSet', 'memberActivity', 'userDirectory', 'connectionSnapshot', 'connectionDirectory', 'connectionDirectoryCheck', 'sessionStateSnapshot', 'sessionStateCheck', 'userChange', 'connectionTarget', 'connectionChange', 'roleRead', 'roleSet', 'accessDirectory', 'membershipRead', 'membershipSet', 'grantRead', 'grantChange', 'receivedGrants', 'creationEnvironments', 'sessionCollaborators', 'sessionSharing', 'ownedSessionSharing', 'sessionGuidance', 'quickChatState', 'quickChatCleanup', 'eventAppend', 'executionLease', 'connectorAccess', 'ownerControl', 'executionIssuer', 'executionCommand', 'lifecycleCommand', 'maintenanceCommand', 'eventReplay', 'eventFeed', 'sharedRead', 'sharedCreation', 'issuerManagement'];
/** Append-only command telemetry IDs, independent of dispatch-list ordering.
 * These identify operations, not the separate SQL failure phases below. */
export const hubMemberCommandSteps: Readonly<Record<HubMemberKind, number>> = Object.freeze({
  notebookMachine: 88,
  taskSession: 89,
  weixin: 84, weixinBindingEffect: 85, weixinBackground: 86, storageMaintenance: 87,
  connectionControl: 82, connectionControlSettlement: 83,
  nativeFile: 80,
  nativeFileBackground: 81,
  contentBackground: 79,
  delegation: 77,
  contentDocument: 78,
  boardBinding: 76,
  usageManifest: 75,
  connectionDirectoryVersion: 74,
  lifecycleCommand: 65, maintenanceCommand: 66, eventReplay: 67, eventFeed: 68, sharedRead: 69, sharedCreation: 70,
  issuerManagement: 71, quickChatExecution: 72, quickChatEffect: 73,
  executionCommand: 64,
  userDirectory: 63,
  sessionStateSnapshot: 61, sessionStateCheck: 62,
  connectionDirectory: 59, connectionDirectoryCheck: 60,
  fileBindingRead: 58,
  workspaceReport: 57,
  workspaceProjection: 56,
  workspaceConfiguration: 55,
  workspaceVisual: 54,
  notebookControl: 53,
  legacyAuth: 51,
  memberIdentity: 52,
  sharedDirectory: 50,
  personalNotebook: 49,
  boardMachine: 48,
  boardCapability: 47,
  workspaceBoard: 46,
  memberSnapshot: 1, memberSessionCreate: 2, memberSessionDelete: 3,
  memberKeysRead: 4, memberKeyIssue: 5, memberKeyRevoke: 6,
  loginLimiterCheck: 7, loginLimiterFailure: 8, loginLimiterSuccess: 9,
  auditAppend: 10, auditPage: 11, auditList: 12,
  workspaceGet: 13, workspaceSave: 14, layoutGet: 15, layoutSave: 16,
  completionSummary: 17, completionObserve: 18, completionRead: 19,
  sessionPreferenceSet: 20, memberActivity: 21, connectionSnapshot: 22,
  userChange: 23, connectionTarget: 24, connectionChange: 25,
  roleRead: 26, roleSet: 27, accessDirectory: 28,
  membershipRead: 29, membershipSet: 30, grantRead: 31, grantChange: 32,
  receivedGrants: 33, creationEnvironments: 34, sessionCollaborators: 35,
  sessionSharing: 36, ownedSessionSharing: 37, sessionGuidance: 38,
  quickChatState: 39, quickChatCleanup: 40, eventAppend: 41,
  executionLease: 42, connectorAccess: 43, ownerControl: 44, executionIssuer: 45,
});
/** Stable failure phases; 12=close and 13=startup remain reserved. */
export const hubMemberFailureSteps: Readonly<Record<HubMemberKind, number>> = Object.freeze({
  notebookMachine: 108,
  taskSession: 109,
  weixin: 104, weixinBindingEffect: 105, weixinBackground: 106, storageMaintenance: 107,
  connectionControl: 102, connectionControlSettlement: 103,
  nativeFile: 100,
  nativeFileBackground: 101,
  contentBackground: 99,
  delegation: 97,
  contentDocument: 98,
  boardBinding: 96,
  usageManifest: 95,
  connectionDirectoryVersion: 94,
  lifecycleCommand: 85, maintenanceCommand: 86, eventReplay: 87, eventFeed: 88, sharedRead: 89, sharedCreation: 90,
  issuerManagement: 91, quickChatExecution: 92, quickChatEffect: 93,
  executionCommand: 84,
  userDirectory: 83,
  sessionStateSnapshot: 81, sessionStateCheck: 82,
  connectionDirectory: 79, connectionDirectoryCheck: 80,
  fileBindingRead: 78,
  workspaceReport: 77,
  workspaceProjection: 76,
  workspaceConfiguration: 75,
  workspaceVisual: 74,
  notebookControl: 73,
  legacyAuth: 71,
  memberIdentity: 72,
  sharedDirectory: 70,
  personalNotebook: 69,
  boardMachine: 68,
  boardCapability: 67,
  workspaceBoard: 66,
  ownerControl: 64,
  executionIssuer: 65,
  connectorAccess: 63,
  executionLease: 52,
  eventAppend: 51,
  memberSnapshot: 8, memberSessionCreate: 9, memberSessionDelete: 10,
  memberKeysRead: 11, memberKeyIssue: 14, memberKeyRevoke: 15,
  loginLimiterCheck: 16, loginLimiterFailure: 17, loginLimiterSuccess: 18,
  auditAppend: 19, auditPage: 20, auditList: 21,
  workspaceGet: 22, workspaceSave: 23,
  layoutGet: 24, layoutSave: 25,
  completionSummary: 26, completionObserve: 27, completionRead: 28,
  sessionPreferenceSet: 29,
  memberActivity: 30,
  connectionSnapshot: 31,
  userChange: 32,
  connectionTarget: 33,
  connectionChange: 34,
  roleRead: 35,
  roleSet: 36,
  accessDirectory: 37,
  membershipRead: 38,
  membershipSet: 39,
  grantRead: 40,
  grantChange: 41,
  receivedGrants: 42,
  creationEnvironments: 43,
  sessionCollaborators: 44,
  sessionSharing: 45,
  ownedSessionSharing: 46,
  sessionGuidance: 47,
  quickChatState: 49,
  quickChatCleanup: 50,
});
export const HUB_MEMBER_COMMAND_BYTES = 16_384;
export const HUB_MEMBER_RESULT_BYTES = 16_384;
/** Reserve worst-case result bytes BEFORE accepting work. Large original
 * audit responses do not multiply the 256-command budget into GiB of replies.
 * A refusal never dispatches, retries or cancels a retention mutation. */
export const HUB_MEMBER_RESULT_BUDGET = 32 * 1024 * 1024;
export function hubMemberCommandBytes(kind: HubMemberKind | 'close'): number {
  if (kind === 'taskSession') return HUB_TASK_SESSION_BYTES;
  if (kind === 'weixinBackground') return WEIXIN_BACKGROUND_BYTES;
  if (kind === 'weixin' || kind === 'weixinBindingEffect') return HUB_WEIXIN_BYTES;
  if (kind === 'nativeFile' || kind === 'nativeFileBackground') return HUB_NATIVE_FILE_BYTES;
  if (kind === 'delegation') return HUB_DELEGATION_BYTES;
  if (kind === 'contentDocument' || kind === 'contentBackground') return HUB_CONTENT_DOCUMENT_BYTES;
  if (kind === 'usageManifest') return HUB_USAGE_MANIFEST_BYTES;
  if (kind === 'quickChatExecution' || kind === 'quickChatEffect') return HUB_QUICK_CHAT_EXECUTION_BYTES;
  if (kind === 'sharedRead') return HUB_SHARED_READ_BYTES;
  if (kind === 'eventFeed') return HUB_EVENT_FEED_COMMAND_BYTES;
  if (kind === 'eventReplay') return HUB_EVENT_REPLAY_COMMAND_BYTES;
  if (kind === 'issuerManagement') return HUB_ISSUER_MANAGEMENT_BYTES;
  if (kind === 'sharedCreation') return HUB_SHARED_CREATION_BYTES;
  if (kind === 'maintenanceCommand') return HUB_MAINTENANCE_BYTES;
  if (kind === 'lifecycleCommand') return HUB_LIFECYCLE_BYTES;
  if (kind === 'executionCommand') return HUB_EXECUTION_COMMAND_BYTES;
  if (kind === 'ownerControl') return HUB_OWNER_CONTROL_COMMAND_BYTES;
  if (kind === 'fileBindingRead') return HUB_FILE_BINDING_RPC_BYTES;
  if (kind === 'workspaceReport') return HUB_REPORT_RPC_BYTES;
  if (kind === 'notebookControl') return HUB_NOTEBOOK_CONTROL_COMMAND_BYTES;
  if (kind === 'legacyAuth') return SQLITE_AUTH_COMMAND_BYTES;
  if (kind === 'sharedDirectory') return HUB_SHARED_DIRECTORY_BYTES;
  if (kind === 'personalNotebook') return HUB_NOTEBOOK_RPC_BYTES;
  if (kind === 'boardMachine') return HUB_BOARD_MACHINE_RPC_BYTES;
  if (kind === 'notebookMachine') return HUB_NOTEBOOK_MACHINE_BYTES;
  if (kind === 'workspaceConfiguration') return HUB_CONFIGURATION_RPC_BYTES;
  if (kind === 'workspaceVisual') return HUB_VISUAL_RPC_BYTES;
  if (kind === 'workspaceBoard') return HUB_BOARD_RPC_BYTES;
  if (kind === 'executionLease') return HUB_EXECUTION_LEASE_COMMAND_BYTES;
  if (kind === 'eventAppend') return HUB_EVENT_RPC_BYTES;
  if (kind === 'quickChatState') return HUB_QUICK_CHAT_STATE_COMMAND_BYTES;
  if (kind === 'sessionGuidance') return HUB_GUIDANCE_COMMAND_BYTES;
  if (kind === 'connectionChange') return HUB_CONNECTION_CHANGE_BYTES;
  if (kind === 'sessionPreferenceSet') return HUB_SESSION_PREFERENCE_RPC_BYTES;
  if (kind === 'completionSummary' || kind === 'completionObserve' || kind === 'completionRead') return HUB_COMPLETION_RPC_BYTES;
  return kind === 'workspaceSave' ? HUB_WORKSPACE_BYTES : kind === 'layoutSave' ? HUB_LAYOUT_RPC_BYTES : HUB_MEMBER_COMMAND_BYTES;
}
/** Preserve the private content catalog's original 10,000-session bound.
 * Other domains retain the existing generic array cap. Byte/node bounds still
 * apply independently, including before owner execution. */
export function hubMemberCommandArrayLength(kind: HubMemberKind): number {
  return kind === 'contentDocument' ? 10_000 : 8192;
}
export function hubMemberCommandNodes(kind: HubMemberKind): number {
  if (kind === 'delegation') return HUB_DELEGATION_NODES;
  if (kind === 'contentDocument' || kind === 'contentBackground') return 16_384;
  if (kind === 'usageManifest') return HUB_USAGE_MANIFEST_NODES;
  if (kind === 'workspaceVisual') return HUB_VISUAL_RPC_NODES;
  if (kind === 'workspaceBoard') return HUB_BOARD_RPC_NODES;
  if (kind === 'eventAppend') return HUB_EVENT_RPC_NODES;
  return kind === 'workspaceSave' ? HUB_WORKSPACE_NODES : 16_384;
}
export function hubMemberCommandBudget(kind: HubMemberKind | 'close'): number {
  if (kind === 'nativeFile' || kind === 'nativeFileBackground') return 4 * HUB_NATIVE_FILE_BYTES;
  if (kind === 'delegation') return 2 * HUB_DELEGATION_BYTES;
  if (kind === 'contentDocument' || kind === 'contentBackground') return 4 * HUB_CONTENT_DOCUMENT_BYTES;
  if (kind === 'usageManifest') return 2 * HUB_USAGE_MANIFEST_BYTES;
  if (kind === 'quickChatExecution' || kind === 'quickChatEffect') return 16 * HUB_QUICK_CHAT_EXECUTION_BYTES;
  if (kind === 'issuerManagement') return 32 * HUB_ISSUER_MANAGEMENT_BYTES;
  if (kind === 'sharedCreation') return 32 * HUB_SHARED_CREATION_BYTES;
  if (kind === 'eventReplay') return 4 * HUB_EVENT_REPLAY_COMMAND_BYTES;
  if (kind === 'maintenanceCommand') return 32 * HUB_MAINTENANCE_BYTES;
  if (kind === 'lifecycleCommand') return 32 * HUB_LIFECYCLE_BYTES;
  if (kind === 'executionCommand') return 32 * HUB_EXECUTION_COMMAND_BYTES;
  if (kind === 'ownerControl') return 32 * HUB_OWNER_CONTROL_COMMAND_BYTES;
  if (kind === 'workspaceReport') return 4 * HUB_REPORT_RPC_BYTES;
  if (kind === 'legacyAuth') return 32 * SQLITE_AUTH_COMMAND_BYTES;
  if (kind === 'personalNotebook') return 4 * HUB_NOTEBOOK_RPC_BYTES;
  if (kind === 'boardMachine') return 4 * HUB_BOARD_MACHINE_RPC_BYTES;
  if (kind === 'notebookMachine') return 4 * HUB_NOTEBOOK_MACHINE_BYTES;
  if (kind === 'workspaceConfiguration') return 4 * HUB_CONFIGURATION_RPC_BYTES;
  if (kind === 'workspaceVisual') return 4 * HUB_VISUAL_RPC_BYTES;
  if (kind === 'workspaceBoard') return 4 * HUB_BOARD_RPC_BYTES;
  if (kind === 'eventAppend') return 4 * HUB_EVENT_RPC_BYTES;
  return kind === 'workspaceSave' ? HUB_WORKSPACE_BYTES : kind === 'layoutSave' ? HUB_LAYOUT_RPC_BYTES : 32 * HUB_MEMBER_COMMAND_BYTES;
}
export function hubMemberResultBudget(kind: HubMemberKind | 'close'): number {
  return kind === 'workspaceGet' || kind === 'workspaceSave' ? HUB_WORKSPACE_BYTES : HUB_MEMBER_RESULT_BUDGET;
}
export function hubMemberResultBytes(kind: HubMemberKind | 'close', copiedInput?: unknown): number {
  if (kind === 'weixinBackground') return WEIXIN_BACKGROUND_BYTES;
  if (kind === 'weixin' || kind === 'weixinBindingEffect') return HUB_WEIXIN_BYTES;
  if (kind === 'nativeFileBackground') return 32 * 1024;
  if (kind === 'nativeFile') return HUB_NATIVE_FILE_BYTES;
  if (kind === 'contentBackground') {
    return validContentBackgroundCommand(copiedInput) && ['scan','release','access'].includes(copiedInput.action)
      ? 32 * 1024 : HUB_CONTENT_DOCUMENT_RESULT_BYTES;
  }
  if (kind === 'contentDocument') {
    const command = copiedInput && typeof copiedInput === 'object' && 'command' in copiedInput ? copiedInput.command : undefined;
    if (validHubContentDocumentCommand(command)) {
      // Unmigrated overviews include a complete native card, not just refs.
      // Its validated JSON is <=2MiB; <=32 bounded descriptors and the RPC
      // envelope fit the extra 128KiB. Keep the aggregate lane bound unchanged.
      if (command.action === 'overview') return WORKSPACE_FILE_CARD_MAX_BYTES + 128 * 1024;
      // Snapshot refs carry the exact JSON wire size, including escaping.
      // Raw card bytes (or command bytes) are not a response-size bound.
      if (command.action === 'overview-snapshot') return command.snapshot.bytes
        + Buffer.byteLength(JSON.stringify({action:command.action,resourceId:command.resourceId,snapshot:null}));
      if (!['migrate','migration-read','migration-recover',
        'binding-prepare','binding-current','binding-ack','binding-revoke','binding-lookup',
        'batch-directory','batch-prepare','batch-confirm','batch-read','batch-cancel','batch-settle','batch-cleanup-settle','batch-binding-prepare',
        'sync-conflict-proof','sync-proposal-ack','sync-projection-next','sync-projection-claim','sync-projection-ack'].includes(command.action)) {
        return 32 * 1024;
      }
    }
    return HUB_CONTENT_DOCUMENT_RESULT_BYTES;
  }
  if (kind === 'delegation') {
    // A complete directory needs the large envelope, not every claim/check.
    // Keep the shared total bound while admitting four effects and recovery.
    const command = copiedInput && typeof copiedInput === 'object' && 'command' in copiedInput ? copiedInput.command : undefined;
    if (validHubDelegationCommand(command)) {
      if (command.action === 'snapshot') return HUB_DELEGATION_BYTES;
      if (command.action === 'check' || command.action === 'write-check') return 32 * 1024;
      if (command.action === 'claim') return 64 * 1024;
      // At most 32 members and 200 task-title snapshots, no task bodies.
      return 1024 * 1024;
    }
    return HUB_DELEGATION_BYTES;
  }
  if (kind === 'taskSession') return HUB_TASK_SESSION_BYTES;
  if (kind === 'boardBinding') return HUB_BOARD_BINDING_RESULT_BYTES;
  if (kind === 'usageManifest') return HUB_USAGE_MANIFEST_BYTES;
  if (kind === 'eventFeed') {
    if (validHubEventFeedInput(copiedInput)) {
      const action = copiedInput.command.action;
      if (action === 'cursor') return 2 * 1024 * 1024;
      if (action !== 'directory' && action !== 'open') return 128 * 1024;
    }
    return HUB_EVENT_FEED_RESULT_BYTES;
  }
  if (kind === 'eventReplay') {
    const command = copiedInput && typeof copiedInput === 'object' && 'command' in copiedInput ? copiedInput.command : undefined;
    return hubEventReplayResultBytes(command);
  }
  if (kind === 'quickChatExecution' || kind === 'quickChatEffect') return HUB_QUICK_CHAT_EXECUTION_BYTES;
  if (kind === 'sharedRead') return HUB_SHARED_READ_RESULT_BYTES;
  if (kind === 'issuerManagement') return HUB_ISSUER_MANAGEMENT_BYTES;
  if (kind === 'sharedCreation') return HUB_SHARED_CREATION_BYTES;
  if (kind === 'maintenanceCommand') return HUB_MAINTENANCE_BYTES;
  if (kind === 'lifecycleCommand') return HUB_LIFECYCLE_BYTES;
  if (kind === 'executionCommand') return HUB_EXECUTION_COMMAND_RESULT_BYTES;
  if (kind === 'ownerControl') return HUB_OWNER_CONTROL_RESULT_BYTES;
  if (kind === 'fileBindingRead') return HUB_FILE_BINDING_RPC_BYTES;
  if (kind === 'workspaceReport') return HUB_REPORT_RPC_BYTES;
  if (kind === 'workspaceProjection') return HUB_PROJECTION_RESULT_BYTES;
  if (kind === 'notebookControl') return HUB_NOTEBOOK_CONTROL_RESULT_BYTES;
  if (kind === 'notebookMachine') return HUB_NOTEBOOK_MACHINE_BYTES;
  if (kind === 'legacyAuth') return SQLITE_AUTH_RESULT_BYTES;
  if (kind === 'sharedDirectory') return HUB_SHARED_DIRECTORY_BYTES;
  if (kind === 'personalNotebook') return ['snapshotPrivate', 'snapshotSession'].includes((copiedInput as HubMemberCommands['personalNotebook']['input'] | undefined)?.command?.action ?? '')
    ? NOTEBOOK_SNAPSHOT_RESULT_BYTES + 65_536 : HUB_NOTEBOOK_RPC_BYTES;
  if (kind === 'boardMachine') return HUB_BOARD_MACHINE_RPC_BYTES;
  if (kind === 'boardCapability') return HUB_BOARD_CAPABILITY_RESULT_BYTES;
  if (kind === 'workspaceConfiguration') return HUB_CONFIGURATION_RPC_BYTES;
  if (kind === 'workspaceVisual') return HUB_VISUAL_RPC_BYTES;
  if (kind === 'workspaceBoard') return HUB_BOARD_RPC_BYTES;
  if (kind === 'executionLease') return HUB_EXECUTION_LEASE_RESULT_BYTES;
  if (kind === 'quickChatState') return HUB_QUICK_CHAT_STATE_RESULT_BYTES;
  if (kind === 'sessionGuidance') return HUB_GUIDANCE_RESULT_BYTES;
  if (kind === 'ownedSessionSharing') return HUB_OWNED_SESSION_SHARING_BYTES;
  if (kind === 'sessionCollaborators') return HUB_SESSION_COLLABORATOR_BYTES;
  if (kind === 'creationEnvironments') return HUB_CREATION_DISCOVERY_RESULT_BYTES;
  if (kind === 'receivedGrants') return HUB_RECEIVED_GRANT_RESULT_BYTES;
  if (kind === 'grantRead' || kind === 'grantChange') return HUB_GRANT_RESULT_BYTES;
  if (kind === 'accessDirectory') return HUB_ACCESS_DIRECTORY_BYTES;
  if (kind === 'connectionTarget' || kind === 'connectionChange' || kind === 'connectorAccess') return HUB_CONNECTION_CHANGE_BYTES;
  if (kind === 'sessionStateSnapshot') return HUB_SESSION_STATE_RPC_BYTES;
  if (kind === 'sessionStateCheck') return 32 * 1024;
  if (kind === 'connectionDirectory') return HUB_CONNECTION_DIRECTORY_RPC_BYTES;
  if (kind === 'connectionDirectoryCheck' || kind === 'connectionDirectoryVersion') return 32 * 1024;
  if (kind === 'userDirectory') return HUB_USER_DIRECTORY_BYTES;
  if (kind === 'connectionSnapshot') return HUB_CONNECTION_RPC_BYTES;
  if (kind === 'completionSummary') return HUB_COMPLETION_RPC_BYTES;
  if (kind === 'layoutGet' || kind === 'layoutSave') return HUB_LAYOUT_RPC_BYTES;
  if (kind === 'workspaceGet' || kind === 'workspaceSave') return HUB_WORKSPACE_BYTES;
  return kind === 'auditList' ? 16 * 1024 * 1024 : kind === 'auditPage' ? 2 * 1024 * 1024 : HUB_MEMBER_RESULT_BYTES;
}
export const HUB_MEMBER_CONFIG_BYTES = 262_144;
export type HubMemberOwnerConfig = { file: string; encryptionSecret?: string;
  lifecycleEndpoints?: readonly LifecycleEndpoint[]; administratorKey?: string; localMaintenanceConnectionId?: string;
  loginLimiter?: Omit<LoginAttemptLimiterOptions, 'now'>; bootstrap?: HubMemberBootstrap;
  auth?: { file: string; legacyFiles: string[]; kind?: never }
    | { kind: 'json'; passkeysFile: string; sessionsFile: string } };
function limiterPolicy(value: unknown): Omit<LoginAttemptLimiterOptions, 'now'> {
  if (!object(value) || Object.keys(value).some(k => !['maxFailures', 'windowMs', 'lockoutMs', 'maxBuckets'].includes(k)))
    throw new HubMemberOwnerUnavailable();
  for (const field of ['maxFailures', 'windowMs', 'lockoutMs', 'maxBuckets']) {
    const number = value[field];
    if (field === 'maxBuckets' && number === undefined) continue;
    if (!Number.isSafeInteger(number) || Number(number) < 1) throw new HubMemberOwnerUnavailable();
  }
  return { maxFailures: value.maxFailures as number, windowMs: value.windowMs as number,
    lockoutMs: value.lockoutMs as number, ...(value.maxBuckets === undefined ? {} : { maxBuckets: value.maxBuckets as number }) };
}
/** Parsed, descriptor-safe configuration only. Keep all original Hub options;
 * no credentials, endpoints or file names enter observations. */
export function hubMemberOwnerConfig(value: unknown): HubMemberOwnerConfig {
  if (!object(value) || Object.keys(value).some(k => !['file', 'encryptionSecret', 'lifecycleEndpoints', 'administratorKey', 'loginLimiter', 'bootstrap', 'auth', 'localMaintenanceConnectionId'].includes(k))
    || typeof value.file !== 'string' || !value.file || value.file === ':memory:' || value.file.includes('\0')
    || value.encryptionSecret !== undefined && typeof value.encryptionSecret !== 'string'
    || value.administratorKey !== undefined && typeof value.administratorKey !== 'string'
    || value.localMaintenanceConnectionId !== undefined && (typeof value.localMaintenanceConnectionId !== 'string' || !value.localMaintenanceConnectionId
      || value.localMaintenanceConnectionId.includes('\0') || Buffer.byteLength(value.localMaintenanceConnectionId) > 512)) throw new HubMemberOwnerUnavailable();
  try {
    let auth: HubMemberOwnerConfig['auth'];
    if (value.auth !== undefined) {
      const v = value.auth;
      if (object(v) && v.kind === 'json') {
        if (Object.keys(v).length !== 3 || !Object.hasOwn(v, 'passkeysFile') || !Object.hasOwn(v, 'sessionsFile')
          || ![v.passkeysFile, v.sessionsFile].every(p => typeof p === 'string' && !!p && p !== ':memory:' && !p.includes('\0')))
          throw new HubMemberOwnerUnavailable();
        auth = { kind: 'json', passkeysFile: v.passkeysFile as string, sessionsFile: v.sessionsFile as string };
      } else {
      if (!object(v) || Object.keys(v).length !== 2 || !Object.hasOwn(v, 'file') || !Object.hasOwn(v, 'legacyFiles')
        || typeof v.file !== 'string' || !v.file || v.file === ':memory:' || v.file.includes('\0')
        || !Array.isArray(v.legacyFiles) || v.legacyFiles.length > 64
        || !v.legacyFiles.every(p => typeof p === 'string' && !!p && !p.includes('\0'))) throw new HubMemberOwnerUnavailable();
      auth = { file: v.file, legacyFiles: [...v.legacyFiles] };
      }
    }
    return { file: value.file,
      ...(value.localMaintenanceConnectionId === undefined ? {} : { localMaintenanceConnectionId: value.localMaintenanceConnectionId }),
      ...(auth ? { auth } : {}),
      ...(value.encryptionSecret === undefined ? {} : { encryptionSecret: value.encryptionSecret }),
      ...(value.administratorKey === undefined ? {} : { administratorKey: value.administratorKey }),
      ...(value.bootstrap === undefined ? {} : { bootstrap: parseHubMemberBootstrap(value.bootstrap) }),
      ...(value.loginLimiter === undefined ? {} : { loginLimiter: limiterPolicy(value.loginLimiter) }),
      ...(value.lifecycleEndpoints === undefined ? {} : { lifecycleEndpoints: parseLifecycleEndpoints(JSON.stringify(value.lifecycleEndpoints)) }) };
  } catch { throw new HubMemberOwnerUnavailable(); }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const credential = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  && Buffer.byteLength(v) <= 4096 && !/[\x00-\x20\x7f]/.test(v);
const session = (v: unknown): v is string => typeof v === 'string' && /^hub_session_[A-Za-z0-9_-]{43}$/.test(v);
const scope = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
// The original request fingerprint truncates SHA-256 to 24 hexadecimal
// characters. Recovery scopes use the full hash and are a different domain.
const sourceHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v);
const identity = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 4096
  && !/[\x00-\x1f\x7f]/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
function fingerprint(v: unknown): boolean {
  return v === undefined || object(v) && Object.keys(v).every(k => k === 'ipHash' || k === 'userAgentHash')
    && (v.ipHash === undefined || sourceHash(v.ipHash)) && (v.userAgentHash === undefined || sourceHash(v.userAgentHash));
}
/** Pin audit metadata before permission awaits. Reject executable descriptors,
 * proxies and unknown fields without running caller code. This is not proof. */
export function copyHubMemberFingerprint(value?: Fingerprint): Readonly<Fingerprint> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new HubMemberOwnerUnavailable();
  const copy: Fingerprint = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'ipHash' && key !== 'userAgentHash') throw new HubMemberOwnerUnavailable();
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (!field.enumerable || !Object.hasOwn(field, 'value')) throw new HubMemberOwnerUnavailable();
    if (field.value === undefined) continue;
    if (!sourceHash(field.value)) throw new HubMemberOwnerUnavailable();
    copy[key] = field.value;
  }
  return Object.freeze(copy);
}
/** Validate parsed JSON only: the parent must reject descriptors/proxies and
 * bound bytes before serialization; the worker independently repeats this. */
export function validHubMemberInput(kind: HubMemberKind, input: unknown): boolean {
  if (kind === 'weixinBackground') return validWeixinBackgroundCommand(input);
  if (kind === 'weixinBindingEffect') return validWeixinBindingEffectCommand(input);
  if (kind === 'connectionControlSettlement') return validConnectionControlSettlement(input);
  if (kind === 'quickChatEffect') return validHubQuickChatEffectCommand(input);
  if (kind === 'contentBackground') return validContentBackgroundCommand(input);
  if (kind === 'nativeFileBackground') return validNativeFileBackgroundCommand(input);
  if (kind === 'eventFeed') return validHubEventFeedInput(input);
  if (kind === 'legacyAuth') return validHubLegacyAuthCommand(input);
  if (kind === 'boardMachine') return validHubBoardMachineCommand(input);
  if (kind === 'notebookMachine') return validHubNotebookMachineCommand(input);
  if (kind === 'executionLease') return validHubExecutionLeaseCommand(input);
  if (kind === 'executionIssuer') return validHubExecutionIssuerCommand(input);
  if (!object(input)) return false;
  const keys = Object.keys(input);
  // Bridge references are not general login credentials. They may observe
  // session state and the original Connector authority only, never issue Keys,
  // mutate workspaces, acquire leases or grant administrator capabilities.
  if (object(input.evidence) && Object.hasOwn(input.evidence, 'weixinBinding')
    && !['sessionStateSnapshot', 'sessionStateCheck', 'connectorAccess', 'connectionTarget', 'ownerControl'].includes(kind)) return false;
  if (kind === 'weixin') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubWeixinCommand(input.command);
  if (kind === 'storageMaintenance') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validStorageMaintenanceCommand(input.command);
  if (kind === 'nativeFile') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubNativeFileCommand(input.command);
  if (kind === 'usageManifest') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubUsageManifestCommand(input.command);
  if (kind === 'delegation') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubDelegationCommand(input.command);
  if (kind === 'contentDocument') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubContentDocumentCommand(input.command);
  if (kind === 'boardBinding') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubBoardBindingCommand(input.command);
  if (kind === 'taskSession') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubTaskSessionCommand(input.command);
  if (kind === 'connectorAccess' && object(input.evidence) && Object.hasOwn(input.evidence, 'weixinBinding')
    && (!object(input.command) || input.command.maintenance !== false || Object.hasOwn(input.command, 'grant'))) return false;
  if (kind === 'sharedDirectory') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubSharedDirectoryCommand(input.command);
  if (kind === 'issuerManagement') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubIssuerManagementCommand(input.command);
  if (kind === 'quickChatExecution') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubQuickChatExecutionCommand(input.command);
  if (kind === 'sharedCreation') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubSharedCreationCommand(input.command);
  if (kind === 'maintenanceCommand') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubMaintenanceCommand(input.command);
  if (kind === 'eventReplay') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubEventReplayCommand(input.command);
  if (kind === 'sharedRead') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubSharedReadCommand(input.command);
  if (kind === 'lifecycleCommand') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubLifecycleCommand(input.command);
  if (kind === 'executionCommand') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubExecutionCommand(input.command);
  if (kind === 'ownerControl') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubOwnerControlCommand(input.command)
    && (input.command.action !== 'claim' || input.command.target.operation !== 'message'
      || object(input.evidence) && !!input.evidence.weixinBinding);
  if (kind === 'connectorAccess') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubConnectorAccessCommand(input.command);
  if (kind === 'eventAppend') return keys.length === 3 && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot',input.evidence) && scope(input.expectedScope) && validHubEventCommand(input.command);
  if (kind === 'quickChatCleanup') return keys.length === 3
    && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubQuickChatCleanupCommand(input.command);
  if (kind === 'quickChatState') return keys.length === 3
    && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubQuickChatStateCommand(input.command);
  if (kind === 'sessionGuidance') return keys.length === 3
    && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubGuidanceCommand(input.command);
  if (kind === 'ownedSessionSharing') return keys.length === 3
    && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubOwnedSessionSharingCommand(input.command);
  if (kind === 'sessionSharing') return keys.length === 3
    && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubSessionSharingCommand(input.command);
  if (kind === 'sessionCollaborators') return keys.length === 3
    && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubSessionCollaboratorCommand(input.command);
  if (kind === 'creationEnvironments') return keys.length === 3
    && keys.every(k=>['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot',input.evidence) && scope(input.expectedScope) && validHubCreationDiscoveryCommand(input.command);
  if (kind === 'receivedGrants') return keys.length === 3
    && keys.every(k => ['evidence','expectedScope','command'].includes(k))
    && validHubMemberInput('memberSnapshot',input.evidence) && scope(input.expectedScope) && validHubReceivedGrantCommand(input.command);
  if (kind === 'grantRead' || kind === 'grantChange') return keys.length === 3
    && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubGrantCommand(input.command)
    && (kind === 'grantRead' ? ['authorize', 'list', 'get'].includes(input.command.action) : ['create', 'replace', 'revoke'].includes(input.command.action));
  if (kind === 'membershipRead' || kind === 'membershipSet') return keys.length === 3
    && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubMembershipCommand(input.command)
    && (kind === 'membershipRead' ? input.command.action !== 'set' : input.command.action === 'set');
  if (kind === 'roleRead' || kind === 'roleSet') return keys.length === 3
    && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope)
    && validHubRoleCommand(input.command) && input.command.action === (kind === 'roleRead' ? 'read' : 'set');
  if (kind === 'notebookControl') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubNotebookControlCommand(input.command);
  if (kind === 'personalNotebook') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubNotebookCommand(input.command);
  if (kind === 'fileBindingRead') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubFileBindingCommand(input.command);
  if (kind === 'workspaceReport') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubReportCommand(input.command);
  if (kind === 'workspaceProjection') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubProjectionCommand(input.command);
  if (kind === 'workspaceConfiguration') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubConfigurationCommand(input.command);
  if (kind === 'workspaceVisual') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubVisualCommand(input.command);
  if (kind === 'workspaceBoard') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubBoardCommand(input.command);
  if (kind === 'boardCapability') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubBoardCapabilityCommand(input.command);
  if (kind === 'connectionControl') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubConnectionControlCommand(input.command);
  if (kind === 'connectionTarget') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'id'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && identity(input.id);
  if (kind === 'connectionChange') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'change'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubConnectionChange(input.change);
  if (kind === 'userChange') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'change'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubUserChange(input.change);
  if (kind === 'sessionStateSnapshot' || kind === 'sessionStateCheck') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubSessionStateCommand(input.command)
    && input.command.action === (kind === 'sessionStateSnapshot' ? 'read' : 'check');
  if (kind === 'connectionDirectory' || kind === 'connectionDirectoryCheck' || kind === 'connectionDirectoryVersion') return keys.length === 3 && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubConnectionDirectoryCommand(input.command)
    && input.command.action === (kind === 'connectionDirectory' ? 'read' : kind === 'connectionDirectoryVersion' ? 'version' : 'check');
  if (kind === 'memberActivity' || kind === 'connectionSnapshot' || kind === 'userDirectory' || kind === 'accessDirectory') return keys.length === 2 && keys.every(k => ['evidence', 'expectedScope'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope);
  if (kind === 'sessionPreferenceSet') return keys.length === 3
    && keys.every(k => ['evidence', 'expectedScope', 'change'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope)
    && validHubSessionPreferenceChange(input.change);
  if (kind === 'completionSummary' || kind === 'completionObserve' || kind === 'completionRead') return keys.length === 3
    && keys.every(k => ['evidence', 'expectedScope', 'command'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubCompletionAction(input.command)
    && input.command.action === (kind === 'completionSummary' ? 'summary' : kind === 'completionObserve' ? 'observe' : 'read');
  if (kind === 'layoutGet' || kind === 'layoutSave') return keys.length === (kind === 'layoutGet' ? 3 : 4)
    && keys.every(k => ['evidence', 'expectedScope', 'layoutKind', ...(kind === 'layoutSave' ? ['document'] : [])].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope) && validHubLayoutKind(input.layoutKind)
    && (kind === 'layoutGet' || validHubLayoutDocument(input.document, input.layoutKind));
  if (kind === 'workspaceGet' || kind === 'workspaceSave') return keys.length === (kind === 'workspaceGet' ? 2 : 3)
    && keys.every(k => ['evidence', 'expectedScope', ...(kind === 'workspaceSave' ? ['document'] : [])].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope)
    && (kind === 'workspaceGet' || validHubWorkspaceDocument(input.document));
  if (kind === 'auditAppend') return keys.length === 1 && validHubAuditRecord(input.record);
  if (kind === 'auditPage' || kind === 'auditList') return keys.length === 3
    && keys.every(k => ['evidence', 'expectedScope', kind === 'auditPage' ? 'options' : 'limit'].includes(k))
    && validHubMemberInput('memberSnapshot', input.evidence) && scope(input.expectedScope)
    && (kind === 'auditPage' ? validHubAuditOptions(input.options) : typeof input.limit === 'number' && Number.isFinite(input.limit));
  if (kind === 'memberIdentity') return input.action === 'request'
    ? keys.length === 2 && keys.every(k => k === 'action' || k === 'evidence') && validHubMemberInput('memberSnapshot', input.evidence)
    : input.action === 'key' && keys.every(k => k === 'action' || k === 'key')
      && (input.key === undefined || credential(input.key));
  if (kind === 'memberSnapshot') {
    if (Object.hasOwn(input, 'weixinBinding')) {
      const binding = input.weixinBinding;
      return keys.length === 1 && object(binding) && Object.keys(binding).length === 3
        && Object.keys(binding).every(k => ['id', 'user', 'keyId'].includes(k))
        && uuid(binding.id) && identity(binding.user) && identity(binding.keyId);
    }
    return keys.every(k => k === 'accessKey' || k === 'sessionToken')
      && (input.accessKey === undefined || credential(input.accessKey))
      && (input.sessionToken === undefined || credential(input.sessionToken));
  }
  if (kind === 'memberSessionCreate') return keys.length === 1 && credential(input.key)
    && /^hub_key_[A-Za-z0-9_-]{43}$/.test(input.key);
  if (kind === 'memberSessionDelete') return keys.length === 1 && session(input.token);
  // Existing HTTP subject is the source fingerprint hash, not a plaintext IP,
  // user-agent, supplied key or client-declared persisted bucket identifier.
  if (kind === 'loginLimiterCheck' || kind === 'loginLimiterFailure' || kind === 'loginLimiterSuccess')
    return keys.length === 1 && sourceHash(input.subject);
  const allowed = kind === 'memberKeysRead' ? ['evidence', 'expectedScope', 'userId']
    : kind === 'memberKeyIssue' ? ['evidence', 'expectedScope', 'userId', 'fingerprint']
    : kind === 'memberKeyRevoke' ? ['evidence', 'expectedScope', 'userId', 'keyId', 'fingerprint'] : [];
  return keys.every(k => allowed.includes(k)) && validHubMemberInput('memberSnapshot', input.evidence)
    && scope(input.expectedScope) && identity(input.userId)
    && (kind !== 'memberKeyRevoke' || uuid(input.keyId))
    && (kind === 'memberKeysRead' || fingerprint(input.fingerprint));
}
export function validHubMemberOutput(kind: HubMemberKind, value: unknown): boolean {
  if (kind === 'weixinBackground') return validWeixinBackgroundResult(value);
  if (kind === 'storageMaintenance') return validStorageMaintenanceResult(value);
  if (kind === 'weixin') return validHubWeixinResult(value);
  if (kind === 'weixinBindingEffect') return validWeixinBindingEffectResult(value);
  if (kind === 'connectionControl') return validHubConnectionControlResult(value);
  if (kind === 'connectionControlSettlement') return validConnectionControlSettlementResult(value);
  if (kind === 'delegation') return validHubDelegationResult(value);
  if (kind === 'nativeFile') return validHubNativeFileResult(value);
  if (kind === 'contentBackground') return validContentBackgroundResult(value);
  if (kind === 'nativeFileBackground') return validNativeFileBackgroundResult(value);
  if (kind === 'contentDocument') return validHubContentDocumentResult(value);
  if (kind === 'taskSession') return validHubTaskSessionResult(value);
  if (kind === 'boardBinding') return validHubBoardBindingResult(value);
  if (kind === 'usageManifest') return validHubUsageManifestResult(value);
  if (kind === 'eventFeed') return validHubEventFeedResult(value);
  if (kind === 'legacyAuth') return validHubLegacyAuthResult(value);
  if (kind === 'sharedDirectory') return validHubSharedDirectoryResult(value);
  if (kind === 'notebookControl') return validHubNotebookControlResult(value);
  if (kind === 'personalNotebook') return validHubNotebookResult(value);
  if (kind === 'boardMachine') return validHubBoardMachineResult(value);
  if (kind === 'notebookMachine') return validHubNotebookMachineResult(value);
  if (kind === 'executionLease') return validHubExecutionLeaseResult(value);
  if (kind === 'fileBindingRead') return validHubFileBindingResult(value);
  if (kind === 'workspaceReport') return validHubReportResult(value);
  if (kind === 'workspaceProjection') return validHubProjectionResult(value);
  if (kind === 'workspaceConfiguration') return validHubConfigurationResult(value);
  if (kind === 'workspaceVisual') return validHubVisualResult(value);
  if (kind === 'workspaceBoard') return validHubBoardResult(value);
  if (kind === 'boardCapability') return validHubBoardCapabilityResult(value);
  if (kind === 'executionIssuer') return validHubExecutionIssuerResult(value);
  if (kind === 'eventAppend') return validHubEventResult(value);
  if (kind === 'quickChatExecution') return validHubQuickChatExecutionResult(value);
  if (kind === 'quickChatEffect') return validHubQuickChatEffectResult(value);
  if (kind === 'quickChatCleanup') return validHubQuickChatCleanupResult(value);
  if (kind === 'quickChatState') return validHubQuickChatStateResult(value);
  if (kind === 'sessionGuidance') return validHubGuidanceResult(value);
  if (kind === 'ownedSessionSharing') return validHubOwnedSessionSharingResult(value);
  if (kind === 'sessionSharing') return validHubSessionSharingResult(value);
  if (kind === 'sessionCollaborators') return validHubSessionCollaboratorResult(value);
  if (kind === 'creationEnvironments') return validHubCreationDiscoveryResult(value);
  if (kind === 'receivedGrants') return validHubReceivedGrantResult(value);
  if (kind === 'grantRead' || kind === 'grantChange') return validHubGrantResult(value);
  if (kind === 'membershipRead' || kind === 'membershipSet') return validHubMembershipResult(value);
  if (kind === 'accessDirectory') return validHubAccessDirectoryResult(value);
  if (kind === 'roleRead' || kind === 'roleSet') return validHubRoleResult(value);
  if (kind === 'issuerManagement') return validHubIssuerManagementResult(value);
  if (kind === 'sharedCreation') return validHubSharedCreationResult(value);
  if (kind === 'maintenanceCommand') return validHubMaintenanceResult(value);
  if (kind === 'eventReplay') return validHubEventReplayResult(value);
  if (kind === 'sharedRead') return validHubSharedReadResult(value);
  if (kind === 'lifecycleCommand') return validHubLifecycleResult(value);
  if (kind === 'executionCommand') return validHubExecutionCommandResult(value);
  if (kind === 'ownerControl') return validHubOwnerControlResult(value);
  if (kind === 'connectorAccess') return validHubConnectorAccessResult(value);
  if (kind === 'connectionTarget') return validHubConnectionTarget(value);
  if (kind === 'connectionChange') return validHubConnectionChangeResult(value);
  if (kind === 'userChange') return validHubUserChangeResult(value);
  if (kind === 'sessionStateSnapshot' || kind === 'sessionStateCheck') return validHubSessionStateResult(value)
    && (value === null || value.action === (kind === 'sessionStateSnapshot' ? 'read' : 'check'));
  if (kind === 'connectionDirectory' || kind === 'connectionDirectoryCheck' || kind === 'connectionDirectoryVersion') return validHubConnectionDirectoryResult(value)
    && (value === null || value.action === (kind === 'connectionDirectory' ? 'read' : kind === 'connectionDirectoryVersion' ? 'version' : 'check'));
  if (kind === 'userDirectory') return validHubUserDirectoryResult(value);
  if (kind === 'connectionSnapshot') return validHubConnectionSnapshot(value);
  if (kind === 'memberActivity') return value === null || object(value) && Object.keys(value).length === 1 && value.ok === true;
  if (kind === 'sessionPreferenceSet') return validHubSessionPreferenceResult(value);
  if (kind === 'completionSummary' || kind === 'completionObserve' || kind === 'completionRead')
    return validHubCompletionResult(value, kind === 'completionSummary' ? 'summary' : kind === 'completionObserve' ? 'observe' : 'read');
  if (kind === 'layoutGet' || kind === 'layoutSave') return validHubLayoutResult(value, kind === 'layoutSave');
  if (kind === 'workspaceGet' || kind === 'workspaceSave') return validHubWorkspaceResult(value, kind === 'workspaceSave');
  if (kind === 'auditAppend') return validHubAuditRecord(value, true);
  if (kind === 'auditPage') return value === null || validHubAuditPage(value);
  if (kind === 'auditList') return value === null || validHubAuditList(value);
  if (kind === 'loginLimiterCheck' || kind === 'loginLimiterFailure') {
    try { copyLoginAttemptDecision(value); return true; } catch { return false; }
  }
  if (kind === 'loginLimiterSuccess') return value === null;
  if (value === null) return true;
  if (!object(value)) return false;
  if (kind === 'memberIdentity') return Object.keys(value).length === 2
    && Object.keys(value).every(k => k === 'userId' || k === 'keyId') && identity(value.userId) && uuid(value.keyId);
  if (kind === 'memberSessionCreate') return Object.keys(value).length === 1 && session(value.token);
  if (kind === 'memberKeyIssue') return Object.keys(value).length === 1 && ['configuration_required', 'cannot_issue'].includes(value.error as string)
    || Object.keys(value).length === 2 && uuid(value.id)
      && typeof value.token === 'string' && /^hub_key_[A-Za-z0-9_-]{43}$/.test(value.token);
  if (kind === 'memberKeyRevoke') return Object.keys(value).length === 1 && typeof value.ok === 'boolean';
  if (kind === 'memberKeysRead') return Object.keys(value).length === 1 && Array.isArray(value.keys) && value.keys.length <= 64
    && value.keys.every(row => object(row) && Object.keys(row).length === 6
      && Object.keys(row).every(k => ['id', 'createdAt', 'lastLoginAt', 'lastUsedAt', 'lastActiveAt', 'loginCount'].includes(k))
      && uuid(row.id) && Number.isSafeInteger(row.createdAt) && Number(row.createdAt) >= 0
      && [row.lastLoginAt, row.lastUsedAt, row.lastActiveAt].every(v => v === null || Number.isSafeInteger(v) && Number(v) >= 0)
      && Number.isSafeInteger(row.loginCount) && Number(row.loginCount) >= 0);
  if (kind !== 'memberSnapshot' || Object.keys(value).length !== 2 || !object(value.principal)) return false;
  const p = value.principal;
  return Object.keys(p).length === 2 && typeof p.userId === 'string' && p.userId.length > 0
    && Buffer.byteLength(p.userId) <= 4096 && typeof p.admin === 'boolean'
    && typeof value.recoveryScope === 'string' && /^[a-f0-9]{64}$/.test(value.recoveryScope);
}
/** Own the COMPLETE HubStore in one worker. The initial command surface only
 * migrates member identity operations: not the whole caller graph, nor an authority
 * callback for later writes. Legacy administrator/anonymous authority remains
 * unsupported (denied), never serialized as `authorized: true`.
 * The original identity store still owns the session/usage savepoint. */
export type HubMemberDispatchResult<K extends HubMemberKind> = K extends 'storageMaintenance' | 'connectionControl' | 'executionLease' | 'executionIssuer' | 'ownerControl' | 'executionCommand' | 'lifecycleCommand' | 'maintenanceCommand' | 'sharedCreation' | 'usageManifest' | 'contentBackground'
  ? Promise<HubMemberCommands[K]['output']> : HubMemberCommands[K]['output'];
export function executeHubMemberCommand<K extends HubMemberKind>(owner: HubStore, kind: K,
  input: HubMemberCommands[K]['input'], limiter?: PersistentLoginAttemptLimiter): HubMemberDispatchResult<K> {
  if (!validHubMemberInput(kind, input) || kind === 'legacyAuth') throw new HubMemberOwnerUnavailable();
  if (kind === 'storageMaintenance') {
    const proof = input as HubMemberCommands['storageMaintenance']['input'];
    return executeStorageMaintenance(owner, request(proof.evidence), proof.expectedScope, proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'weixinBackground') return owner.weixinBackgroundCommand(input as WeixinBackgroundCommand) as HubMemberDispatchResult<K>;
  if (kind === 'weixinBindingEffect') return owner.weixinBindingEffectCommand(input as WeixinBindingEffectCommand) as HubMemberDispatchResult<K>;
  if (kind === 'weixin') {
    const proof = input as HubMemberCommands['weixin']['input'];
    return owner.identities.memberWeixinCommand(request(proof.evidence), proof.expectedScope, owner, proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'connectionControlSettlement') return owner.connectionControlSettlement(input as ConnectionControlSettlement) as HubMemberDispatchResult<K>;
  if (kind === 'contentBackground') return executeContentBackground(owner, input as ContentBackgroundCommand) as HubMemberDispatchResult<K>;
  if (kind === 'nativeFileBackground') return owner.nativeFileBackgroundCommand(input as NativeFileBackgroundCommand) as HubMemberDispatchResult<K>;
  if (kind === 'eventFeed') return owner.eventFeedCommand(input as HubEventFeedInput) as HubMemberDispatchResult<K>;
  if (kind === 'sharedRead') {
    const proof = input as HubMemberCommands['sharedRead']['input'];
    return owner.identities.memberSharedReadCommand(request(proof.evidence), proof.expectedScope, owner, proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'boardMachine') return owner.identities.boardMachineCommand(owner.boardCapabilities, input as HubBoardMachineCommand) as HubMemberDispatchResult<K>;
  if (kind === 'notebookMachine') return owner.identities.notebookMachineCommand(owner, input as HubNotebookMachineCommand) as HubMemberDispatchResult<K>;
  if (kind === 'eventReplay') {
    const proof = input as HubMemberCommands['eventReplay']['input'];
    return owner.identities.memberEventReplayCommand(request(proof.evidence), proof.expectedScope, owner, proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'executionLease') return owner.executionLeaseCommand(input as HubExecutionLeaseCommand) as HubMemberDispatchResult<K>;
  if (kind === 'executionIssuer') return executeHubExecutionIssuerCommand(owner, input as HubExecutionIssuerCommand) as HubMemberDispatchResult<K>;
  if (kind === 'quickChatEffect') return executeHubQuickChatEffectCommand(owner, input as HubQuickChatEffectCommand) as HubMemberDispatchResult<K>;
  // The original guarded SQL statement owns bounded rollback recovery. Do not
  // replace it with a snapshot-only fence that would make owner rollback
  // permanently unreachable, and never clear/repair the original fence here.
  let value: unknown;
  function request(proof: HubMemberEvidence) {
    if (proof.weixinBinding) return owner.identities.weixinCommandRequest(owner.weixin, proof.weixinBinding);
    const headers = new Headers();
    if (proof.accessKey !== undefined) headers.set('x-agentopsdeck-key', proof.accessKey);
    if (proof.sessionToken !== undefined) headers.set('cookie', 'agentopsdeck_session=' + encodeURIComponent(proof.sessionToken));
    return new Request('http://localhost/', { headers });
  }
  if (kind === 'connectionControl') {
    const proof = input as HubMemberCommands['connectionControl']['input'];
    return claimHubConnectionControl(owner, request(proof.evidence), proof.expectedScope, proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'issuerManagement') {
    const proof = input as HubMemberCommands['issuerManagement']['input'];
    return owner.identities.memberIssuerManagementCommand(request(proof.evidence), proof.expectedScope, owner, proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'usageManifest') {
    const proof = input as HubMemberCommands['usageManifest']['input'];
    return executeHubUsageManifest(owner, request(proof.evidence), proof.expectedScope, proof.command)
      .then(result => { if (!validHubUsageManifestResult(result)) throw new HubMemberOwnerUnavailable(); return result; }) as HubMemberDispatchResult<K>;
  }
  if (kind === 'delegation') {
    const proof = input as HubMemberCommands['delegation']['input'];
    return owner.identities.memberDelegationCommand(request(proof.evidence),proof.expectedScope,owner,proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'contentDocument') {
    const proof = input as HubMemberCommands['contentDocument']['input'];
    return owner.identities.memberContentDocumentCommand(request(proof.evidence),proof.expectedScope,owner,proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'nativeFile') {
    const proof = input as HubMemberCommands['nativeFile']['input'];
    return owner.identities.memberNativeFileCommand(request(proof.evidence), proof.expectedScope, owner, proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'boardBinding') {
    const proof = input as HubMemberCommands['boardBinding']['input'];
    return owner.identities.memberBoardBindingCommand(request(proof.evidence),proof.expectedScope,owner,proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'taskSession') {
    const proof = input as HubMemberCommands['taskSession']['input'];
    return owner.identities.memberTaskSessionCommand(request(proof.evidence),proof.expectedScope,owner,proof.command) as HubMemberDispatchResult<K>;
  }
  if (kind === 'sharedCreation') {
    const proof = input as HubMemberCommands['sharedCreation']['input'];
    return (proof.command.action === 'claim'
      ? claimHubSharedCreation(owner, request(proof.evidence), proof.expectedScope, proof.command)
      : Promise.resolve(owner.identities.memberSharedCreationCommand(request(proof.evidence), proof.expectedScope, owner, proof.command)))
      .then(result => { if (!validHubMemberOutput(kind, result)) throw new HubMemberOwnerUnavailable(); return result; }) as HubMemberDispatchResult<K>;
  }
  if (kind === 'maintenanceCommand') {
    const proof = input as HubMemberCommands['maintenanceCommand']['input'];
    return (proof.command.action === 'claim'
      ? claimHubMaintenanceCommand(owner, request(proof.evidence), proof.expectedScope, proof.command)
      : Promise.resolve(owner.identities.memberMaintenanceCommand(request(proof.evidence), proof.expectedScope, owner, proof.command)))
      .then(result => { if (!validHubMemberOutput(kind, result)) throw new HubMemberOwnerUnavailable(); return result; }) as HubMemberDispatchResult<K>;
  }
  if (kind === 'lifecycleCommand') {
    const proof = input as HubMemberCommands['lifecycleCommand']['input'];
    return (proof.command.action === 'claim'
      ? claimHubLifecycleCommand(owner, request(proof.evidence), proof.expectedScope, proof.command)
      : Promise.resolve(owner.identities.memberLifecycleCommand(request(proof.evidence), proof.expectedScope, owner, proof.command)))
      .then(result => { if (!validHubMemberOutput(kind, result)) throw new HubMemberOwnerUnavailable(); return result; }) as HubMemberDispatchResult<K>;
  }
  if (kind === 'executionCommand') {
    const proof = input as HubMemberCommands['executionCommand']['input'];
    return (proof.command.action === 'claim' || proof.command.action === 'queueClaim'
      ? claimHubExecutionCommand(owner, request(proof.evidence), proof.expectedScope, proof.command)
      : Promise.resolve(owner.identities.memberExecutionCommand(request(proof.evidence), proof.expectedScope, owner, proof.command)))
      .then(result => { if (!validHubMemberOutput(kind, result)) throw new HubMemberOwnerUnavailable(); return result; }) as HubMemberDispatchResult<K>;
  }
  if (kind === 'ownerControl') {
    const proof = input as HubMemberCommands['ownerControl']['input'];
    if (proof.evidence.weixinBinding && !weixinBackgroundStop(owner, proof.evidence.weixinBinding,
      proof.command.target.connectionId, proof.command)) return Promise.resolve({error:403}) as HubMemberDispatchResult<K>;
    return (proof.command.action === 'claim' || proof.command.action === 'claimDigest'
      ? claimHubOwnerControl(owner, request(proof.evidence), proof.expectedScope, proof.command)
      : Promise.resolve(owner.identities.memberOwnerControlCommand(request(proof.evidence), proof.expectedScope, owner, proof.command)))
      .then(result => { if (!validHubMemberOutput(kind, result)) throw new HubMemberOwnerUnavailable(); return result; }) as HubMemberDispatchResult<K>;
  }
  if (kind === 'eventAppend') {
    const proof = input as HubEventProof;
    value = executeHubEventCommand(owner,request(proof.evidence),proof);
  } else if (kind === 'quickChatExecution') {
    const proof = input as HubMemberCommands['quickChatExecution']['input'];
    value = owner.identities.memberQuickChatExecutionCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'quickChatCleanup') {
    const proof = input as HubMemberCommands['quickChatCleanup']['input'];
    value = owner.identities.memberQuickChatCleanupCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'quickChatState') {
    const proof = input as HubMemberCommands['quickChatState']['input'];
    value = owner.identities.memberQuickChatStateCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'sessionGuidance') {
    const proof = input as HubMemberCommands['sessionGuidance']['input'];
    value = owner.identities.memberGuidanceCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'ownedSessionSharing') {
    const proof = input as HubMemberCommands['ownedSessionSharing']['input'];
    value = owner.identities.memberOwnedSessionSharingCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'sessionSharing') {
    const proof = input as HubMemberCommands['sessionSharing']['input'];
    value = owner.identities.memberSessionSharingCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'sessionCollaborators') {
    const proof = input as HubMemberCommands['sessionCollaborators']['input'];
    value = owner.identities.memberSessionCollaboratorCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'creationEnvironments') {
    const proof = input as HubMemberCommands['creationEnvironments']['input'];
    value = owner.identities.memberCreationDiscoveryCommand(request(proof.evidence),proof.expectedScope,owner,proof.command);
  } else if (kind === 'receivedGrants') {
    const proof = input as HubMemberCommands['receivedGrants']['input'];
    value = owner.identities.memberReceivedGrantCommand(request(proof.evidence),proof.expectedScope,owner,proof.command);
  } else if (kind === 'grantRead' || kind === 'grantChange') {
    const proof = input as HubMemberCommands['grantRead']['input'] | HubMemberCommands['grantChange']['input'];
    value = owner.identities.memberGrantCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'membershipRead' || kind === 'membershipSet') {
    const proof = input as HubMemberCommands['membershipRead']['input'] | HubMemberCommands['membershipSet']['input'];
    value = owner.identities.memberMembershipCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'accessDirectory') {
    const proof = input as HubMemberCommands['accessDirectory']['input'];
    value = owner.identities.memberAccessDirectoryCommand(request(proof.evidence), proof.expectedScope, owner);
  } else if (kind === 'roleRead' || kind === 'roleSet') {
    const proof = input as HubMemberCommands['roleRead']['input'] | HubMemberCommands['roleSet']['input'];
    value = owner.identities.administratorRoleCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'sharedDirectory') {
    const proof = input as HubMemberCommands['sharedDirectory']['input'];
    value = owner.identities.memberSharedDirectoryCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'connectorAccess') {
    const proof = input as HubMemberCommands['connectorAccess']['input'];
    value = owner.identities.memberConnectorAccessCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'connectionTarget') {
    const proof = input as HubMemberCommands['connectionTarget']['input'];
    if (proof.evidence.weixinBinding && !weixinBackgroundStop(owner, proof.evidence.weixinBinding, proof.id))
      return {error:403} as HubMemberDispatchResult<K>;
    value = owner.identities.memberConnectionTargetCommand(request(proof.evidence), proof.expectedScope, owner, proof.id);
  } else if (kind === 'connectionChange') {
    const proof = input as HubMemberCommands['connectionChange']['input'];
    value = owner.identities.memberConnectionChangeCommand(request(proof.evidence), proof.expectedScope, owner, proof.change);
  } else if (kind === 'userChange') {
    const proof = input as HubMemberCommands['userChange']['input'];
    value = owner.identities.administratorUserCommand(request(proof.evidence), proof.expectedScope, owner, proof.change);
  } else if (kind === 'sessionStateSnapshot' || kind === 'sessionStateCheck') {
    const proof = input as HubMemberCommands['sessionStateSnapshot']['input'];
    value = owner.identities.memberSessionStateCommand(request(proof.evidence), proof.expectedScope, proof.command);
  } else if (kind === 'connectionDirectory' || kind === 'connectionDirectoryCheck' || kind === 'connectionDirectoryVersion') {
    const proof = input as HubMemberCommands['connectionDirectory']['input'];
    value = owner.identities.memberConnectionDirectoryCommand(request(proof.evidence), proof.expectedScope, proof.command);
  } else if (kind === 'userDirectory') {
    const proof = input as HubMemberCommands['userDirectory']['input'];
    value = owner.identities.memberUserDirectoryCommand(request(proof.evidence), proof.expectedScope);
  } else if (kind === 'connectionSnapshot') {
    const proof = input as HubMemberCommands['connectionSnapshot']['input'];
    value = owner.identities.memberConnectionSnapshotCommand(request(proof.evidence), proof.expectedScope);
  } else if (kind === 'memberActivity') {
    const proof = input as HubMemberCommands['memberActivity']['input'];
    value = owner.identities.memberActivityCommand(request(proof.evidence), proof.expectedScope);
  } else if (kind === 'sessionPreferenceSet') {
    const proof = input as HubMemberCommands['sessionPreferenceSet']['input'];
    value = owner.identities.memberSessionPreferenceCommand(request(proof.evidence), proof.expectedScope, owner, proof.change);
  } else if (kind === 'completionSummary' || kind === 'completionObserve' || kind === 'completionRead') {
    const proof = input as HubCompletionProof;
    value = owner.completions.memberCommand(() => hubCompletionAuthority(owner, request(proof.evidence), proof.expectedScope, proof.command), proof.command);
  } else if (kind === 'layoutGet' || kind === 'layoutSave') {
    const proof = input as HubMemberCommands['layoutSave']['input'];
    value = owner.identities.memberLayoutCommand(request(proof.evidence), proof.expectedScope, owner.layouts,
      kind === 'layoutGet' ? { action: 'get', kind: proof.layoutKind } : { action: 'save', kind: proof.layoutKind, document: proof.document });
  } else if (kind === 'notebookControl') {
    const proof = input as HubMemberCommands['notebookControl']['input'];
    value = owner.identities.memberNotebookControlCommand(request(proof.evidence), proof.expectedScope,
      owner.notebooks, owner.notebookCapabilities, proof.command, owner);
  } else if (kind === 'personalNotebook') {
    const proof = input as HubMemberCommands['personalNotebook']['input'];
    value = owner.identities.memberNotebookCommand(request(proof.evidence), proof.expectedScope, owner.notebooks, proof.command, owner);
  } else if (kind === 'fileBindingRead') {
    const proof = input as HubMemberCommands['fileBindingRead']['input'];
    value = owner.identities.memberFileBindingCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'workspaceReport') {
    const proof = input as HubMemberCommands['workspaceReport']['input'];
    value = owner.identities.memberReportCommand(request(proof.evidence), proof.expectedScope, owner, proof.command);
  } else if (kind === 'workspaceProjection') {
    const proof = input as HubMemberCommands['workspaceProjection']['input'];
    value = owner.identities.memberProjectionCommand(request(proof.evidence), proof.expectedScope, owner.cardFileProjection, proof.command);
  } else if (kind === 'workspaceConfiguration') {
    const proof = input as HubMemberCommands['workspaceConfiguration']['input'];
    value = owner.identities.memberConfigurationCommand(request(proof.evidence), proof.expectedScope, owner.cardConfigurations, proof.command);
  } else if (kind === 'workspaceVisual') {
    const proof = input as HubMemberCommands['workspaceVisual']['input'];
    value = owner.identities.memberVisualCommand(request(proof.evidence), proof.expectedScope, owner.cards, owner.drawings, owner.nativeDrawio, proof.command);
  } else if (kind === 'workspaceBoard') {
    const proof = input as HubMemberCommands['workspaceBoard']['input'];
    value = owner.identities.memberBoardCommand(request(proof.evidence), proof.expectedScope, owner.boards, proof.command, owner.boardFiles);
  } else if (kind === 'boardCapability') {
    const proof = input as HubMemberCommands['boardCapability']['input'];
    value = owner.identities.memberBoardCapabilityCommand(request(proof.evidence), proof.expectedScope, owner.boardCapabilities, proof.command);
  } else if (kind === 'workspaceGet' || kind === 'workspaceSave') {
    const proof = input as HubMemberCommands['workspaceSave']['input'];
    value = owner.identities.memberWorkspaceCommand(request(proof.evidence), proof.expectedScope, owner.workspace,
      kind === 'workspaceGet' ? { action: 'get' } : { action: 'save', document: proof.document });
  } else if (kind === 'auditAppend') {
    value = owner.identities.audit.append((input as HubMemberCommands['auditAppend']['input']).record);
  } else if (kind === 'auditPage' || kind === 'auditList') {
    const proof = input as HubMemberCommands['auditPage']['input'] & HubMemberCommands['auditList']['input'];
    value = owner.identities.administratorAuditCommand(request(proof.evidence), proof.expectedScope,
      kind === 'auditPage' ? { action: 'page', options: proof.options } : { action: 'list', limit: proof.limit });
  } else if (kind === 'loginLimiterCheck' || kind === 'loginLimiterFailure' || kind === 'loginLimiterSuccess') {
    // The original policy is constructed ONCE inside the complete Hub owner.
    // No caller-supplied policy/clock, process-local replacement or retry.
    if (!limiter) throw new HubMemberOwnerUnavailable();
    const { subject } = input as { subject: string };
    if (kind === 'loginLimiterCheck') value = copyLoginAttemptDecision(limiter.check(subject));
    else if (kind === 'loginLimiterFailure') value = copyLoginAttemptDecision(limiter.recordFailure(subject));
    else { limiter.recordSuccess(subject); value = null; }
  } else if (kind === 'memberIdentity') {
    const proof = input as HubMemberCommands['memberIdentity']['input'];
    const identity = proof.action === 'key' ? owner.identities.keyIdentity(proof.key)
      : owner.identities.requestIdentity(request(proof.evidence));
    value = identity ? { userId: identity.userId, keyId: identity.keyId } : null;
  } else if (kind === 'memberSnapshot') {
    const principal = owner.identities.commandPrincipal(request(input as HubMemberEvidence));
    value = principal ? { principal, recoveryScope: owner.identities.recoveryScope(principal) } : null;
  } else if (kind === 'memberSessionCreate') {
    const token = owner.identities.createSession((input as { key: string }).key);
    value = token === undefined ? null : { token };
  } else if (kind === 'memberSessionDelete') {
    owner.identities.revokeSession((input as { token: string }).token);
    value = null;
  } else {
    const proof = input as HubMemberKeyEvidence & { keyId?: string; fingerprint?: Fingerprint };
    value = owner.identities.administratorKeyCommand(request(proof.evidence), proof.expectedScope,
      kind === 'memberKeysRead' ? { action: 'list', userId: proof.userId }
        : kind === 'memberKeyIssue' ? { action: 'issue', userId: proof.userId,
            ...(proof.fingerprint === undefined ? {} : { fingerprint: proof.fingerprint }) }
          : { action: 'revoke', userId: proof.userId, keyId: proof.keyId!,
            ...(proof.fingerprint === undefined ? {} : { fingerprint: proof.fingerprint }) });
  }
  if (!validHubMemberOutput(kind, value)) throw new HubMemberOwnerUnavailable();
  return value as HubMemberDispatchResult<K>;
}
