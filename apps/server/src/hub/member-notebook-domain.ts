import { createHash } from 'node:crypto';
import { NOTEBOOK_MAX_CHARS, NOTEBOOK_ARCHIVE_MAX_CHARS, validHubNotebookLayout, type SessionNotebookDocument } from '@agentopsdeck/shared';
import { validNotebookInput, type SessionNotebooks } from './session-notebooks.js';
import { validNotebookMove, type NotebookMove } from './notebook-operations.js';
import { validHubSessionNotebookAuthority, sessionNotebookResourceMatches, type HubSessionNotebookAuthority } from './member-session-notebook-authority.js';
import { decodeHubSessionId } from './session-id.js';
import { validNotebookSnapshotRead, validNotebookSnapshot, type NotebookSnapshotRead, type NotebookSnapshot } from './notebook-snapshot-read.js';

export type PrivateNotebookRead = Omit<NotebookSnapshotRead, 'owner'>;
export function validPrivateNotebookRead(v: unknown): v is PrivateNotebookRead {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 5 || Object.hasOwn(v, 'owner')) return false;
  const read = v as PrivateNotebookRead;
  return validNotebookSnapshotRead({...read, owner: 'current'}) && (read.mode === 'layouts'
    || privateNotebookResource(read.resourceId!, false) || read.mode === 'hot' && privateNotebookResource(read.resourceId!, true));
}

export type SessionNotebookTarget = {sessionId: string; ownerUserId: string | null};
export function validSessionNotebookTarget(v: unknown): v is SessionNotebookTarget {
  return object(v) && fields(v, ['sessionId', 'ownerUserId']) && typeof v.sessionId === 'string'
    && v.sessionId.length <= 4096 && !!decodeHubSessionId(v.sessionId)
    && (v.ownerUserId === null || typeof v.ownerUserId === 'string' && !!v.ownerUserId && v.ownerUserId.length <= 4096);
}
export type SessionNotebookRead = SessionNotebookTarget & {mode: 'hot' | 'cold' | 'search';
  query: string | null; includeArchive: boolean};
export function validSessionNotebookRead(v: unknown): v is SessionNotebookRead {
  if (!object(v) || !fields(v, ['sessionId', 'ownerUserId', 'mode', 'query', 'includeArchive'])
    || typeof v.sessionId !== 'string' || v.sessionId.length > 4096 || !decodeHubSessionId(v.sessionId)
    || !(v.ownerUserId === null || typeof v.ownerUserId === 'string' && !!v.ownerUserId && v.ownerUserId.length <= 4096)) return false;
  return validNotebookSnapshotRead({owner: 'current', resourceId: 'session', after: null,
    mode: v.mode, query: v.query, includeArchive: v.includeArchive}) && v.mode !== 'layouts';
}

/** Personal SQLite data only. No delegated file ID, arbitrary SQL, transported
 * principal or callback. File-bound moves retain their original coordinator. */
export type HubNotebookCommand = { action: 'get' | 'archive'; resourceId: string }
  | { action: 'snapshotPrivate'; read: PrivateNotebookRead }
  | { action: 'snapshotSession'; read: SessionNotebookRead }
  | { action: 'resolveSession'; target: SessionNotebookTarget }
  | { action: 'checkSession'; authority: HubSessionNotebookAuthority; resourceId: string }
  | { action: 'save' | 'saveArchive'; document: { resourceId: string; revision: number; text: string } }
  | { action: 'savePrivate'; document: { resourceId: string; revision: number; text: string }; area: 'hot' | 'cold' | 'layout'; styled: boolean }
  | { action: 'saveSession'; document: { resourceId: string; revision: number; text: string }; area: 'hot' | 'cold'; styled: boolean;
      authority: HubSessionNotebookAuthority }
  | { action: 'search'; resourceId: string; query: string; area: 'hot' | 'cold' | 'both' }
  | { action: 'receipt'; resourceId: string; requestId: string }
  | { action: 'move'; resourceId: string; input: NotebookMove };
export type HubNotebookMoveResult = { hotRevision: number; coldRevision: number; moved: number };
export type HubNotebookSearchResult = ReturnType<SessionNotebooks['searchAreas']>;
export type HubNotebookResult = null
  | { action: 'snapshotPrivate'; read: PrivateNotebookRead; snapshot: NotebookSnapshot }
  | { action: 'snapshotSession'; read: SessionNotebookRead; authority: HubSessionNotebookAuthority | null;
      resourceId: string | null; snapshot: NotebookSnapshot | null }
  | { action: 'resolveSession'; target: SessionNotebookTarget; authority: HubSessionNotebookAuthority | null; resourceId: string | null }
  | { action: 'checkSession'; authority: HubSessionNotebookAuthority; resourceId: string; current: boolean }
  | { action: 'get' | 'archive'; document: SessionNotebookDocument }
  | { action: 'save' | 'saveArchive'; document: SessionNotebookDocument | null }
  | { action: 'savePrivate'; status: 'saved' | 'conflict' | 'format'; document: SessionNotebookDocument | null }
  | { action: 'saveSession'; status: 'saved' | 'conflict' | 'format' | 'denied'; document: SessionNotebookDocument | null }
  | { action: 'search'; resourceId: string; result: HubNotebookSearchResult }
  | { action: 'receipt' | 'move'; resourceId: string; requestId: string; result: HubNotebookMoveResult | null };
// JSON can expand every UTF-16 unit to six bytes. Keep the legal cold note and
// credential/envelope overhead; never truncate or assume UTF-8 source size.
export const HUB_NOTEBOOK_RPC_BYTES = 6 * NOTEBOOK_ARCHIVE_MAX_CHARS + 65_536;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const resource = (v: unknown): v is string => typeof v === 'string' && v.length <= 8192;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
/** Canonical private resources only; never accept a session tuple here. */
export function privateNotebookResource(resourceId: string, layout: boolean): boolean {
  try {
    const value: unknown = JSON.parse(resourceId);
    if (!Array.isArray(value) || JSON.stringify(value) !== resourceId || value[1] !== 1) return false;
    const validId = (id: unknown) => id === 'default' || typeof id === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
    return layout ? value.length === 3 && value[0] === 'hub-notebook-layout' && validId(value[2])
      : value[0] === 'hub-notebook' && (value.length === 2 || value.length === 3 && value[2] !== 'default' && validId(value[2]));
  } catch { return false; }
}
export function validHubNotebookCommand(v: unknown): v is HubNotebookCommand {
  if (!object(v)) return false;
  if (v.action === 'snapshotPrivate') return fields(v, ['action', 'read']) && validPrivateNotebookRead(v.read);
  if (v.action === 'snapshotSession') return fields(v, ['action', 'read']) && validSessionNotebookRead(v.read);
  if (v.action === 'resolveSession') return fields(v, ['action', 'target']) && validSessionNotebookTarget(v.target);
  if (v.action === 'checkSession') return fields(v, ['action', 'authority', 'resourceId'])
    && validHubSessionNotebookAuthority(v.authority) && resource(v.resourceId) && sessionNotebookResourceMatches(v.authority, v.resourceId);
  if (v.action === 'saveSession') return fields(v, ['action', 'document', 'area', 'styled', 'authority'])
    && typeof v.styled === 'boolean' && (v.area === 'hot' || v.area === 'cold')
    && validNotebookInput(v.document, v.area === 'cold' ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS)
    && validHubSessionNotebookAuthority(v.authority);
  if (v.action === 'savePrivate') {
    if (!fields(v, ['action', 'document', 'area', 'styled']) || typeof v.styled !== 'boolean'
      || !['hot', 'cold', 'layout'].includes(String(v.area))
      || !validNotebookInput(v.document, v.area === 'cold' ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS)
      || !privateNotebookResource(v.document.resourceId, v.area === 'layout')) return false;
    if (v.area !== 'layout') return true;
    try { return validHubNotebookLayout(JSON.parse(v.document.text)); } catch { return false; }
  }
  if (v.action === 'save' || v.action === 'saveArchive') return fields(v, ['action', 'document'])
    && validNotebookInput(v.document, v.action === 'saveArchive' ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS);
  if (!resource(v.resourceId)) return false;
  if (v.action === 'get' || v.action === 'archive') return fields(v, ['action', 'resourceId']);
  if (v.action === 'receipt') return fields(v, ['action', 'resourceId', 'requestId']) && uuid(v.requestId);
  if (v.action === 'move') return fields(v, ['action', 'resourceId', 'input']) && validNotebookMove(v.input);
  return v.action === 'search' && fields(v, ['action', 'resourceId', 'query', 'area']) && typeof v.query === 'string'
    && !!v.query.trim() && v.query.length <= 200 && ['hot', 'cold', 'both'].includes(String(v.area));
}
function document(v: unknown, cold: boolean): v is SessionNotebookDocument {
  return object(v) && fields(v, ['resourceId', 'text', 'revision', 'updatedAt']) && resource(v.resourceId)
    && typeof v.text === 'string' && v.text.length <= (cold ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS)
    && revision(v.revision) && (v.updatedAt === null ? v.revision === 0 && v.text === '' : revision(v.updatedAt) && Number(v.revision) > 0);
}
function move(v: unknown): v is HubNotebookMoveResult {
  return object(v) && fields(v, ['hotRevision', 'coldRevision', 'moved']) && revision(v.hotRevision) && Number(v.hotRevision) > 0
    && revision(v.coldRevision) && Number(v.coldRevision) > 0 && revision(v.moved) && Number(v.moved) > 0 && Number(v.moved) <= NOTEBOOK_ARCHIVE_MAX_CHARS;
}
function search(v: unknown): v is HubNotebookSearchResult {
  if (!object(v) || !fields(v, ['hotRevision', 'coldRevision', 'results'])
    || !(v.hotRevision === null || revision(v.hotRevision)) || !(v.coldRevision === null || revision(v.coldRevision))
    || !Array.isArray(v.results) || v.results.length > 20) return false;
  return v.results.every(r => object(r) && fields(r, ['area', 'revision', 'start', 'end', 'text'])
    && (r.area === 'hot' || r.area === 'cold') && revision(r.revision) && revision(r.start) && revision(r.end)
    && Number(r.end) > Number(r.start) && Number(r.end) <= (r.area === 'hot' ? NOTEBOOK_MAX_CHARS : NOTEBOOK_ARCHIVE_MAX_CHARS)
    && r.revision === (r.area === 'hot' ? v.hotRevision : v.coldRevision) && typeof r.text === 'string' && r.text.length <= 264);
}
export function validHubNotebookResult(v: unknown): v is HubNotebookResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (v.action === 'resolveSession') {
    if (!fields(v, ['action', 'target', 'authority', 'resourceId']) || !validSessionNotebookTarget(v.target)) return false;
    if (v.authority === null) return v.resourceId === null;
    return validHubSessionNotebookAuthority(v.authority) && resource(v.resourceId)
      && sessionNotebookResourceMatches(v.authority, v.resourceId) && v.authority.sessionId === v.target.sessionId
      && (v.target.ownerUserId === null ? v.authority.kind === 'owner'
        : v.authority.kind === 'shared' && v.authority.ownerUserId === v.target.ownerUserId);
  }
  if (v.action === 'snapshotPrivate') return fields(v, ['action', 'read', 'snapshot']) && validPrivateNotebookRead(v.read)
    && validNotebookSnapshot(v.snapshot, {...v.read, owner: 'current'});
  if (v.action === 'checkSession') return fields(v, ['action', 'authority', 'resourceId', 'current'])
    && validHubSessionNotebookAuthority(v.authority) && resource(v.resourceId)
    && sessionNotebookResourceMatches(v.authority, v.resourceId) && typeof v.current === 'boolean';
  if (v.action === 'snapshotSession') {
    if (!fields(v, ['action', 'read', 'authority', 'resourceId', 'snapshot']) || !validSessionNotebookRead(v.read)) return false;
    if (v.authority === null) return v.resourceId === null && v.snapshot === null;
    if (!validHubSessionNotebookAuthority(v.authority) || !resource(v.resourceId)
      || !sessionNotebookResourceMatches(v.authority, v.resourceId) || v.authority.sessionId !== v.read.sessionId
      || (v.read.ownerUserId === null ? v.authority.kind !== 'owner'
        : v.authority.kind !== 'shared' || v.authority.ownerUserId !== v.read.ownerUserId)) return false;
    return validNotebookSnapshot(v.snapshot, {owner: 'current', resourceId: v.resourceId, after: null,
      mode: v.read.mode, query: v.read.query, includeArchive: v.read.includeArchive});
  }
  if (v.action === 'savePrivate' || v.action === 'saveSession') return fields(v, ['action', 'status', 'document'])
    && (v.status === 'saved' ? document(v.document, true)
      : (v.status === 'conflict' || v.status === 'format' || v.action === 'saveSession' && v.status === 'denied') && v.document === null);
  if (v.action === 'get' || v.action === 'archive' || v.action === 'save' || v.action === 'saveArchive')
    return fields(v, ['action', 'document']) && ((v.action === 'save' || v.action === 'saveArchive') && v.document === null
      || document(v.document, v.action === 'archive' || v.action === 'saveArchive'));
  if (v.action === 'receipt' || v.action === 'move') return fields(v, ['action', 'resourceId', 'requestId', 'result'])
    && resource(v.resourceId) && uuid(v.requestId) && (v.result === null || move(v.result));
  return v.action === 'search' && fields(v, ['action', 'resourceId', 'result']) && resource(v.resourceId) && search(v.result);
}
/** Waiters retain action/resource, revisions and a digest, never note text,
 * bearer credentials, range hashes or caller objects. */
export type HubNotebookReplyExpectation = { action: HubNotebookCommand['action']; resourceId: string; readHash?: string; authorityHash?: string; requestId?: string; revision?: number;
  textHash?: string; area?: 'hot' | 'cold' | 'both'; queryHash?: string; queryLength?: number;
  hotRevision?: number; coldRevision?: number; moved?: number };
// JSON preserves unpaired UTF-16 units; raw UTF-8 hashing would collapse
// different legal legacy strings to the same replacement character.
const hash = (text: string) => createHash('sha256').update(JSON.stringify(text)).digest('hex');
export function hubNotebookReplyExpectation(c: HubNotebookCommand): HubNotebookReplyExpectation {
  if (c.action === 'resolveSession') return {action: c.action, resourceId: '', readHash: hash(JSON.stringify(c.target))};
  if (c.action === 'snapshotPrivate' || c.action === 'snapshotSession') return {action: c.action, resourceId: '', readHash: hash(JSON.stringify(c.read))};
  if (c.action === 'checkSession') return {action: c.action, resourceId: c.resourceId, authorityHash: hash(JSON.stringify(c.authority))};
  if ('document' in c) return { action: c.action, resourceId: c.document.resourceId,
    // Original node:sqlite TEXT binding round-trips through UTF-8. In particular,
    // unpaired UTF-16 units become U+FFFD. Correlate the original persisted text,
    // not an impossible acknowledgement of the pre-binding JavaScript string.
    revision: c.document.revision + 1, textHash: hash(Buffer.from(c.document.text, 'utf8').toString('utf8')) };
  const base = { action: c.action, resourceId: c.resourceId };
  if (c.action === 'receipt') return { ...base, requestId: c.requestId };
  if (c.action === 'move') return { ...base, requestId: c.input.requestId, hotRevision: c.input.hotRevision + 1, coldRevision: c.input.coldRevision + 1,
    moved: c.input.ranges.reduce((n, r) => n + r.end - r.start, 0) };
  if (c.action === 'search') return { ...base, area: c.area, queryHash: hash(c.query), queryLength: c.query.length };
  return base;
}
export function validHubNotebookReply(e: HubNotebookReplyExpectation, v: unknown): v is HubNotebookResult {
  if (!validHubNotebookResult(v)) return false;
  if (v === null) return true;
  if (v.action !== e.action) return false;
  if (v.action === 'resolveSession') return hash(JSON.stringify(v.target)) === e.readHash;
  if (v.action === 'snapshotPrivate' || v.action === 'snapshotSession') return hash(JSON.stringify(v.read)) === e.readHash;
  if (v.action === 'checkSession') return v.resourceId === e.resourceId && hash(JSON.stringify(v.authority)) === e.authorityHash;
  if ('document' in v) return v.document === null || v.document.resourceId === e.resourceId
    && (e.revision === undefined || v.document.revision === e.revision && hash(v.document.text) === e.textHash);
  if (v.resourceId !== e.resourceId || (v.action === 'receipt' || v.action === 'move') && v.requestId !== e.requestId) return false;
  if (v.action === 'move') return v.result === null || v.result.hotRevision === e.hotRevision
    && v.result.coldRevision === e.coldRevision && v.result.moved === e.moved;
  if (v.action === 'search') {
    if (e.area === 'hot' && v.result.coldRevision !== null || e.area === 'cold' && v.result.hotRevision !== null) return false;
    let lastHot = -1, lastCold = -1;
    let seenCold = false;
    return v.result.results.every(r => {
      if (e.area !== 'both' && r.area !== e.area || r.end - r.start !== e.queryLength) return false;
      const previous = r.area === 'hot' ? lastHot : lastCold;
      if (r.start < previous || r.area === 'hot' && seenCold) return false;
      if (r.area === 'hot') lastHot = r.end; else { lastCold = r.end; seenCold = true; }
      const index = Math.min(r.start, 32);
      return hash(r.text.slice(index, index + e.queryLength!)) === e.queryHash;
    });
  }
  return true;
}
