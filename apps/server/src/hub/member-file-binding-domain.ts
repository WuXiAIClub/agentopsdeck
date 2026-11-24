import { validBoardId, validBoardUuid, validWorkspaceFileCardResource } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import { publicFileBoardBinding } from './workspace-board-files.js';

/** Metadata only. No subscription, reconciliation, file I/O or write receipt is admitted. */
export type HubFileBindingCommand = { domain: 'board' | 'card'; resourceId: string } &
  ({ action: 'current' } | { action: 'get'; bindingId: string });
export type HubPublicFileBinding = ReturnType<typeof publicFileBoardBinding>;
export type HubFileBindingResult = null | (HubFileBindingCommand & { binding: HubPublicFileBinding | null });
export const HUB_FILE_BINDING_RPC_BYTES = 65_536;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join(',') === expected.sort().join(',');
export function validHubFileBindingCommand(v: unknown): v is HubFileBindingCommand {
  return record(v) && (v.domain === 'board' ? validBoardId(v.resourceId) : v.domain === 'card' && validWorkspaceFileCardResource(v.resourceId))
    && (v.action === 'current' ? keys(v, ['domain', 'resourceId', 'action'])
      : v.action === 'get' && validBoardUuid(v.bindingId) && keys(v, ['domain', 'resourceId', 'action', 'bindingId']));
}
export function validHubFileBindingResult(v: unknown): v is HubFileBindingResult {
  if (v === null) return true;
  if (!record(v) || !Object.hasOwn(v, 'binding')) return false;
  const { binding, ...command } = v;
  if (!validHubFileBindingCommand(command)) return false;
  return binding === null || record(binding) && keys(binding, ['bindingId', 'resourceId', 'sessionId', 'state', 'problem'])
    && validBoardUuid(binding.bindingId) && binding.resourceId === command.resourceId
    && (command.action !== 'get' || binding.bindingId === command.bindingId)
    && typeof binding.sessionId === 'string' && binding.sessionId.length > 0 && binding.sessionId.length <= 1024
    && ['prepared', 'active', 'revoked'].includes(String(binding.state))
    && (binding.problem === null || typeof binding.problem === 'string' && binding.problem.length <= 1024)
    && (command.action !== 'current' || binding.state !== 'revoked');
}
export function validHubFileBindingReply(command: HubFileBindingCommand, value: unknown): value is HubFileBindingResult {
  return validHubFileBindingResult(value) && (value === null || value.domain === command.domain
    && value.resourceId === command.resourceId && value.action === command.action
    && (command.action !== 'get' || value.action === 'get' && value.bindingId === command.bindingId));
}
export function executeHubFileBinding(store: Pick<HubStore, 'boardFiles' | 'cardFiles'>, userId: string, command: HubFileBindingCommand): HubFileBindingResult {
  const files = command.domain === 'board' ? store.boardFiles : store.cardFiles;
  const binding = command.action === 'current' ? files.current(userId, command.resourceId) : files.get(userId, command.bindingId);
  return { ...command, binding: binding?.resourceId === command.resourceId ? publicFileBoardBinding(binding) : null };
}
