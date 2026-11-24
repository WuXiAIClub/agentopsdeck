import { createHash } from 'node:crypto';
import { validBoardId, validBoardUuid,
  validBoardWrite, validBoardContent, validWorkspaceFileCard, validWorkspaceFileCardWrite,
  parseWorkspaceFileCardResource, workspaceFileCardContent, workspaceFileCardResource, type BoardContent, type BoardWrite,
  NOTEBOOK_ARCHIVE_MAX_CHARS, type SessionNotebookDocument, type WorkspaceFileCard, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { FileBoardBinding, FileBoardApplyResult } from './workspace-board-files.js';
import type { WorkspaceFileSnapshot } from '../connector/workspace-file-codec.js';
import { ArchiveUpgradeConflict } from './workspace-card-files.js';
import { NotebookMoveConflict, validNotebookMove, type NotebookMove } from './notebook-operations.js';
import { moveInput } from './session-notebooks.js';
import { decodeHubSessionId } from './session-id.js';
import { serializeBoardFile } from '../connector/workspace-board-file-format.js';
import { serializeCardFile } from '../connector/workspace-file-card-format.js';
import { validNotebookInput } from './session-notebooks.js';
import { validHubSessionNotebookAuthority, sessionNotebookResourceMatches, sessionNotebookAuthorityCurrent,
  type HubSessionNotebookAuthority } from './member-session-notebook-authority.js';
import { validNativeNotebookAutosave, planNativeNotebookAutosave, finishNativeNotebookAutosave,
  NativeNotebookAutosaveConflict, type NativeNotebookAutosave } from './native-notebook-autosave.js';

/** Fixed original transactions, not a method-name facade. Identity and these
 * operations execute in one original savepoint. Network/file effects stay out. */
export type SessionNativeFileProof = {authority: HubSessionNotebookAuthority; resourceId: string};
export type NativeFileScope = { domain: 'board' | 'card'; resourceId: string; sessionProof?: SessionNativeFileProof };
export type NativeFileTarget = { sessionId: string; connectionId: string; sessionKey: string; nodeId: string; authority: number };
export type NativeFileWrite = BoardWrite | WorkspaceFileCardWrite;
export type NativeFileRequest = { mode: 'ordinary'; input: NativeFileWrite }
  | NativeNotebookAutosave
  | { mode: 'archive'; revision: number; mutationId: string }
  | { mode: 'move'; notebookResource: string; input: NotebookMove };
type NativeSnapshot = WorkspaceFileSnapshot<BoardContent | WorkspaceFileCard>;
export type HubNativeFileCommand = NativeFileScope & (
  { action: 'current' } | { action: 'target'; sessionId: string }
  // Original editor selection + receipt/content validation in one savepoint.
  // Only taskboard/statuscard may select the exact sibling of the same ID.
  | { action: 'editor-select'; input: WorkspaceFileCardWrite }
  | { action: 'move-select'; notebookResource: string; requestId: string; input: NotebookMove | null }
  | { action: 'notebook-plan' | 'notebook-finish'; bindingId: string; request: NativeNotebookAutosave }
  | { action: 'get'; bindingId: string } | { action: 'revoke'; bindingId: string } | { action: 'cancel'; bindingId: string }
  | { action: 'bind-plan'; sessionId: string; bindingId: string; revision: number }
  | { action: 'bind-admit'; target: NativeFileTarget; bindingId: string; revision: number }
  | { action: 'installation-settle'; bindingId: string; target: NativeFileTarget; state: 'installed' | 'revoked' }
  | { action: 'write-plan'; bindingId: string; request: NativeFileRequest }
  | { action: 'write-admit'; bindingId: string; target: NativeFileTarget; request: NativeFileRequest }
  | { action: 'write-read'; bindingId: string; mutationId: string }
  // Read-only negative evidence for THIS original archive mutation. A failed
  // admission ACK or network error is never itself proof of non-admission.
  | { action: 'archive-status'; bindingId: string; mutationId: string }
  | { action: 'write-settle'; bindingId: string; target: NativeFileTarget; mutationId: string;
      expectedHash: string; state: 'saved' | 'conflict' | 'uncertain'; snapshot: NativeSnapshot | null }
  | { action: 'refresh-apply'; bindingId: string; target: NativeFileTarget; baseline: string | null; snapshot: NativeSnapshot }
  | { action: 'move-finish'; bindingId: string; notebookResource: string; requestId: string });
type Binding = Omit<FileBoardBinding, 'userId'>;
type Receipt = { mutationId: string; expectedHash: string; state: 'saved' | 'conflict' | 'uncertain'; fingerprint: string };
type Move = { hotRevision: number; coldRevision: number; moved: number };
type Correlation = Pick<NativeFileScope, 'domain' | 'resourceId'> & { action: HubNativeFileCommand['action'];
  bindingId: string | null; mutationId: string | null; sessionHash?: string };
/** All fields are bounded and explicit. This private DTO is never serialized
 * directly as a browser binding (which still uses publicFileBoardBinding). */
export type HubNativeFileResult = null | { error: 403 | 404 | 409 | 429 } | (Correlation & {
  binding: Binding | null; target: NativeFileTarget | null;
  document: NativeFileWrite | null; receipt: Receipt | null; fresh: boolean;
  applied: FileBoardApplyResult | null; move: Move | null; moveState: 'pending' | 'saved' | 'conflict' | null;
  note: SessionNotebookDocument | null;
});
// A reply contains at most one full original document, never document+snapshot.
export {HUB_NATIVE_FILE_BYTES} from './native-file-budget.js';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < Number.MAX_SAFE_INTEGER;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const states = ['saved', 'conflict', 'uncertain'];
const resources = (v: NativeFileScope | Record<string, unknown>) => v.domain === 'board' ? validBoardId(v.resourceId)
  : v.domain === 'card' && !!parseWorkspaceFileCardResource(v.resourceId);
function validTarget(v: unknown): v is NativeFileTarget {
  if (!object(v) || !fields(v, ['sessionId', 'connectionId', 'sessionKey', 'nodeId', 'authority'])
    || !text(v.sessionId) || !text(v.connectionId, 160) || !text(v.sessionKey) || !text(v.nodeId, 1024)
    || !revision(v.authority) || !/^(codex|claude-code|ghcp):/.test(v.sessionKey)) return false;
  const decoded = decodeHubSessionId(v.sessionId);
  return !!decoded && decoded.connectionId === v.connectionId && decoded.remoteSessionKey === v.sessionKey;
}
function sameTarget(a: NativeFileTarget, b: NativeFileTarget): boolean {
  return a.sessionId === b.sessionId && a.connectionId === b.connectionId && a.sessionKey === b.sessionKey
    && a.nodeId === b.nodeId && a.authority === b.authority;
}
function documentHash(scope: NativeFileScope, value: NativeFileWrite): string {
  const content = scope.domain === 'board' ? serializeBoardFile(value as BoardWrite)
    : serializeCardFile(workspaceFileCardContent(value as WorkspaceFileCardWrite));
  return createHash('sha256').update(JSON.stringify([value.revision, value.mutationId, content])).digest('hex');
}
function validWrite(scope: NativeFileScope, v: unknown): v is NativeFileWrite {
  if (scope.domain === 'board') return validBoardWrite(v);
  return validWorkspaceFileCardWrite(v) && v.kind === parseWorkspaceFileCardResource(scope.resourceId)?.kind;
}
export function validNativeFileSnapshot(scope: NativeFileScope, v: unknown): v is NativeSnapshot {
  if (!object(v) || !['ready', 'missing', 'invalid', 'too-large', 'unsafe', 'unavailable'].includes(String(v.state))) return false;
  if (!Object.hasOwn(v, 'value')) return v.state !== 'ready' && fields(v, ['state']);
  if (!fields(v, ['state', 'value']) || !object(v.value) || !fields(v.value, ['content', 'hash']) || !hash(v.value.hash)) return false;
  return scope.domain === 'board' ? validBoardContent(v.value.content) : validWorkspaceFileCard(v.value.content)
    && v.value.content.kind === parseWorkspaceFileCardResource(scope.resourceId)?.kind;
}
function validRequest(scope: NativeFileScope, v: unknown): v is NativeFileRequest {
  if (!object(v)) return false;
  if (v.mode === 'ordinary') return fields(v, ['mode', 'input']) && validWrite(scope, v.input);
  if (scope.domain !== 'card' || parseWorkspaceFileCardResource(scope.resourceId)?.kind !== 'notebook') return false;
  if (v.mode === 'autosave') return validNativeNotebookAutosave(v);
  if (v.mode === 'archive') return fields(v, ['mode', 'revision', 'mutationId']) && revision(v.revision) && validBoardUuid(v.mutationId);
  return v.mode === 'move' && fields(v, ['mode', 'notebookResource', 'input']) && text(v.notebookResource, 8192) && validNotebookMove(v.input);
}
export function validHubNativeFileCommand(v: unknown): v is HubNativeFileCommand {
  if (!object(v) || !resources(v)) return false;
  const scope = v as NativeFileScope, base = ['action', 'domain', 'resourceId'];
  if (Object.hasOwn(v, 'sessionProof')) {
    const proof = v.sessionProof;
    if (!object(proof) || !fields(proof, ['authority', 'resourceId']) || !validHubSessionNotebookAuthority(proof.authority)
      || proof.authority.kind !== 'owner' || typeof proof.resourceId !== 'string'
      || !sessionNotebookResourceMatches(proof.authority, proof.resourceId) || v.domain !== 'card'
      || v.resourceId !== workspaceFileCardResource('notebook', `session:${proof.authority.sessionId}`)) return false;
    if ('notebookResource' in v && v.notebookResource !== proof.resourceId) return false;
    if (object(v.request) && (v.request.mode === 'autosave'
      && (!object(v.request.document) || v.request.document.resourceId !== proof.resourceId)
      || v.request.mode === 'move' && v.request.notebookResource !== proof.resourceId)) return false;
    base.push('sessionProof');
  }
  const shape = (...names: string[]) => fields(v, [...base, ...names]);
  switch (v.action) {
    case 'current': return shape();
    case 'editor-select': return shape('input') && scope.domain === 'card' && validWrite(scope, v.input);
    case 'move-select': return shape('notebookResource', 'requestId', 'input') && scope.domain === 'card'
      && parseWorkspaceFileCardResource(scope.resourceId)?.kind === 'notebook' && text(v.notebookResource, 8192)
      && validBoardUuid(v.requestId) && (v.input === null || validNotebookMove(v.input) && v.input.requestId === v.requestId);
    case 'notebook-plan': case 'notebook-finish': return shape('bindingId', 'request') && validBoardUuid(v.bindingId)
      && object(v.request) && v.request.mode === 'autosave' && validRequest(scope, v.request);
    case 'target': return shape('sessionId') && text(v.sessionId) && !!decodeHubSessionId(v.sessionId);
    case 'get': case 'revoke': case 'cancel': return shape('bindingId') && validBoardUuid(v.bindingId);
    case 'bind-plan': return shape('sessionId', 'bindingId', 'revision') && validBoardUuid(v.bindingId) && text(v.sessionId) && revision(v.revision);
    case 'bind-admit': return shape('target', 'bindingId', 'revision') && validBoardUuid(v.bindingId) && validTarget(v.target) && revision(v.revision);
    case 'installation-settle': return shape('target', 'bindingId', 'state') && validBoardUuid(v.bindingId) && validTarget(v.target)
      && ['installed', 'revoked'].includes(String(v.state));
    case 'write-plan': return shape('bindingId', 'request') && validBoardUuid(v.bindingId) && validRequest(scope, v.request);
    case 'write-admit': return shape('bindingId', 'target', 'request') && validBoardUuid(v.bindingId) && validTarget(v.target) && validRequest(scope, v.request);
    case 'write-read': return shape('bindingId', 'mutationId') && validBoardUuid(v.bindingId) && validBoardUuid(v.mutationId);
    case 'archive-status': return shape('bindingId', 'mutationId') && scope.domain === 'card'
      && parseWorkspaceFileCardResource(scope.resourceId)?.kind === 'notebook' && validBoardUuid(v.bindingId) && validBoardUuid(v.mutationId);
    case 'write-settle': return shape('bindingId', 'target', 'mutationId', 'expectedHash', 'state', 'snapshot')
      && validBoardUuid(v.bindingId) && validTarget(v.target) && validBoardUuid(v.mutationId) && hash(v.expectedHash)
      && states.includes(String(v.state)) && (v.snapshot === null || validNativeFileSnapshot(scope, v.snapshot));
    case 'refresh-apply': return shape('bindingId', 'target', 'baseline', 'snapshot') && validBoardUuid(v.bindingId)
      && validTarget(v.target) && (v.baseline === null || hash(v.baseline)) && validNativeFileSnapshot(scope, v.snapshot);
    case 'move-finish': return shape('bindingId', 'notebookResource', 'requestId') && scope.domain === 'card'
      && parseWorkspaceFileCardResource(scope.resourceId)?.kind === 'notebook'
      && validBoardUuid(v.bindingId) && text(v.notebookResource, 8192) && validBoardUuid(v.requestId);
    default: return false;
  }
}
function validBinding(scope: NativeFileScope, v: unknown): v is Binding {
  return object(v) && fields(v, ['bindingId', 'resourceId', 'sessionId', 'connectionId', 'authority', 'state', 'sourceHash', 'problem', 'createdAt'])
    && validBoardUuid(v.bindingId) && v.resourceId === scope.resourceId && text(v.sessionId) && text(v.connectionId, 160)
    && decodeHubSessionId(v.sessionId)?.connectionId === v.connectionId
    && revision(v.authority) && ['prepared', 'active', 'revoked'].includes(String(v.state)) && (v.sourceHash === null || hash(v.sourceHash))
    && (v.problem === null || ['missing', 'invalid', 'too-large', 'unsafe', 'unavailable'].includes(String(v.problem))) && revision(v.createdAt);
}
function editorSelectionScope(scope: NativeFileScope, selected: unknown): NativeFileScope | undefined {
  if (selected === scope.resourceId) return scope;
  if (scope.domain !== 'card' || typeof selected !== 'string') return;
  const original = parseWorkspaceFileCardResource(scope.resourceId), next = parseWorkspaceFileCardResource(selected);
  if (original && next && original.id === next.id && (original.kind === 'taskboard' && next.kind === 'statuscard'
    || original.kind === 'statuscard' && next.kind === 'taskboard')) return {domain: 'card', resourceId: selected};
}
export function validHubNativeFileResult(v: unknown): v is HubNativeFileResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (Object.hasOwn(v, 'error')) return fields(v, ['error']) && typeof v.error === 'number' && [403, 404, 409, 429].includes(v.error);
  const scope = v as NativeFileScope;
  const selectedScope = v.action === 'editor-select' && object(v.binding) ? editorSelectionScope(scope, v.binding.resourceId) : scope;
  const valid = resources(v) && fields(v, ['action', 'domain', 'resourceId', 'bindingId', 'mutationId', 'binding', 'target', 'document', 'receipt', 'fresh', 'applied', 'move', 'moveState', 'note',
    ...(Object.hasOwn(v, 'sessionHash') ? ['sessionHash'] : [])]) && (!Object.hasOwn(v, 'sessionHash') || hash(v.sessionHash))
    && ['current', 'target', 'get', 'revoke', 'cancel', 'bind-plan', 'bind-admit', 'installation-settle', 'write-plan', 'write-admit',
      'write-read', 'write-settle', 'refresh-apply', 'move-finish', 'move-select', 'archive-status', 'editor-select', 'notebook-plan', 'notebook-finish'].includes(String(v.action))
    && (v.note === null || v.action === 'notebook-finish' && object(v.note) && fields(v.note, ['resourceId', 'revision', 'text', 'updatedAt'])
      && validNotebookInput({resourceId: v.note.resourceId, revision: v.note.revision, text: v.note.text}, NOTEBOOK_ARCHIVE_MAX_CHARS)
      && (v.note.updatedAt === null || revision(v.note.updatedAt)))
    && (v.bindingId === null || validBoardUuid(v.bindingId)) && (v.mutationId === null || validBoardUuid(v.mutationId))
    && (v.binding === null || selectedScope && validBinding(selectedScope, v.binding) && (v.bindingId === null || v.binding.bindingId === v.bindingId))
    && (v.target === null || validTarget(v.target) && (v.binding === null || v.target.sessionId === (v.binding as Binding).sessionId
      && v.target.connectionId === (v.binding as Binding).connectionId && v.target.authority === (v.binding as Binding).authority))
    && (v.document === null || selectedScope && validWrite(selectedScope, v.document)
      && v.document.mutationId === (v.mutationId ?? v.bindingId)) && typeof v.fresh === 'boolean'
    && (v.receipt === null || object(v.receipt) && fields(v.receipt, ['mutationId', 'expectedHash', 'state', 'fingerprint'])
      && v.receipt.mutationId === v.mutationId && hash(v.receipt.expectedHash) && hash(v.receipt.fingerprint) && states.includes(String(v.receipt.state)))
    && (!v.fresh || v.action === 'bind-admit' && v.document !== null && v.binding !== null && v.target !== null
      || v.action === 'write-admit' && v.receipt !== null && v.document !== null && v.target !== null)
    && (v.applied === null || ['updated', 'unchanged', 'retained', 'denied', 'invalid', 'limit'].includes(String(v.applied)))
    && (v.move === null || object(v.move) && fields(v.move, ['hotRevision', 'coldRevision', 'moved'])
      && revision(v.move.hotRevision) && revision(v.move.coldRevision) && revision(v.move.moved) && v.move.moved > 0 && v.move.moved <= 16_000)
    && (v.moveState === null || ['pending', 'saved', 'conflict'].includes(String(v.moveState)));
  if (!valid) return false;
  // An ACK is an action-specific capability, not just a bag of valid fields.
  // Never allow a metadata reply to smuggle an executable document/receipt.
  const noWrite = v.receipt === null && v.mutationId === null;
  const noMove = v.move === null && v.moveState === null;
  const plain = v.document === null && v.applied === null && !v.fresh;
  switch (v.action) {
    case 'move-select': return v.domain === 'card' && parseWorkspaceFileCardResource(v.resourceId)?.kind === 'notebook'
      && plain && v.note === null && v.receipt === null && v.mutationId !== null
      && (v.moveState === 'saved' ? v.move !== null && v.binding === null && v.bindingId === null && v.target === null
        : v.move === null && (v.moveState === null || v.moveState === 'pending')
          && (v.binding === null ? v.moveState === null && v.bindingId === null && v.target === null
            : v.bindingId !== null && v.target !== null));
    case 'notebook-plan': return v.domain === 'card' && parseWorkspaceFileCardResource(v.resourceId)?.kind === 'notebook'
      && noMove && !v.fresh && v.applied === null && v.note === null && v.binding !== null && v.target !== null
      && v.bindingId !== null && v.mutationId !== null && !(v.document !== null && v.receipt !== null);
    case 'notebook-finish': return v.domain === 'card' && noMove && plain && v.receipt === null && v.note !== null
      && v.binding !== null && v.target !== null && v.bindingId !== null && v.mutationId !== null;
    case 'editor-select': return v.domain === 'card' && noMove && !v.fresh && v.applied === null && v.mutationId !== null
      && (v.binding === null ? plain && v.bindingId === null && v.target === null && v.receipt === null
        : v.bindingId !== null && v.target !== null && v.document !== null);
    case 'current': return noWrite && noMove && plain && v.bindingId === null && v.target === null;
    case 'target': return noWrite && noMove && plain && v.bindingId === null && v.binding === null && v.target !== null;
    case 'get': return noWrite && noMove && plain && v.binding !== null && v.target === null;
    case 'revoke': case 'cancel': return noWrite && noMove && plain && (v.binding !== null || v.action === 'cancel' && v.target === null);
    case 'bind-plan': return noWrite && noMove && !v.fresh && v.applied === null && v.document !== null && v.target !== null;
    case 'bind-admit': return noWrite && noMove && v.applied === null && v.binding !== null && v.target !== null
      && (v.fresh ? v.document !== null : v.document === null);
    case 'installation-settle': return noWrite && noMove && plain && v.binding !== null && v.target !== null;
    case 'write-plan': case 'write-admit': return v.binding !== null && v.target !== null && v.mutationId !== null
      && v.applied === null && v.move === null && (v.action === 'write-plan' ? !v.fresh : v.receipt !== null)
      && (v.document !== null || v.receipt !== null);
    case 'write-read': case 'write-settle': return v.binding !== null && v.target !== null && v.receipt !== null
      && noMove && v.document === null && !v.fresh && (v.action === 'write-settle' || v.applied === null);
    case 'archive-status': return v.domain === 'card' && parseWorkspaceFileCardResource(v.resourceId)?.kind === 'notebook'
      && v.bindingId !== null && v.mutationId !== null && noMove && plain
      && (v.receipt === null || v.binding !== null && v.target !== null);
    case 'refresh-apply': return noWrite && noMove && v.binding !== null && v.target !== null && v.document === null && !v.fresh;
    case 'move-finish': return v.domain === 'card' && v.binding !== null && v.target !== null && v.mutationId !== null
      && v.receipt === null && plain && v.moveState !== null;
    default: return false;
  }
}
const mutation = (r: NativeFileRequest) => r.mode === 'ordinary' ? r.input.mutationId : r.mode === 'archive' || r.mode === 'autosave' ? r.mutationId : r.input.requestId;
export function nativeFileExpectation(c: HubNativeFileCommand) {
  return { action: c.action, domain: c.domain, resourceId: c.resourceId, bindingId: 'bindingId' in c ? c.bindingId : null,
    sessionHash: c.sessionProof ? createHash('sha256').update(JSON.stringify(c.sessionProof)).digest('hex') : undefined,
    mutationId: c.action === 'editor-select' ? c.input.mutationId : 'request' in c ? mutation(c.request) : 'mutationId' in c ? c.mutationId : 'requestId' in c ? c.requestId : null,
    target: 'target' in c ? c.target : null,
    sessionId: 'sessionId' in c ? c.sessionId : null,
    noteResource: 'request' in c && c.request.mode === 'autosave' ? c.request.document.resourceId : null,
    receiptOnly: 'request' in c && (c.request.mode === 'autosave' || c.request.mode === 'move'),
    documentHash: c.action === 'editor-select' ? documentHash(c, c.input) : 'request' in c && c.request.mode === 'ordinary'
      ? documentHash(c, c.request.input) : null };
}
export function validHubNativeFileReply(e: ReturnType<typeof nativeFileExpectation>, v: unknown): v is HubNativeFileResult {
  if (!validHubNativeFileResult(v)) return false;
  if (v === null || 'error' in v) return true;
  if (v.sessionHash !== e.sessionHash) return false;
  if (v.action !== e.action || v.domain !== e.domain || v.resourceId !== e.resourceId
    || e.action !== 'editor-select' && e.action !== 'move-select' && v.bindingId !== e.bindingId || v.mutationId !== e.mutationId) return false;
  if (e.target && v.target && !sameTarget(e.target, v.target)) return false;
  if (e.sessionId && v.target && e.sessionId !== v.target.sessionId) return false;
  if (v.note && v.note.resourceId !== e.noteResource) return false;
  if ((e.action === 'write-plan' || e.action === 'write-admit') && v.document === null && !e.receiptOnly) return false;
  const document = e.action === 'editor-select' && v.document ? {...v.document, kind: parseWorkspaceFileCardResource(e.resourceId)!.kind} as WorkspaceFileCardWrite : v.document;
  return !e.documentHash || document === null || documentHash(e, document) === e.documentHash;
}

/** Caller must wrap this in the original identity savepoint. All callbacks
 * below are synchronous original-store callbacks; none crosses an await/RPC. */
export function executeHubNativeFile(owner: HubStore, actor: HubPrincipal, command: HubNativeFileCommand): HubNativeFileResult {
  return executeNativeFile(owner, actor.userId, command, actor);
}
/** Machine callers have a separately checked notebook capability, NOT a
 * manufactured human principal. The caller must constrain the command domain. */
export function executeNotebookMachineNativeFile(owner: HubStore, user: string, command: HubNativeFileCommand): HubNativeFileResult {
  if (command.sessionProof) throw Error('notebook_machine_human_proof');
  return executeNativeFile(owner, user, command);
}
function executeNativeFile(owner: HubStore, user: string, command: HubNativeFileCommand, actor?: HubPrincipal): HubNativeFileResult {
  if (!validHubNativeFileCommand(command)) throw Error('hub_native_file_unavailable');
  const { domain, resourceId, action } = command;
  const files = domain === 'board' ? owner.boardFiles : owner.cardFiles;
  const expectation = nativeFileExpectation(command);
  // Admission and final delivery require the original live session proof.
  // Already-owned effects still settle by their original binding/target/UUID;
  // revocation must not manufacture a negative ACK or authorize a replay.
  if (command.sessionProof && !['write-settle', 'installation-settle', 'move-finish', 'notebook-finish'].includes(action)
    && (!actor || !sessionNotebookAuthorityCurrent(owner, actor, command.sessionProof.authority, command.sessionProof.resourceId))) return {error: 403};
  const result: Exclude<HubNativeFileResult, null | { error: number }> = {
    action, domain, resourceId, bindingId: expectation.bindingId, mutationId: expectation.mutationId,
    ...(expectation.sessionHash ? {sessionHash: expectation.sessionHash} : {}),
    binding: null, target: null, document: null, receipt: null, fresh: false, applied: null, move: null, moveState: null, note: null,
  };
  if (action === 'editor-select') {
    let binding = owner.cardFiles.current(user, resourceId);
    const ref = parseWorkspaceFileCardResource(resourceId)!;
    if (!binding && (ref.kind === 'taskboard' || ref.kind === 'statuscard')) {
      binding = owner.cardFiles.current(user, workspaceFileCardResource(ref.kind === 'taskboard' ? 'statuscard' : 'taskboard', ref.id));
    }
    if (!binding) return result; // Private save still performs its own original file-managed/CAS check.
    const selected = parseWorkspaceFileCardResource(binding.resourceId)!;
    const planned = executeNativeFile(owner, user, {domain: 'card', resourceId: binding.resourceId, action: 'write-plan',
      ...(command.sessionProof ? {sessionProof: command.sessionProof} : {}),
      bindingId: binding.bindingId, request: {mode: 'ordinary', input: {...command.input, kind: selected.kind} as WorkspaceFileCardWrite}}, actor);
    if (!planned || 'error' in planned) return planned;
    return {...planned, action, resourceId};
  }
  const target = (sessionId: string): NativeFileTarget | undefined => {
    const decoded = decodeHubSessionId(sessionId);
    if (!decoded || !/^(codex|claude-code|ghcp):/.test(decoded.remoteSessionKey)) return;
    const connection = owner.getConnection(decoded.connectionId, user), authority = owner.connectionAuthority(decoded.connectionId, user);
    if (!connection?.nodeId || connection.status === 'disabled' || authority === undefined) return;
    return { sessionId, connectionId: decoded.connectionId, sessionKey: decoded.remoteSessionKey, nodeId: connection.nodeId, authority };
  };
  const expose = (binding: FileBoardBinding | undefined) => {
    if (!binding) return null;
    const { userId: _user, ...rest } = binding; return rest;
  };
  const document = (): NativeFileWrite | null => {
    const mutationId = command.action === 'bind-plan' || command.action === 'bind-admit' ? command.bindingId : expectation.mutationId!;
    if (domain === 'board') {
      const value = owner.boards.get(user, resourceId);
      return { title: value.title, tasks: value.tasks, revision: value.revision, mutationId };
    }
    const value = owner.cardFileProjection.get(user, resourceId);
    return value ? { ...value, mutationId } : null;
  };
  if (action === 'target' || action === 'bind-plan' || action === 'bind-admit') {
    const current = target(action === 'bind-admit' ? command.target.sessionId : command.sessionId);
    if (!current) return { error: 404 };
    if (action === 'bind-admit' && !sameTarget(current, command.target)) return { error: 403 };
    result.target = current;
    if (action === 'target') return result;
    const previous = files.get(user, command.bindingId);
    if (previous && (previous.resourceId !== resourceId || previous.sessionId !== current.sessionId
      || previous.connectionId !== current.connectionId || previous.authority !== current.authority)) return { error: 409 };
    if (action === 'bind-plan') {
      result.binding = expose(previous); result.document = document();
      return result.document && (previous || result.document.revision === command.revision) ? result : { error: 409 };
    }
    const prepared = files.prepare({ bindingId: command.bindingId, userId: user, resourceId,
      sessionId: current.sessionId, connectionId: current.connectionId, authority: current.authority }, command.revision);
    if (!prepared) return { error: 409 };
    result.binding = expose(prepared);
    // Original prepare is the durable install intent. Even a crash BEFORE PUT
    // means an existing UUID may only be inspected, never installed again.
    result.fresh = !previous; result.document = result.fresh ? document() : null;
    if (result.fresh && !result.document) throw Error('hub_native_file_document_unavailable');
    return result;
  }
  if (action === 'current') { result.binding = expose(files.current(user, resourceId)); return result; }
  if (action === 'move-select') {
    // Inspect the original move BEFORE current binding selection. An admitted
    // UUID never follows a rebind or becomes a private-copy fallback.
    if (owner.cardFileProjection.notebookRef(user, resourceId)?.textId !== command.notebookResource) return {error: 409};
    const old = owner.notebooks.boundMove(user, command.notebookResource, command.requestId);
    if (old && command.input && old.input !== moveInput(command.input)) return {error: 409};
    if (old?.state === 'conflict') return {error: 409};
    if (old?.state === 'saved') {
      result.move = owner.notebooks.moveReceipt(user, command.notebookResource, command.requestId) ?? null;
      result.moveState = 'saved';
      return result.move ? result : {error: 409};
    }
    if (!old && (!command.input || owner.notebooks.moveReceipt(user, command.notebookResource, command.requestId))) return result;
    const id = old?.bindingId ?? owner.notebooks.fileBinding(user, command.notebookResource);
    if (!id) return result;
    const selected = files.get(user, id);
    if (!selected || selected.resourceId !== resourceId || old && old.fileResource !== resourceId) return {error: 409};
    const pin = target(selected.sessionId);
    if (!pin || pin.connectionId !== selected.connectionId || pin.authority !== selected.authority) return {error: 403};
    if (old && !files.writeReceipt(user, id, command.requestId)) return {error: 409};
    result.bindingId = id; result.binding = expose(selected); result.target = pin; result.moveState = old?.state ?? null;
    return result;
  }
  const binding = files.get(user, command.bindingId);
  if (binding && binding.resourceId !== resourceId) return { error: 404 };
  if (action === 'archive-status') {
    if (binding) {
      const pin = target(binding.sessionId);
      if (!pin || pin.connectionId !== binding.connectionId || pin.authority !== binding.authority) return { error: 403 };
      result.binding = expose(binding); result.target = pin;
      result.receipt = files.writeReceipt(user, command.bindingId, command.mutationId) ?? null;
    }
    return result;
  }
  if (action === 'cancel') {
    if (binding) { files.revoke(user, command.bindingId); result.binding = expose(files.get(user, command.bindingId)); result.target = target(binding.sessionId) ?? null; }
    else if (!files.cancelAbsent(user, resourceId, command.bindingId)) return { error: 409 };
    // Never give a new authority permission to clean up an old destination.
    if (binding && (result.target?.authority !== binding.authority || result.target.connectionId !== binding.connectionId)) result.target = null;
    return result;
  }
  if (!binding) return { error: 404 };
  result.binding = expose(binding);
  if (action === 'revoke') {
    files.revoke(user, command.bindingId); result.binding = expose(files.get(user, command.bindingId));
    const current = target(binding.sessionId);
    result.target = current?.authority === binding.authority && current.connectionId === binding.connectionId ? current : null;
    return result;
  }
  if (action === 'get') return result;
  const current = target(binding.sessionId);
  if (!current || current.connectionId !== binding.connectionId || current.authority !== binding.authority
    || 'target' in command && !sameTarget(current, command.target)) return { error: 403 };
  result.target = current;
  if (action === 'installation-settle') {
    if (command.state === 'installed') files.activate(user, command.bindingId); else files.revoke(user, command.bindingId);
    result.binding = expose(files.get(user, command.bindingId)); return result;
  }
  if (action === 'refresh-apply') {
    if (binding.state !== 'active') return { error: 409 };
    if (binding.sourceHash === command.baseline) result.applied = domain === 'board'
      ? owner.boardFiles.apply(user, command.bindingId, command.snapshot as WorkspaceFileSnapshot<BoardContent>)
      : owner.cardFiles.apply(user, command.bindingId, command.snapshot as WorkspaceFileSnapshot<WorkspaceFileCard>);
    result.binding = expose(files.get(user, command.bindingId)); return result;
  }
  if (action === 'write-read' || action === 'write-settle') {
    const original = files.writeReceipt(user, command.bindingId, command.mutationId);
    if (!original) return { error: 404 };
    if (action === 'write-settle') {
      if (original.expectedHash !== command.expectedHash || original.state !== 'uncertain' && original.state !== command.state) return { error: 409 };
      files.finishWrite(user, command.bindingId, command.mutationId, command.state);
      if (command.snapshot && binding.sourceHash === original.expectedHash && binding.state === 'active') result.applied = domain === 'board'
        ? owner.boardFiles.apply(user, command.bindingId, command.snapshot as WorkspaceFileSnapshot<BoardContent>)
        : owner.cardFiles.apply(user, command.bindingId, command.snapshot as WorkspaceFileSnapshot<WorkspaceFileCard>);
    }
    result.receipt = files.writeReceipt(user, command.bindingId, command.mutationId) ?? null;
    result.binding = expose(files.get(user, command.bindingId)); return result;
  }
  try {
    if (action === 'notebook-plan' || action === 'notebook-finish') {
      if (binding.state !== 'active') return {error: 409};
      if (action === 'notebook-finish') result.note = finishNativeNotebookAutosave(owner, user, resourceId, command.bindingId, command.request);
      else {
        const planned = planNativeNotebookAutosave(owner, user, resourceId, command.bindingId, command.request);
        result.document = planned.document;
        if (planned.receipt) result.receipt = files.writeReceipt(user, command.bindingId, command.request.mutationId) ?? null;
      }
      return result;
    }
    if (action === 'move-finish') {
      if (owner.cardFileProjection.notebookRef(user, resourceId)?.textId !== command.notebookResource) return {error: 409};
      const old = owner.notebooks.boundMove(user, command.notebookResource, command.requestId);
      if (!old || old.bindingId !== command.bindingId || old.fileResource !== resourceId) return { error: 404 };
      result.move = owner.notebooks.finishBoundMove(user, command.notebookResource, command.requestId) ?? null;
      result.moveState = owner.notebooks.boundMove(user, command.notebookResource, command.requestId)?.state ?? null;
      return result;
    }
    const request = command.request;
    if (binding.state !== 'active') return { error: 409 };
    let input: NativeFileWrite | undefined;
    const prepare = (value: NativeFileWrite) => domain === 'board' ? owner.boardFiles.prepareWrite(user, command.bindingId, value as BoardWrite)
      : owner.cardFiles.prepareWrite(user, command.bindingId, value as WorkspaceFileCardWrite);
    if (request.mode === 'ordinary') input = request.input;
    else if (request.mode === 'autosave') {
      const planned = planNativeNotebookAutosave(owner, user, resourceId, command.bindingId, request);
      if (planned.receipt) {
        result.receipt = files.writeReceipt(user, command.bindingId, request.mutationId) ?? null;
        return result.receipt ? result : {error: 409};
      }
      input = planned.document ?? undefined;
    }
    else if (request.mode === 'archive') input = owner.cardFiles.archiveUpgradePlan(user, command.bindingId, request.mutationId, request.revision);
    else {
      if (owner.cardFileProjection.notebookRef(user, resourceId)?.textId !== request.notebookResource) return {error: 409};
      const old = owner.notebooks.boundMove(user, request.notebookResource, request.input.requestId);
      if (old) {
        if (old.bindingId !== command.bindingId || old.fileResource !== resourceId || old.input !== moveInput(request.input)) return { error: 409 };
        result.receipt = files.writeReceipt(user, command.bindingId, request.input.requestId) ?? null;
        if (!result.receipt) return { error: 409 }; // Missing original intent is NEVER recreated.
        result.moveState = old.state; return result;
      }
      if (files.writeReceipt(user, command.bindingId, request.input.requestId) || owner.notebooks.moveReceipt(user, request.notebookResource, request.input.requestId)
        || owner.notebooks.fileBinding(user, request.notebookResource) !== command.bindingId) return { error: 409 };
      const next = owner.notebooks.plannedMove(user, request.notebookResource, request.input), doc = owner.cardFileProjection.get(user, resourceId);
      if (doc?.kind !== 'notebook') return { error: 409 };
      input = { kind: 'notebook', revision: doc.revision, mutationId: request.input.requestId, content: { ...doc.content, text: next.hotText,
        ...(doc.content.archive !== undefined ? { archive: next.coldText } : {}) } };
    }
    if (!input) return { error: 409 };
    result.document = input;
    result.receipt = files.writeReceipt(user, command.bindingId, mutation(request)) ?? null;
    // A read-only plan must reject reuse of an original UUID with a changed
    // document too. prepareWrite with an existing receipt cannot create work.
    if (result.receipt && !prepare(input)) return { error: 409 };
    if (action === 'write-plan') return result;
    const intent = request.mode === 'archive' && !result.receipt
      ? owner.cardFiles.admitArchiveUpgrade(user, command.bindingId, input as WorkspaceFileCardWrite, () => prepare(input!))
      : request.mode === 'move' ? owner.notebooks.admitBoundMove(user, request.notebookResource, request.input,
        command.bindingId, resourceId, () => prepare(input!)) : prepare(input);
    if (!intent) return { error: 409 };
    const { fresh, ...receipt } = intent;
    result.receipt = receipt; result.fresh = fresh; result.binding = expose(files.get(user, command.bindingId));
    return result;
  } catch (error) {
    if (error instanceof ArchiveUpgradeConflict || error instanceof NotebookMoveConflict || error instanceof NativeNotebookAutosaveConflict) return { error: 409 };
    throw error;
  }
}
