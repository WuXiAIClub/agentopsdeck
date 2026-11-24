import { createHash } from 'node:crypto';
import { validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import { BOARD_CAPABILITY_PREFIX, validBoardCapabilityInput, type BoardCapability, type BoardCapabilityInput } from './workspace-board-capabilities.js';

/** Human-owner management only. Machine bearer credentials do not become a
 * Hub principal, and neither arbitrary SQL nor caller-selected user IDs cross
 * this boundary. Agent read/update and native-file binding stay separate. */
export type HubBoardCapabilityCommand = { action: 'list'; resourceId: string }
  | { action: 'issue'; resourceId: string; input: BoardCapabilityInput }
  | { action: 'revoke'; resourceId: string; capabilityId: string }
  | { action: 'events'; resourceId: string; before: number };
export type HubBoardCapabilityEvent = { sequence: number; capabilityId: string; event: string;
  mutationId: string | null; revision: number | null; createdAt: number };
export type HubBoardCapabilityResult = null
  | { action: 'list'; capabilities: BoardCapability[] }
  | { action: 'issue'; issued: { capability: BoardCapability; token: string } | null }
  | { action: 'revoke'; revoked: boolean }
  | { action: 'events'; events: HubBoardCapabilityEvent[] };
// The original quota is 256 grants, each up to 200 task UUIDs. The ordinary
// 16KiB response is insufficient; reserve this bound before accepting work.
export const HUB_BOARD_CAPABILITY_RESULT_BYTES = 3 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function validHubBoardCapabilityCommand(v: unknown): v is HubBoardCapabilityCommand {
  if (!object(v) || !validBoardId(v.resourceId)) return false;
  switch (v.action) {
    case 'list': return fields(v, ['action', 'resourceId']);
    case 'issue': return fields(v, ['action', 'resourceId', 'input']) && validBoardCapabilityInput(v.input);
    case 'revoke': return fields(v, ['action', 'resourceId', 'capabilityId']) && validBoardUuid(v.capabilityId);
    case 'events': return fields(v, ['action', 'resourceId', 'before']) && integer(v.before) && v.before > 0;
    default: return false;
  }
}
function capability(v: unknown): v is BoardCapability {
  return object(v) && fields(v, ['id', 'resourceId', 'taskIds', 'fields', 'expiresAt', 'createdAt', 'revokedAt'])
    && validBoardUuid(v.id) && validBoardId(v.resourceId)
    && validBoardCapabilityInput({ taskIds: v.taskIds, fields: v.fields, expiresAt: v.expiresAt })
    && integer(v.createdAt) && (v.revokedAt === null || integer(v.revokedAt));
}
function event(v: unknown): v is HubBoardCapabilityEvent {
  return object(v) && fields(v, ['sequence', 'capabilityId', 'event', 'mutationId', 'revision', 'createdAt'])
    && integer(v.sequence) && v.sequence > 0 && validBoardUuid(v.capabilityId)
    && ['issued', 'revoked', 'updated', 'denied', 'conflict', 'mutation-reused', 'limit'].includes(String(v.event))
    && (v.mutationId === null || validBoardUuid(v.mutationId)) && (v.revision === null || integer(v.revision) && v.revision > 0)
    && integer(v.createdAt);
}
export function validHubBoardCapabilityResult(v: unknown): v is HubBoardCapabilityResult {
  if (v === null) return true;
  if (!object(v)) return false;
  switch (v.action) {
    case 'list': return fields(v, ['action', 'capabilities']) && Array.isArray(v.capabilities)
      && v.capabilities.length <= 256 && v.capabilities.every(capability)
      && new Set(v.capabilities.map(c => c.id)).size === v.capabilities.length;
    case 'issue': return fields(v, ['action', 'issued']) && (v.issued === null || object(v.issued)
      && fields(v.issued, ['capability', 'token']) && capability(v.issued.capability)
      && typeof v.issued.token === 'string' && new RegExp('^' + BOARD_CAPABILITY_PREFIX + '[A-Za-z0-9_-]{43}$').test(v.issued.token));
    case 'revoke': return fields(v, ['action', 'revoked']) && typeof v.revoked === 'boolean';
    case 'events': return fields(v, ['action', 'events']) && Array.isArray(v.events) && v.events.length <= 100
      && v.events.every(event) && v.events.every((e, i, rows) => i === 0 || rows[i - 1]!.sequence > e.sequence);
    default: return false;
  }
}
// Correlation retains a hash, not bearer credentials or the original DTO.
const grantHash = (v: BoardCapabilityInput) => createHash('sha256').update(JSON.stringify({
  taskIds: [...v.taskIds].sort(), fields: [...v.fields].sort(), expiresAt: v.expiresAt,
})).digest('hex');
export type HubBoardCapabilityReplyExpectation = { action: HubBoardCapabilityCommand['action']; resourceId: string;
  before?: number; grantHash?: string };
export function hubBoardCapabilityReplyExpectation(v: HubBoardCapabilityCommand): HubBoardCapabilityReplyExpectation {
  return { action: v.action, resourceId: v.resourceId, ...(v.action === 'events' ? { before: v.before } : {}),
    ...(v.action === 'issue' ? { grantHash: grantHash(v.input) } : {}) };
}
export function validHubBoardCapabilityReply(expected: HubBoardCapabilityReplyExpectation, v: unknown): v is HubBoardCapabilityResult {
  if (!validHubBoardCapabilityResult(v)) return false;
  if (v === null) return true;
  if (v.action !== expected.action) return false;
  if (v.action === 'list') return v.capabilities.every(c => c.resourceId === expected.resourceId);
  if (v.action === 'events') return v.events.every(e => e.sequence < expected.before!);
  if (v.action === 'issue' && v.issued) return v.issued.capability.resourceId === expected.resourceId
    && v.issued.capability.revokedAt === null && grantHash(v.issued.capability) === expected.grantHash;
  return true;
}
