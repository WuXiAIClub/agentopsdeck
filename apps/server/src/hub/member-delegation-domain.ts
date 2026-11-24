import { sessionRuntimeId, validBoardContent, validBoardId, validBoardUuid, validSessionTags } from '@agentopsdeck/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { readHubConnectionDirectory } from './member-connection-directory-domain.js';
import { decodeHubSessionId } from './session-id.js';
import { DelegationConflict, type DelegationBatch, type DelegationIntent } from './workspace-delegation-store.js';
import { type DelegationMember, type DelegationPreviewInput, type DelegationSelection } from './workspace-delegation-preview.js';
import { parseBoardAgentEndpoint } from './workspace-board-bindings.js';
import { validBoardToolCredential } from '../tools/workspace-board-cli.js';
import type { HubBoardBindingCredential } from './member-board-binding-domain.js';

/** Private server commands, NOT HTTP input. Remote enumeration/preflight is an
 * owned server effect. All local authority, grouping, board and grant facts are
 * rebuilt here; no principal, binding ID, SQL or executable participant is wired. */
type Fence = { generation: number; preferencesRevision: number };
type Catalog = Fence & { members: { sessionId: string; taskBinding: DelegationMember['taskBinding'] }[] };
type Base = { boardId: string };
export type HubDelegationCommand = Base & (
  { action: 'snapshot' } | { action: 'check'; fence: Fence }
  | { action: 'prepare'; batchId: string; catalog: Catalog; selection: DelegationSelection;
      taskIds: string[]; fields: ('status' | 'detail')[]; expiresAt: number }
  | { action: 'confirm'; batchId: string; catalog: Catalog }
  | { action: 'read'; batchId: string } | { action: 'cancel'; batchId: string }
  | { action: 'claim'; batchId: string; requestId: string; endpoint: string }
  | { action: 'write-check'; batchId: string; requestId: string }
  | { action: 'cleanup-settle'; batchId: string; requestId: string }
  | { action: 'settle'; batchId: string; requestId: string; state: 'installed' | 'unknown'; source: 'query' | 'put' });
export type HubDelegationSnapshot = Fence & {
  connections: { id: string; nodeId: string; epoch: number }[];
  sessions: { sessionId: string; groupId: string | null; tags: string[] }[];
  board: DelegationPreviewInput['board']; enabled: boolean;
};
export type HubDelegationResult = null | { error: 403 | 404 | 409 | 429 }
  | { action: 'snapshot'; snapshot: HubDelegationSnapshot }
  | { action: 'check'; ok: true }
  | { [A in 'prepare' | 'confirm' | 'read' | 'cancel' | 'settle' | 'cleanup-settle']: {action:A;batch:DelegationBatch|null} }['prepare' | 'confirm' | 'read' | 'cancel' | 'settle' | 'cleanup-settle']
  | { action: 'write-check'; batchId: string; requestId: string; ok: boolean }
  | { action: 'claim'; batchId: string; requestId: string; claimed: boolean;
      intent: DelegationIntent | null; credential: HubBoardBindingCredential | null };
export const HUB_DELEGATION_BYTES = 16 * 1024 * 1024;
export const HUB_DELEGATION_NODES = 300_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v,k));
const text = (v: unknown, max = 2048): v is string => typeof v === 'string' && !!v && v.length <= max
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const unique = (v: unknown[]): boolean => new Set(v).size === v.length;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const session = (v: unknown): v is string => text(v) && !!decodeHubSessionId(v);
const grantFields = (v: unknown): v is ('status' | 'detail')[] => Array.isArray(v) && !!v.length && v.length <= 2
  && unique(v) && v.every(f => f === 'status' || f === 'detail');
const tasks = (v: unknown): v is string[] => Array.isArray(v) && !!v.length && v.length <= 200 && unique(v) && v.every(validBoardUuid);
const fence = (v: unknown): v is Fence => object(v) && keys(v,['generation','preferencesRevision'])
  && integer(v.generation) && integer(v.preferencesRevision);
function selection(v: unknown): v is DelegationSelection {
  return object(v) && keys(v,v.groupId === undefined ? ['tags','tagMode'] : ['groupId','tags','tagMode'])
    && (v.groupId === undefined || text(v.groupId,80)) && validSessionTags(v.tags)
    && (v.groupId !== undefined || (v.tags as string[]).length > 0) && ['all','any'].includes(String(v.tagMode));
}
function catalog(v: unknown): v is Catalog {
  return object(v) && keys(v,['generation','preferencesRevision','members']) && integer(v.generation) && integer(v.preferencesRevision)
    && Array.isArray(v.members) && v.members.length <= 10_000 && v.members.every(m => object(m)
      && keys(m,['sessionId','taskBinding']) && session(m.sessionId) && ['supported','unsupported','unknown'].includes(String(m.taskBinding)))
    && unique(v.members.map(m => m.sessionId));
}
export function validHubDelegationCommand(v: unknown): v is HubDelegationCommand {
  if (!object(v) || !validBoardId(v.boardId)) return false;
  const exact = (...names: string[]) => keys(v,['action','boardId',...names]);
  if (v.action === 'snapshot') return exact();
  if (v.action === 'check') return exact('fence') && fence(v.fence);
  if (!validBoardUuid(v.batchId)) return false;
  if (v.action === 'read' || v.action === 'cancel') return exact('batchId');
  if (v.action === 'prepare') return exact('batchId','catalog','selection','taskIds','fields','expiresAt') && catalog(v.catalog)
    && selection(v.selection) && tasks(v.taskIds) && grantFields(v.fields) && integer(v.expiresAt);
  if (v.action === 'confirm') return exact('batchId','catalog') && catalog(v.catalog);
  if (!validBoardUuid(v.requestId)) return false;
  if (v.action === 'claim') {
    if (!exact('batchId','requestId','endpoint') || !text(v.endpoint,8192)) return false;
    try { return parseBoardAgentEndpoint(v.endpoint) === v.endpoint; } catch { return false; }
  }
  if (v.action === 'write-check' || v.action === 'cleanup-settle') return exact('batchId','requestId');
  return v.action === 'settle' && exact('batchId','requestId','state','source')
    && ['installed','unknown'].includes(String(v.state)) && ['query','put'].includes(String(v.source));
}
function member(v: unknown): v is DelegationMember {
  if (!object(v) || !keys(v,['owner','nodeId','connectionId','runtime','sessionId','authorityEpoch','groupId','tags','taskBinding'])
    || ![v.owner,v.nodeId,v.connectionId,v.runtime].every(s => text(s)) || !session(v.sessionId) || !integer(v.authorityEpoch)
    || v.authorityEpoch === 0 || !(v.groupId === null || text(v.groupId,80)) || !validSessionTags(v.tags)
    || !['supported','unsupported','unknown'].includes(String(v.taskBinding))) return false;
  const decoded = decodeHubSessionId(v.sessionId)!;
  return decoded.connectionId === v.connectionId && sessionRuntimeId(decoded.remoteSessionKey) === v.runtime;
}
function intent(v: unknown): v is DelegationIntent {
  return object(v) && keys(v,['owner','batchId','boardId','boardRevision','requestId','member','grant']) && text(v.owner)
    && validBoardUuid(v.batchId) && validBoardId(v.boardId) && integer(v.boardRevision) && validBoardUuid(v.requestId)
    && member(v.member) && v.member.owner === v.owner && object(v.grant) && keys(v.grant,['taskIds','fields','expiresAt'])
    && tasks(v.grant.taskIds) && grantFields(v.grant.fields) && integer(v.grant.expiresAt);
}
export function validHubDelegationBatch(v: unknown): v is DelegationBatch {
  if (!object(v) || !keys(v,['owner','batchId','fingerprint','preview','grantExpiresAt','state','members']) || !text(v.owner)
    || !validBoardUuid(v.batchId) || !hash(v.fingerprint) || !integer(v.grantExpiresAt) || !['prepared','confirmed','cancelled'].includes(String(v.state))
    || !object(v.preview) || !Array.isArray(v.members) || !v.members.length || v.members.length > 32) return false;
  const p = v.preview;
  if (!keys(p,['owner','generation','preferencesRevision','selection','resource','members','confirmable','createdAt','expiresAt','fingerprint'])
    || p.owner !== v.owner || !integer(p.generation) || !integer(p.preferencesRevision) || !selection(p.selection)
    || !object(p.resource) || !keys(p.resource,['resourceId','revision','tasks','fields']) || !validBoardId(p.resource.resourceId)
    || !integer(p.resource.revision) || !grantFields(p.resource.fields) || !validBoardContent({title:'Tasks',tasks:p.resource.tasks})
    || !Array.isArray(p.resource.tasks) || !p.resource.tasks.length || !Array.isArray(p.members) || p.members.length !== v.members.length
    || !p.members.every(member) || !unique(p.members.map(m => m.sessionId)) || p.confirmable !== true
    || !integer(p.createdAt) || !integer(p.expiresAt) || p.expiresAt <= p.createdAt || !hash(p.fingerprint)) return false;
  return unique(v.members.map(m => object(m) ? m.requestId : undefined)) && v.members.every((m,i) => object(m)
    && keys(m,['requestId','member','state','bindingId','reason','updatedAt']) && validBoardUuid(m.requestId) && member(m.member)
    && JSON.stringify(m.member) === JSON.stringify((p.members as DelegationMember[])[i]) && m.member.owner === v.owner
    && m.member.taskBinding === 'supported' && ['prepared','dispatching','installed','rejected','unknown','cancelled','cleanup_pending','revoked'].includes(String(m.state))
    && (m.bindingId === null || validBoardUuid(m.bindingId)) && (m.state !== 'installed' || m.bindingId !== null)
    && [null,'authority-changed','expired','provider-rejected'].includes(m.reason as null) && integer(m.updatedAt) && m.updatedAt >= Number(p.createdAt));
}
export function validHubDelegationResult(v: unknown): v is HubDelegationResult {
  try {
    if (v === null) return true;
    if (!object(v) || Buffer.byteLength(JSON.stringify(v)) > HUB_DELEGATION_BYTES) return false;
    if ('error' in v) return keys(v,['error']) && [403,404,409,429].includes(v.error as number);
    if (v.action === 'check') return keys(v,['action','ok']) && v.ok === true;
    if (v.action === 'snapshot') {
      const s = v.snapshot;
      return keys(v,['action','snapshot']) && object(s) && keys(s,['generation','preferencesRevision','connections','sessions','board','enabled'])
        && integer(s.generation) && integer(s.preferencesRevision) && typeof s.enabled === 'boolean'
        && object(s.board) && keys(s.board,['resourceId','revision','title','tasks']) && validBoardId(s.board.resourceId)
        && integer(s.board.revision) && validBoardContent({title:s.board.title,tasks:s.board.tasks})
        && Array.isArray(s.connections) && s.connections.length <= 10_000 && unique(s.connections.map(c => c.id))
        && s.connections.every(c => object(c) && keys(c,['id','nodeId','epoch']) && text(c.id) && text(c.nodeId) && integer(c.epoch) && c.epoch > 0)
        && Array.isArray(s.sessions) && s.sessions.length <= 5000 && unique(s.sessions.map(m => m.sessionId))
        && s.sessions.every(m => object(m) && keys(m,['sessionId','groupId','tags']) && text(m.sessionId,1024)
          && (m.groupId === null || text(m.groupId,80)) && validSessionTags(m.tags));
    }
    if (v.action === 'write-check') return keys(v,['action','batchId','requestId','ok']) && validBoardUuid(v.batchId)
      && validBoardUuid(v.requestId) && typeof v.ok === 'boolean';
    if (v.action === 'claim') return keys(v,['action','batchId','requestId','claimed','intent','credential'])
      && validBoardUuid(v.batchId) && validBoardUuid(v.requestId) && (v.claimed === false ? v.intent === null && v.credential === null
        : v.claimed === true && intent(v.intent) && v.intent.batchId === v.batchId && v.intent.requestId === v.requestId
          && object(v.credential) && keys(v.credential,['endpoint','token','expiresAt']) && validBoardToolCredential(v.credential)
          && v.credential.expiresAt === v.intent.grant.expiresAt);
    return ['prepare','confirm','read','cancel','settle','cleanup-settle'].includes(String(v.action)) && keys(v,['action','batch'])
      && (v.batch === null && v.action === 'cancel' || validHubDelegationBatch(v.batch));
  } catch { return false; }
}

class Denied extends Error {}
/** Runs only on the original worker/store connection. Mutation commands are
 * deliberately NOT wrapped in an outer savepoint: claim and cancellation must
 * root-COMMIT before any credential/remote cleanup can leave this function. */
export function executeHubDelegation(db: DatabaseSync, owner: HubStore, actor: HubPrincipal,
  fresh: () => HubPrincipal | undefined, command: HubDelegationCommand): HubDelegationResult {
  if (!validHubDelegationCommand(command)) throw Error('hub_delegation_unavailable');
  const user = actor.userId, boardId = command.boardId, store = owner.delegations, bindings = owner.boardBindings;
  const guard = () => { if (fresh()?.userId !== user) throw new Denied(); };
  const versions = (): Fence => ({generation:readHubConnectionDirectory(db,actor,{action:'version'}).version,
    preferencesRevision:owner.workspace.get(user).revision});
  const checkFence = (expected: Fence) => {
    guard(); const now = versions();
    if (expected.generation !== now.generation || expected.preferencesRevision !== now.preferencesRevision) throw new DelegationConflict('directory-changed');
  };
  const board = () => {
    const b = owner.boards.get(user,boardId);
    return {resourceId:boardId,revision:b.revision,title:b.title,tasks:b.tasks};
  };
  const grantable = () => bindings.enabled && !owner.boards.fileManaged(user,boardId);
  const localMember = (sessionId: string, taskBinding: DelegationMember['taskBinding']): DelegationMember => {
    const decoded = decodeHubSessionId(sessionId), c = decoded && owner.getConnection(decoded.connectionId,user);
    const epoch = c && owner.connectionAuthority(c.id,user), prefs = owner.workspace.get(user).sessions[sessionId];
    if (!c || c.status === 'disabled' || !c.nodeId || !epoch || !decoded) throw new DelegationConflict('member-changed');
    return {owner:user,nodeId:c.nodeId,connectionId:c.id,runtime:sessionRuntimeId(decoded.remoteSessionKey),sessionId,
      authorityEpoch:epoch,groupId:prefs?.groupId ?? null,tags:[...(prefs?.tags ?? [])].sort(),taskBinding};
  };
  const input = (c: Catalog, s: DelegationSelection, taskIds: string[], fields: ('status'|'detail')[]): DelegationPreviewInput => {
    checkFence(c); if (!grantable()) throw new DelegationConflict('grant-unavailable');
    return {owner:user,catalog:{owner:user,generation:c.generation,preferencesRevision:c.preferencesRevision,complete:true,
      members:c.members.map(m => localMember(m.sessionId,m.taskBinding))},selection:s,board:board(),taskIds,fields};
  };
  const required = (id: string) => {
    guard(); const b = store.read(user,id);
    if (!b || b.preview.resource.resourceId !== boardId) throw new DelegationConflict('missing'); return b;
  };
  const authorized = (i: DelegationIntent) => {
    guard(); if (!grantable()) return false;
    const current = localMember(i.member.sessionId,'supported'), b = board();
    return JSON.stringify(current) === JSON.stringify(i.member) && b.revision === i.boardRevision
      && ['codex','claude-code','ghcp'].includes(current.runtime) && i.grant.taskIds.every(id => b.tasks.some(t => t.id === id));
  };
  const readResult = (action: 'prepare'|'confirm'|'read'|'cancel'|'settle'|'cleanup-settle', b: DelegationBatch|null): HubDelegationResult => ({action,batch:b});
  try {
    guard();
    if (command.action === 'snapshot') {
      const v = versions(), prefs = owner.workspace.get(user);
      const connections = owner.listConnections(user).filter(c => c.status !== 'disabled').map(c => {
        const epoch = owner.connectionAuthority(c.id,user); if (!c.nodeId || !epoch) throw new DelegationConflict('member-changed');
        return {id:c.id,nodeId:c.nodeId,epoch};
      }).sort((a,b) => a.id.localeCompare(b.id));
      return {action:'snapshot',snapshot:{...v,connections,sessions:Object.entries(prefs.sessions).map(([sessionId,s]) =>
        ({sessionId,groupId:s.groupId ?? null,tags:s.tags ?? []})),board:board(),enabled:grantable()}};
    }
    if (command.action === 'check') { checkFence(command.fence); return {action:'check',ok:true}; }
    if (command.action === 'prepare') {
      const i = input(command.catalog,command.selection,command.taskIds,command.fields);
      return readResult('prepare',store.prepare(user,command.batchId,i,command.expiresAt,() => {
        checkFence(command.catalog); if (!grantable() || board().revision !== i.board.revision) throw new DelegationConflict('preview-changed');
      }));
    }
    const original = command.action === 'cancel' ? store.read(user,command.batchId) : required(command.batchId);
    if (original && original.preview.resource.resourceId !== boardId) return {error:404};
    if (command.action === 'read') return readResult('read',original!);
    if (command.action === 'confirm') {
      const p = original!.preview, i = input(command.catalog,p.selection,p.resource.tasks.map(t => t.id),p.resource.fields as ('status'|'detail')[]);
      return readResult('confirm',store.confirm(user,command.batchId,i,() => {
        checkFence(command.catalog); if (!grantable() || board().revision !== i.board.revision) throw new DelegationConflict('preview-changed');
      }));
    }
    if (command.action === 'cancel') {
      const b = store.cancel(user,command.batchId,guard,batch => {
        // The batch tombstone fences every undispatched member. Existing binding
        // rows are durable UUID reservations themselves: revoking them must NOT
        // require a free slot in the separate absent-request tombstone table.
        for (const m of batch.members) {
          const bound = bindings.get(user,boardId,m.requestId);
          if (bound && bindings.revoke(user,boardId,m.requestId)?.state !== 'revoked') throw new DelegationConflict('not-revoked');
        }
      });
      return readResult('cancel',b ?? null);
    }
    const receipt = original!.members.find(m => m.requestId === command.requestId);
    if (!receipt) return {error:404};
    if (command.action === 'claim') {
      let credential: HubBoardBindingCredential | null = null, effect: DelegationIntent | null = null;
      const result = store.claim(user,command.batchId,command.requestId,authorized,i => {
        if (bindings.get(user,boardId,i.requestId)) throw new DelegationConflict('binding-unavailable');
        const prepared = bindings.prepare(user,boardId,{requestId:i.requestId,sessionId:i.member.sessionId,grant:i.grant},
          i.member.connectionId,i.member.authorityEpoch,command.endpoint);
        // A different feature may have reserved this UUID. Never adopt/replay it.
        if (!prepared || prepared.state !== 'prepared') throw new DelegationConflict('binding-unavailable');
        credential = bindings.credential(user,boardId,i.requestId) ?? null;
        if (!credential || bindings.outcome(user,boardId,i.requestId,'uncertain')?.state !== 'uncertain') throw new DelegationConflict('binding-unavailable');
        effect = i;
      });
      return {action:'claim',batchId:command.batchId,requestId:command.requestId,claimed:result.claimed,intent:effect,credential};
    }
    if (command.action === 'write-check') return {action:'write-check',batchId:command.batchId,requestId:command.requestId,
      ok:store.canWrite(user,command.batchId,command.requestId,i => authorized(i) && !!bindings.credential(user,boardId,i.requestId))};
    if (command.action === 'cleanup-settle') {
      // A remote receipt cannot invent proof that the local capability is fenced.
      store.finishCancellation(user,command.batchId,command.requestId,() => {
        guard(); if (bindings.get(user,boardId,command.requestId)?.state !== 'revoked') throw new DelegationConflict('not-revoked');
      });
      return readResult('cleanup-settle',required(command.batchId));
    }
    const binding = bindings.get(user,boardId,command.requestId);
    const outcome = command.state === 'installed' && binding
      ? {requestId:command.requestId,state:'installed' as const,bindingId:binding.capabilityId}
      : {requestId:command.requestId,state:'unknown' as const};
    store.settle(user,command.batchId,outcome,() => {
      guard(); const current = required(command.batchId);
      if (current.state === 'cancelled') return;
      // Revocation/epoch changes cannot be overwritten by a delayed transport ACK.
      if (!authorized(store.intent(current,current.members.find(m => m.requestId === command.requestId)!))) throw new Denied();
      const bound = bindings.outcome(user,boardId,command.requestId,command.state === 'installed' ? 'installed' : 'uncertain',command.source === 'put');
      if (command.state === 'installed' && bound?.state !== 'installed') throw new DelegationConflict('binding-unavailable');
    });
    return readResult('settle',required(command.batchId));
  } catch (error) {
    if (error instanceof Denied) return {error:403};
    if (error instanceof DelegationConflict) return {error:error.message === 'missing' ? 404 : error.message.includes('capacity') ? 429 : 409};
    throw error;
  }
}
