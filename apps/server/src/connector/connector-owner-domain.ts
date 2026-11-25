import { connectorUpdateSteps, isConnectorUpdateKind, validConnectorUpdateInput, validConnectorUpdateOutput,
  createConnectorUpdateCommands, type ConnectorUpdateCommands } from './connector-update-domain.js';
import { connectorMaintenanceSteps, isConnectorMaintenanceKind, validConnectorMaintenanceInput,
  validConnectorMaintenanceOutput, createConnectorMaintenanceCommands, type ConnectorMaintenanceCommands } from './connector-maintenance-domain.js';
import { createAuthorizedMaintenanceCommands, validAuthorizedMaintenanceInput, validAuthorizedMaintenanceOutput,
  createAuthorizedMaintenanceResume, validAuthorizedMaintenanceResumeInput, validAuthorizedMaintenanceResumeOutput,
  type ConnectorAuthorizedMaintenanceCommands } from './connector-authorized-maintenance-domain.js';
import { connectorContentReplicaSteps, isConnectorContentReplicaKind, validConnectorContentReplicaInput,
  validConnectorContentReplicaOutput, createConnectorContentReplicaCommands, type ConnectorContentReplicaCommands } from './connector-content-replica-domain.js';
import { connectorWorkspaceFileSteps, isConnectorWorkspaceFileKind, validConnectorWorkspaceFileInput,
  validConnectorWorkspaceFileOutput, createConnectorWorkspaceFileCommands, type ConnectorWorkspaceFileCommands,
  type WorkspaceFileToolPolicies } from './connector-workspace-file-domain.js';
import { randomUUID } from 'node:crypto';
import { connectorCodexFilesSteps, isConnectorCodexFilesKind, validConnectorCodexFilesInput,
  validConnectorCodexFilesOutput, createConnectorCodexFiles, type ConnectorCodexFilesCommands } from './connector-codex-files-domain.js';
import { connectorCodexPublicUsageSteps, isConnectorCodexPublicUsageKind, validConnectorCodexPublicUsageInput,
  validConnectorCodexPublicUsageOutput, executeConnectorCodexPublicUsage, type ConnectorCodexPublicUsageCommands } from './connector-codex-public-usage-domain.js';
import { connectorCodexDeletionSteps, isConnectorCodexDeletionKind, validConnectorCodexDeletionInput,
  validConnectorCodexDeletionOutput, createConnectorCodexDeletion, type ConnectorCodexDeletionCommands } from './connector-codex-deletion-domain.js';
import { connectorCodexSettingsSteps, isConnectorCodexSettingsKind, validConnectorCodexSettingsInput,
  validConnectorCodexSettingsOutput, createConnectorCodexSettings, type ConnectorCodexSettingsCommands } from './connector-codex-settings-domain.js';
import { connectorTitleSteps, isConnectorTitleKind, validConnectorTitleInput, validConnectorTitleOutput,
  createConnectorTitle, type ConnectorTitleCommands } from './connector-title-domain.js';
import { connectorCodexCatalogSteps, isConnectorCodexCatalogKind, validConnectorCodexCatalogInput,
  validConnectorCodexCatalogOutput, executeConnectorCodexCatalog, type ConnectorCodexCatalogCommands } from './connector-codex-catalog-domain.js';
import { connectorCodexFileIndexSteps, isConnectorCodexFileIndexKind, validConnectorCodexFileIndexInput,
  validConnectorCodexFileIndexOutput, executeConnectorCodexFileIndex, CODEX_FILE_INDEX_COMMAND_BYTES,
  type ConnectorCodexFileIndexCommands } from './connector-codex-file-index-domain.js';
import { connectorCodexUsageSteps, isConnectorCodexUsageKind, validConnectorCodexUsageInput,
  validConnectorCodexUsageOutput, executeConnectorCodexUsage, type ConnectorCodexUsageCommands } from './connector-codex-usage-domain.js';
import { connectorAutomationBackgroundSteps, isConnectorAutomationBackgroundKind, validConnectorAutomationBackgroundInput,
  validConnectorAutomationBackgroundOutput, createConnectorAutomationBackground, type ConnectorAutomationBackgroundCommands } from './connector-automation-background-domain.js';
import { connectorAutomationSteps, isConnectorAutomationKind, validConnectorAutomationInput, validConnectorAutomationOutput,
  createConnectorAutomationCommands, type ConnectorAutomationCommands } from './connector-automation-domain.js';
import { connectorCodexInteractionSteps, isConnectorCodexInteractionKind, validConnectorCodexInteractionInput,
  validConnectorCodexInteractionOutput, createConnectorCodexInteractionCommands, type ConnectorCodexInteractionCommands } from './connector-codex-interaction-domain.js';
import { connectorCodexContextSteps, isConnectorCodexContextKind, validConnectorCodexContextInput,
  validConnectorCodexContextOutput, createConnectorCodexContextCommands, type ConnectorCodexContextCommands } from './connector-codex-context-domain.js';
import { parseFileBoardPolicy, type FileBoardPolicy } from './workspace-board-file-policy.js';
import { connectorSdkContextSteps, validConnectorSdkContextInput, validConnectorSdkContextOutput,
  createConnectorSdkContextCommands, type ConnectorSdkContextCommands } from './connector-sdk-context-domain.js';
import { connectorCodexResumeSteps, isConnectorCodexResumeKind, validConnectorCodexResumeInput,
  validConnectorCodexResumeOutput, executeConnectorCodexResume, type ConnectorCodexResumeCommands } from './connector-codex-resume-domain.js';
import { connectorCodexReadSteps, isConnectorCodexReadKind, validConnectorCodexReadInput,
  validConnectorCodexReadOutput, executeConnectorCodexRead, type ConnectorCodexReadCommands } from './connector-codex-read-domain.js';
import { connectorCodexSchedulingSteps, isConnectorCodexSchedulingKind, validConnectorCodexSchedulingInput,
  validConnectorCodexSchedulingOutput, executeConnectorCodexScheduling, type ConnectorCodexSchedulingCommands } from './connector-codex-scheduling-domain.js';
import { connectorCodexMessageSteps, isConnectorCodexMessageKind, validConnectorCodexMessageInput,
  validConnectorCodexMessageOutput, executeConnectorCodexMessage, disposeCodexMessageIntents,
  CODEX_MESSAGE_COMMAND_BYTES, type ConnectorCodexMessageCommands } from './connector-codex-message-domain.js';
import { connectorCodexStopSteps, isConnectorCodexStopKind, validConnectorCodexStopInput,
  validConnectorCodexStopOutput, executeConnectorCodexStop, disposeCodexStopIntents,
  type ConnectorCodexStopCommands } from './connector-codex-stop-domain.js';
import { connectorOpenClawCompactSteps, isConnectorOpenClawCompactKind, validConnectorOpenClawCompactInput,
  validConnectorOpenClawCompactOutput, executeConnectorOpenClawCompact, disposeOpenClawCompactIntents,
  type ConnectorOpenClawCompactCommands } from './connector-openclaw-compact-domain.js';
import { connectorOpenClawStatusSteps, isConnectorOpenClawStatusKind, validConnectorOpenClawStatusInput,
  validConnectorOpenClawStatusOutput, executeConnectorOpenClawStatus, type ConnectorOpenClawStatusCommands } from './connector-openclaw-status-domain.js';
import { connectorOpenClawStopSteps, isConnectorOpenClawStopKind, validConnectorOpenClawStopInput,
  validConnectorOpenClawStopOutput, executeConnectorOpenClawStop, disposeOpenClawStopIntents,
  type ConnectorOpenClawStopCommands } from './connector-openclaw-stop-domain.js';
import { connectorOpenClawMessageSteps, isConnectorOpenClawMessageKind, validConnectorOpenClawMessageInput,
  validConnectorOpenClawMessageOutput, executeConnectorOpenClawMessage, disposeOpenClawMessageIntents,
  OPENCLAW_MESSAGE_COMMAND_BYTES, type ConnectorOpenClawMessageCommands } from './connector-openclaw-message-domain.js';
import { connectorOpenClawDispatchSteps, isConnectorOpenClawDispatchKind, validConnectorOpenClawDispatchInput,
  validConnectorOpenClawDispatchOutput, executeConnectorOpenClawDispatch, type ConnectorOpenClawDispatchCommands } from './connector-openclaw-dispatch-domain.js';
import { connectorHermesReadSteps, isConnectorHermesReadKind, validConnectorHermesReadInput,
  validConnectorHermesReadOutput, executeConnectorHermesRead, type ConnectorHermesReadCommands } from './connector-hermes-read-domain.js';
import { connectorOpenClawReadSteps, isConnectorOpenClawReadKind, validConnectorOpenClawReadInput,
  validConnectorOpenClawReadOutput, executeConnectorOpenClawRead, type ConnectorOpenClawReadCommands } from './connector-openclaw-read-domain.js';
import { connectorHermesStopSteps, isConnectorHermesStopKind, validConnectorHermesStopInput,
  validConnectorHermesStopOutput, executeConnectorHermesStop, type ConnectorHermesStopCommands } from './connector-hermes-stop-domain.js';
import { connectorHermesLocalControlSteps, isConnectorHermesLocalControlKind, validConnectorHermesLocalControlInput,
  validConnectorHermesLocalControlOutput, executeConnectorHermesLocalControl, type ConnectorHermesLocalControlCommands } from './connector-hermes-local-control-domain.js';
import { connectorHermesCreationSteps, isConnectorHermesCreationKind, validConnectorHermesCreationInput,
  validConnectorHermesCreationOutput, executeConnectorHermesCreation, type ConnectorHermesCreationCommands } from './connector-hermes-creation-domain.js';
import { connectorCodexCreationSteps, isConnectorCodexCreationKind, validConnectorCodexCreationInput,
  validConnectorCodexCreationOutput, createConnectorCodexCreation, type ConnectorCodexCreationCommands } from './connector-codex-creation-domain.js';
import { connectorHermesLifecycleSteps, isConnectorHermesLifecycleKind, validConnectorHermesLifecycleInput,
  validConnectorHermesLifecycleOutput, executeConnectorHermesLifecycle, type ConnectorHermesLifecycleCommands } from './connector-hermes-lifecycle-domain.js';
import { connectorNativeQueueSteps, isConnectorNativeQueueKind, validConnectorNativeQueueInput,
  validConnectorNativeQueueOutput, executeConnectorNativeQueue, type ConnectorNativeQueueCommands } from './connector-native-queue-domain.js';
import { connectorHermesQueueSteps, isConnectorHermesQueueKind, validConnectorHermesQueueInput,
  validConnectorHermesQueueOutput, executeConnectorHermesQueue, type ConnectorHermesQueueCommands } from './connector-hermes-queue-domain.js';
import { connectorHermesDeletionSteps, isConnectorHermesDeletionKind, validConnectorHermesDeletionInput,
  validConnectorHermesDeletionOutput, executeConnectorHermesDeletion, type ConnectorHermesDeletionCommands } from './connector-hermes-deletion-domain.js';
import { connectorHermesHistorySteps, isConnectorHermesHistoryKind, validConnectorHermesHistoryInput,
  validConnectorHermesHistoryOutput, executeConnectorHermesHistory, type ConnectorHermesHistoryCommands } from './connector-hermes-history-domain.js';
import { connectorHermesDispatchSteps, isConnectorHermesDispatchKind, validConnectorHermesDispatchInput,
  validConnectorHermesDispatchOutput, executeConnectorHermesDispatch, type ConnectorHermesDispatchCommands } from './connector-hermes-dispatch-domain.js';
import { connectorHermesMessageSteps, isConnectorHermesMessageKind, validConnectorHermesMessageInput,
  validConnectorHermesMessageOutput, executeConnectorHermesMessage, HERMES_MESSAGE_COMMAND_BYTES,
  type ConnectorHermesMessageCommands } from './connector-hermes-message-domain.js';
import { connectorHermesExecutionSteps, isConnectorHermesExecutionKind, validConnectorHermesExecutionInput,
  validConnectorHermesExecutionOutput, executeConnectorHermesExecution, HERMES_TERMINAL_COMMAND_BYTES,
  type ConnectorHermesExecutionCommands } from './connector-hermes-execution-domain.js';
import { MAX_TEXT_MESSAGE_BODY_BYTES } from '@agentopsdeck/shared';
import { localCredentialsSteps, isLocalCredentialsKind, validLocalCredentialsInput, validLocalCredentialsOutput,
  createLocalCredentialsCommands, type LocalCredentialsCommands } from './local-credentials-domain.js';
import { connectorSdkMetadataSteps, isConnectorSdkMetadataKind, validConnectorSdkMetadataInput, validConnectorSdkMetadataOutput,
  executeConnectorSdkMetadata, type ConnectorSdkMetadataCommands } from './connector-sdk-metadata-domain.js';
import { connectorSdkFilesSteps, isConnectorSdkFilesKind, validConnectorSdkFilesInput, validConnectorSdkFilesOutput,
  createConnectorSdkFiles, type ConnectorSdkFilesCommands } from './connector-sdk-files-domain.js';
import { connectorSdkUsageSteps, isConnectorSdkUsageKind, validConnectorSdkUsageInput, validConnectorSdkUsageOutput,
  executeConnectorSdkUsage, type ConnectorSdkUsageCommands } from './connector-sdk-usage-domain.js';
import { connectorSdkHistorySteps, isConnectorSdkHistoryKind, validConnectorSdkHistoryInput,
  validConnectorSdkHistoryOutput, executeConnectorSdkHistory, type ConnectorSdkHistoryCommands } from './connector-sdk-history-domain.js';
import { connectorSdkStatusSteps, isConnectorSdkStatusKind, validConnectorSdkStatusInput,
  validConnectorSdkStatusOutput, executeConnectorSdkStatus, type ConnectorSdkStatusCommands } from './connector-sdk-status-domain.js';
import { connectorSdkLifecycleSteps, isConnectorSdkLifecycleKind, validConnectorSdkLifecycleInput,
  validConnectorSdkLifecycleOutput, executeConnectorSdkLifecycle, type ConnectorSdkLifecycleCommands } from './connector-sdk-lifecycle-domain.js';
import { connectorSdkStopSteps, isConnectorSdkStopKind, validConnectorSdkStopInput,
  validConnectorSdkStopOutput, executeConnectorSdkStop, type ConnectorSdkStopCommands } from './connector-sdk-stop-domain.js';
import { connectorEventSteps, isConnectorEventKind, validConnectorEventInput, validConnectorEventOutput,
  executeConnectorEvent, CONNECTOR_EVENT_COMMAND_BYTES, type ConnectorEventCommands } from './connector-event-domain.js';
import { connectorSdkLocalRecoverySteps, isConnectorSdkLocalRecoveryKind, validConnectorSdkLocalRecoveryInput,
  validConnectorSdkLocalRecoveryOutput, executeConnectorSdkLocalRecovery, type ConnectorSdkLocalRecoveryCommands } from './connector-sdk-local-recovery-domain.js';
import { connectorSdkLocalSteps, isConnectorSdkLocalKind, validConnectorSdkLocalInput, validConnectorSdkLocalOutput,
  executeConnectorSdkLocal, copySdkOwnerCatalogs, type SdkOwnerCatalogs, type ConnectorSdkLocalCommands } from './connector-sdk-local-domain.js';
import { connectorGrantSteps, isConnectorGrantKind, validConnectorGrantInput, validConnectorGrantOutput, executeConnectorGrant, type ConnectorGrantCommands } from './connector-grant-domain.js';
import { connectorStorageSteps, isConnectorStorageKind, validConnectorStorageInput, validConnectorStorageOutput, executeConnectorStorage, type ConnectorStorageCommands } from './connector-storage-domain.js';
import { connectorRecoverySteps, isConnectorRecoveryKind, validConnectorRecoveryInput, validConnectorRecoveryOutput,
  executeConnectorRecovery, type ConnectorRecoveryCommands } from './connector-recovery-domain.js';
import { types } from 'node:util';
import { connectorCodexToolsSteps, isConnectorCodexToolsKind, validConnectorCodexToolsInput,
  validConnectorCodexToolsOutput, createConnectorCodexToolsCommands, type ConnectorCodexToolsCommands } from './connector-codex-tools-domain.js';
import { connectorCodexDispatchSteps, isConnectorCodexDispatchKind, validConnectorCodexDispatchInput,
  validConnectorCodexDispatchOutput, executeConnectorCodexDispatch, type ConnectorCodexDispatchCommands } from './connector-codex-dispatch-domain.js';
import { connectorCodexQueuePlanSteps, isConnectorCodexQueuePlanKind, validConnectorCodexQueuePlanInput,
  validConnectorCodexQueuePlanOutput, createConnectorCodexQueuePlanCommands, type ConnectorCodexQueuePlanCommands } from './connector-codex-queue-plan-domain.js';
import { connectorCodexNotificationSteps, isConnectorCodexNotificationKind, validConnectorCodexNotificationInput,
  validConnectorCodexNotificationOutput, executeConnectorCodexNotification, type ConnectorCodexNotificationCommands } from './connector-codex-notification-domain.js';
import { connectorCodexStartupSteps, isConnectorCodexStartupKind, validConnectorCodexStartupInput,
  validConnectorCodexStartupOutput, createConnectorCodexStartupCommands, type ConnectorCodexStartupCommands } from './connector-codex-startup-domain.js';
import { connectorCodexHistorySteps, isConnectorCodexHistoryKind, validConnectorCodexHistoryInput,
  validConnectorCodexHistoryOutput, createConnectorCodexHistoryCommands, type ConnectorCodexHistoryCommands } from './connector-codex-history-domain.js';
import { connectorSdkMessageSteps, isConnectorSdkMessageKind, validConnectorSdkMessageInput, validConnectorSdkMessageOutput,
  executeConnectorSdkMessage, SDK_MESSAGE_COMMAND_BYTES, type ConnectorSdkMessageCommands } from './connector-sdk-message-domain.js';
import type { ConnectorUserStore, ConnectorUser } from './connector-user-store.js';
import { connectorExecutionSteps, isConnectorExecutionKind, validConnectorExecutionInput, validConnectorExecutionOutput,
  executeConnectorExecution, type ConnectorExecutionCommands } from './connector-execution-domain.js';
import { connectorExecutionObservationSteps, isConnectorExecutionObservationKind, validConnectorExecutionObservationInput,
  validConnectorExecutionObservationOutput, executeConnectorExecutionObservation, type ConnectorExecutionObservationCommands } from './connector-execution-observation-domain.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { connectorSessionMediaSteps, isConnectorSessionMediaKind, validConnectorSessionMediaInput,
  validConnectorSessionMediaOutput, executeConnectorSessionMedia, type ConnectorSessionMediaCommands } from './connector-session-media-domain.js';
import { connectorExecutionSettlementSteps, isConnectorExecutionSettlementKind, validConnectorExecutionSettlementInput,
  validConnectorExecutionSettlementOutput, executeConnectorExecutionSettlement, type ConnectorExecutionSettlementCommands } from './connector-execution-settlement-domain.js';
import { connectorNativeReplySteps, isConnectorNativeReplyKind, validConnectorNativeReplyInput,
  validConnectorNativeReplyOutput, executeConnectorNativeReply, CONNECTOR_NATIVE_REPLY_COMMAND_BYTES, type ConnectorNativeReplyCommands } from './connector-native-reply-domain.js';
import { connectorMirrorDeliverySteps, isConnectorMirrorDeliveryKind, validConnectorMirrorDeliveryInput,
  validConnectorMirrorDeliveryOutput, executeConnectorMirrorDelivery, type ConnectorMirrorDeliveryCommands } from './connector-mirror-delivery-domain.js';
import { connectorAuthoritySteps, isConnectorAuthorityKind, validConnectorAuthorityInput,
  validConnectorAuthorityOutput, executeConnectorAuthority, type ConnectorAuthorityCommands } from './connector-authority-domain.js';
import { connectorSdkJournalSteps, isConnectorSdkJournalKind, validConnectorSdkJournalInput,
  validConnectorSdkJournalOutput, executeConnectorSdkJournal, SDK_METRICS_COMMAND_BYTES, type ConnectorSdkJournalCommands } from './connector-sdk-journal-domain.js';
import { connectorSdkDispatchSteps, isConnectorSdkDispatchKind, validConnectorSdkDispatchInput,
  validConnectorSdkDispatchOutput, executeConnectorSdkDispatch, type ConnectorSdkDispatchCommands } from './connector-sdk-dispatch-domain.js';
import { connectorSdkQueueSteps, isConnectorSdkQueueKind, validConnectorSdkQueueInput,
  validConnectorSdkQueueOutput, executeConnectorSdkQueue, type ConnectorSdkQueueCommands } from './connector-sdk-queue-domain.js';
import { connectorSdkQueueReadSteps, isConnectorSdkQueueReadKind, validConnectorSdkQueueReadInput,
  validConnectorSdkQueueReadOutput, executeConnectorSdkQueueRead, type ConnectorSdkQueueReadCommands } from './connector-sdk-queue-read-domain.js';

import { connectorSdkAttachmentSteps, isConnectorSdkAttachmentKind, validConnectorSdkAttachmentInput,
  validConnectorSdkAttachmentOutput, executeConnectorSdkAttachment, type ConnectorSdkAttachmentCommands } from './connector-sdk-attachment-domain.js';
import { connectorSdkCompactSteps, isConnectorSdkCompactKind, validConnectorSdkCompactInput,
  validConnectorSdkCompactOutput, executeConnectorSdkCompact, disposeSdkCompactIntents, type ConnectorSdkCompactCommands } from './connector-sdk-compact-domain.js';
import { connectorSdkTranscriptSteps, isConnectorSdkTranscriptKind, validConnectorSdkTranscriptInput,
  validConnectorSdkTranscriptOutput, executeConnectorSdkTranscript, SDK_TRANSCRIPT_COMMAND_BYTES, type ConnectorSdkTranscriptCommands } from './connector-sdk-transcript-domain.js';
import { connectorSdkInteractionSteps, isConnectorSdkInteractionKind, validConnectorSdkInteractionInput,
  validConnectorSdkInteractionOutput, executeConnectorSdkInteraction, type ConnectorSdkInteractionCommands } from './connector-sdk-interaction-domain.js';

export class ConnectorOwnerUnavailable extends Error {
  constructor() { super('connector_storage_unavailable'); }
}
import { APPLICATION_TRANSACTION_COMMAND_OVERHEAD } from '../auth/application-transaction-gate.js';
import { applicationFilesTransaction } from './application-files-transaction.js';
import { createApplicationInteractionTransactions } from './application-interaction-transaction.js';
export const CONNECTOR_COMMAND_BYTES = 16_384;
export const CONNECTOR_PENDING_INPUT_BYTES = 12 * 1024 * 1024;
export const connectorOwnerCommandBytes = (kind: string): number => isConnectorContentReplicaKind(kind) ? 32 * 1024 * 1024 + 65536 : kind === 'workspaceFileInstall' || kind === 'workspaceFileWrite' ? 3 * 1024 * 1024 + 16_384 : kind === 'eventProjectionAppend' ? CONNECTOR_EVENT_COMMAND_BYTES
  : kind === 'codexFileIndexProjection' ? CODEX_FILE_INDEX_COMMAND_BYTES
  : kind === 'automationBackgroundPoll' ? 2 * 1024 * 1024 // Bounded 1000 local vetoes + 512 native completions.
  : kind === 'automationConfigure' ? 64 * 1024 // Original 48KiB HTTP body plus raw credential/request envelope.
  : kind === 'codexMessageClaim' || kind === 'codexStopClaim' ? CODEX_MESSAGE_COMMAND_BYTES : kind === 'codexMessageCommit' ? 128 * 1024
  : kind === 'openClawCompactClaim' || kind === 'openClawStatus' || kind === 'openClawMessageClaim' || kind === 'openClawStopClaim' ? OPENCLAW_MESSAGE_COMMAND_BYTES : kind === 'openClawMessageCommit' ? 128 * 1024
  : kind === 'hermesMessageSend' || kind === 'hermesStopClaim' || kind === 'hermesLocalControl' ? HERMES_MESSAGE_COMMAND_BYTES
  : kind === 'hermesExecutionTerminal' || kind === 'hermesHistoryCommit' ? HERMES_TERMINAL_COMMAND_BYTES
  : isConnectorSdkInteractionKind(kind) || isConnectorCodexInteractionKind(kind) ? 128 * 1024 + APPLICATION_TRANSACTION_COMMAND_OVERHEAD
  : isConnectorSdkFilesKind(kind) || isConnectorCodexFilesKind(kind) ? CONNECTOR_COMMAND_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD
  : kind === 'sdkUsageSnapshotCreate' || kind === 'codexPublicUsageSnapshotCreate' ? CONNECTOR_COMMAND_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD
  : kind === 'sdkMessageSend' || kind === 'sdkMessageStopClaim' || kind === 'sdkMessageStatus' ? SDK_MESSAGE_COMMAND_BYTES
  : isConnectorSdkTranscriptKind(kind) ? SDK_TRANSCRIPT_COMMAND_BYTES
  : isConnectorNativeReplyKind(kind) ? CONNECTOR_NATIVE_REPLY_COMMAND_BYTES
  : isConnectorSdkLocalKind(kind) ? 6 * 128 * 1024 + CONNECTOR_COMMAND_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD
  : kind === 'codexCreationClaim' || kind === 'hermesCreationClaim'
    || kind === 'codexDeletionClaim' || kind === 'hermesDeletionClaim' || kind === 'sdkDeletionClaim' ? CONNECTOR_COMMAND_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD
  : kind === 'codexSettingsClaim' || kind === 'titleClaim' ? 6 * 128 * 1024 + CONNECTOR_COMMAND_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD
  : kind === 'sdkMetricsObserve' ? SDK_METRICS_COMMAND_BYTES
  : kind === 'sdkQueuedEdit' || kind === 'hermesQueuedEdit' || kind === 'nativeQueuedEdit' ? MAX_TEXT_MESSAGE_BODY_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD
  : kind === 'sdkQueuedCancel' || kind === 'hermesQueuedCancel' || kind === 'nativeQueuedCancel' ? CONNECTOR_COMMAND_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD : CONNECTOR_COMMAND_BYTES;
export const CONNECTOR_RESULT_BYTES = 1024 * 1024;
// Serialized file text is itself a JSON string in the result envelope. Each
// source byte may need one additional escape; retain a bounded envelope margin.
export const WORKSPACE_FILE_RESULT_BYTES = 4 * CONNECTOR_RESULT_BYTES + 16_384;
// A legacy history page already permits 1MiB of rows; reserve its envelope as
// well, without increasing the aggregate physical result budget.
// Preserve the original 64MiB automation store capacity and JSON envelope.
// Supervisor reserves ONE separate large result slot; ordinary RPC budgets do
// not grow, and an HTTP timeout does not return this physical-work reservation.
export const connectorOwnerLargeResult = (kind: string): boolean => isConnectorContentReplicaKind(kind) || kind === 'automationConfigurationView' || kind === 'automationBackgroundPoll';
export const connectorOwnerResultBytes = (kind: string): number => connectorOwnerLargeResult(kind)
  ? 65 * CONNECTOR_RESULT_BYTES : kind === 'workspaceFileInstall' || kind === 'workspaceFileWrite' ? WORKSPACE_FILE_RESULT_BYTES : (isConnectorSdkUsageKind(kind) && kind !== 'sdkUsageRange'
    || isConnectorCodexPublicUsageKind(kind) && kind !== 'codexPublicUsageRange' && kind !== 'codexPublicUsageDeliver')
  ? 8 * CONNECTOR_RESULT_BYTES : kind === 'mirrorDeliveryClaim' ? 8 * CONNECTOR_RESULT_BYTES
  : kind === 'sdkHistoryPage' || kind === 'sdkHistoryMessage' || kind === 'sdkUsageRange' || kind === 'codexPublicUsageRange'
  ? 2 * CONNECTOR_RESULT_BYTES : CONNECTOR_RESULT_BYTES;
export const CONNECTOR_PENDING_LIMIT = 128;
/** A single large SDK body or native snapshot has its own physical-work budget; small RPCs retain
 * their existing aggregate ceiling. Both worker and supervisor enforce this. */
export const connectorOwnerLargeInput = (kind: string, size: number): boolean => (isConnectorContentReplicaKind(kind) || kind === 'workspaceFileInstall' || kind === 'workspaceFileWrite' || isConnectorCodexFileIndexKind(kind) || kind === 'codexStopClaim' || kind === 'codexMessageClaim' || kind === 'codexMessageCommit' || kind === 'openClawCompactClaim' || kind === 'openClawStatus' || kind === 'openClawStopClaim' || kind === 'openClawMessageClaim' || kind === 'openClawMessageCommit' || kind === 'hermesLocalControl' || kind === 'hermesHistoryCommit' || kind === 'hermesExecutionTerminal' || kind === 'sdkMessageSend' || kind === 'sdkMessageStopClaim' || kind === 'sdkMessageStatus') && size > CONNECTOR_COMMAND_BYTES;
export type ConnectorOwnerConfig = { file: string; tokenFile?: string; bootstrapToken?: string; sdkModels?: SdkOwnerCatalogs; codexQueueFile?: string; openClawQueueFile?: string; mirrorOutboxFile?: string; boardFiles?: FileBoardPolicy; codexBoardTools?: boolean; fileToolPolicies?: WorkspaceFileToolPolicies };
type Empty = Record<string, never>;
export type ConnectorFileSessionObservation = null
  | { runtime: 'codex'; deleted: boolean; boardTools: boolean }
  | { runtime: 'claude-code' | 'ghcp' | 'antigravity'; deleted: boolean; sessionId: string | null };
export type ConnectorOwnerCommands = ConnectorTitleCommands & ConnectorNativeQueueCommands & ConnectorMirrorDeliveryCommands & ConnectorSessionMediaCommands & ConnectorContentReplicaCommands & ConnectorWorkspaceFileCommands & ConnectorOpenClawReadCommands & ConnectorOpenClawCompactCommands & ConnectorOpenClawStatusCommands & ConnectorOpenClawStopCommands & ConnectorOpenClawMessageCommands & ConnectorOpenClawDispatchCommands & ConnectorHermesReadCommands & ConnectorHermesLocalControlCommands & ConnectorHermesStopCommands & ConnectorHermesCreationCommands & ConnectorHermesLifecycleCommands & ConnectorHermesQueueCommands & ConnectorHermesDeletionCommands & ConnectorHermesHistoryCommands & ConnectorHermesDispatchCommands & ConnectorHermesMessageCommands & ConnectorHermesExecutionCommands & LocalCredentialsCommands & ConnectorSdkMetadataCommands & ConnectorSdkFilesCommands & ConnectorSdkUsageCommands & ConnectorSdkHistoryCommands & ConnectorSdkInteractionCommands & ConnectorSdkStatusCommands & ConnectorSdkStopCommands & ConnectorSdkLifecycleCommands & ConnectorSdkTranscriptCommands & ConnectorSdkMessageCommands & ConnectorEventCommands & ConnectorSdkLocalRecoveryCommands & ConnectorSdkLocalCommands & ConnectorSdkCompactCommands & ConnectorSdkAttachmentCommands & ConnectorSdkQueueReadCommands & ConnectorSdkQueueCommands & ConnectorSdkDispatchCommands & ConnectorSdkJournalCommands & ConnectorAuthorityCommands & ConnectorGrantCommands & ConnectorStorageCommands & ConnectorRecoveryCommands & ConnectorExecutionCommands & ConnectorExecutionObservationCommands & ConnectorExecutionSettlementCommands & ConnectorNativeReplyCommands & {
  codexDispatchClaim: ConnectorCodexDispatchCommands['codexDispatchClaim'];
  codexCreationClaim: ConnectorCodexCreationCommands['codexCreationClaim'];
  codexCreationReceiptRead: ConnectorCodexCreationCommands['codexCreationReceiptRead'];
  codexCreationReady: ConnectorCodexCreationCommands['codexCreationReady'];
  codexCreationIdentify: ConnectorCodexCreationCommands['codexCreationIdentify'];
  codexCreationNameReady: ConnectorCodexCreationCommands['codexCreationNameReady'];
  codexCreationAccept: ConnectorCodexCreationCommands['codexCreationAccept'];
  codexCreationAbandon: ConnectorCodexCreationCommands['codexCreationAbandon'];
  codexQueueContext: ConnectorCodexContextCommands['codexQueueContext'];
  sdkExecutionContext: ConnectorSdkContextCommands['sdkExecutionContext'];
  codexToolsBind: ConnectorCodexToolsCommands['codexToolsBind'];
  codexToolsCheck: ConnectorCodexToolsCommands['codexToolsCheck'];
  codexToolsRelease: ConnectorCodexToolsCommands['codexToolsRelease'];
  codexSchedulingObservation: ConnectorCodexSchedulingCommands['codexSchedulingObservation'];
  codexSchedulingRecheck: ConnectorCodexSchedulingCommands['codexSchedulingRecheck'];
  codexSchedulingRejectHead: ConnectorCodexSchedulingCommands['codexSchedulingRejectHead'];
  codexResumePrepare: ConnectorCodexResumeCommands['codexResumePrepare'];
  codexResumeBegin: ConnectorCodexResumeCommands['codexResumeBegin'];
  codexResumeFinish: ConnectorCodexResumeCommands['codexResumeFinish'];
  codexQueuePlan: ConnectorCodexQueuePlanCommands['codexQueuePlan'];
  codexQueuePlanChunk: ConnectorCodexQueuePlanCommands['codexQueuePlanChunk'];
  codexQueuePlanRelease: ConnectorCodexQueuePlanCommands['codexQueuePlanRelease'];
  codexStopClaim: ConnectorCodexStopCommands['codexStopClaim'];
  codexReadAuthorize: ConnectorCodexReadCommands['codexReadAuthorize'];
  codexReadDeliver: ConnectorCodexReadCommands['codexReadDeliver'];
  codexStopReady: ConnectorCodexStopCommands['codexStopReady'];
  codexStopCheck: ConnectorCodexStopCommands['codexStopCheck'];
  codexStopSettle: ConnectorCodexStopCommands['codexStopSettle'];
  codexStopRelease: ConnectorCodexStopCommands['codexStopRelease'];
  codexStopReceiptRead: ConnectorCodexStopCommands['codexStopReceiptRead'];
  codexDispatchReady: ConnectorCodexDispatchCommands['codexDispatchReady'];
  codexPreparationReady: ConnectorCodexDispatchCommands['codexPreparationReady'];
  codexPreparationFinish: ConnectorCodexDispatchCommands['codexPreparationFinish'];
  codexOwnedLoadBegin: ConnectorCodexDispatchCommands['codexOwnedLoadBegin'];
  codexOwnedLoadAcknowledge: ConnectorCodexDispatchCommands['codexOwnedLoadAcknowledge'];
  codexOwnedLoadFinish: ConnectorCodexDispatchCommands['codexOwnedLoadFinish'];
  codexDispatchFailure: ConnectorCodexDispatchCommands['codexDispatchFailure'];
  codexNativeNotification: ConnectorCodexNotificationCommands['codexNativeNotification'];
  codexStartupRecover: ConnectorCodexStartupCommands['codexStartupRecover'];
  codexStartupQueuePage: ConnectorCodexStartupCommands['codexStartupQueuePage'];
  codexStartupQueueChunk: ConnectorCodexStartupCommands['codexStartupQueueChunk'];
  codexHistoryOpen: ConnectorCodexHistoryCommands['codexHistoryOpen'];
  codexHistoryPage: ConnectorCodexHistoryCommands['codexHistoryPage'];
  codexHistoryChunk: ConnectorCodexHistoryCommands['codexHistoryChunk'];
  codexHistoryEvidence: ConnectorCodexHistoryCommands['codexHistoryEvidence'];
  codexHistoryFinish: ConnectorCodexHistoryCommands['codexHistoryFinish'];
  codexMessageClaim: ConnectorCodexMessageCommands['codexMessageClaim'];
  codexMessageReady: ConnectorCodexMessageCommands['codexMessageReady'];
  codexMessageCommit: ConnectorCodexMessageCommands['codexMessageCommit'];
  codexMessageReceiptRead: ConnectorCodexMessageCommands['codexMessageReceiptRead'];
  codexMessageSendReceiptRead: ConnectorCodexMessageCommands['codexMessageSendReceiptRead'];
  codexMessageRelease: ConnectorCodexMessageCommands['codexMessageRelease'];
  eventProjectionHead: { input: Empty; output: { cursor: string; version: string } };
  nodeIdentity: { input: Empty; output: string };
  usersList: { input: Empty; output: ConnectorUser[] };
  userGet: { input: { id: string }; output: ConnectorUser | null };
  userCreate: { input: { label: string }; output: ConnectorUser };
  userUpdate: { input: { id: string; label: string }; output: ConnectorUser | null };
  sessionPolicy: { input: { sessionKey: string }; output: { canDelete: boolean; canChangeSettings: boolean } };
  turnMaintenanceCount: { input: { runtime?: string }; output: number };
  turnSessionPage: { input: { runtime: string; after: string; limit: number }; output: string[] };
  receiptDeletion: { input: { sessionKey: string }; output: 'accepted' | 'outcome_unknown' | null };
  fileSessionObserve: { input: { sessionKey: string }; output: ConnectorFileSessionObservation };
  receiptSettingsPending: { input: { sessionKey: string }; output: boolean };
  interactionCount: { input: Empty; output: number };
  interactionPending: { input: { sessionKey: string }; output: boolean };
  eventCursor: { input: Empty; output: string };
  maintenancePause: { input: Empty; output: number };
  maintenanceResume: { input: { generation: number }; output: boolean };
  maintenanceStop: { input: Empty; output: null };
  maintenanceSnapshot: { input: Empty; output: { queueSha256: string; commandAdmissionOpen: boolean } };
  storageRecovery: { input: Empty; output: ReturnType<ConnectorUserStore['storageRecovery']> };
} & ConnectorAuthorizedMaintenanceCommands & ConnectorUpdateCommands & ConnectorMaintenanceCommands & ConnectorCodexInteractionCommands & ConnectorAutomationCommands & ConnectorAutomationBackgroundCommands & ConnectorCodexUsageCommands & ConnectorCodexFileIndexCommands & ConnectorCodexCatalogCommands & ConnectorCodexSettingsCommands & ConnectorCodexDeletionCommands & ConnectorCodexPublicUsageCommands & ConnectorCodexFilesCommands;
export type ConnectorOwnerKind = keyof ConnectorOwnerCommands;
// Append only: command numbers are a diagnostic protocol, not array indices.
export const connectorOwnerSteps: Readonly<Record<ConnectorOwnerKind, number>> = Object.freeze({
  nodeIdentity: 1, usersList: 2, userGet: 3, userCreate: 4, userUpdate: 5, sessionPolicy: 6,
  turnMaintenanceCount: 7, turnSessionPage: 8, receiptDeletion: 9, receiptSettingsPending: 10,
  interactionCount: 11, interactionPending: 12, eventCursor: 13, maintenancePause: 14,
  maintenanceResume: 15, maintenanceStop: 16, maintenanceSnapshot: 17, storageRecovery: 18,
  ...connectorAuthoritySteps, ...connectorGrantSteps, ...connectorStorageSteps, ...connectorRecoverySteps, ...connectorExecutionSteps,
  ...connectorExecutionObservationSteps,
  ...connectorExecutionSettlementSteps,
  ...connectorCodexDispatchSteps,
  ...connectorCodexToolsSteps,
  ...connectorCodexInteractionSteps,
  ...connectorAutomationSteps,
  ...connectorAutomationBackgroundSteps,
  ...connectorCodexUsageSteps,
  ...connectorCodexFileIndexSteps,
  ...connectorCodexCatalogSteps,
  ...connectorCodexSettingsSteps,
  ...connectorTitleSteps,
  ...connectorCodexDeletionSteps,
  ...connectorCodexPublicUsageSteps,
  ...connectorCodexFilesSteps,
  ...connectorWorkspaceFileSteps,
  ...connectorContentReplicaSteps,
  ...connectorCodexContextSteps,
  ...connectorSdkContextSteps,
  ...connectorMaintenanceSteps,
  ...connectorUpdateSteps,
  runtimeMaintenanceAuthorized: 346,
  runtimeMaintenanceResumeAuthorized: 347,
  fileSessionObserve: 353,
  ...connectorMirrorDeliverySteps,
  ...connectorCodexQueuePlanSteps,
  ...connectorCodexSchedulingSteps,
  ...connectorCodexResumeSteps,
  ...connectorCodexNotificationSteps,
  ...connectorCodexStartupSteps,
  ...connectorCodexHistorySteps,
  ...connectorCodexMessageSteps,
  ...connectorCodexStopSteps,
  ...connectorCodexReadSteps,
  ...connectorNativeReplySteps,
  ...connectorOpenClawDispatchSteps,
  ...connectorOpenClawMessageSteps,
  ...connectorOpenClawStopSteps,
  ...connectorOpenClawStatusSteps,
  ...connectorOpenClawCompactSteps,
  ...connectorSdkJournalSteps,
  ...connectorSdkDispatchSteps,
  ...connectorSdkQueueSteps,
  ...connectorSdkQueueReadSteps,
  ...connectorSdkAttachmentSteps,
  ...connectorSdkCompactSteps,
  ...connectorSdkLocalSteps,
  ...connectorSdkLocalRecoverySteps,
  ...connectorEventSteps,
  ...connectorSdkMessageSteps,
  ...connectorSdkTranscriptSteps,
  ...connectorSdkLifecycleSteps,
  ...connectorSdkStopSteps,
  ...connectorSdkStatusSteps,
  ...connectorSdkInteractionSteps,
  ...connectorSdkHistorySteps,
  ...connectorSessionMediaSteps,
  ...connectorSdkUsageSteps,
  ...connectorSdkFilesSteps,
  ...connectorSdkMetadataSteps,
  ...localCredentialsSteps,
  ...connectorHermesExecutionSteps,
  ...connectorHermesMessageSteps,
  ...connectorHermesDispatchSteps,
  ...connectorHermesHistorySteps,
  ...connectorHermesDeletionSteps,
  ...connectorHermesQueueSteps,
  ...connectorNativeQueueSteps,
  ...connectorHermesLifecycleSteps,
  ...connectorHermesCreationSteps,
  ...connectorCodexCreationSteps,
  ...connectorHermesStopSteps,
  ...connectorHermesLocalControlSteps,
  ...connectorHermesReadSteps,
  ...connectorOpenClawReadSteps,
  eventProjectionHead: 142,
});
export const connectorOwnerKinds: readonly ConnectorOwnerKind[] = Object.freeze(Object.keys(connectorOwnerSteps) as ConnectorOwnerKind[]);

// Audited observations only, not authority cached for a later effect. Every
// invocation still enters its domain and checks the original credentials.
// Names such as connectionRecoveryPage can hide writes: never infer from names.
export const connectorProjectionReadKinds = Object.freeze([
  'fileSessionObserve',
  'updateOperatorCheck', 'updateReceiptInspect',
  'runtimeMaintenanceObserve', 'runtimeMaintenanceHistory', 'runtimeMaintenanceSdkSession', 'runtimeMaintenancePreservation',
  'hermesLifecyclePage', 'hermesLifecycleRead', 'hermesLifecycleHistoryPage', 'hermesLifecycleHistoryPart',
  'eventReplay', 'sdkSessionPage', 'sdkLifecycleRead',
  'hermesReadAuthorize', 'hermesReadDeliver',
  'openClawReadAuthorize', 'openClawReadDeliver',
  'codexReadAuthorize', 'codexReadDeliver', 'codexExecutionRead', 'codexHistoryObservation', 'codexMaintenanceObservation',
  'codexSchedulingObservation', 'codexSchedulingRecheck',
  'codexToolsRelease',
  'codexQueuePlanChunk', 'codexQueuePlanRelease',
  'openClawRecoveryCandidate', 'openClawExecutionRead', 'executionSessionPage', 'executionFactBatch',
  'openClawMessageReceiptRead', 'openClawMessageSendReceiptRead',
  'tokenAuthenticate', 'tokenHasScope', 'tokenDelegationHub', 'tokensList',
  'authorizedUsersList', 'authorizedUserGet', 'authorizedUsersPermission',
  'sdkStateRead', 'sdkModelsRead', 'sdkModelsDeliver',
  'sdkHistoryPage', 'sdkHistoryMessage', 'sdkHistoryDeliver',
  'sessionMediaObserve', 'sessionMediaChunk',
  'nativeQueuePage', 'nativeQueueCommandPage', 'nativeQueueReceiptRead', 'sdkQueuePage', 'sdkQueueCommandPage', 'hermesQueuePage', 'hermesQueueCommandPage', 'sdkLocalReceiptRead',
  'sdkMessageReceiptRead', 'sdkMessageSendReceiptRead',
  'sdkSnapshotRead', 'sdkPendingCount',
  'sdkUsageRange', 'sdkUsageExport', 'sdkUsageSnapshotRead', 'sdkDeletionReceiptRead',
  'codexPublicUsageRange', 'codexPublicUsageExport', 'codexPublicUsageSnapshotRead', 'codexPublicUsageDeliver',
  'codexFilesPage', 'codexFilesDeliver',
] as const satisfies readonly ConnectorOwnerKind[]);
const projectionReads: ReadonlySet<ConnectorOwnerKind> = new Set(connectorProjectionReadKinds);

/** Do not invoke caller getters, proxies, thenables, callbacks or toJSON. This
 * fixed command envelope is intentionally not SQL/RPC-method reflection. */
export function encodeConnectorOwnerJson(value: unknown, maximum = CONNECTOR_COMMAND_BYTES): string {
  return encodeOwnerJson(value, maximum, false);
}
export function encodeConnectorOwnerInput(kind: ConnectorOwnerKind, value: unknown): string {
  return encodeOwnerJson(value, connectorOwnerCommandBytes(kind), false,
    kind === 'codexFileIndexProjection' ? 262_144 : 32_768);
}
/** Display events historically use JSON's optional-field omission. Keep this
 * compatibility at the projection boundary only, not authority or replies.
 * Descriptor validation and work/byte budgets still apply to omitted fields. */
export function encodeConnectorProjectionJson(value: unknown, maximum = CONNECTOR_COMMAND_BYTES): string {
  return encodeOwnerJson(value, maximum, true);
}
function encodeOwnerJson(value: unknown, maximum: number, projection: boolean, maximumNodes = 32_768): string {
  let nodes = 0, bytes = 0;
  const active = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > maximumNodes || depth > 24) throw new ConnectorOwnerUnavailable();
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item);
      if (bytes > maximum) throw new ConnectorOwnerUnavailable();
      return item;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || types.isProxy(item) || active.has(item)) throw new ConnectorOwnerUnavailable();
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw new ConnectorOwnerUnavailable();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const symbols = Reflect.ownKeys(descriptors).filter(key => typeof key !== 'string').length;
    if (symbols && (!projection || (nodes += symbols) > maximumNodes)) throw new ConnectorOwnerUnavailable();
    active.add(item);
    try {
      if (array) {
        const length = descriptors.length!.value as number;
        if (length > 16_384 || Object.keys(descriptors).length !== length + 1) throw new ConnectorOwnerUnavailable();
        return Array.from({ length }, (_, index) => {
          const field = descriptors[String(index)];
          if (!field || !Object.hasOwn(field, 'value')) throw new ConnectorOwnerUnavailable();
          return copy(projection && field.value === undefined ? null : field.value, depth + 1);
        });
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, field] of Object.entries(descriptors)) {
        if (!field.enumerable || !Object.hasOwn(field, 'value')) throw new ConnectorOwnerUnavailable();
        bytes += Buffer.byteLength(key);
        if (bytes > maximum) throw new ConnectorOwnerUnavailable();
        if (projection && field.value === undefined) {
          if (++nodes > maximumNodes) throw new ConnectorOwnerUnavailable();
          continue;
        }
        result[key] = copy(field.value, depth + 1);
      }
      return result;
    } finally { active.delete(item); }
  };
  try {
    const result = JSON.stringify(copy(value, 0));
    if (Buffer.byteLength(result) > maximum) throw new ConnectorOwnerUnavailable();
    return result;
  } catch { throw new ConnectorOwnerUnavailable(); }
}
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && !v.includes('\0') && Buffer.byteLength(v) <= 4096;
const userId = (v: unknown) => typeof v === 'string' && v.length > 0;
const userLabel = (v: unknown) => typeof v === 'string' && !!v.trim() && Buffer.byteLength(v) <= 4096;
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const record = (v: unknown, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
export function connectorOwnerConfig(v: unknown): ConnectorOwnerConfig {
  const c = v as ConnectorOwnerConfig;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'file')
    || !Object.keys(v).every(key => ['file', 'tokenFile', 'bootstrapToken', 'sdkModels', 'codexQueueFile', 'openClawQueueFile', 'mirrorOutboxFile', 'boardFiles', 'codexBoardTools', 'fileToolPolicies'].includes(key))
    || Object.hasOwn(v, 'codexBoardTools') && typeof c.codexBoardTools !== 'boolean'
    || !text(c.file) || c.file === ':memory:'
    || Object.hasOwn(v, 'tokenFile') && (!text(c.tokenFile) || c.tokenFile === ':memory:')
    || Object.hasOwn(v, 'codexQueueFile') && !text(c.codexQueueFile)
    || Object.hasOwn(v, 'openClawQueueFile') && !text(c.openClawQueueFile)
    || Object.hasOwn(v, 'mirrorOutboxFile') && !text(c.mirrorOutboxFile)
    || Object.hasOwn(v, 'bootstrapToken') && (!Object.hasOwn(v, 'tokenFile') || !text(c.bootstrapToken))) throw new ConnectorOwnerUnavailable();
  let fileToolPolicies: WorkspaceFileToolPolicies | undefined;
  if (Object.hasOwn(v, 'fileToolPolicies')) {
    const policies = c.fileToolPolicies;
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)
      || Object.keys(policies).some(k => k !== 'claude' && k !== 'copilot')) throw new ConnectorOwnerUnavailable();
    for (const p of Object.values(policies)) if (!p || !record(p, ['toolPolicy'])
      || typeof p.toolPolicy !== 'string' || !['workspace-read', 'workspace-edit', 'trusted-exec'].includes(p.toolPolicy)) throw new ConnectorOwnerUnavailable();
    fileToolPolicies = structuredClone(policies);
  }
  let sdkModels: SdkOwnerCatalogs, boardFiles: FileBoardPolicy | undefined;
  try {
    sdkModels = copySdkOwnerCatalogs(c.sdkModels);
    if (Object.hasOwn(v, 'boardFiles')) boardFiles = parseFileBoardPolicy(JSON.stringify(c.boardFiles));
    if (Object.hasOwn(v, 'boardFiles') && !boardFiles) throw new ConnectorOwnerUnavailable();
  } catch { throw new ConnectorOwnerUnavailable(); }
  return { file: c.file, ...(fileToolPolicies ? { fileToolPolicies } : {}), ...(c.tokenFile !== undefined ? { tokenFile: c.tokenFile } : {}),
    ...(c.codexBoardTools !== undefined ? { codexBoardTools: c.codexBoardTools } : {}),
    ...(c.codexQueueFile !== undefined ? { codexQueueFile: c.codexQueueFile } : {}),
    ...(c.openClawQueueFile !== undefined ? { openClawQueueFile: c.openClawQueueFile } : {}),
    ...(c.mirrorOutboxFile !== undefined ? { mirrorOutboxFile: c.mirrorOutboxFile } : {}),
    ...(c.bootstrapToken !== undefined ? { bootstrapToken: c.bootstrapToken } : {}),
    ...(c.sdkModels !== undefined ? { sdkModels } : {}), ...(boardFiles ? { boardFiles } : {}) };
}
export function validConnectorOwnerInput(kind: ConnectorOwnerKind, value: unknown): boolean {
  if (kind === 'runtimeMaintenanceAuthorized') return validAuthorizedMaintenanceInput(value);
  if (kind === 'runtimeMaintenanceResumeAuthorized') return validAuthorizedMaintenanceResumeInput(value);
  if (isConnectorUpdateKind(kind)) return validConnectorUpdateInput(kind, value);
  if (isConnectorMaintenanceKind(kind)) return validConnectorMaintenanceInput(kind, value);
  if (isConnectorContentReplicaKind(kind)) return validConnectorContentReplicaInput(kind,value);
  if (isConnectorWorkspaceFileKind(kind)) return validConnectorWorkspaceFileInput(kind, value);
  if (isConnectorCodexSettingsKind(kind)) return validConnectorCodexSettingsInput(kind, value);
  if (isConnectorTitleKind(kind)) return validConnectorTitleInput(kind, value);
  if (isConnectorCodexPublicUsageKind(kind)) return validConnectorCodexPublicUsageInput(kind, value);
  if (isConnectorCodexFilesKind(kind)) return validConnectorCodexFilesInput(kind, value);
  if (isConnectorCodexDeletionKind(kind)) return validConnectorCodexDeletionInput(kind, value);
  if (isConnectorCodexCatalogKind(kind)) return validConnectorCodexCatalogInput(kind, value);
  if (isConnectorCodexCreationKind(kind)) return validConnectorCodexCreationInput(kind, value);
  if (isConnectorAutomationBackgroundKind(kind)) return validConnectorAutomationBackgroundInput(kind, value);
  if (isConnectorCodexUsageKind(kind)) return validConnectorCodexUsageInput(kind, value);
  if (isConnectorCodexFileIndexKind(kind)) return validConnectorCodexFileIndexInput(kind, value);
  if (isConnectorAutomationKind(kind)) return validConnectorAutomationInput(kind, value);
  if (isConnectorCodexInteractionKind(kind)) return validConnectorCodexInteractionInput(kind, value);
  if (isConnectorCodexContextKind(kind)) return validConnectorCodexContextInput(value);
  if (kind === 'sdkExecutionContext') return validConnectorSdkContextInput(value);
  if (isConnectorCodexMessageKind(kind)) return validConnectorCodexMessageInput(kind, value);
  if (isConnectorCodexStopKind(kind)) return validConnectorCodexStopInput(kind, value);
  if (isConnectorCodexReadKind(kind)) return validConnectorCodexReadInput(kind, value);
  if (isConnectorCodexHistoryKind(kind)) return validConnectorCodexHistoryInput(kind, value);
  if (isConnectorCodexStartupKind(kind)) return validConnectorCodexStartupInput(kind, value);
  if (isConnectorOpenClawCompactKind(kind)) return validConnectorOpenClawCompactInput(kind, value);
  if (isConnectorOpenClawStatusKind(kind)) return validConnectorOpenClawStatusInput(kind, value);
  if (isConnectorOpenClawStopKind(kind)) return validConnectorOpenClawStopInput(kind, value);
  if (isConnectorOpenClawMessageKind(kind)) return validConnectorOpenClawMessageInput(kind, value);
  if (isConnectorHermesCreationKind(kind)) return validConnectorHermesCreationInput(kind, value);
  if (isConnectorHermesLocalControlKind(kind)) return validConnectorHermesLocalControlInput(kind, value);
  if (isConnectorHermesReadKind(kind)) return validConnectorHermesReadInput(kind, value);
  if (isConnectorOpenClawReadKind(kind)) return validConnectorOpenClawReadInput(kind, value);
  if (isConnectorHermesStopKind(kind)) return validConnectorHermesStopInput(kind, value);
  if (isConnectorHermesLifecycleKind(kind)) return validConnectorHermesLifecycleInput(kind, value);
  if (isConnectorNativeQueueKind(kind)) return validConnectorNativeQueueInput(kind, value);
  if (isConnectorHermesQueueKind(kind)) return validConnectorHermesQueueInput(kind, value);
  if (isConnectorHermesHistoryKind(kind)) return validConnectorHermesHistoryInput(kind, value);
  if (isConnectorHermesDeletionKind(kind)) return validConnectorHermesDeletionInput(kind, value);
  if (isConnectorOpenClawDispatchKind(kind)) return validConnectorOpenClawDispatchInput(kind, value);
  if (isConnectorCodexDispatchKind(kind)) return validConnectorCodexDispatchInput(kind, value);
  if (isConnectorCodexToolsKind(kind)) return validConnectorCodexToolsInput(kind, value);
  if (isConnectorCodexQueuePlanKind(kind)) return validConnectorCodexQueuePlanInput(kind, value);
  if (isConnectorCodexSchedulingKind(kind)) return validConnectorCodexSchedulingInput(kind, value);
  if (isConnectorCodexResumeKind(kind)) return validConnectorCodexResumeInput(kind, value);
  if (isConnectorCodexNotificationKind(kind)) return validConnectorCodexNotificationInput(kind, value);
  if (isConnectorHermesDispatchKind(kind)) return validConnectorHermesDispatchInput(kind, value);
  if (isConnectorHermesMessageKind(kind)) return validConnectorHermesMessageInput(kind, value);
  if (isConnectorHermesExecutionKind(kind)) return validConnectorHermesExecutionInput(kind, value);
  if (isLocalCredentialsKind(kind)) return validLocalCredentialsInput(kind, value);
  if (isConnectorSdkMetadataKind(kind)) return validConnectorSdkMetadataInput(kind, value);
  if (isConnectorSdkFilesKind(kind)) return validConnectorSdkFilesInput(kind, value);
  if (isConnectorSdkUsageKind(kind)) return validConnectorSdkUsageInput(kind, value);
  if (isConnectorSdkHistoryKind(kind)) return validConnectorSdkHistoryInput(kind, value);
  if (isConnectorSessionMediaKind(kind)) return validConnectorSessionMediaInput(kind, value);
  if (isConnectorSdkInteractionKind(kind)) return validConnectorSdkInteractionInput(kind, value);
  if (isConnectorSdkLifecycleKind(kind)) return validConnectorSdkLifecycleInput(kind, value);
  if (isConnectorSdkStatusKind(kind)) return validConnectorSdkStatusInput(kind, value);
  if (isConnectorSdkStopKind(kind)) return validConnectorSdkStopInput(kind, value);
  if (isConnectorSdkTranscriptKind(kind)) return validConnectorSdkTranscriptInput(kind, value);
  if (isConnectorSdkMessageKind(kind)) return validConnectorSdkMessageInput(kind, value);
  if (isConnectorEventKind(kind)) return validConnectorEventInput(kind, value);
  if (isConnectorSdkLocalRecoveryKind(kind)) return validConnectorSdkLocalRecoveryInput(value);
  if (isConnectorSdkLocalKind(kind)) return validConnectorSdkLocalInput(kind, value);
  if (isConnectorSdkCompactKind(kind)) return validConnectorSdkCompactInput(kind, value);
  if (isConnectorSdkAttachmentKind(kind)) return validConnectorSdkAttachmentInput(kind, value);
  if (isConnectorSdkQueueReadKind(kind)) return validConnectorSdkQueueReadInput(kind, value);
  if (isConnectorSdkQueueKind(kind)) return validConnectorSdkQueueInput(kind, value);
  if (isConnectorSdkDispatchKind(kind)) return validConnectorSdkDispatchInput(kind, value);
  if (isConnectorSdkJournalKind(kind)) return validConnectorSdkJournalInput(kind, value);
  if (isConnectorNativeReplyKind(kind)) return validConnectorNativeReplyInput(kind, value);
  if (isConnectorMirrorDeliveryKind(kind)) return validConnectorMirrorDeliveryInput(kind, value);
  if (isConnectorExecutionSettlementKind(kind)) return validConnectorExecutionSettlementInput(kind, value);
  if (isConnectorExecutionObservationKind(kind)) return validConnectorExecutionObservationInput(kind, value);
  if (isConnectorExecutionKind(kind)) return validConnectorExecutionInput(kind, value);
  if (isConnectorRecoveryKind(kind)) return validConnectorRecoveryInput(kind, value);
  if (isConnectorStorageKind(kind)) return validConnectorStorageInput(kind, value);
  if (isConnectorGrantKind(kind)) return validConnectorGrantInput(kind, value);
  if (isConnectorAuthorityKind(kind)) return validConnectorAuthorityInput(kind, value);
  const v = value as Record<string, unknown>;
  switch (kind) {
    case 'userGet': return record(v, ['id']) && userId(v.id);
    case 'userCreate': return record(v, ['label']) && userLabel(v.label);
    case 'userUpdate': return record(v, ['id', 'label']) && userId(v.id) && userLabel(v.label);
    case 'sessionPolicy': case 'receiptDeletion': case 'receiptSettingsPending': case 'interactionPending': case 'fileSessionObserve':
      return record(v, ['sessionKey']) && text(v.sessionKey);
    case 'turnMaintenanceCount': return record(v, []) || record(v, ['runtime']) && text(v.runtime);
    case 'turnSessionPage': return record(v, ['runtime', 'after', 'limit']) && text(v.runtime) && typeof v.after === 'string'
      && Buffer.byteLength(v.after) <= 4096 && !v.after.includes('\0') && integer(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 64;
    case 'maintenanceResume': return record(v, ['generation']) && integer(v.generation) && Number(v.generation) >= 1;
    default: return connectorOwnerKinds.includes(kind) && record(v, []);
  }
}
const user = (v: unknown) => record(v, ['id', 'label', 'createdAt', 'updatedAt'])
  && userId((v as ConnectorUser).id) && typeof (v as ConnectorUser).label === 'string'
  && integer((v as ConnectorUser).createdAt) && integer((v as ConnectorUser).updatedAt);
export function validConnectorOwnerOutput(kind: ConnectorOwnerKind, v: unknown): boolean {
  if (kind === 'runtimeMaintenanceAuthorized') return validAuthorizedMaintenanceOutput(v);
  if (kind === 'runtimeMaintenanceResumeAuthorized') return validAuthorizedMaintenanceResumeOutput(v);
  if (isConnectorUpdateKind(kind)) return validConnectorUpdateOutput(kind, v);
  if (isConnectorMaintenanceKind(kind)) return validConnectorMaintenanceOutput(kind, v);
  if (isConnectorContentReplicaKind(kind)) return validConnectorContentReplicaOutput(kind,v);
  if (isConnectorWorkspaceFileKind(kind)) return validConnectorWorkspaceFileOutput(kind, v);
  if (isConnectorCodexSettingsKind(kind)) return validConnectorCodexSettingsOutput(kind, v);
  if (isConnectorTitleKind(kind)) return validConnectorTitleOutput(kind, v);
  if (isConnectorCodexPublicUsageKind(kind)) return validConnectorCodexPublicUsageOutput(kind, v);
  if (isConnectorCodexFilesKind(kind)) return validConnectorCodexFilesOutput(kind, v);
  if (isConnectorCodexDeletionKind(kind)) return validConnectorCodexDeletionOutput(kind, v);
  if (isConnectorCodexCatalogKind(kind)) return validConnectorCodexCatalogOutput(kind, v);
  if (isConnectorCodexCreationKind(kind)) return validConnectorCodexCreationOutput(kind, v);
  if (isConnectorAutomationBackgroundKind(kind)) return validConnectorAutomationBackgroundOutput(kind, v);
  if (isConnectorCodexUsageKind(kind)) return validConnectorCodexUsageOutput(kind, v);
  if (isConnectorCodexFileIndexKind(kind)) return validConnectorCodexFileIndexOutput(kind, v);
  if (isConnectorAutomationKind(kind)) return validConnectorAutomationOutput(kind, v);
  if (isConnectorCodexInteractionKind(kind)) return validConnectorCodexInteractionOutput(kind, v);
  if (isConnectorCodexContextKind(kind)) return validConnectorCodexContextOutput(v);
  if (kind === 'sdkExecutionContext') return validConnectorSdkContextOutput(v);
  if (isConnectorCodexMessageKind(kind)) return validConnectorCodexMessageOutput(kind, v);
  if (isConnectorCodexStopKind(kind)) return validConnectorCodexStopOutput(kind, v);
  if (isConnectorCodexReadKind(kind)) return validConnectorCodexReadOutput(kind, v);
  if (isConnectorCodexHistoryKind(kind)) return validConnectorCodexHistoryOutput(kind, v);
  if (isConnectorCodexStartupKind(kind)) return validConnectorCodexStartupOutput(kind, v);
  if (isConnectorOpenClawCompactKind(kind)) return validConnectorOpenClawCompactOutput(kind, v);
  if (isConnectorOpenClawStatusKind(kind)) return validConnectorOpenClawStatusOutput(kind, v);
  if (isConnectorOpenClawStopKind(kind)) return validConnectorOpenClawStopOutput(kind, v);
  if (isConnectorOpenClawMessageKind(kind)) return validConnectorOpenClawMessageOutput(kind, v);
  if (isConnectorOpenClawDispatchKind(kind)) return validConnectorOpenClawDispatchOutput(kind, v);
  if (isConnectorCodexDispatchKind(kind)) return validConnectorCodexDispatchOutput(kind, v);
  if (isConnectorCodexToolsKind(kind)) return validConnectorCodexToolsOutput(kind, v);
  if (isConnectorCodexQueuePlanKind(kind)) return validConnectorCodexQueuePlanOutput(kind, v);
  if (isConnectorCodexSchedulingKind(kind)) return validConnectorCodexSchedulingOutput(kind, v);
  if (isConnectorCodexResumeKind(kind)) return validConnectorCodexResumeOutput(kind, v);
  if (isConnectorCodexNotificationKind(kind)) return validConnectorCodexNotificationOutput(kind, v);
  if (isConnectorHermesCreationKind(kind)) return validConnectorHermesCreationOutput(kind, v);
  if (isConnectorHermesLocalControlKind(kind)) return validConnectorHermesLocalControlOutput(kind, v);
  if (isConnectorHermesReadKind(kind)) return validConnectorHermesReadOutput(kind, v);
  if (isConnectorOpenClawReadKind(kind)) return validConnectorOpenClawReadOutput(kind, v);
  if (isConnectorHermesStopKind(kind)) return validConnectorHermesStopOutput(kind, v);
  if (isConnectorHermesLifecycleKind(kind)) return validConnectorHermesLifecycleOutput(kind, v);
  if (isConnectorNativeQueueKind(kind)) return validConnectorNativeQueueOutput(kind, v);
  if (isConnectorHermesQueueKind(kind)) return validConnectorHermesQueueOutput(kind, v);
  if (isConnectorHermesHistoryKind(kind)) return validConnectorHermesHistoryOutput(kind, v);
  if (isConnectorHermesDeletionKind(kind)) return validConnectorHermesDeletionOutput(kind, v);
  if (isConnectorHermesDispatchKind(kind)) return validConnectorHermesDispatchOutput(kind, v);
  if (isConnectorHermesMessageKind(kind)) return validConnectorHermesMessageOutput(kind, v);
  if (isConnectorHermesExecutionKind(kind)) return validConnectorHermesExecutionOutput(kind, v);
  if (isLocalCredentialsKind(kind)) return validLocalCredentialsOutput(kind, v);
  if (isConnectorSdkMetadataKind(kind)) return validConnectorSdkMetadataOutput(kind, v);
  if (isConnectorSdkFilesKind(kind)) return validConnectorSdkFilesOutput(kind, v);
  if (isConnectorSdkUsageKind(kind)) return validConnectorSdkUsageOutput(kind, v);
  if (isConnectorSdkHistoryKind(kind)) return validConnectorSdkHistoryOutput(kind, v);
  if (isConnectorSessionMediaKind(kind)) return validConnectorSessionMediaOutput(kind, v);
  if (isConnectorSdkInteractionKind(kind)) return validConnectorSdkInteractionOutput(kind, v);
  if (isConnectorSdkLifecycleKind(kind)) return validConnectorSdkLifecycleOutput(kind, v);
  if (isConnectorSdkStatusKind(kind)) return validConnectorSdkStatusOutput(kind, v);
  if (isConnectorSdkStopKind(kind)) return validConnectorSdkStopOutput(kind, v);
  if (isConnectorSdkTranscriptKind(kind)) return validConnectorSdkTranscriptOutput(v);
  if (isConnectorSdkMessageKind(kind)) return validConnectorSdkMessageOutput(kind, v);
  if (isConnectorEventKind(kind)) return validConnectorEventOutput(kind, v);
  if (isConnectorSdkLocalRecoveryKind(kind)) return validConnectorSdkLocalRecoveryOutput(v);
  if (isConnectorSdkLocalKind(kind)) return validConnectorSdkLocalOutput(kind, v);
  if (isConnectorSdkCompactKind(kind)) return validConnectorSdkCompactOutput(kind, v);
  if (isConnectorSdkAttachmentKind(kind)) return validConnectorSdkAttachmentOutput(kind, v);
  if (isConnectorSdkQueueReadKind(kind)) return validConnectorSdkQueueReadOutput(kind, v);
  if (isConnectorSdkQueueKind(kind)) return validConnectorSdkQueueOutput(kind, v);
  if (isConnectorSdkDispatchKind(kind)) return validConnectorSdkDispatchOutput(kind, v);
  if (isConnectorSdkJournalKind(kind)) return validConnectorSdkJournalOutput(kind, v);
  if (isConnectorNativeReplyKind(kind)) return validConnectorNativeReplyOutput(kind, v);
  if (isConnectorMirrorDeliveryKind(kind)) return validConnectorMirrorDeliveryOutput(kind, v);
  if (isConnectorExecutionSettlementKind(kind)) return validConnectorExecutionSettlementOutput(kind, v);
  if (isConnectorExecutionObservationKind(kind)) return validConnectorExecutionObservationOutput(kind, v);
  if (isConnectorExecutionKind(kind)) return validConnectorExecutionOutput(kind, v);
  if (isConnectorRecoveryKind(kind)) return validConnectorRecoveryOutput(kind, v);
  if (isConnectorStorageKind(kind)) return validConnectorStorageOutput(kind, v);
  if (isConnectorGrantKind(kind)) return validConnectorGrantOutput(kind, v);
  if (isConnectorAuthorityKind(kind)) return validConnectorAuthorityOutput(kind, v);
  switch (kind) {
    case 'eventProjectionHead': {
      if (!record(v, ['cursor', 'version'])) return false;
      const head = v as { cursor: unknown; version: unknown };
      return validConnectorEventOutput('eventReplay', { cursor: head.cursor, known: true, events: [] })
        && typeof head.version === 'string' && /^cv1_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:(0|[1-9]\d{0,15})$/.test(head.version)
        && Number.isSafeInteger(Number(head.version.slice(head.version.lastIndexOf(':') + 1)));
    }
    case 'nodeIdentity': case 'eventCursor': return text(v);
    case 'usersList': return Array.isArray(v) && v.length <= 16_384 && v.every(user);
    case 'userCreate': return user(v);
    case 'userGet': case 'userUpdate': return v === null || user(v);
    case 'sessionPolicy': return record(v, ['canDelete', 'canChangeSettings'])
      && typeof (v as { canDelete: unknown }).canDelete === 'boolean' && typeof (v as { canChangeSettings: unknown }).canChangeSettings === 'boolean';
    case 'turnMaintenanceCount': case 'interactionCount': return integer(v);
    case 'maintenancePause': return integer(v) && Number(v) >= 1;
    case 'turnSessionPage': return Array.isArray(v) && v.length <= 64 && v.every(text);
    case 'receiptDeletion': return v === null || v === 'accepted' || v === 'outcome_unknown';
    case 'fileSessionObserve': {
      if (v === null) return true;
      const row = v as Record<string, unknown>;
      return record(v, ['runtime', 'deleted', 'boardTools']) && row.runtime === 'codex'
        && typeof row.deleted === 'boolean' && typeof row.boardTools === 'boolean'
        || record(v, ['runtime', 'deleted', 'sessionId']) && (row.runtime === 'claude-code' || row.runtime === 'ghcp' || row.runtime === 'antigravity')
        && typeof row.deleted === 'boolean' && (row.sessionId === null || text(row.sessionId));
    }
    case 'receiptSettingsPending': case 'interactionPending': case 'maintenanceResume': return typeof v === 'boolean';
    case 'maintenanceStop': return v === null;
    case 'maintenanceSnapshot': return record(v, ['queueSha256', 'commandAdmissionOpen'])
      && /^[a-f0-9]{64}$/.test((v as { queueSha256: string }).queueSha256)
      && typeof (v as { commandAdmissionOpen: unknown }).commandAdmissionOpen === 'boolean';
    case 'storageRecovery': return record(v, ['state', 'attempts']) && ['ready', 'owner-rollback-required', 'parent-rollback-required', 'close-required', 'closed']
      .includes((v as { state: string }).state) && integer((v as { attempts: unknown }).attempts);
    default: return false;
  }
}

/** All shared participants are constructed by ONE original store. The first
 * surface migrates observation/user/maintenance and execution-grant calls. Runtime dispatch,
 * cross-store admission MUST migrate before activation. Optional token authority
 * joins this same Worker; no parent authorization boolean is accepted.
 * No callback, DatabaseSync or caller-supplied authorization crosses the port. */
export function createConnectorOwnerCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore, catalogs?: SdkOwnerCatalogs, codexQueueFile?: string, boardFiles?: FileBoardPolicy, codexBoardTools = false, fileToolPolicies?: WorkspaceFileToolPolicies,
  applicationTransactions?: import('../auth/application-transaction-gate.js').ApplicationTransactionClient) {
  const authorizedMaintenance = createAuthorizedMaintenanceCommands(owner, tokens);
  const maintenanceResume = createAuthorizedMaintenanceResume(owner, tokens);
  const runtimeMaintenance = createConnectorMaintenanceCommands(owner);
  const update = createConnectorUpdateCommands(owner, tokens);
  const codexSettings = createConnectorCodexSettings(owner, tokens, applicationTransactions);
  const titles = createConnectorTitle(owner, tokens, applicationTransactions);
  const codexDeletion = createConnectorCodexDeletion(owner, tokens, applicationTransactions);
  const codexCreation = createConnectorCodexCreation(owner, tokens, codexBoardTools, applicationTransactions);
  const codexHistory = createConnectorCodexHistoryCommands(owner);
  const codexStartup = createConnectorCodexStartupCommands(owner, codexQueueFile);
  const codexQueuePlan = createConnectorCodexQueuePlanCommands(owner, tokens);
  const codexTools = createConnectorCodexToolsCommands(owner, tokens);
  const codexInteraction = createConnectorCodexInteractionCommands(owner, tokens);
  const interactionTransactions = createApplicationInteractionTransactions(applicationTransactions);
  const workspaceFiles = createConnectorWorkspaceFileCommands(owner, tokens, boardFiles, fileToolPolicies);
  const contentReplicas = createConnectorContentReplicaCommands(owner,tokens,boardFiles,fileToolPolicies);
  const codexContext = createConnectorCodexContextCommands(owner, tokens, boardFiles);
  const sdkContext = createConnectorSdkContextCommands(owner, tokens, boardFiles, fileToolPolicies);
  const automation = createConnectorAutomationCommands(owner, tokens);
  const automationBackground = createConnectorAutomationBackground(owner, tokens);
  const sdkModels = copySdkOwnerCatalogs(catalogs);
  const files = createConnectorSdkFiles(owner, tokens);
  const codexFiles = createConnectorCodexFiles(owner, tokens);
  const localCredentials = createLocalCredentialsCommands(tokens);
  let generation = 0, resume: (() => boolean) | undefined;
  const dispatch = async <K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> => {
    if (!validConnectorOwnerInput(kind, input)) throw new ConnectorOwnerUnavailable();
    if (kind === 'runtimeMaintenanceAuthorized') return authorizedMaintenance(
      input as ConnectorAuthorizedMaintenanceCommands['runtimeMaintenanceAuthorized']['input']) as ConnectorOwnerCommands[K]['output'];
    if (kind === 'runtimeMaintenanceResumeAuthorized') return maintenanceResume(
      input as ConnectorAuthorizedMaintenanceCommands['runtimeMaintenanceResumeAuthorized']['input']) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorUpdateKind(kind)) return update(kind,
      input as ConnectorUpdateCommands[typeof kind]['input']) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorMaintenanceKind(kind)) return runtimeMaintenance(kind,
      input as ConnectorMaintenanceCommands[typeof kind]['input']) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexFilesKind(kind)) return applicationFilesTransaction(kind, 'codex', input as ConnectorCodexFilesCommands[typeof kind]['input'],
      applicationTransactions, () => codexFiles(kind,
        input as ConnectorCodexFilesCommands[typeof kind]['input'])) as ConnectorOwnerCommands[K]['output'] | Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorCodexPublicUsageKind(kind)) return executeConnectorCodexPublicUsage(kind,
      input as ConnectorCodexPublicUsageCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorCodexDeletionKind(kind)) return codexDeletion(kind,
      input as ConnectorCodexDeletionCommands[typeof kind]['input']) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorCodexSettingsKind(kind)) return codexSettings(kind,
      input as ConnectorCodexSettingsCommands[typeof kind]['input']) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorTitleKind(kind)) return titles(kind,
      input as ConnectorTitleCommands[typeof kind]['input']) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorCodexCatalogKind(kind)) return executeConnectorCodexCatalog(kind,
      input as ConnectorCodexCatalogCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexCreationKind(kind)) return codexCreation(kind,
      input as ConnectorCodexCreationCommands[typeof kind]['input']) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorAutomationBackgroundKind(kind)) return automationBackground(kind,
      input as ConnectorAutomationBackgroundCommands[typeof kind]['input']) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorAutomationKind(kind)) return automation(kind,
      input as ConnectorAutomationCommands[typeof kind]['input']) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexInteractionKind(kind)) return interactionTransactions.run(kind, 'codex', input, () => codexInteraction(kind,
      input as ConnectorCodexInteractionCommands[typeof kind]['input'])) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorContentReplicaKind(kind)) return contentReplicas(kind,input as ConnectorContentReplicaCommands[typeof kind]['input']) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorWorkspaceFileKind(kind)) return workspaceFiles(kind, input as ConnectorWorkspaceFileCommands[typeof kind]['input']) as ConnectorOwnerCommands[K]['output'];
    if (kind === 'codexQueueContext') return codexContext(input as ConnectorCodexContextCommands['codexQueueContext']['input']) as ConnectorOwnerCommands[K]['output'];
    if (kind === 'sdkExecutionContext') return sdkContext(input as ConnectorSdkContextCommands['sdkExecutionContext']['input']) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorOpenClawCompactKind(kind)) return executeConnectorOpenClawCompact(kind,
      input as ConnectorOpenClawCompactCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorOpenClawStatusKind(kind)) return executeConnectorOpenClawStatus(kind,
      input as ConnectorOpenClawStatusCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorOpenClawStopKind(kind)) return executeConnectorOpenClawStop(kind,
      input as ConnectorOpenClawStopCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorCodexMessageKind(kind)) return executeConnectorCodexMessage(kind,
      input as ConnectorCodexMessageCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorCodexStopKind(kind)) return executeConnectorCodexStop(kind,
      input as ConnectorCodexStopCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorOpenClawMessageKind(kind)) return executeConnectorOpenClawMessage(kind,
      input as ConnectorOpenClawMessageCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorHermesReadKind(kind)) return executeConnectorHermesRead(kind,
      input as ConnectorHermesReadCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorOpenClawReadKind(kind)) return executeConnectorOpenClawRead(kind,
      input as ConnectorOpenClawReadCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexReadKind(kind)) return executeConnectorCodexRead(kind,
      input as ConnectorCodexReadCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorHermesLocalControlKind(kind)) return executeConnectorHermesLocalControl(kind,
      input as ConnectorHermesLocalControlCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorHermesStopKind(kind)) return executeConnectorHermesStop(kind,
      input as ConnectorHermesStopCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorHermesCreationKind(kind)) return executeConnectorHermesCreation(kind,
      input as ConnectorHermesCreationCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorHermesLifecycleKind(kind)) return executeConnectorHermesLifecycle(kind,
      input as ConnectorHermesLifecycleCommands[typeof kind]['input'], owner) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorNativeQueueKind(kind)) return executeConnectorNativeQueue(kind,
      input as ConnectorNativeQueueCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorHermesQueueKind(kind)) return executeConnectorHermesQueue(kind,
      input as ConnectorHermesQueueCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorHermesHistoryKind(kind)) return executeConnectorHermesHistory(kind,
      input as ConnectorHermesHistoryCommands[typeof kind]['input'], owner) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorHermesDeletionKind(kind)) return executeConnectorHermesDeletion(kind,
      input as ConnectorHermesDeletionCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorCodexDispatchKind(kind)) return executeConnectorCodexDispatch(kind,
      input as ConnectorCodexDispatchCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexToolsKind(kind)) return codexTools(kind,
      input as ConnectorCodexToolsCommands[typeof kind]['input']) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexQueuePlanKind(kind)) return codexQueuePlan(kind,
      input as ConnectorCodexQueuePlanCommands[typeof kind]['input']) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexSchedulingKind(kind)) return executeConnectorCodexScheduling(kind,
      input as ConnectorCodexSchedulingCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexResumeKind(kind)) return executeConnectorCodexResume(kind,
      input as ConnectorCodexResumeCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexUsageKind(kind)) return executeConnectorCodexUsage(kind,
      input as ConnectorCodexUsageCommands[typeof kind]['input'], owner) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexFileIndexKind(kind)) return executeConnectorCodexFileIndex(kind,
      input as ConnectorCodexFileIndexCommands[typeof kind]['input'], owner) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexNotificationKind(kind)) return executeConnectorCodexNotification(kind,
      input as ConnectorCodexNotificationCommands[typeof kind]['input'], owner) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexHistoryKind(kind)) return codexHistory(kind,
      input as ConnectorCodexHistoryCommands[typeof kind]['input']) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorCodexStartupKind(kind)) return codexStartup(kind,
      input as ConnectorCodexStartupCommands[typeof kind]['input']) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorOpenClawDispatchKind(kind)) return executeConnectorOpenClawDispatch(kind,
      input as ConnectorOpenClawDispatchCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorHermesDispatchKind(kind)) return executeConnectorHermesDispatch(kind,
      input as ConnectorHermesDispatchCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorHermesMessageKind(kind)) return executeConnectorHermesMessage(kind,
      input as ConnectorHermesMessageCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorHermesExecutionKind(kind)) return executeConnectorHermesExecution(kind,
      input as ConnectorHermesExecutionCommands[typeof kind]['input'], owner) as ConnectorOwnerCommands[K]['output'];
    if (isLocalCredentialsKind(kind)) return localCredentials.execute(kind,
      input as LocalCredentialsCommands[typeof kind]['input']) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkMetadataKind(kind)) return executeConnectorSdkMetadata(kind,
      input as ConnectorSdkMetadataCommands[typeof kind]['input'], owner, tokens, sdkModels) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkFilesKind(kind)) return applicationFilesTransaction(kind, (input as ConnectorSdkFilesCommands[typeof kind]['input']).runtime,
      input as ConnectorSdkFilesCommands[typeof kind]['input'], applicationTransactions, () => files(kind,
        input as ConnectorSdkFilesCommands[typeof kind]['input'])) as ConnectorOwnerCommands[K]['output'] | Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorSdkUsageKind(kind)) return executeConnectorSdkUsage(kind,
      input as ConnectorSdkUsageCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorSessionMediaKind(kind)) return executeConnectorSessionMedia(kind,
      input as ConnectorSessionMediaCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkHistoryKind(kind)) return executeConnectorSdkHistory(kind,
      input as ConnectorSdkHistoryCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkInteractionKind(kind)) return interactionTransactions.run(kind, (input as ConnectorSdkInteractionCommands[typeof kind]['input']).runtime, input,
      () => executeConnectorSdkInteraction(kind, input as ConnectorSdkInteractionCommands[typeof kind]['input'], owner, tokens)) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorSdkLifecycleKind(kind)) return executeConnectorSdkLifecycle(kind,
      input as ConnectorSdkLifecycleCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorSdkStatusKind(kind)) return executeConnectorSdkStatus(kind,
      input as ConnectorSdkStatusCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorSdkStopKind(kind)) return executeConnectorSdkStop(kind,
      input as ConnectorSdkStopCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorSdkTranscriptKind(kind)) return executeConnectorSdkTranscript(kind,
      input as ConnectorSdkTranscriptCommands[typeof kind]['input'], owner) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkMessageKind(kind)) return executeConnectorSdkMessage(kind,
      input as ConnectorSdkMessageCommands[typeof kind]['input'], owner, tokens, sdkModels, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorEventKind(kind)) return executeConnectorEvent(kind,
      input as ConnectorEventCommands[typeof kind]['input'], owner.events) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkLocalRecoveryKind(kind)) return executeConnectorSdkLocalRecovery(
      input as ConnectorSdkLocalRecoveryCommands['sdkLocalReceiptRead']['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkLocalKind(kind)) return executeConnectorSdkLocal(kind,
      input as ConnectorSdkLocalCommands[typeof kind]['input'], owner, tokens, sdkModels, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorSdkCompactKind(kind)) return executeConnectorSdkCompact(kind,
      input as ConnectorSdkCompactCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorSdkAttachmentKind(kind)) return executeConnectorSdkAttachment(kind,
      input as ConnectorSdkAttachmentCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkQueueReadKind(kind)) return executeConnectorSdkQueueRead(kind,
      input as ConnectorSdkQueueReadCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkQueueKind(kind)) return executeConnectorSdkQueue(kind,
      input as ConnectorSdkQueueCommands[typeof kind]['input'], owner, tokens, applicationTransactions) as Promise<ConnectorOwnerCommands[K]['output']>;
    if (isConnectorSdkDispatchKind(kind)) return executeConnectorSdkDispatch(kind,
      input as ConnectorSdkDispatchCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorSdkJournalKind(kind)) return executeConnectorSdkJournal(kind,
      input as ConnectorSdkJournalCommands[typeof kind]['input'], owner) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorMirrorDeliveryKind(kind)) return executeConnectorMirrorDelivery(kind,
      input as ConnectorMirrorDeliveryCommands[typeof kind]['input'], owner, tokens) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorNativeReplyKind(kind)) {
      const value = executeConnectorNativeReply(kind, input as ConnectorNativeReplyCommands[typeof kind]['input'], owner);
      if (!validConnectorNativeReplyOutput(kind, value)) throw new ConnectorOwnerUnavailable();
      return value as ConnectorOwnerCommands[K]['output'];
    }
    if (isConnectorExecutionSettlementKind(kind)) {
      const value = executeConnectorExecutionSettlement(kind, input as ConnectorExecutionSettlementCommands[typeof kind]['input'], owner);
      if (!validConnectorExecutionSettlementOutput(kind, value)) throw new ConnectorOwnerUnavailable();
      return value as ConnectorOwnerCommands[K]['output'];
    }
    if (isConnectorExecutionObservationKind(kind)) {
      const value = executeConnectorExecutionObservation(kind, input as ConnectorExecutionObservationCommands[typeof kind]['input'], owner);
      if (!validConnectorExecutionObservationOutput(kind, value)) throw new ConnectorOwnerUnavailable();
      return value as ConnectorOwnerCommands[K]['output'];
    }
    if (isConnectorExecutionKind(kind)) return executeConnectorExecution(kind, input as ConnectorExecutionCommands[typeof kind]['input'], owner) as ConnectorOwnerCommands[K]['output'];
    if (isConnectorRecoveryKind(kind)) {
      const value = executeConnectorRecovery(input as ConnectorRecoveryCommands[typeof kind]['input'], owner);
      if (!validConnectorRecoveryOutput(kind, value)) throw new ConnectorOwnerUnavailable();
      return value as ConnectorOwnerCommands[K]['output'];
    }
    if (isConnectorStorageKind(kind)) {
      if (!tokens) throw new ConnectorOwnerUnavailable();
      const value = await executeConnectorStorage(kind, input as ConnectorStorageCommands[typeof kind]['input'], { owner, tokens });
      if (!validConnectorStorageOutput(kind, value)) throw new ConnectorOwnerUnavailable();
      return value as ConnectorOwnerCommands[K]['output'];
    }
    if (isConnectorGrantKind(kind)) {
      if (!tokens) throw new ConnectorOwnerUnavailable();
      const value = executeConnectorGrant(kind, input as ConnectorGrantCommands[typeof kind]['input'], { nodeId: owner.nodeId, tokens,
        grants: owner.executionGrants, turns: owner.turns, mirrorOutbox: owner.mirrorOutbox });
      if (!validConnectorGrantOutput(kind, value)) throw new ConnectorOwnerUnavailable();
      return value as ConnectorOwnerCommands[K]['output'];
    }
    if (isConnectorAuthorityKind(kind)) {
      const value = executeConnectorAuthority(kind, input, owner, tokens);
      if (!validConnectorAuthorityOutput(kind, value)) throw new ConnectorOwnerUnavailable();
      return value as ConnectorOwnerCommands[K]['output'];
    }
    const v = input as Record<string, unknown>;
    let value: unknown;
    switch (kind) {
      case 'nodeIdentity': value = owner.nodeId; break;
      case 'usersList': value = owner.listUsers(); break;
      case 'userGet': value = owner.getUser(v.id as string) ?? null; break;
      case 'userCreate': value = owner.createUser(v.label as string); break;
      case 'userUpdate': value = owner.updateUser(v.id as string, v.label as string) ?? null; break;
      case 'sessionPolicy': value = { canDelete: owner.canDeleteSession(v.sessionKey as string), canChangeSettings: owner.canChangeSettings(v.sessionKey as string) }; break;
      case 'turnMaintenanceCount': value = owner.turns.maintenanceCount(v.runtime as string | undefined); break;
      case 'turnSessionPage': value = owner.turns.sessionPage(v.runtime as string, v.after as string, v.limit as number); break;
      case 'receiptDeletion': value = owner.commands.sessionDeletion(v.sessionKey as string) ?? null; break;
      case 'fileSessionObserve': {
        const key = v.sessionKey as string;
        const deleted = !!owner.commands.sessionDeletion(key);
        if (key.startsWith('codex:') && key.length > 6) {
          value = { runtime: 'codex', deleted: deleted || owner.codexExecutions.isDeletedTerminal(key),
            boardTools: owner.codexExecutions.hasBoardTools(key.slice(6)) };
        } else if (key.startsWith('claude-code:') && key.length > 12 || key.startsWith('ghcp:') && key.length > 5 || key.startsWith('antigravity:') && key.length > 12) {
          const runtime = key.startsWith('claude-code:') ? 'claude-code' : key.startsWith('ghcp:') ? 'ghcp' : 'antigravity';
          const journal = runtime === 'claude-code' ? owner.claudeJournal : runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
          value = { runtime, deleted: deleted || !!journal.deletion(key), sessionId: journal.session(key)?.nativeSessionId ?? null };
        } else value = null;
        break;
      }
      case 'receiptSettingsPending': value = owner.commands.sessionSettingsPending(v.sessionKey as string); break;
      case 'interactionCount': value = owner.interactions.unresolvedCount(); break;
      case 'interactionPending': value = owner.interactions.hasUnresolvedKey(v.sessionKey as string); break;
      case 'eventCursor': value = owner.events.latestEventId(); break;
      case 'maintenancePause':
        if (!resume) {
          if (generation === Number.MAX_SAFE_INTEGER) throw new ConnectorOwnerUnavailable();
          resume = owner.pauseTurnStarts(); generation++;
        }
        value = generation; break;
      case 'maintenanceResume':
        value = v.generation === generation && !!resume && resume();
        if (value) resume = undefined;
        break;
      case 'maintenanceStop': owner.stopTurnStarts(); value = null; break;
      case 'maintenanceSnapshot': value = { queueSha256: owner.maintenanceQueueSha256(), commandAdmissionOpen: owner.sdkCommandAdmissionOpen }; break;
      case 'storageRecovery': value = owner.storageRecovery(); break;
    }
    if (!validConnectorOwnerOutput(kind, value)) throw new ConnectorOwnerUnavailable();
    return value as ConnectorOwnerCommands[K]['output'];
  };
  // A display event cursor is NOT a database-fact revision. Several durable
  // settings and live transcript changes intentionally precede notification.
  // Conservatively invalidate on every command except these audited pure
  // observations used by full refresh and concurrent HTTP polling. New commands default to
  // invalidating; there is no caller-supplied "readOnly" escape hatch.
  const epoch = randomUUID();
  let revision = 0, changing = 0;
  const execute = async <K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> => {
    if (!validConnectorOwnerInput(kind, input)) throw new ConnectorOwnerUnavailable();
    if (kind === 'eventProjectionHead') {
      if (changing) throw new ConnectorOwnerUnavailable();
      return { cursor: owner.events.latestEventId(), version: `cv1_${epoch}:${revision}` } as ConnectorOwnerCommands[K]['output'];
    }
    if (projectionReads.has(kind)
      || kind === 'automationBackgroundPlan' && owner.automationOwners().length === 0) return dispatch(kind, input);
    if (revision >= Number.MAX_SAFE_INTEGER - 2) throw new ConnectorOwnerUnavailable();
    revision++; changing++;
    try { return await dispatch(kind, input); }
    finally { revision++; changing--; }
  };
  return Object.assign(execute, { dispose: () => { interactionTransactions.dispose(); titles.dispose(); workspaceFiles.dispose(); codexFiles.dispose(); codexDeletion.dispose(); codexSettings.dispose(); codexCreation.dispose(); automationBackground.dispose(); disposeCodexStopIntents(owner); disposeCodexMessageIntents(owner); codexHistory.dispose(); codexStartup.dispose(); codexQueuePlan.dispose(); codexTools.dispose(); codexInteraction.dispose(); disposeSdkCompactIntents(owner); disposeOpenClawCompactIntents(owner); disposeOpenClawStopIntents(owner); disposeOpenClawMessageIntents(owner); localCredentials.dispose(); } });
}
