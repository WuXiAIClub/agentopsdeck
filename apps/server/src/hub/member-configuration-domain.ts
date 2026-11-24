import { createHash } from 'node:crypto';
import { WORKSPACE_FILE_CARD_MAX_BYTES, validBoardUuid, validWorkspaceFileCard,
  validWorkspaceFileCardWrite, workspaceFileCardContent, type WorkspaceFileCard,
  type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import type { WorkspaceCardConfigurations, WorkspaceCardConfiguration } from './workspace-card-configurations.js';

/** Declarative content only; no caller identity, binding bypass or execution. */
export const HUB_CONFIGURATION_KINDS = ['website', 'browser', 'research', 'terminal', 'media', 'dashboard'] as const;
export type HubConfigurationKind = typeof HUB_CONFIGURATION_KINDS[number];
export type HubConfigurationCommand = { action: 'get'; kind: HubConfigurationKind; resourceId: string }
  | { action: 'save'; kind: HubConfigurationKind; resourceId: string; document: WorkspaceFileCardWrite };
export type HubConfigurationResult = null
  | { action: 'get'; kind: HubConfigurationKind; resourceId: string; document: WorkspaceCardConfiguration | null }
  | { action: 'save'; kind: HubConfigurationKind; resourceId: string; result: ReturnType<WorkspaceCardConfigurations['save']> };
export const HUB_CONFIGURATION_RPC_BYTES = WORKSPACE_FILE_CARD_MAX_BYTES + 16_384;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function validHubConfigurationCommand(v: unknown): v is HubConfigurationCommand {
  if (!record(v) || !HUB_CONFIGURATION_KINDS.includes(v.kind as HubConfigurationKind) || !validBoardUuid(v.resourceId)) return false;
  if (v.action === 'get') return exact(v, ['action', 'kind', 'resourceId']);
  return v.action === 'save' && exact(v, ['action', 'kind', 'resourceId', 'document'])
    && validWorkspaceFileCardWrite(v.document) && v.document.kind === v.kind;
}
function document(kind: HubConfigurationKind, v: unknown): v is WorkspaceCardConfiguration {
  return record(v) && exact(v, ['kind', 'content', 'revision', 'updatedAt']) && v.kind === kind
    && integer(v.revision) && v.revision > 0 && integer(v.updatedAt)
    && validWorkspaceFileCard({ kind: v.kind, content: v.content });
}
export function validHubConfigurationResult(v: unknown): v is HubConfigurationResult {
  if (v === null) return true;
  if (!record(v) || !HUB_CONFIGURATION_KINDS.includes(v.kind as HubConfigurationKind) || !validBoardUuid(v.resourceId)) return false;
  const kind = v.kind as HubConfigurationKind;
  if (v.action === 'get') return exact(v, ['action', 'kind', 'resourceId', 'document'])
    && (v.document === null || document(kind, v.document));
  if (v.action !== 'save' || !exact(v, ['action', 'kind', 'resourceId', 'result']) || !record(v.result)) return false;
  return v.result.status === 'saved' ? exact(v.result, ['status', 'document']) && document(kind, v.result.document)
    : exact(v.result, ['status']) && ['conflict', 'mutation-reused', 'file-managed', 'limit'].includes(String(v.result.status));
}
const hash = (v: WorkspaceFileCard) => createHash('sha256').update(JSON.stringify(workspaceFileCardContent(v))).digest('hex');
export function hubConfigurationExpectation(command: HubConfigurationCommand) {
  return { action: command.action, kind: command.kind, resourceId: command.resourceId,
    ...(command.action === 'save' ? { revision: command.document.revision + 1, contentHash: hash(command.document) } : {}) };
}
export type HubConfigurationExpectation = ReturnType<typeof hubConfigurationExpectation>;
export function validHubConfigurationReply(expected: HubConfigurationExpectation, v: unknown): v is HubConfigurationResult {
  if (!validHubConfigurationResult(v)) return false;
  if (v === null) return true;
  if (v.kind !== expected.kind || v.action !== expected.action || v.resourceId !== expected.resourceId) return false;
  return v.action !== 'save' || v.result.status !== 'saved'
    || v.result.document.revision === expected.revision && hash(v.result.document) === expected.contentHash;
}
export function executeHubConfiguration(store: WorkspaceCardConfigurations, userId: string, command: HubConfigurationCommand): HubConfigurationResult {
  const { kind, resourceId } = command;
  return command.action === 'get' ? { kind, action: 'get', resourceId, document: store.get(userId, kind, resourceId) ?? null }
    : { kind, action: 'save', resourceId, result: store.save(userId, resourceId, command.document) };
}
