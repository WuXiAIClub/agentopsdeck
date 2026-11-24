import { validBoardUuid, parseWorkspaceFileCardResource } from '@agentopsdeck/shared';
import type { HubStore, HubConnection } from './hub-store.js';
import type { SessionNotebooks } from './session-notebooks.js';
import type { NotebookFacet } from './notebook-capabilities.js';
import { NotebookMoveConflict, validNotebookMove, type NotebookMove } from './notebook-operations.js';
import { executeNotebookMachineNativeFile, validHubNativeFileCommand, validHubNativeFileResult,
  validHubNativeFileReply, nativeFileExpectation,
  type HubNativeFileCommand, type HubNativeFileResult } from './member-native-file-domain.js';
import { validHubConnectorAccessResult } from './member-connector-access-domain.js';
import {HUB_NATIVE_FILE_BYTES} from './native-file-budget.js';

/** A capability is not a human identity. Only the original bearer selects the
 * owner and notebook; every operation is run in the original SQL savepoint. */
export type NotebookMachineContext = { capabilityId: string; resourceId: string; fileResource: string; bindingId: string };
type Query = [string, string][];
type Move = { hotRevision: number; coldRevision: number; moved: number };
type Slice = { resourceId: string; area: 'hot' | 'cold'; revision: number; start: number; end: number; total: number; text: string };
type Search = ReturnType<SessionNotebooks['searchAreas']>;
type Read = { status: 200; body: Slice | Search } | { status: 400 | 409; body: { error: string } };
export type HubNotebookMachineCommand = { token: string } & (
  { action: 'authorized'; facets: NotebookFacet[] }
  | { action: 'read'; query: Query }
  | { action: 'context' | 'access' }
  | { action: 'move'; input: NotebookMove }
  | { action: 'receipt'; requestId: string }
  | { action: 'native'; requestId: string; command: HubNativeFileCommand });
export type HubNotebookMachineResult = null
  | { action: 'authorized'; authorized: boolean }
  | { action: 'read'; result: Read }
  | { action: 'context'; context: NotebookMachineContext | null }
  | { action: 'access'; context: NotebookMachineContext; connection: HubConnection; epoch: number; token: string | null }
  | { action: 'move' | 'receipt'; requestId: string; result: Move | null; conflict: boolean }
  | { action: 'native'; result: HubNativeFileResult };
export const HUB_NOTEBOOK_MACHINE_BYTES = HUB_NATIVE_FILE_BYTES + 32_768;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const string = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const facets = (v: unknown): v is NotebookFacet[] => Array.isArray(v) && v.length <= 3 && new Set(v).size === v.length
  && v.every(f => ['hot:read', 'cold:read', 'move'].includes(f));
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const moveFacets: NotebookFacet[] = ['hot:read', 'cold:read', 'move'];
const nativeActions = new Set(['current', 'get', 'target', 'move-select', 'write-plan', 'write-admit', 'write-read', 'write-settle', 'refresh-apply', 'move-finish']);
export function validHubNotebookMachineCommand(v: unknown): v is HubNotebookMachineCommand {
  if (!object(v) || typeof v.token !== 'string' || !/^aod_note_[A-Za-z0-9_-]{43}$/.test(v.token)) return false;
  const exact = (...names: string[]) => keys(v, ['token', 'action', ...names]);
  switch (v.action) {
    case 'authorized': return exact('facets') && facets(v.facets);
    case 'context': case 'access': return exact();
    case 'read': return exact('query') && Array.isArray(v.query) && v.query.length <= 16
      && v.query.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && p[0].length <= 128 && typeof p[1] === 'string' && p[1].length <= 8192);
    case 'move': return exact('input') && validNotebookMove(v.input);
    case 'receipt': return exact('requestId') && uuid(v.requestId);
    case 'native': return exact('requestId', 'command') && validBoardUuid(v.requestId) && validHubNativeFileCommand(v.command)
      && v.command.domain === 'card' && !v.command.sessionProof && nativeActions.has(v.command.action)
      && (!('request' in v.command) || v.command.request.mode === 'move');
    default: return false;
  }
}
function context(v: unknown): v is NotebookMachineContext {
  return object(v) && keys(v, ['capabilityId', 'resourceId', 'fileResource', 'bindingId']) && validBoardUuid(v.capabilityId)
    && string(v.resourceId) && string(v.fileResource) && parseWorkspaceFileCardResource(v.fileResource)?.kind === 'notebook' && validBoardUuid(v.bindingId);
}
function read(v: unknown): v is Read {
  if (!object(v) || !keys(v, ['status', 'body']) || !object(v.body)) return false;
  const b = v.body;
  if (v.status === 400 || v.status === 409) return keys(b, ['error']) && typeof b.error === 'string'
    && (v.status === 409 ? b.error === 'revision_changed' : ['Invalid read', 'Invalid area', 'Invalid search', 'Select one area for a slice', 'Invalid range'].includes(b.error));
  if (v.status !== 200) return false;
  if ('results' in b) return keys(b, ['hotRevision', 'coldRevision', 'results']) && [b.hotRevision, b.coldRevision].every(n => n === null || integer(n))
    && Array.isArray(b.results) && b.results.length <= 20 && b.results.every(r => object(r)
      && keys(r, ['area', 'revision', 'start', 'end', 'text']) && ['hot', 'cold'].includes(String(r.area)) && integer(r.revision)
      && integer(r.start) && integer(r.end) && r.end > r.start && typeof r.text === 'string' && r.text.length <= 264);
  return keys(b, ['resourceId', 'area', 'revision', 'start', 'end', 'total', 'text']) && string(b.resourceId)
    && ['hot', 'cold'].includes(String(b.area)) && [b.revision, b.start, b.end, b.total].every(integer)
    && typeof b.text === 'string' && b.text.length <= 4000 && Number(b.start) + b.text.length === b.end && Number(b.end) <= Number(b.total);
}
export function validHubNotebookMachineResult(v: unknown): v is HubNotebookMachineResult {
  if (v === null) return true;
  if (!object(v)) return false;
  switch (v.action) {
    case 'authorized': return keys(v, ['action', 'authorized']) && typeof v.authorized === 'boolean';
    case 'read': return keys(v, ['action', 'result']) && read(v.result);
    case 'context': return keys(v, ['action', 'context']) && (v.context === null || context(v.context));
    case 'access': return keys(v, ['action', 'context', 'connection', 'epoch', 'token']) && context(v.context)
      && validHubConnectorAccessResult({connection: v.connection, epoch: v.epoch, token: v.token}) && object(v.connection)
      && v.connection.status !== 'disabled' && !!v.connection.nodeId && (v.connection.kind !== 'local' || v.token === null);
    case 'native': return keys(v, ['action', 'result']) && validHubNativeFileResult(v.result);
    case 'move': case 'receipt': return keys(v, ['action', 'requestId', 'result', 'conflict'])
      && (uuid(v.requestId) || validBoardUuid(v.requestId)) && typeof v.conflict === 'boolean'
      && (v.result === null || !v.conflict && object(v.result) && keys(v.result, ['hotRevision', 'coldRevision', 'moved'])
        && [v.result.hotRevision, v.result.coldRevision, v.result.moved].every(integer) && Number(v.result.moved) > 0 && Number(v.result.moved) <= 16_000);
    default: return false;
  }
}
/** Correlation data excludes bearer, read text and remote credentials. */
export function notebookMachineExpectation(c: HubNotebookMachineCommand) {
  return {action: c.action, requestId: c.action === 'move' ? c.input.requestId : c.action === 'receipt' ? c.requestId : undefined,
    native: c.action === 'native' ? nativeFileExpectation(c.command) : undefined,
    query: c.action === 'read' ? c.query.map(([k, v]) => [k, v] as [string, string]) : undefined};
}
export function validHubNotebookMachineReply(e: ReturnType<typeof notebookMachineExpectation>, v: unknown): v is HubNotebookMachineResult {
  if (!validHubNotebookMachineResult(v) || v === null) return v === null;
  if (v.action !== e.action) return false;
  if (v.action === 'native') return !!e.native && validHubNativeFileReply(e.native, v.result);
  if (v.action === 'move' || v.action === 'receipt') return v.requestId === e.requestId;
  if (v.action !== 'read' || v.result.status !== 200) return true;
  const p = new URLSearchParams(e.query), area = p.get('area') ?? 'hot', b = v.result.body;
  if ('results' in b) return p.has('q') && (area !== 'cold' || b.hotRevision === null && b.results.every(r => r.area === 'cold'))
    && (area !== 'hot' || b.coldRevision === null && b.results.every(r => r.area === 'hot'));
  return !p.has('q') && b.area === area && b.start === Number(p.get('start') ?? 0)
    && b.text.length <= Number(p.get('limit') ?? 2000) && (!p.has('revision') || b.revision === Number(p.get('revision')));
}

export function executeHubNotebookMachine(owner: HubStore, c: HubNotebookMachineCommand): HubNotebookMachineResult {
  if (!validHubNotebookMachineCommand(c)) throw Error('hub_notebook_machine_unavailable');
  const required = c.action === 'authorized' ? c.facets : c.action === 'read' ? [] : moveFacets;
  const grant = owner.notebookCapabilities.authorized(c.token, required);
  if (c.action === 'authorized') return {action: c.action, authorized: !!grant};
  if (!grant) return null;
  const notes = owner.notebooks, user = grant.owner, resource = grant.resourceId;
  if (c.action === 'read') {
    const params = new URLSearchParams(c.query);
    const bad = (error: string, status: 400 | 409 = 400): HubNotebookMachineResult => ({action: 'read', result: {status, body: {error}}});
    if ([...params.keys()].some(k => !['area', 'q', 'start', 'limit', 'revision'].includes(k) || params.getAll(k).length !== 1)) return bad('Invalid read');
    const area = params.get('area') ?? 'hot';
    if (area !== 'hot' && area !== 'cold' && area !== 'both') return bad('Invalid area');
    if (!owner.notebookCapabilities.authorized(c.token, area === 'both' ? ['hot:read', 'cold:read'] : [area === 'cold' ? 'cold:read' : 'hot:read'])) return null;
    if (params.has('q')) {
      const q = params.get('q')!;
      if (!q.trim() || q.length > 200 || ['start', 'limit', 'revision'].some(k => params.has(k))) return bad('Invalid search');
      return {action: 'read', result: {status: 200, body: notes.searchAreas(user, resource, q, area)}};
    }
    if (area === 'both') return bad('Select one area for a slice');
    const start = Number(params.get('start') ?? 0), limit = Number(params.get('limit') ?? 2000);
    if (!integer(start) || !integer(limit) || limit < 1 || limit > 4000) return bad('Invalid range');
    const doc = area === 'cold' ? notes.getArchive(user, resource) : notes.get(user, resource);
    if (params.has('revision') && (!/^(0|[1-9][0-9]*)$/.test(params.get('revision')!) || Number(params.get('revision')) !== doc.revision)) return bad('revision_changed', 409);
    if (start > doc.text.length) return bad('Invalid range');
    const text = doc.text.slice(start, start + limit);
    return {action: 'read', result: {status: 200, body: {resourceId: resource, area, revision: doc.revision, start, end: start + text.length, total: doc.text.length, text}}};
  }
  if (c.action === 'move' || c.action === 'receipt') {
    const requestId = c.action === 'move' ? c.input.requestId : c.requestId;
    // File moves MUST enter the original native intent/executor, not local CAS.
    if (notes.fileBinding(user, resource)) return null;
    try { return {action: c.action, requestId, conflict: false, result: (c.action === 'move' ? notes.move(user, resource, c.input) : notes.moveReceipt(user, resource, requestId)) ?? null}; }
    catch (error) { if (error instanceof NotebookMoveConflict) return {action: c.action, requestId, result: null, conflict: true}; throw error; }
  }
  const binding = grant.binding ? owner.cardFiles.get(user, grant.binding) : undefined;
  if (c.action === 'context' && !binding && !grant.binding) return {action: 'context', context: null};
  if (!binding || binding.state !== 'active' || parseWorkspaceFileCardResource(binding.resourceId)?.kind !== 'notebook') return null;
  const ctx: NotebookMachineContext = {capabilityId: grant.id, resourceId: resource, fileResource: binding.resourceId, bindingId: binding.bindingId};
  if (c.action === 'context') return {action: c.action, context: ctx};
  if (c.action === 'access') {
    const connection = owner.getConnection(binding.connectionId, user), epoch = owner.connectionAuthority(binding.connectionId, user);
    if (!connection || connection.status === 'disabled' || !connection.nodeId || epoch !== binding.authority) return null;
    return {action: c.action, context: ctx, connection, epoch, token: connection.kind === 'local' ? null : owner.getCredentialToken(connection.id, user) ?? null};
  }
  if (c.action !== 'native') return null;
  const n = c.command;
  if (n.resourceId !== binding.resourceId || 'bindingId' in n && n.bindingId !== binding.bindingId
    || 'sessionId' in n && n.sessionId !== binding.sessionId || 'notebookResource' in n && n.notebookResource !== resource
    || 'request' in n && (n.request.mode !== 'move' || n.request.notebookResource !== resource || n.request.input.requestId !== c.requestId)
    || 'mutationId' in n && n.mutationId !== c.requestId || 'requestId' in n && n.requestId !== c.requestId) return null;
  // A bearer for moves is not permission to settle an unrelated editor write.
  // Only the original, durable bound-move UUID may cross the receipt boundary.
  if (n.action === 'write-read' || n.action === 'write-settle' || n.action === 'refresh-apply') {
    const old = notes.boundMove(user, resource, c.requestId);
    const receipt = owner.cardFiles.writeReceipt(user, binding.bindingId, c.requestId);
    // A newly installed file has no source hash yet. The original executor
    // must first GET its snapshot before it can plan the move. This is a
    // one-time, baseline-CAS projection, not settlement of a write receipt.
    const initialProjection = n.action === 'refresh-apply' && binding.sourceHash === null
      && n.baseline === null && !old && !receipt;
    if (!initialProjection) {
      if (!old || old.bindingId !== binding.bindingId || old.fileResource !== binding.resourceId) return null;
      // Once initialized, refresh follows only this move's confirmed write.
      if (n.action === 'refresh-apply' && receipt?.state !== 'saved') return null;
    }
  }
  return {action: 'native', result: executeNotebookMachineNativeFile(owner, user, n)};
}
