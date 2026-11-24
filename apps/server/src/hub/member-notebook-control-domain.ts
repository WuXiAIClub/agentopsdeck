import { createHash } from 'node:crypto';
import { privateNotebookResource } from './member-notebook-domain.js';
import { validNotebookMove, NotebookMoveConflict, type NotebookMove } from './notebook-operations.js';
import { validNotebookCapability, type NotebookCapability, type NotebookCapabilities } from './notebook-capabilities.js';
import type { SessionNotebooks } from './session-notebooks.js';
import { validHubSessionNotebookAuthority, type HubSessionNotebookAuthority } from './member-session-notebook-authority.js';
import type { NotebookAuthority } from './notebook-capabilities.js';
import { isAgentRuntimeId } from '@agentopsdeck/shared';
import { isNodeId } from '../connector/node-identity.js';
import { legacySessionKey } from './session-ref.js';

/** Exact human controls. Session commands require the original route proof;
 * machine tokens and bound-file coordination are never substituted for it. */
export type HubNotebookControlCommand = ({ action: 'receipt'; resourceId: string; requestId: string }
  | { action: 'move'; resourceId: string; input: NotebookMove }
  | { action: 'capabilities'; resourceId: string }
  | { action: 'issue'; resourceId: string; input: Parameters<NotebookCapabilities['issue']>[2] }
  | { action: 'revoke'; resourceId: string; capabilityId: string }) & { authority?: HubSessionNotebookAuthority };
type MoveResult = { hotRevision: number; coldRevision: number; moved: number };
export type HubNotebookControlResult = null
  | { action: 'denied'; resourceId: string; operation: HubNotebookControlCommand['action'] }
  | { action: 'receipt'; resourceId: string; requestId: string; result: MoveResult | null }
  | { action: 'move'; resourceId: string; requestId: string; result: MoveResult | null; conflict: string | null }
  | { action: 'capabilities'; resourceId: string; capabilities: NotebookCapability[] }
  | { action: 'issue'; resourceId: string; issued: { capability: NotebookCapability; token: string } | null }
  | { action: 'revoke'; resourceId: string; capabilityId: string; revoked: boolean };
export const HUB_NOTEBOOK_CONTROL_COMMAND_BYTES = 65_536;
// 64 capabilities can each carry the original escaped session resource.
// The shared owner still reserves the bounded result budget before admission.
export const HUB_NOTEBOOK_CONTROL_RESULT_BYTES = 2 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export const notebookControlUuid = (v: unknown): v is string => typeof v === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const privateResource = (v: unknown): v is string => typeof v === 'string' && v.length <= 128 && privateNotebookResource(v, false);
function sessionResource(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 8192) return false;
  try {
    const parts: unknown = JSON.parse(v);
    if (!Array.isArray(parts) || parts.length !== 4 || JSON.stringify(parts) !== v
      || typeof parts[0] !== 'string' || !parts[0] || parts[0].length > 4096
      || !isNodeId(parts[1]) || !isAgentRuntimeId(parts[2]) || typeof parts[3] !== 'string') return false;
    legacySessionKey({ nodeId: parts[1], runtimeId: parts[2], nativeSessionKey: parts[3] });
    return true;
  } catch { return false; }
}
const resource = (v: unknown): v is string => privateResource(v) || sessionResource(v);
const actions = new Set(['receipt', 'move', 'capabilities', 'issue', 'revoke']);
const conflicts = new Set(['Invalid move', 'Request ID already used', 'Linked notebook requires coordinated file projection',
  'Receipt capacity reached', 'Notebook changed', 'Invalid ranges', 'Selection changed', 'Move limit exceeded', 'Destination full']);
export function validHubNotebookControlCommand(v: unknown): v is HubNotebookControlCommand {
  if (!object(v)) return false;
  const session = Object.hasOwn(v, 'authority');
  if (session ? !sessionResource(v.resourceId) || !validHubSessionNotebookAuthority(v.authority) : !privateResource(v.resourceId)) return false;
  const exact = (names: string[]) => fields(v, session ? [...names, 'authority'] : names);
  switch (v.action) {
    case 'receipt': return exact(['action', 'resourceId', 'requestId']) && notebookControlUuid(v.requestId);
    case 'move': return exact(['action', 'resourceId', 'input']) && validNotebookMove(v.input);
    case 'capabilities': return exact(['action', 'resourceId']);
    case 'issue': return exact(['action', 'resourceId', 'input']) && validNotebookCapability(v.input);
    case 'revoke': return exact(['action', 'resourceId', 'capabilityId']) && notebookControlUuid(v.capabilityId);
    default: return false;
  }
}
function move(v: unknown): v is MoveResult {
  return object(v) && fields(v, ['hotRevision', 'coldRevision', 'moved'])
    && integer(v.hotRevision) && v.hotRevision > 0 && integer(v.coldRevision) && v.coldRevision > 0
    && integer(v.moved) && v.moved > 0 && v.moved <= 16_000;
}
function capability(v: unknown): v is NotebookCapability {
  return object(v) && fields(v, ['id', 'resourceId', 'facets', 'expiresAt', 'createdAt', 'revokedAt'])
    && notebookControlUuid(v.id) && resource(v.resourceId)
    && validNotebookCapability({ facets: v.facets, expiresAt: v.expiresAt })
    && integer(v.createdAt) && Number(v.expiresAt) > v.createdAt
    && (v.revokedAt === null || integer(v.revokedAt));
}
export function validHubNotebookControlResult(v: unknown): v is HubNotebookControlResult {
  if (v === null) return true;
  if (!object(v) || !resource(v.resourceId)) return false;
  switch (v.action) {
    case 'denied': return fields(v, ['action', 'resourceId', 'operation']) && typeof v.operation === 'string' && actions.has(v.operation);
    case 'receipt': return fields(v, ['action', 'resourceId', 'requestId', 'result']) && notebookControlUuid(v.requestId)
      && (v.result === null || move(v.result));
    case 'move': return fields(v, ['action', 'resourceId', 'requestId', 'result', 'conflict']) && notebookControlUuid(v.requestId)
      && (v.result === null ? typeof v.conflict === 'string' && conflicts.has(v.conflict) : move(v.result) && v.conflict === null);
    case 'capabilities': return fields(v, ['action', 'resourceId', 'capabilities']) && Array.isArray(v.capabilities)
      && v.capabilities.length <= 64 && v.capabilities.every(capability)
      && v.capabilities.every(c => c.resourceId === v.resourceId)
      && new Set(v.capabilities.map(c => c.id)).size === v.capabilities.length;
    case 'issue': return fields(v, ['action', 'resourceId', 'issued']) && (v.issued === null || object(v.issued)
      && fields(v.issued, ['capability', 'token']) && capability(v.issued.capability)
      && v.issued.capability.resourceId === v.resourceId && v.issued.capability.revokedAt === null
      && typeof v.issued.token === 'string' && /^aod_note_[A-Za-z0-9_-]{43}$/.test(v.issued.token));
    case 'revoke': return fields(v, ['action', 'resourceId', 'capabilityId', 'revoked'])
      && notebookControlUuid(v.capabilityId) && typeof v.revoked === 'boolean';
    default: return false;
  }
}
const grantHash = (v: Pick<NotebookCapability, 'facets' | 'expiresAt'>) => createHash('sha256')
  .update(JSON.stringify({ facets: [...v.facets].sort(), expiresAt: v.expiresAt })).digest('hex');
export function hubNotebookControlExpectation(c: HubNotebookControlCommand) {
  return { action: c.action, resourceId: c.resourceId,
    requestId: c.action === 'receipt' ? c.requestId : c.action === 'move' ? c.input.requestId : undefined,
    capabilityId: c.action === 'revoke' ? c.capabilityId : undefined,
    grantHash: c.action === 'issue' ? grantHash(c.input) : undefined,
    hotRevision: c.action === 'move' ? c.input.hotRevision + 1 : undefined,
    coldRevision: c.action === 'move' ? c.input.coldRevision + 1 : undefined,
    moved: c.action === 'move' ? c.input.ranges.reduce((n, r) => n + r.end - r.start, 0) : undefined };
}
export function validHubNotebookControlReply(e: ReturnType<typeof hubNotebookControlExpectation>, v: unknown): v is HubNotebookControlResult {
  if (!validHubNotebookControlResult(v)) return false;
  if (v === null) return true;
  if (v.action === 'denied') return v.resourceId === e.resourceId && v.operation === e.action;
  if (v.action !== e.action || v.resourceId !== e.resourceId) return false;
  if ((v.action === 'receipt' || v.action === 'move') && v.requestId !== e.requestId) return false;
  if (v.action === 'move' && v.result) return v.result.hotRevision === e.hotRevision
    && v.result.coldRevision === e.coldRevision && v.result.moved === e.moved;
  if (v.action === 'issue' && v.issued) return grantHash(v.issued.capability) === e.grantHash;
  if (v.action === 'revoke') return v.capabilityId === e.capabilityId;
  return true;
}
/** Called only inside the original identity/scope savepoint. Never runs SQL
 * supplied by callers, invokes callbacks or creates another writer. */
export function executeHubNotebookControl(user: string, notes: SessionNotebooks, caps: NotebookCapabilities,
  command: HubNotebookControlCommand, authority: NotebookAuthority = null): Exclude<HubNotebookControlResult, null> {
  const resourceId = command.resourceId;
  switch (command.action) {
    case 'receipt': return { action: 'receipt', resourceId, requestId: command.requestId,
      result: notes.moveReceipt(user, resourceId, command.requestId) ?? null };
    case 'move': {
      const reply = { action: 'move' as const, resourceId, requestId: command.input.requestId };
      try { return { ...reply, result: notes.move(user, resourceId, command.input), conflict: null }; }
      catch (error) {
        if (error instanceof NotebookMoveConflict && conflicts.has(error.message)) return { ...reply, result: null, conflict: error.message };
        throw error;
      }
    }
    case 'capabilities': return { action: 'capabilities', resourceId, capabilities: caps.list(user, resourceId) };
    case 'issue': return { action: 'issue', resourceId, issued: caps.issue(user, resourceId, command.input, authority) ?? null };
    case 'revoke': return { action: 'revoke', resourceId, capabilityId: command.capabilityId, revoked: caps.revoke(user, resourceId, command.capabilityId) };
  }
}
